#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/transport_policy.hpp
 * @brief How an outbound transfer reaches the network (issue #705).
 *
 * One policy, resolved from settings at the point of use, applied by one
 * function (`detail::apply_transport_policy`). Every driver - the
 * single-request client, the load event loop and the SSE consumer - reads the
 * same struct, which is the whole point: building transport config per-driver
 * is how the SSE path came to have no proxy option at all while the other two
 * did. Phase 2 (#706) added the CA bundle to it and touched no driver, which
 * is the plumbing working as designed; phase 3's client certificates arrive
 * the same way.
 */

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::db {
class Database;
}

namespace vayu::http {

/**
 * @brief Where a transfer's proxy comes from.
 */
enum class ProxyMode {
    /**
     * libcurl's own `http_proxy` / `https_proxy` / `no_proxy` environment
     * pickup - the default, because it is the behaviour every shell and CI
     * user already gets today by accident. Making it a named mode changes
     * nothing for them and gives the other two something to be distinct from.
     */
    Environment,
    /// The configured `proxyUrl`, for everything the bypass list does not skip.
    Manual,
    /**
     * No proxy at all, environment included. Distinct from `Environment`
     * because a desktop app launched from a dock inherits no environment while
     * a terminal-launched engine does, so "leave it alone" and "do not proxy"
     * are different answers.
     */
    Off
};

/// Every mode, in the order the `proxyMode` setting offers them. The seed
/// builds its options from this rather than from a literal list, so a mode
/// added here cannot become one the engine understands and `POST /config`
/// refuses - the same rule `all_http_versions` exists for.
std::array<ProxyMode, 3> all_proxy_modes ();

/// The wire spelling of @p mode, as the `proxyMode` config entry stores it.
const char* to_string (ProxyMode mode);

/// What the Settings row calls @p mode.
const char* proxy_mode_label (ProxyMode mode);

/// Parse a stored `proxyMode`. An unrecognised value yields nullopt so the
/// caller decides between falling back and refusing - the two callers want
/// different things (the resolver logs and falls back, the config route
/// rejects).
std::optional<ProxyMode> proxy_mode_from_string (std::string_view value);

/**
 * @brief Why @p url cannot be a proxy URL, or nullopt when it can.
 *
 * The one copy of the rule: `POST /config` rejects a bad value with it, and
 * the resolver below re-checks a row that was hand-edited around the route.
 * Deliberately permissive about the shapes curl itself accepts - a bare
 * `host:port` is valid and means `http://host:port` - and strict about the
 * shapes that are always a mistake: empty, whitespace-bearing, no host, or a
 * scheme libcurl has no proxy support for.
 */
std::optional<std::string> proxy_url_rejection (std::string_view url);

/**
 * @brief One registry row: the certificate a host is called with (issue #707).
 *
 * A certificate is a property of *where you are calling*, not of one request -
 * which is why this is a registry keyed by host rather than a request field.
 * The request that needs mTLS is usually the third one in a chain (a token
 * fetch, a redirect, a script's `pm.sendRequest`), and none of those are places
 * a user can attach anything.
 *
 * **Paths, never contents.** The private key stays on disk where the user's
 * own tooling put it; the database holds the way to find it. That is the
 * strongest storage decision available without a keystore, and it is the one
 * asymmetry worth stating out loud: `passphrase` below *is* stored, in
 * plaintext, on the repo's existing credential precedent (#704 decision 6).
 */
struct ClientCertRule {
    /// Engine-assigned id of the `client_certificates` row this came from.
    std::string id;

    /**
     * The host this certificate answers for, lower-cased, with no scheme, port
     * or path - the same spelling `parse_authority` produces, so a match is a
     * string compare rather than a second URL parser. An IPv6 literal is stored
     * without its brackets, again because that is the form the parser yields.
     *
     * Exact match only. Wildcards are deliberately absent in v1: a
     * `*.example.com` that matched `a.b.example.com` but not `example.com`
     * would be a rule the card cannot state in one line, and a certificate
     * silently *not* used is the failure this feature exists to end.
     */
    std::string host;

    /// The port this row is specific to, or nullopt when it answers for the
    /// host on every port. An entry naming the port wins over one that does not
    /// - see `match_client_certificate`.
    std::optional<int> port;

    /// PEM (or, per platform, PKCS#12) certificate file, passed to
    /// `CURLOPT_SSLCERT` verbatim.
    std::string cert_path;

    /// Private key file, passed to `CURLOPT_SSLKEY` verbatim.
    std::string key_path;

    /// The key's passphrase, empty when it has none. Stored plaintext - see the
    /// struct comment and `docs/engine/db-schema.md`.
    std::string passphrase;
};

/**
 * @brief What a rule is called on screen and in a trace: `host` or `host:port`.
 *
 * One spelling, because the response pane, the log line and the Settings card
 * all name the same row and three renderings of it would be three things to
 * cross-reference by eye.
 */
std::string client_cert_label (const ClientCertRule& rule);

/**
 * @brief Why this registry entry cannot be stored, or nullopt when it can.
 *
 * The one copy of the rule: the CRUD routes reject a bad entry with it, and the
 * resolver re-checks a row that was hand-edited around them. Strict about what
 * can never work - a host carrying a scheme, a port outside 1..65535, a
 * certificate or key file this process cannot open - because every one of those
 * surfaces at handshake time as a TLS error that names the endpoint rather than
 * the setting, which is the shape this epic exists to stop.
 */
std::optional<std::string> client_cert_rejection (std::string_view host,
const std::optional<int>& port,
std::string_view cert_path,
std::string_view key_path);

/**
 * @brief Everything the wire needs to know about how to leave this machine.
 */
struct TransportPolicy {
    ProxyMode proxy_mode = ProxyMode::Environment;

    /**
     * curl-shaped: `scheme://user:pass@host:port`. That one string buys SOCKS
     * (`socks5://`, `socks5h://`) and basic proxy auth with no extra columns
     * and no second credential store - epic decision 5 of #704.
     *
     * Read only in `ProxyMode::Manual`.
     */
    std::string proxy_url;

    /**
     * Hosts that skip the proxy, comma-separated, passed to `CURLOPT_NOPROXY`
     * verbatim. curl's matching rules (leading-dot suffix match, `*` for
     * everything) are documented rather than re-implemented here: a second
     * implementation of host matching is a second set of bugs, and the one
     * that ships in libcurl is the one the user's other tools already obey.
     */
    std::string proxy_bypass;

    /**
     * The materialized CA bundle `CURLOPT_CAINFO` points at, empty when the
     * user has added no certificate of their own (issue #706).
     *
     * A *path*, because that is the only shape libcurl takes - but what the
     * user stores is the PEM *content* (`customCaCertificates`), and this file
     * is derived from it beside the database. A stored path would break the
     * moment the file moved and could not be shown back in Settings.
     *
     * On an OpenSSL-backed build `CURLOPT_CAINFO` *replaces* the default
     * bundle, so the file this names is the system anchors and the user's PEMs
     * concatenated - the additive rule of #704 is kept by construction rather
     * than by hoping the backend merges for us. See `resolve_transport_policy`.
     */
    std::string ca_bundle_path;

    /**
     * The client-certificate registry as it stood when this policy was
     * resolved (issue #707), empty when the user has registered none.
     *
     * The *whole* registry travels with the policy rather than one
     * pre-selected certificate, because one policy serves many hosts: a load
     * run has one target but a scenario run walks a collection, a script's
     * `pm.sendRequest` dials wherever it likes, and a redirect can leave the
     * host the run started on. Matching therefore happens per transfer
     * (`match_client_certificate`) while the *reading* happens once - which is
     * the load path's rule from #704 decision 3 kept without giving the hot
     * path a database.
     */
    std::vector<ClientCertRule> client_certificates;
};

/**
 * @brief The registry entry that answers for @p host on @p port, or null.
 *
 * Most specific wins: an entry naming this exact port beats one that answers
 * for the host on any port. Beyond that there is nothing to rank, because
 * `client_cert_rejection` refuses a second entry for a host+port pair that is
 * already registered - so a match is unique by construction rather than by a
 * tie-break nobody could predict from the card.
 *
 * @param host Lower-cased hostname, as `parse_authority` yields it.
 * @param port The port the transfer dials, scheme default included - never 0,
 *             since "any port" is a property of the *entry*, not the transfer.
 * @return A pointer into @p policy, valid as long as it is. Callers that keep
 *         it past the policy's lifetime must copy what they need.
 */
const ClientCertRule*
match_client_certificate (const TransportPolicy& policy, std::string_view host, int port);

/**
 * @brief Why @p pem cannot be a CA bundle, or nullopt when it can.
 *
 * The one copy of the rule, shared by `POST /config` (which rejects a bad
 * paste outright) and the resolver (which re-checks a row edited around the
 * route). Deliberately shallow - it asks whether the text is PEM-shaped, not
 * whether the certificates inside it are valid or unexpired, because a
 * pasted-in-full chain that curl accepts must not be refused by a parser of
 * ours, and the certificate that fails to verify says so at handshake time
 * with libcurl's own error rather than a guess of ours at paste time.
 */
std::optional<std::string> ca_pem_rejection (std::string_view pem);

/**
 * @brief The trust anchors this platform verifies with today, as PEM text.
 *
 * Empty when they cannot be read as a file - which is the normal case on
 * Windows (Schannel) and macOS (Apple SecTrust), where the anchors live in an
 * OS store rather than a bundle. Exposed for the tests and for the per-platform
 * disclosure in the docs; production code reaches it through
 * `resolve_transport_policy`.
 */
std::string system_ca_bundle_pem ();

/**
 * @brief Read the policy out of the config table.
 *
 * Resolved at the point of use rather than cached, the same way
 * `read_sse_limits` is, so a settings change applies to the next transfer
 * without a restart. A value no `POST /config` would have accepted can still
 * reach here from a hand-edited row; each one is logged and replaced with the
 * default rather than trusted, because a malformed `proxyUrl` silently
 * becomes "no proxy" and that is the failure this whole issue exists to stop
 * being invisible.
 */
TransportPolicy resolve_transport_policy (vayu::db::Database& db);

} // namespace vayu::http
