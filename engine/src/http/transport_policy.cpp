/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/transport_policy.cpp
 * @brief Reading the transport policy out of settings (issue #705).
 */

#include "vayu/http/transport_policy.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <compare>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <sstream>
#include <system_error>
#include <utility>
#include <vector>

#include <curl/curl.h>

#include "vayu/db/database.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http {

namespace {

/// The proxy schemes libcurl understands. A scheme outside this list is always
/// a typo - curl would take `htp://host` as a *host* named "htp:" and dial
/// something the user never named.
constexpr std::array<std::string_view, 7> PROXY_SCHEMES = { "http", "https",
    "socks4", "socks4a", "socks5", "socks5h", "socks5t" };

bool is_blank (std::string_view value) {
    return std::all_of (value.begin (), value.end (),
    [] (unsigned char c) { return std::isspace (c) != 0; });
}

/// The one wildcard form the registry takes: a leading `*.` and nothing else
/// (issue #803). Written once because the matcher and the write-time check must
/// agree on what a pattern *is* - a shape one accepted and the other did not
/// would store an entry that can never match.
bool is_wildcard_host (std::string_view host) {
    return host.rfind ("*.", 0) == 0;
}

/// The labels a wildcard answers for, dot included: `*.example.com` yields
/// `.example.com`. That leading dot is the rule - it is what makes the apex a
/// non-match without a second condition to forget.
std::string_view wildcard_suffix (std::string_view pattern) {
    return pattern.substr (1);
}

/**
 * Whether @p host is an address rather than a name.
 *
 * A wildcard is a rule about DNS labels, so it must not answer for an address
 * literal: without this, an entry for `*.0.1` presents the user's client
 * identity to `127.0.0.1`, which is the failure this feature is most obliged
 * not to introduce - a certificate offered to a host nobody registered. Shallow
 * on purpose (digits and dots, or a colon): it decides what a *wildcard* may
 * answer for, never whether an address is well formed, and an exact entry still
 * matches an address literal the way it always did.
 */
bool is_address_literal (std::string_view host) {
    if (host.find (':') != std::string_view::npos) {
        return true; // an IPv6 literal, stored bracketless
    }
    return !host.empty () &&
    std::all_of (host.begin (), host.end (),
    [] (unsigned char c) { return std::isdigit (c) != 0 || c == '.'; });
}

/// The PEM markers a certificate is wrapped in. Only the certificate label is
/// accepted: a pasted *private key* is the one mistake worth naming, because
/// the file it would land in is world-readable and the user would never see it
/// again.
constexpr std::string_view CERT_BEGIN     = "-----BEGIN CERTIFICATE-----";
constexpr std::string_view CERT_END       = "-----END CERTIFICATE-----";
constexpr std::string_view KEY_MARKER     = "-----BEGIN PRIVATE KEY-----";
constexpr std::string_view RSA_KEY_MARKER = "-----BEGIN RSA PRIVATE KEY-----";

/// Where a Unix build keeps its trust store, for a libcurl whose compiled-in
/// `cainfo` names no file that exists. Probed in the order curl's own fallback
/// probes them, so the file we read is the file it would have read.
///
/// The last resort of three, and which one answers is a property of the build
/// rather than of the platform: the linux-dev build at the pinned baseline
/// reports `cainfo=/etc/ssl/certs/ca-certificates.crt`, so it never reaches
/// this list. Linux and macOS run this resolver for real, which is why
/// `TlsBackend.FindsTheSystemAnchorsTheMergeExtends` asserts there that *some*
/// probe answers rather than assuming a particular one does. Windows is
/// OpenSSL-backed too since #851 but has no bundle on any of these paths - the
/// `cainfo` its port reports names the build machine - so it normally falls
/// through to the empty path and takes its anchors from the certificate store
/// via `CURLSSLOPT_NATIVE_CA` instead.
constexpr std::array<std::string_view, 6> SYSTEM_CA_BUNDLES = {
    "/etc/ssl/certs/ca-certificates.crt", // Debian, Ubuntu, Alpine
    "/etc/pki/tls/certs/ca-bundle.crt",   // Fedora, RHEL
    "/etc/ssl/ca-bundle.pem",             // openSUSE
    "/etc/pki/tls/cacert.pem",            // legacy RHEL
    "/etc/ssl/cert.pem",                  // macOS, FreeBSD
    "/usr/local/share/certs/ca-root-nss.crt"
};

std::string read_file (const std::filesystem::path& path) {
    std::ifstream in (path, std::ios::binary);
    if (!in) {
        return {};
    }
    std::ostringstream buffer;
    buffer << in.rdbuf ();
    return buffer.str ();
}

/// The file libcurl itself would verify against, or an empty path when this
/// build has none. Environment first, because a user who exports
/// `CURL_CA_BUNDLE` has already told every curl on the machine where their
/// anchors are and ours must not be the one tool that ignores it.
std::filesystem::path system_ca_bundle_path () {
    for (const char* variable : { "CURL_CA_BUNDLE", "SSL_CERT_FILE" }) {
        // The one mt-unsafe call in the engine with no reentrant spelling to
        // move to (#945). `getenv` races only against a *write* to the
        // environment, and nothing in the engine writes one - no `setenv`,
        // `putenv` or `_putenv_s` anywhere in `src`, which
        // `tests/reentrant_test.cpp` scans for and keeps true. Caching the
        // answer in a function-local static would silence the check and cost
        // more than it buys: the resolved bundle would then be fixed for the
        // process, so a `CURL_CA_BUNDLE` exported for a later run would go
        // unread with nothing to say why.
        // NOLINTNEXTLINE(concurrency-mt-unsafe)
        if (const char* value = std::getenv (variable); value != nullptr && *value != '\0') {
            std::error_code ec;
            if (std::filesystem::is_regular_file (value, ec)) {
                return { value };
            }
        }
    }

    const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
    if (info != nullptr && info->age >= CURLVERSION_SEVENTH &&
    info->cainfo != nullptr && *info->cainfo != '\0') {
        std::error_code ec;
        if (std::filesystem::is_regular_file (info->cainfo, ec)) {
            return { info->cainfo };
        }
    }

    for (const auto& candidate : SYSTEM_CA_BUNDLES) {
        std::error_code ec;
        if (std::filesystem::is_regular_file (candidate, ec)) {
            return { candidate };
        }
    }
    return {};
}

/**
 * Write @p content to @p path, through a temporary beside it.
 *
 * Renamed into place rather than truncated and rewritten, because the resolver
 * runs on the request path: a transfer that read the file halfway through a
 * rewrite would verify against a truncated bundle, and "some of your CAs" is
 * the failure shape this whole feature exists to remove.
 */
bool write_atomically (const std::filesystem::path& path, const std::string& content) {
    std::filesystem::path temp = path;
    temp += ".tmp";

    {
        std::ofstream out (temp, std::ios::binary | std::ios::trunc);
        if (!out) {
            return false;
        }
        out << content;
        if (!out) {
            return false;
        }
    }

    std::error_code ec;
    std::filesystem::rename (temp, path, ec);
    if (ec) {
        std::filesystem::remove (temp, ec);
        return false;
    }
    return true;
}

/**
 * The bundle path for @p pem, materialized beside the database.
 *
 * Cached on the content that produced it: `resolve_transport_policy` runs per
 * transfer (deliberately - a settings change must reach the next request), and
 * rewriting a file on every send is a cost the feature has no reason to carry.
 * The existence check is part of the key, so a bundle deleted underneath the
 * engine comes back rather than being trusted because we once wrote it.
 */
std::string materialize_ca_bundle (const std::string& pem,
const std::filesystem::path& directory) {
    static std::mutex cache_mutex;
    static std::string cached_pem;
    static std::string cached_path;

    // A database opened by a bare filename ("vayu.db", which the tests and the
    // CLI both do) has no parent path; the bundle belongs beside it either way.
    const std::filesystem::path dir =
    directory.empty () ? std::filesystem::path (".") : directory;
    const std::filesystem::path bundle = dir / "ca-bundle.pem";

    std::lock_guard<std::mutex> lock (cache_mutex);
    std::error_code ec;
    if (cached_pem == pem && cached_path == bundle.string () &&
    std::filesystem::is_regular_file (bundle, ec)) {
        return cached_path;
    }

    // The user's anchors *extend* the platform's rather than replacing them
    // (decision 4 of #704). On an OpenSSL-backed build `CURLOPT_CAINFO` is the
    // whole trust store, so the merge has to happen here - and since #851
    // every leg is one, macOS included (#818).
    //
    // Windows is the leg with nothing to merge: it keeps its anchors in a
    // certificate store and ships no PEM bundle, so `system_ca_bundle_path()`
    // finds none and this writes the user's certificates alone. The additive
    // promise is kept there by `CURLSSLOPT_NATIVE_CA`, which the applier sets
    // unconditionally on that platform (`curl_utils.cpp`) - so the store still
    // applies beside this file. A machine that exports `CURL_CA_BUNDLE` puts a
    // file back in reach and the merge below runs there like anywhere else.
    std::string content;
    const std::filesystem::path system_bundle = system_ca_bundle_path ();
    if (!system_bundle.empty ()) {
        content = read_file (system_bundle);
        if (!content.empty () && content.back () != '\n') {
            content += '\n';
        }
    }
    content += pem;
    if (!content.empty () && content.back () != '\n') {
        content += '\n';
    }

    std::filesystem::create_directories (dir, ec);
    if (!write_atomically (bundle, content)) {
        vayu::utils::log_error ("Could not write the CA bundle to " + bundle.string () +
        "; the certificates in 'customCaCertificates' are not in use");
        cached_pem.clear ();
        cached_path.clear ();
        return {};
    }

    cached_pem  = pem;
    cached_path = bundle.string ();
    return cached_path;
}

} // namespace

std::array<ProxyMode, 4> all_proxy_modes () {
    return { ProxyMode::Environment, ProxyMode::System, ProxyMode::Manual, ProxyMode::Off };
}

const char* to_string (ProxyMode mode) {
    switch (mode) {
    case ProxyMode::Environment: return "environment";
    case ProxyMode::System: return "system";
    case ProxyMode::Manual: return "manual";
    case ProxyMode::Off: return "off";
    }
    return "environment";
}

const char* proxy_mode_label (ProxyMode mode) {
    switch (mode) {
    case ProxyMode::Environment: return "From environment";
    case ProxyMode::System: return "From system";
    case ProxyMode::Manual: return "Manual";
    case ProxyMode::Off: return "None";
    }
    return "From environment";
}

std::optional<ProxyMode> proxy_mode_from_string (std::string_view value) {
    if (value == "environment") {
        return ProxyMode::Environment;
    }
    if (value == "system") {
        return ProxyMode::System;
    }
    if (value == "manual") {
        return ProxyMode::Manual;
    }
    if (value == "off") {
        return ProxyMode::Off;
    }
    return std::nullopt;
}

std::optional<std::string> proxy_url_rejection (std::string_view url) {
    if (url.empty () || is_blank (url)) {
        return std::string ("proxy URL is empty");
    }
    if (std::any_of (url.begin (), url.end (),
        [] (unsigned char c) { return std::isspace (c) != 0; })) {
        return std::string ("proxy URL contains whitespace");
    }

    std::string_view authority = url;
    const auto scheme_end      = url.find ("://");
    if (scheme_end != std::string_view::npos) {
        const std::string_view scheme = url.substr (0, scheme_end);
        std::string lowered (scheme);
        std::transform (lowered.begin (), lowered.end (), lowered.begin (),
        [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
        if (std::find (PROXY_SCHEMES.begin (), PROXY_SCHEMES.end (), lowered) ==
        PROXY_SCHEMES.end ()) {
            std::string allowed;
            for (const auto& candidate : PROXY_SCHEMES) {
                allowed += (allowed.empty () ? "" : ", ");
                allowed += std::string (candidate);
            }
            return "proxy URL scheme '" + std::string (scheme) +
            "' is not one libcurl proxies through (expected one of: " + allowed + ")";
        }
        authority = url.substr (scheme_end + 3);
    }

    // Userinfo is optional and may itself contain '@' in an encoded password,
    // so the host starts after the *last* one.
    const auto userinfo_end = authority.rfind ('@');
    if (userinfo_end != std::string_view::npos) {
        authority = authority.substr (userinfo_end + 1);
    }
    // Anything past the authority (a path curl ignores on a proxy URL) is not
    // part of the host.
    const auto host = authority.substr (0, authority.find ('/'));
    if (host.empty () || host.front () == ':') {
        return std::string ("proxy URL names no host");
    }
    return std::nullopt;
}

std::string client_cert_label (const ClientCertRule& rule) {
    return rule.port ? rule.host + ":" + std::to_string (*rule.port) : rule.host;
}

std::array<ClientCertFormat, 2> all_client_cert_formats () {
    return { ClientCertFormat::Pem, ClientCertFormat::Pkcs12 };
}

const char* to_string (ClientCertFormat format) {
    switch (format) {
    case ClientCertFormat::Pem: return "pem";
    case ClientCertFormat::Pkcs12: return "p12";
    }
    return "pem";
}

const char* curl_ssl_cert_type (ClientCertFormat format) {
    switch (format) {
    case ClientCertFormat::Pem: return "PEM";
    case ClientCertFormat::Pkcs12: return "P12";
    }
    return "PEM";
}

std::optional<ClientCertFormat> client_cert_format_from_string (std::string_view value) {
    for (const auto format : all_client_cert_formats ()) {
        if (value == to_string (format)) {
            return format;
        }
    }
    return std::nullopt;
}

std::optional<ClientCertFormat> sniff_client_cert_format (std::string_view path) {
    std::ifstream file{ std::string (path), std::ios::binary };
    if (!file) {
        return std::nullopt;
    }
    // Enough to clear the "Bag Attributes" preamble `openssl pkcs12` writes
    // ahead of a PEM block, and small enough that a wrong path costs one page.
    std::array<char, 4096> head{};
    file.read (head.data (), static_cast<std::streamsize> (head.size ()));
    const std::string_view leading (
    head.data (), static_cast<std::size_t> (file.gcount ()));
    if (leading.empty ()) {
        return std::nullopt;
    }
    // The PEM marker is looked for first because a PEM file is text and the
    // ASN.1 tag below is also the ASCII digit '0' - a rule the other way round
    // would classify a text file starting with a zero as a PKCS#12 bundle.
    if (leading.find ("-----BEGIN") != std::string_view::npos) {
        return ClientCertFormat::Pem;
    }
    if (static_cast<unsigned char> (leading.front ()) == 0x30) {
        return ClientCertFormat::Pkcs12;
    }
    return std::nullopt;
}

namespace {

/**
 * Why @p host is not a host this registry can match on, or nothing.
 *
 * Each near miss is refused by name rather than stored and quietly never
 * matched, because a registry entry that cannot match is indistinguishable from
 * a feature that does not work (issue #803).
 */
std::optional<std::string> client_cert_host_rejection (std::string_view host) {
    if (host.empty () || is_blank (host)) {
        return std::string ("host is empty");
    }
    if (std::any_of (host.begin (), host.end (),
        [] (unsigned char c) { return std::isspace (c) != 0; })) {
        return std::string ("host contains whitespace");
    }
    // The one wildcard form, and every near-miss refused by name (issue #803).
    // A `*` anywhere else is a pattern this engine does not have - stored, it
    // would be a hostname no transfer can ever equal, which is exactly the
    // "registered and silently never used" state this registry exists to end.
    if (const std::string_view labels = is_wildcard_host (host) ? host.substr (2) : host;
    labels.find ('*') != std::string_view::npos) {
        return std::string (
        "a wildcard host is written '*.example.com' - one leading '*.' and "
        "the domain it answers for, with no other '*'");
    }
    if (is_wildcard_host (host) && (host.size () == 2 || host[2] == '.')) {
        return std::string ("'" + std::string (host) +
        "' names no domain after the '*.' - register '*.example.com'");
    }

    // The three shapes a user reaches for when they copy the address bar. Each
    // is refused by name rather than stored and quietly never matched, because
    // a registry entry that cannot match is indistinguishable from a feature
    // that does not work.
    if (host.find ("://") != std::string_view::npos) {
        return std::string (
        "host must not carry a scheme - register 'api.example.com', "
        "not 'https://api.example.com'");
    }
    if (host.find ('/') != std::string_view::npos) {
        return std::string ("host must not carry a path");
    }
    // An IPv6 literal is stored bracketless (the form `parse_authority` yields),
    // so a colon is only ever an attempt at a port - which has its own field.
    if (host.find (':') != std::string_view::npos &&
    host.find (']') == std::string_view::npos &&
    std::count (host.begin (), host.end (), ':') == 1) {
        return std::string ("host must not carry a port - use the port field");
    }
    if (host.find ('[') != std::string_view::npos ||
    host.find (']') != std::string_view::npos) {
        return std::string (
        "an IPv6 host is registered without brackets, e.g. '::1'");
    }
    return std::nullopt;
}

/**
 * Whether the files a row names are there and readable.
 *
 * Checked *here*, at the moment the user can still fix the path, rather than at
 * handshake time where curl reports `CURLE_SSL_CERTPROBLEM` against the endpoint
 * and says nothing about which setting named a file that is not there. A PKCS#12
 * row has one file to check, which is the whole difference the format makes.
 */
std::optional<std::string> client_cert_file_rejection (
ClientCertFormat format, std::string_view cert_path, std::string_view key_path) {
    // Both files are checked *here*, at the moment the user can still fix the
    // path, rather than at handshake time where curl reports
    // `CURLE_SSL_CERTPROBLEM` against the endpoint and says nothing about which
    // setting named a file that is not there. A PKCS#12 row has one file to
    // check, which is the whole difference the format makes here.
    std::vector<std::pair<const char*, std::string_view>> files{
        { "certificate file", cert_path }
    };
    if (format == ClientCertFormat::Pem) {
        if (key_path.empty () || is_blank (key_path)) {
            return std::string (
            "key file is empty - a PEM certificate keeps its key in a "
            "second file (only a PKCS#12 bundle carries its own)");
        }
        files.emplace_back ("key file", key_path);
    }
    for (const auto& [label, path] : files) {
        if (path.empty () || is_blank (path)) {
            return std::string (label) + " is empty";
        }
        std::error_code ec;
        const std::filesystem::path fs_path{ std::string (path) };
        if (!std::filesystem::is_regular_file (fs_path, ec)) {
            return std::string (label) + " '" + std::string (path) + "' is not a readable file";
        }
        std::ifstream probe (fs_path, std::ios::binary);
        if (!probe) {
            return std::string (label) + " '" + std::string (path) + "' cannot be opened";
        }
    }
    return std::nullopt;
}

} // namespace

std::optional<std::string> client_cert_rejection (std::string_view host,
const std::optional<int>& port,
ClientCertFormat format,
std::string_view cert_path,
std::string_view key_path) {
    if (auto rejection = client_cert_host_rejection (host)) {
        return rejection;
    }

    if (port && (*port < 1 || *port > 65535)) {
        return "port " + std::to_string (*port) + " is outside 1..65535";
    }

    // A PKCS#12 bundle carries its own key, so a key path on such a row is a
    // field nothing would ever read - refused rather than stored and ignored,
    // because a card that keeps asking for a key file the format does not have
    // is a dead end (#833). Clearing it is `keyPath: null` on the update.
    if (format == ClientCertFormat::Pkcs12 && !key_path.empty () && !is_blank (key_path)) {
        return std::string (
        "a PKCS#12 entry names no key file - the bundle carries the key, "
        "so clear the key file or register the certificate as PEM");
    }

    if (auto rejection = client_cert_file_rejection (format, cert_path, key_path)) {
        return rejection;
    }


    // The declared format against the file's own bytes. Only a *contradiction*
    // is refused: a file this engine cannot classify (a DER certificate, an
    // encoding nobody here has seen) is left for the backend to judge, the same
    // shallowness `ca_pem_rejection` is written with. What this catches is the
    // mistake that otherwise surfaces as libcurl's own parse error against the
    // endpoint - a `.p12` registered as a PEM pair, or the reverse.
    if (const auto actual = sniff_client_cert_format (cert_path); actual && *actual != format) {
        return "certificate file '" + std::string (cert_path) + "' is " +
        std::string (to_string (*actual)) + ", but the entry declares " +
        std::string (to_string (format));
    }

    return std::nullopt;
}

namespace {

/**
 * How specific a matching rule is, most significant field first (issue #803).
 *
 * The three tiers the registry documents, as one comparable value: an exact
 * host beats every wildcard, a longer wildcard beats a shorter one, and within
 * one host pattern the entry naming this port beats the catch-all beside it.
 *
 * **Two matching rules can never tie**, which is what keeps the presented
 * certificate independent of row order. Two exact rows that both match have the
 * same host; two wildcards whose suffixes are the same length and both end at
 * the end of the host *are* the same string. So a tie means one host+port pair
 * twice, which the routes answer with a 409 and the resolver drops - there is
 * no order-dependent case left for a tie-break to decide.
 */
struct ClientCertRank {
    /// 1 for an exact host, 0 for a wildcard. Host specificity dominates: an
    /// exact entry with no port still beats a wildcard that names one, because
    /// "the closest host wins, then the port" is the rule a card can state.
    int exact_host = 0;
    /// Length of the wildcard suffix that matched, so the longest wins;
    /// unused (and irrelevant) for an exact host, which already outranks these.
    std::size_t suffix_length = 0;
    /// 1 when the row names this port, 0 when it answers every port.
    int exact_port = 0;

    auto operator<=> (const ClientCertRank&) const = default;
};

/// How well @p rule answers for @p host on @p port, or nullopt when it does not.
/// @p host is already lower-cased; rows are stored that way (`lowered` in the
/// routes), so both sides of every comparison here are.
std::optional<ClientCertRank>
rank_client_cert_rule (const ClientCertRule& rule, std::string_view host, int port) {
    if (rule.port && *rule.port != port) {
        return std::nullopt;
    }
    const int exact_port = rule.port ? 1 : 0;

    if (!is_wildcard_host (rule.host)) {
        if (rule.host != host) {
            return std::nullopt;
        }
        return ClientCertRank{ 1, 0, exact_port };
    }

    // `*.example.com` answers for `api.example.com` and `a.b.example.com`,
    // never for `example.com` (which does not carry the leading dot) and never
    // for `notexample.com` (same). One label of headroom is the whole rule:
    // ending with `.example.com` *and* being longer than it means at least one
    // character sits in front of that dot.
    const std::string_view suffix = wildcard_suffix (rule.host);
    if (host.size () <= suffix.size () || !host.ends_with (suffix) ||
    is_address_literal (host)) {
        return std::nullopt;
    }
    return ClientCertRank{ 0, suffix.size (), exact_port };
}

} // namespace

const ClientCertRule*
match_client_certificate (const TransportPolicy& policy, std::string_view host, int port) {
    if (policy.client_certificates.empty () || host.empty ()) {
        return nullptr;
    }

    std::string wanted (host);
    std::transform (wanted.begin (), wanted.end (), wanted.begin (),
    [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });

    const ClientCertRule* best = nullptr;
    ClientCertRank best_rank;
    for (const auto& rule : policy.client_certificates) {
        const auto rank = rank_client_cert_rule (rule, wanted, port);
        if (!rank) {
            continue;
        }
        if (best == nullptr || best_rank < *rank) {
            best      = &rule;
            best_rank = *rank;
        }
    }
    return best;
}

std::optional<std::string> ca_pem_rejection (std::string_view pem) {
    if (pem.empty () || is_blank (pem)) {
        return std::string ("no certificate found");
    }
    if (pem.find (KEY_MARKER) != std::string_view::npos ||
    pem.find (RSA_KEY_MARKER) != std::string_view::npos) {
        return std::string (
        "this is a private key, not a certificate - paste only the "
        "certificate blocks (a key belongs in the client-certificate "
        "registry, not the trust store)");
    }

    const auto begin = pem.find (CERT_BEGIN);
    if (begin == std::string_view::npos) {
        return "no '" + std::string (CERT_BEGIN) + "' block found";
    }
    if (pem.find (CERT_END, begin + CERT_BEGIN.size ()) == std::string_view::npos) {
        return "a certificate block is not closed by '" + std::string (CERT_END) + "'";
    }
    return std::nullopt;
}

std::string system_ca_bundle_pem () {
    const std::filesystem::path path = system_ca_bundle_path ();
    if (path.empty ()) {
        return {};
    }
    return read_file (path);
}

TransportPolicy resolve_transport_policy (vayu::db::Database& db) {
    TransportPolicy policy;

    // The client-certificate registry (issue #707), read whole because a policy
    // serves every host a run may reach - see TransportPolicy::client_certificates.
    for (const auto& row : db.get_client_certificates ()) {
        // A spelling the route would have refused, so only a hand-edited row
        // reaches it. Dropped with its own line rather than defaulted to PEM:
        // presenting the wrong shape is a handshake failure against the
        // endpoint, and "which format" is not a thing to guess on the user's
        // behalf.
        const auto format = client_cert_format_from_string (row.cert_format);
        if (!format) {
            vayu::utils::log_error ("Client certificate '" + row.id +
            "' for host '" + row.host + "' declares an unknown format '" +
            row.cert_format + "'; requests to that host will be sent without it");
            continue;
        }
        if (const auto rejection = client_cert_rejection (
            row.host, row.port, *format, row.cert_path, row.key_path)) {
            // The routes refuse this shape, so only a hand-edited row or a file
            // that has moved since it was registered reaches here. Named rather
            // than swallowed, and named *now*: the alternative is a handshake
            // failure against the endpoint, which is precisely the "the API is
            // down" misdiagnosis this epic exists to end.
            vayu::utils::log_error ("Client certificate '" + row.id +
            "' for host '" + row.host + "' is unusable (" + *rejection +
            "); requests to that host will be sent without it");
            continue;
        }
        ClientCertRule rule;
        rule.id         = row.id;
        rule.host       = row.host;
        rule.port       = row.port;
        rule.cert_path  = row.cert_path;
        rule.key_path   = row.key_path;
        rule.passphrase = row.passphrase;
        rule.format     = *format;
        policy.client_certificates.push_back (std::move (rule));
    }

    // TLS trust first: it is independent of the proxy, and the manual-mode
    // early return below would otherwise skip it for every direct sender.
    const std::string ca_pem = db.get_config_string ("customCaCertificates", "");
    if (!ca_pem.empty () && !is_blank (ca_pem)) {
        if (const auto rejection = ca_pem_rejection (ca_pem)) {
            // `POST /config` refuses this shape, so only a hand-edited row
            // reaches it. Named rather than swallowed: a bundle silently
            // dropped would leave every request failing verification with no
            // line anywhere saying the certificates were never loaded.
            vayu::utils::log_error (
            "Config 'customCaCertificates' is unusable (" + *rejection +
            "); no custom CA certificates are in use");
        } else {
            policy.ca_bundle_path = materialize_ca_bundle (
            ca_pem, std::filesystem::path (db.path ()).parent_path ());
        }
    }

    const std::string mode_value =
    db.get_config_string ("proxyMode", to_string (policy.proxy_mode));
    if (const auto parsed = proxy_mode_from_string (mode_value)) {
        policy.proxy_mode = *parsed;
    } else {
        // Only reachable from a hand-edited row - `POST /config` rejects a
        // value outside the enum's options. Named rather than swallowed, as
        // read_sse_limits names an out-of-range limit.
        vayu::utils::log_warning (
        "Config 'proxyMode' holds unrecognised value '" + mode_value +
        "'; using '" + to_string (policy.proxy_mode) + "'");
    }

    policy.proxy_bypass = db.get_config_string ("proxyBypass", "");

    if (policy.proxy_mode == ProxyMode::System) {
        // What the app resolved from the operating system (issue #708). Empty
        // is not a failure here - it is the documented headless case, where no
        // app has ever run to push a value - so it falls through to the
        // environment pickup rather than to `Off`. See ProxyMode::System.
        const std::string resolved = db.get_config_string ("proxySystemUrl", "");
        if (resolved.empty ()) {
            return policy;
        }
        if (const auto rejection = proxy_url_rejection (resolved)) {
            // Only a hand-edited row or an OS answer in a shape libcurl has no
            // proxy support for reaches this. Named rather than swallowed, for
            // the reason the manual arm below is: the alternative is every
            // request going direct while Settings names a proxy.
            vayu::utils::log_error ("Config 'proxySystemUrl' is unusable (" +
            *rejection + "); falling back to the environment for 'system' proxy mode");
            return policy;
        }
        policy.proxy_url = resolved;
        return policy;
    }

    if (policy.proxy_mode != ProxyMode::Manual) {
        // Left empty deliberately: a stored URL that no mode reads must not
        // reach a handle, or turning the mode off would still route through it.
        return policy;
    }

    const std::string url = db.get_config_string ("proxyUrl", "");
    if (const auto rejection = proxy_url_rejection (url)) {
        // Manual mode with an unusable URL is the one combination that must not
        // fail quietly: leaving it in Manual would send every request direct
        // while Settings says otherwise, which is precisely the invisible
        // failure this issue exists to end. `Off` at least means what it says,
        // and the log names the setting to fix.
        vayu::utils::log_error (
        "Config 'proxyMode' is 'manual' but 'proxyUrl' is "
        "unusable (" +
        *rejection + "); no proxy will be used until it is corrected");
        policy.proxy_mode = ProxyMode::Off;
        return policy;
    }

    policy.proxy_url = url;
    return policy;
}

} // namespace vayu::http
