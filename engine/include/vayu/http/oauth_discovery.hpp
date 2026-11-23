#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/oauth_discovery.hpp
 * @brief Where an MCP server's OAuth 2.0 authorization server is and what it
 *        supports (#3766), found the way the MCP authorization spec orders it.
 *
 * 1. An unauthenticated `GET` of the server URL. A 401 whose `Bearer`
 *    challenge names `resource_metadata` says where the protected resource
 *    metadata (RFC 9728) is. Otherwise it is looked for at
 *    `/.well-known/oauth-protected-resource` with the server URL's path
 *    inserted after it, then at the bare well-known path.
 * 2. That document's `resource` must cover the server URL (the same origin, a
 *    path that is the server's or a whole-segment prefix of it), and the first
 *    of its `authorization_servers` is the issuer used.
 * 3. The issuer's metadata is read from the first of
 *    `/.well-known/oauth-authorization-server` (RFC 8414) and
 *    `/.well-known/openid-configuration` (OpenID Connect Discovery), each with
 *    the issuer's path inserted, then the issuer's path with
 *    `/.well-known/openid-configuration` appended, that answers 200. Its
 *    `issuer` must be the issuer exactly (RFC 8414 section 3.3), and it must
 *    list `S256` in `code_challenge_methods_supported`: the MCP spec reads an
 *    absent list as "no PKCE" and the client refuses.
 *
 * Every fetch goes through `Client` under `resolve_transport_policy`, one
 * deadline for the whole discovery, a body bound and the caller's cancel.
 * Every fetched document is untrusted: each member read is type-checked, and
 * a member of the wrong type refuses the document rather than being skipped.
 *
 * **A local endpoint needs a local server.** When the server URL names
 * neither a loopback nor a link-local host, every fetch runs under an empty
 * `LocalPeerRule` (refusing a loopback or link-local peer, by URL and by the
 * address connected to), and a document that names such a URL (a
 * `resource_metadata`, an issuer, an endpoint) is refused. A server on this
 * machine may name anything on it; the Client's reserved-port guard still
 * holds every fetch off Vayu's own ports.
 */

#include <atomic>
#include <chrono>
#include <cstddef>
#include <expected>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::db {
class Database;
} // namespace vayu::db

namespace vayu::http {

// ============================================================================
// Authentication challenges (RFC 9110 section 11.6.1)
// ============================================================================

/// One challenge of a `WWW-Authenticate` field: a scheme and either a
/// `token68` or a list of parameters, never both.
struct AuthChallenge {
    /// As written; compare it case-insensitively.
    std::string scheme;
    /// Empty when the challenge carries parameters or nothing.
    std::string token68;
    /// In field order, each name as written and each value with its quoting
    /// removed. No name appears twice (RFC 9110 section 11.2).
    std::vector<std::pair<std::string, std::string>> params;

    /// The value of the parameter named @p name in any case, or nullopt.
    [[nodiscard]] std::optional<std::string> param (std::string_view name) const;
};

/**
 * @brief The challenges of one `WWW-Authenticate` field value, in order.
 *
 * Several header lines are one field joined by `", "`. Empty list elements are
 * skipped, as RFC 9110 section 5.6.1.2 asks of a recipient. A parameter value
 * is a token or a quoted-string, whose quoted-pairs are unescaped.
 *
 * @return why the text is not that grammar, naming the byte offset, when it
 *         is not: a parameter with no value, an unterminated quoted-string, a
 *         repeated parameter name, a scheme followed by anything but
 *         whitespace, a comma or the end.
 */
[[nodiscard]] std::expected<std::vector<AuthChallenge>, std::string>
parse_auth_challenges (std::string_view field_value);

/// The parameters of a `Bearer` challenge that OAuth discovery and step-up
/// read (RFC 6750 section 3, RFC 9728 section 5.1). Absent and empty differ.
struct BearerChallenge {
    std::optional<std::string> resource_metadata;
    std::optional<std::string> scope;
    std::optional<std::string> error;
    std::optional<std::string> error_description;
};

/**
 * @brief The first `Bearer` challenge (scheme compared case-insensitively) of
 *        @p field_value, nullopt when it has none, or why the field is not
 *        `parse_auth_challenges`' grammar.
 */
[[nodiscard]] std::expected<std::optional<BearerChallenge>, std::string>
parse_bearer_challenge (std::string_view field_value);

/// What the `WWW-Authenticate` lines of a 401 or 403 say about the token that
/// was sent (RFC 6750 section 3.1), for a client deciding whether a wider
/// token would help.
struct StepUp {
    /// True only for a `Bearer` challenge whose `error` is `insufficient_scope`.
    bool step_up = false;
    /// The challenge's `error` as written (`invalid_token` and any other
    /// included, which are not a step-up); empty when it carries none.
    std::string error;
    /// The challenge's `scope`, split on whitespace and deduplicated in the
    /// order written. Empty unless `step_up`.
    std::vector<std::string> required_scopes;
    /// The scopes already held, then the required ones not among them, space
    /// joined: what a re-authorization asks for. Empty unless `step_up`.
    std::string scope;
    /// The challenge's `error_description`, empty when absent.
    std::string description;
};

/**
 * @brief Classifies the `WWW-Authenticate` field values of one response.
 *
 * Reads the first `Bearer` challenge that names an `error` across
 * @p www_authenticate, in order; a value that is not
 * `parse_auth_challenges`' grammar is passed over, so it never makes the
 * answer a step-up. `error` is compared exactly: RFC 6750 error codes are
 * case-sensitive. A step-up whose challenge names no `scope` keeps
 * `required_scopes` empty and `scope` equal to the held ones.
 *
 * Pure: it retries nothing and makes no network call.
 *
 * @param current_scope the scopes already requested or granted, space
 *        separated; may be empty.
 */
[[nodiscard]] StepUp classify_bearer_challenge (const std::vector<std::string>& www_authenticate,
std::string_view current_scope);

// ============================================================================
// Discovery
// ============================================================================

namespace oauth_discovery {

/// How long an authorization server's metadata is reused: short, so a server
/// that changed its endpoints is seen within minutes.
constexpr std::chrono::milliseconds CACHE_TTL{ std::chrono::minutes (5) };
/// Issuers whose metadata is kept at once; the oldest is dropped past it.
constexpr std::size_t MAX_CACHED_SERVERS = 32;

/// The PKCE method a discovered authorization server must advertise.
constexpr std::string_view PKCE_METHOD = "S256";

/// RFC 9728 section 3.1.
constexpr std::string_view PROTECTED_RESOURCE_WELL_KNOWN =
"/.well-known/oauth-protected-resource";
/// RFC 8414 section 3.1.
constexpr std::string_view AUTHORIZATION_SERVER_WELL_KNOWN =
"/.well-known/oauth-authorization-server";
/// OpenID Connect Discovery 1.0 section 4.
constexpr std::string_view OPENID_CONFIGURATION_WELL_KNOWN =
"/.well-known/openid-configuration";

// The stable `OAuthDiscoveryError::code` values.

/// The server URL is not an absolute `http` or `https` URL with a host.
constexpr std::string_view INVALID_SERVER_URL =
"oauth_discovery_invalid_server_url";
/// A fetch got no HTTP answer: unreachable, refused, cancelled, or a body
/// past the bound.
constexpr std::string_view NETWORK_ERROR = "oauth_discovery_network_error";
/// The discovery's deadline ran out.
constexpr std::string_view TIMEOUT = "oauth_discovery_timeout";
/// The 401's `Bearer` challenge names a `resource_metadata` that is not an
/// absolute `http` or `https` URL.
constexpr std::string_view INVALID_CHALLENGE =
"oauth_discovery_invalid_challenge";
/// No protected resource metadata URL answered 200.
constexpr std::string_view RESOURCE_METADATA_NOT_FOUND =
"oauth_discovery_resource_metadata_not_found";
/// The protected resource metadata is not a JSON object, lacks `resource`
/// or `authorization_servers`, or has a member of the wrong type.
constexpr std::string_view INVALID_RESOURCE_METADATA =
"oauth_discovery_invalid_resource_metadata";
/// The metadata's `resource` does not cover the server URL (RFC 9728 3.3).
constexpr std::string_view RESOURCE_MISMATCH =
"oauth_discovery_resource_mismatch";
/// No authorization server metadata URL answered 200.
constexpr std::string_view AUTHORIZATION_SERVER_METADATA_NOT_FOUND =
"oauth_discovery_authorization_server_metadata_not_found";
/// The authorization server metadata is not a JSON object, lacks a required
/// member, or has a member of the wrong type.
constexpr std::string_view INVALID_AUTHORIZATION_SERVER_METADATA =
"oauth_discovery_invalid_authorization_server_metadata";
/// The metadata's `issuer` is not the issuer it was fetched for (RFC 8414
/// section 3.3).
constexpr std::string_view ISSUER_MISMATCH = "oauth_discovery_issuer_mismatch";
/// The authorization server does not list `S256` in
/// `code_challenge_methods_supported`, or lists nothing.
constexpr std::string_view PKCE_UNSUPPORTED =
"oauth_discovery_pkce_unsupported";
/// A document for a server that is not on this machine names a loopback or
/// link-local URL.
constexpr std::string_view LOCAL_ENDPOINT_REFUSED =
"oauth_discovery_local_endpoint_refused";

} // namespace oauth_discovery

/// Why discovery stopped: one of the `oauth_discovery` codes and a sentence
/// naming the URL or member at fault.
struct OAuthDiscoveryError {
    std::string code;
    std::string message;
};

/// What an authorization server's metadata says, read from RFC 8414 or
/// OpenID Connect discovery.
struct AuthorizationServerMetadata {
    std::string issuer;
    std::string authorization_endpoint;
    std::string token_endpoint;
    /// Absent when the server offers no dynamic client registration.
    std::optional<std::string> registration_endpoint;
    std::vector<std::string> code_challenge_methods_supported;
    /// RFC 9207: the server sends `iss` on its authorization response.
    bool authorization_response_iss_parameter_supported = false;
};

/// What discovery found for one MCP server URL.
struct OAuthDiscovery {
    /// The protected resource metadata's `resource`, which covers the server
    /// URL: the RFC 8707 `resource` the authorize and token requests send.
    std::string resource;
    /// The 401 challenge's `scope`, when it stated one.
    std::optional<std::string> challenge_scope;
    /// The protected resource metadata's `scopes_supported`.
    std::vector<std::string> resource_scopes_supported;
    AuthorizationServerMetadata authorization_server;
};

using OAuthDiscoveryResult = std::expected<OAuthDiscovery, OAuthDiscoveryError>;

/**
 * @brief Authorization server metadata by issuer, for `CACHE_TTL`.
 *
 * Holds only metadata that passed the issuer check; the PKCE and local
 * endpoint checks run on every discovery, cached or not, because the second
 * depends on the server being discovered. An entry fetched without the
 * `LocalPeerRule` (for a server on this machine) is not answered to a
 * discovery that needs the rule, so a name that resolved to loopback then is
 * not trusted for a remote server now. Thread-safe.
 */
class AuthorizationServerMetadataCache {
    public:
    using Clock = std::function<std::chrono::steady_clock::time_point ()>;

    /// @p clock reads the time entries are stamped and expired by; a test
    /// passes one it advances.
    explicit AuthorizationServerMetadataCache (
    Clock clock = [] { return std::chrono::steady_clock::now (); });

    /// The unexpired metadata for @p issuer, or nullopt. @p needs_peer_rule
    /// refuses an entry that was fetched without the `LocalPeerRule`.
    [[nodiscard]] std::optional<AuthorizationServerMetadata>
    find (const std::string& issuer, bool needs_peer_rule);

    /// Keeps @p metadata under its `issuer`, recording whether the fetch ran
    /// under the `LocalPeerRule`. Drops expired entries, then the oldest while
    /// past `MAX_CACHED_SERVERS`.
    void store (const AuthorizationServerMetadata& metadata, bool fetched_with_peer_rule);

    private:
    struct Entry {
        AuthorizationServerMetadata metadata;
        std::chrono::steady_clock::time_point stored_at;
        bool fetched_with_peer_rule = false;
    };

    Clock clock_;
    std::mutex mutex_;
    std::map<std::string, Entry, std::less<>> entries_;
};

/// The cache every discovery shares unless a test passes its own.
AuthorizationServerMetadataCache& shared_authorization_server_cache ();

/**
 * @brief Discover the OAuth 2.0 authorization server protecting the MCP
 *        server at @p server_url (see the file comment for the order).
 *
 * The probe asks for `application/json` rather than `text/event-stream`, so
 * a Streamable HTTP server that needs no token answers it (a 405 or 406)
 * instead of opening a stream that would hold the request to its deadline.
 *
 * @param timeout_ms one deadline for every fetch the discovery makes.
 * @param cancel `ClientConfig::cancel` for each fetch; null when nothing
 *        outside the call ends it.
 */
[[nodiscard]] OAuthDiscoveryResult discover_oauth_server (vayu::db::Database& db,
const std::string& server_url,
int timeout_ms,
const std::atomic<bool>* cancel         = nullptr,
AuthorizationServerMetadataCache& cache = shared_authorization_server_cache ());

namespace detail {

/// Whether @p resource covers @p server_url (RFC 9728 section 3.3): the same
/// scheme, host and port, no fragment, and a path equal to the server URL's
/// or a prefix of it ending at a segment boundary. A resource with a query
/// covers only the server URL with that query and that path.
[[nodiscard]] bool resource_covers (const std::string& resource, const std::string& server_url);

/// Whether a document found for @p server_url may not name @p endpoint_url:
/// the endpoint names a loopback or link-local host and the server does not.
[[nodiscard]] bool is_refused_local_endpoint (const std::string& server_url,
const std::string& endpoint_url);

} // namespace detail

} // namespace vayu::http
