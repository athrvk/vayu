/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/oauth_discovery.cpp
 * @brief OAuth 2.0 discovery for an MCP server (#3766): the challenge parser,
 *        protected resource metadata, and authorization server metadata.
 */

#include "vayu/http/oauth_discovery.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/json_depth.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/loopback_guard.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/parse.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdint>
#include <span>

namespace vayu::http {

namespace {

// ============================================================================
// The challenge grammar
// ============================================================================

/// RFC 7235 `token68`, less its trailing `=` padding.
bool is_token68_char (char c) {
    const bool alnum =
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    return alnum || std::string_view ("-._~+/").find (c) != std::string_view::npos;
}

bool is_ows (char c) {
    return c == ' ' || c == '\t';
}

/// What a quoted-string may hold, escaped or not: HTAB, SP, VCHAR, obs-text.
bool is_quotable (char c) {
    const auto byte = static_cast<unsigned char> (c);
    return c == '\t' || (byte >= 0x20 && byte != 0x7F);
}

std::string at_offset (std::string_view what, std::size_t offset) {
    return std::string (what) + " at offset " + std::to_string (offset);
}

/// A read position in one field value.
class FieldCursor {
    public:
    explicit FieldCursor (std::string_view text) : text_ (text) {
    }

    [[nodiscard]] bool at_end () const {
        return pos_ >= text_.size ();
    }
    /// The next byte, or NUL at the end (which no rule here accepts).
    [[nodiscard]] char peek () const {
        return at_end () ? '\0' : text_.at (pos_);
    }
    [[nodiscard]] std::size_t offset () const {
        return pos_;
    }
    char next () {
        const char c = peek ();
        ++pos_;
        return c;
    }
    bool consume (char c) {
        if (at_end () || peek () != c) {
            return false;
        }
        ++pos_;
        return true;
    }
    template <typename Predicate>
    std::string_view take_while (Predicate accepts) {
        const std::size_t start = pos_;
        while (!at_end () && accepts (peek ())) {
            ++pos_;
        }
        return text_.substr (start, pos_ - start);
    }
    /// Skips optional whitespace and answers how much there was.
    std::size_t skip_ows () {
        return take_while (is_ows).size ();
    }
    /// Skips what lies between list elements, empty elements included.
    void skip_list_separators () {
        take_while ([] (char c) { return is_ows (c) || c == ','; });
    }

    private:
    std::string_view text_;
    std::size_t pos_ = 0;
};

/// A token68 at the cursor, consumed with the whitespace after it, or nothing
/// and the cursor left where it was. It must end the challenge: what follows
/// is the end or a comma, which is what tells `abc==` from `name=value`.
std::optional<std::string> take_token68 (FieldCursor& cursor) {
    FieldCursor probe   = cursor;
    std::string token68 = std::string (probe.take_while (is_token68_char));
    if (token68.empty ()) {
        return std::nullopt;
    }
    token68 += probe.take_while ([] (char c) { return c == '='; });
    probe.skip_ows ();
    if (!probe.at_end () && probe.peek () != ',') {
        return std::nullopt;
    }
    cursor = probe;
    return token68;
}

/// Whether an auth-param (a token, then `=` after optional whitespace) starts
/// at @p cursor, which is a copy: the caller's position does not move.
bool param_starts_at (FieldCursor cursor) {
    if (cursor.take_while (is_token_char).empty ()) {
        return false;
    }
    cursor.skip_ows ();
    return cursor.peek () == '=';
}

/// A quoted-string at the cursor (its opening quote), unescaped.
std::expected<std::string, std::string> read_quoted_string (FieldCursor& cursor) {
    const std::size_t open = cursor.offset ();
    cursor.consume ('"');
    std::string value;
    while (!cursor.at_end ()) {
        char c = cursor.next ();
        if (c == '"') {
            return value;
        }
        if (c == '\\' && !cursor.at_end ()) {
            c = cursor.next ();
        }
        if (!is_quotable (c)) {
            return std::unexpected (at_offset (
            "a control character in a quoted-string", cursor.offset () - 1));
        }
        value.push_back (c);
    }
    return std::unexpected (at_offset ("an unterminated quoted-string", open));
}

std::expected<std::pair<std::string, std::string>, std::string> read_param (
FieldCursor& cursor) {
    std::string name = std::string (cursor.take_while (is_token_char));
    cursor.skip_ows ();
    if (name.empty () || !cursor.consume ('=')) {
        return std::unexpected (
        at_offset ("expected a parameter name and '='", cursor.offset ()));
    }
    cursor.skip_ows ();
    if (cursor.peek () == '"') {
        auto quoted = read_quoted_string (cursor);
        if (!quoted) {
            return std::unexpected (quoted.error ());
        }
        return std::pair{ std::move (name), std::move (*quoted) };
    }
    std::string token = std::string (cursor.take_while (is_token_char));
    if (token.empty ()) {
        return std::unexpected (
        at_offset ("parameter '" + name + "' has no value", cursor.offset ()));
    }
    return std::pair{ std::move (name), std::move (token) };
}

/// The parameters of @p challenge, up to the end of the field or the start of
/// the next challenge, where the cursor is left.
std::expected<void, std::string> read_params (FieldCursor& cursor, AuthChallenge& challenge) {
    while (true) {
        const std::size_t start = cursor.offset ();
        auto param              = read_param (cursor);
        if (!param) {
            return std::unexpected (param.error ());
        }
        if (challenge.param (param->first)) {
            return std::unexpected (
            at_offset ("parameter '" + param->first + "' repeated", start));
        }
        challenge.params.push_back (std::move (*param));
        cursor.skip_ows ();
        if (cursor.at_end ()) {
            return {};
        }
        if (!cursor.consume (',')) {
            return std::unexpected (
            at_offset ("expected ',' after a parameter", cursor.offset ()));
        }
        cursor.skip_list_separators ();
        if (cursor.at_end () || !param_starts_at (cursor)) {
            return {};
        }
    }
}

std::expected<AuthChallenge, std::string> read_challenge (FieldCursor& cursor) {
    const std::size_t start = cursor.offset ();
    AuthChallenge challenge;
    challenge.scheme = std::string (cursor.take_while (is_token_char));
    if (challenge.scheme.empty ()) {
        return std::unexpected (at_offset ("expected an auth-scheme", start));
    }
    const std::size_t spaces = cursor.skip_ows ();
    if (cursor.at_end () || cursor.peek () == ',') {
        return challenge;
    }
    if (spaces == 0) {
        return std::unexpected (
        at_offset ("expected a space after the auth-scheme", cursor.offset ()));
    }
    if (auto token68 = take_token68 (cursor)) {
        challenge.token68 = std::move (*token68);
        return challenge;
    }
    if (auto params = read_params (cursor, challenge); !params) {
        return std::unexpected (params.error ());
    }
    return challenge;
}

// ============================================================================
// URLs
// ============================================================================

/// An absolute `http` or `https` URL that names a host.
bool is_http_url (const std::string& url) {
    const std::string_view scheme = url_scheme (url);
    if (!utils::ascii_lower_equal (scheme, "http") &&
    !utils::ascii_lower_equal (scheme, "https")) {
        return false;
    }
    const UrlParts parts = parse_url_parts (url);
    return parts.parsed && !join_host (parts.host).empty ();
}

/// A URL as the well-known rules split it: everything up to the end of the
/// authority, the path with any trailing `/` removed (RFC 8414 section 3.1),
/// and the query without its `?`. The fragment is dropped.
struct UrlLocation {
    std::string origin;
    std::string path;
    std::string query;
};

std::optional<UrlLocation> locate (const std::string& url) {
    const auto span = url_host_span (url);
    if (!span) {
        return std::nullopt;
    }
    std::string_view rest = std::string_view (url).substr (span->authority_end);
    rest                  = rest.substr (0, rest.find ('#'));
    const std::size_t question = rest.find ('?');
    std::string_view path      = rest.substr (0, question);
    while (path.ends_with ('/')) {
        path.remove_suffix (1);
    }
    return UrlLocation{ url.substr (0, span->authority_end), std::string (path),
        question == std::string_view::npos ? "" : std::string (rest.substr (question + 1)) };
}

/// RFC 9728 section 3.1, in the MCP spec's order: the well-known path with the
/// server URL's path and query inserted after it, then the bare one.
std::vector<std::string> protected_resource_metadata_urls (const UrlLocation& server) {
    const std::string root =
    server.origin + std::string (oauth_discovery::PROTECTED_RESOURCE_WELL_KNOWN);
    std::string inserted = root + server.path;
    if (!server.query.empty ()) {
        inserted += "?" + server.query;
    }
    if (inserted == root) {
        return { root };
    }
    return { inserted, root };
}

/// RFC 8414 section 3.1 and OpenID Connect Discovery, in the MCP spec's order.
std::vector<std::string> authorization_server_metadata_urls (const UrlLocation& issuer) {
    const std::string oauth = std::string (oauth_discovery::AUTHORIZATION_SERVER_WELL_KNOWN);
    const std::string openid =
    std::string (oauth_discovery::OPENID_CONFIGURATION_WELL_KNOWN);
    if (issuer.path.empty ()) {
        return { issuer.origin + oauth, issuer.origin + openid };
    }
    return { issuer.origin + oauth + issuer.path,
        issuer.origin + openid + issuer.path, issuer.origin + issuer.path + openid };
}

/// Where an issuer identifier's metadata lives, or nullopt when it is not an
/// `http` or `https` URL free of a query and fragment (RFC 8414 section 2).
std::optional<UrlLocation> issuer_location (const std::string& issuer) {
    if (!is_http_url (issuer) || issuer.find_first_of ("?#") != std::string::npos) {
        return std::nullopt;
    }
    return locate (issuer);
}

/// Whether @p url names a loopback or link-local host: what an empty
/// `LocalPeerRule`, which names no source, refuses by the URL's text.
bool names_local_host (const std::string& url) {
    return is_refused_reference_url (url, LocalPeerRule{});
}

int effective_port (const UrlParts& parts) {
    if (const auto port = utils::parse_number<int> (parts.port)) {
        return *port;
    }
    return utils::ascii_lower_equal (parts.protocol, "https") ? 443 : 80;
}

bool same_origin (const UrlParts& a, const UrlParts& b) {
    const auto host_a = canonical_host (join_host (a.host));
    const auto host_b = canonical_host (join_host (b.host));
    return host_a && host_b && *host_a == *host_b &&
    utils::ascii_lower_equal (a.protocol, b.protocol) &&
    effective_port (a) == effective_port (b);
}

/// The path segments with the empty ones a trailing `/` leaves removed, so
/// `/`, `/mcp` and `/mcp/` compare by what they name.
std::span<const std::string> named_segments (const std::vector<std::string>& path) {
    std::span<const std::string> segments (path);
    while (!segments.empty () && segments.back ().empty ()) {
        segments = segments.first (segments.size () - 1);
    }
    return segments;
}

// ============================================================================
// Fetching
// ============================================================================

OAuthDiscoveryError discovery_error (std::string_view code, std::string message) {
    return OAuthDiscoveryError{ std::string (code), std::move (message) };
}

std::unexpected<OAuthDiscoveryError> refuse (std::string_view code, std::string message) {
    return std::unexpected (discovery_error (code, std::move (message)));
}

vayu::http::ClientConfig discovery_client_config (vayu::db::Database& db,
const std::atomic<bool>* cancel,
bool local_server) {
    vayu::http::ClientConfig config;
    config.transport = resolve_transport_policy (db);
    config.cancel    = cancel;
    config.max_response_bytes = vayu::core::constants::http::MAX_PARSED_RESPONSE_BODY_BYTES;
    if (!local_server) {
        config.local_peer_rule = LocalPeerRule{};
    }
    return config;
}

/// One discovery's fetches: one client, one deadline, one local-host rule.
class DiscoverySession {
    public:
    DiscoverySession (vayu::db::Database& db,
    const std::string& server_url,
    UrlLocation server_location,
    int timeout_ms,
    const std::atomic<bool>* cancel)
    : server_url_ (server_url), server_location_ (std::move (server_location)),
      local_server_ (names_local_host (server_url)), timeout_ms_ (timeout_ms),
      deadline_ (std::chrono::steady_clock::now () + std::chrono::milliseconds (timeout_ms)),
      cancel_ (cancel), client_ (discovery_client_config (db, cancel, local_server_)) {
    }

    [[nodiscard]] const std::string& server_url () const {
        return server_url_;
    }

    [[nodiscard]] const UrlLocation& server_location () const {
        return server_location_;
    }

    /// Whether the fetches run under the `LocalPeerRule`.
    [[nodiscard]] bool peer_rule_applies () const {
        return !local_server_;
    }

    /// The refusal of @p url, which a document named as @p what, when the
    /// server is not on this machine and @p url is.
    [[nodiscard]] std::optional<OAuthDiscoveryError>
    refuse_local (std::string_view what, const std::string& url) const {
        if (!detail::is_refused_local_endpoint (server_url_, url)) {
            return std::nullopt;
        }
        return discovery_error (oauth_discovery::LOCAL_ENDPOINT_REFUSED,
        std::string (what) + " " + url +
        " is a loopback or link-local address, which a server that is not on "
        "this machine may not name");
    }

    /// An unauthenticated GET of @p url, answered whatever its status.
    std::expected<vayu::Response, OAuthDiscoveryError> get (const std::string& url) {
        if (cancel_ != nullptr && cancel_->load (std::memory_order_acquire)) {
            // libcurl reads the flag only at its first progress tick, which a
            // fast server answers before: a stopping server must not fetch.
            return refuse (oauth_discovery::NETWORK_ERROR,
            "OAuth discovery was cancelled before fetching " + url);
        }
        const int remaining_ms = this->remaining_ms ();
        if (remaining_ms <= 0) {
            // Never handed to curl, which reads a zero timeout as no bound.
            return refuse (oauth_discovery::TIMEOUT, timed_out (url));
        }
        vayu::Request request;
        request.method            = vayu::HttpMethod::GET;
        request.url               = url;
        request.timeout_ms        = remaining_ms;
        request.headers["Accept"] = "application/json";
        auto result               = client_.send (request);
        if (!result.is_ok ()) {
            return transport_failure (result.error ().code, result.error ().message, url);
        }
        vayu::Response response = std::move (result).value ();
        if (response.has_error ()) {
            return transport_failure (response.error_code, response.error_message, url);
        }
        return response;
    }

    private:
    [[nodiscard]] int remaining_ms () const {
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds> (
        deadline_ - std::chrono::steady_clock::now ())
                          .count ();
        return static_cast<int> (std::max<int64_t> (left, 0));
    }

    [[nodiscard]] std::string timed_out (const std::string& url) const {
        return "OAuth discovery timed out after " +
        std::to_string (timeout_ms_) + " ms (request timeout) fetching " + url;
    }

    [[nodiscard]] std::unexpected<OAuthDiscoveryError> transport_failure (vayu::ErrorCode code,
    const std::string& detail,
    const std::string& url) const {
        if (code == vayu::ErrorCode::Timeout) {
            return refuse (oauth_discovery::TIMEOUT, timed_out (url));
        }
        return refuse (oauth_discovery::NETWORK_ERROR,
        "OAuth discovery could not fetch " + url + ": " +
        (detail.empty () ? "connection error" : detail));
    }

    std::string server_url_;
    UrlLocation server_location_;
    bool local_server_;
    int timeout_ms_;
    std::chrono::steady_clock::time_point deadline_;
    const std::atomic<bool>* cancel_;
    vayu::http::Client client_;
};

/// The `WWW-Authenticate` lines of @p response as one field value.
std::string authenticate_field (const vayu::Response& response) {
    std::string field;
    for (const HeaderLine& line : response.header_lines) {
        if (utils::ascii_lower_equal (line.name, "WWW-Authenticate")) {
            field += (field.empty () ? "" : ", ") + line.value;
        }
    }
    return field;
}

/// The Bearer challenge of a 401, or nullopt for any other answer, one with no
/// Bearer challenge and one whose field is not the RFC 9110 grammar: each of
/// those leaves the well-known paths to try.
std::optional<BearerChallenge> bearer_challenge_of (const vayu::Response& response) {
    if (response.status_code != 401) {
        return std::nullopt;
    }
    auto challenge = parse_bearer_challenge (authenticate_field (response));
    return challenge ? *challenge : std::nullopt;
}

/// A metadata document kind, for the codes and words its failures use.
struct DocumentKind {
    std::string_view label;
    std::string_view not_found_code;
    std::string_view invalid_code;
};

constexpr DocumentKind PROTECTED_RESOURCE_METADATA{
    "protected resource metadata", oauth_discovery::RESOURCE_METADATA_NOT_FOUND,
    oauth_discovery::INVALID_RESOURCE_METADATA
};
constexpr DocumentKind AUTHORIZATION_SERVER_METADATA{
    "authorization server metadata", oauth_discovery::AUTHORIZATION_SERVER_METADATA_NOT_FOUND,
    oauth_discovery::INVALID_AUTHORIZATION_SERVER_METADATA
};

struct FetchedDocument {
    std::string url;
    nlohmann::json body;
};

std::string
invalid_document (const DocumentKind& kind, const std::string& url, std::string_view why) {
    return "The " + std::string (kind.label) + " at " + url +
    " is invalid: " + std::string (why);
}

/// @p body as a JSON object no deeper than the token response's bound: the
/// parse is iterative, but a copy or `dump` of the tree is not.
std::expected<FetchedDocument, OAuthDiscoveryError>
read_document (const std::string& url, const std::string& body, const DocumentKind& kind) {
    nlohmann::json parsed = nlohmann::json::parse (body, nullptr, false);
    if (parsed.is_discarded () || !parsed.is_object ()) {
        return refuse (kind.invalid_code,
        invalid_document (kind, url, "it is not a JSON object"));
    }
    if (!vayu::core::json_within_depth (parsed, vayu::core::constants::elements::MAX_BODY_DEPTH)) {
        return refuse (kind.invalid_code, invalid_document (kind, url, "it nests too deeply"));
    }
    return FetchedDocument{ url, std::move (parsed) };
}

/// The first of @p urls that answers 200, read as @p kind. Any other status
/// moves on to the next URL; a fetch that gets no answer ends the search.
std::expected<FetchedDocument, OAuthDiscoveryError> fetch_first_document (
DiscoverySession& session,
const std::vector<std::string>& urls,
const DocumentKind& kind) {
    std::string tried;
    for (const std::string& url : urls) {
        auto response = session.get (url);
        if (!response) {
            return std::unexpected (response.error ());
        }
        if (response->status_code == 200) {
            return read_document (url, response->body, kind);
        }
        tried += (tried.empty () ? "" : ", ") + url + " answered HTTP " +
        std::to_string (response->status_code);
    }
    return refuse (kind.not_found_code,
    "No " + std::string (kind.label) + " was found: " + tried);
}

// ============================================================================
// Reading untrusted members
// ============================================================================

/// The string member @p name, "" when absent or null; any other type refuses.
std::expected<std::string, std::string>
string_member (const nlohmann::json& doc, std::string_view name) {
    const auto it = doc.find (name);
    if (it == doc.end () || it->is_null ()) {
        return "";
    }
    if (!it->is_string ()) {
        return std::unexpected ("`" + std::string (name) + "` is not a string");
    }
    return it->get<std::string> ();
}

/// The string-array member @p name, empty when absent or null.
std::expected<std::vector<std::string>, std::string>
string_array_member (const nlohmann::json& doc, std::string_view name) {
    const auto it = doc.find (name);
    if (it == doc.end () || it->is_null ()) {
        return std::vector<std::string>{};
    }
    const bool strings = it->is_array () &&
    std::ranges::all_of (
    *it, [] (const nlohmann::json& entry) { return entry.is_string (); });
    if (!strings) {
        return std::unexpected ("`" + std::string (name) + "` is not an array of strings");
    }
    return it->get<std::vector<std::string>> ();
}

/// The boolean member @p name, false when absent or null.
std::expected<bool, std::string> bool_member (const nlohmann::json& doc, std::string_view name) {
    const auto it = doc.find (name);
    if (it == doc.end () || it->is_null ()) {
        return false;
    }
    if (!it->is_boolean ()) {
        return std::unexpected ("`" + std::string (name) + "` is not a boolean");
    }
    return it->get<bool> ();
}

enum class Presence : std::uint8_t { Required, Optional };

/// The URL member @p name: an absolute `http` or `https` URL, or "" when it is
/// optional and absent.
std::expected<std::string, std::string>
url_member (const nlohmann::json& doc, std::string_view name, Presence presence) {
    auto value = string_member (doc, name);
    if (!value || (value->empty () && presence == Presence::Optional)) {
        return value;
    }
    if (value->empty ()) {
        return std::unexpected ("it has no `" + std::string (name) + "`");
    }
    if (!is_http_url (*value)) {
        return std::unexpected (
        "`" + std::string (name) + "` is not an absolute http or https URL");
    }
    return value;
}

/// Reads members into their destinations until the first one that refuses,
/// whose reason it keeps: a document reads as one flat list of members.
class MemberReader {
    public:
    template <typename T>
    void read (std::expected<T, std::string> member, T& into) {
        if (!problem_.empty ()) {
            return;
        }
        if (!member) {
            problem_ = std::move (member.error ());
            return;
        }
        into = std::move (*member);
    }
    [[nodiscard]] const std::string& problem () const {
        return problem_;
    }

    private:
    std::string problem_;
};

/// What a protected resource metadata document says that discovery uses.
struct ProtectedResource {
    std::string resource;
    std::vector<std::string> authorization_servers;
    std::vector<std::string> scopes_supported;
};

std::expected<ProtectedResource, std::string> read_protected_resource (
const nlohmann::json& doc) {
    ProtectedResource found;
    MemberReader reader;
    reader.read (string_member (doc, "resource"), found.resource);
    reader.read (string_array_member (doc, "authorization_servers"), found.authorization_servers);
    reader.read (string_array_member (doc, "scopes_supported"), found.scopes_supported);
    if (!reader.problem ().empty ()) {
        return std::unexpected (reader.problem ());
    }
    if (found.resource.empty ()) {
        return std::unexpected ("it has no `resource`");
    }
    if (found.authorization_servers.empty ()) {
        return std::unexpected ("it names no `authorization_servers`");
    }
    return found;
}

std::expected<AuthorizationServerMetadata, std::string>
read_authorization_server (const FetchedDocument& document) {
    const nlohmann::json& doc = document.body;
    AuthorizationServerMetadata metadata;
    metadata.metadata_url = document.url;
    std::string registration_endpoint;
    MemberReader reader;
    reader.read (url_member (doc, "issuer", Presence::Required), metadata.issuer);
    reader.read (url_member (doc, "authorization_endpoint", Presence::Required),
    metadata.authorization_endpoint);
    reader.read (url_member (doc, "token_endpoint", Presence::Required),
    metadata.token_endpoint);
    reader.read (url_member (doc, "registration_endpoint", Presence::Optional),
    registration_endpoint);
    reader.read (string_array_member (doc, "scopes_supported"), metadata.scopes_supported);
    reader.read (string_array_member (doc, "code_challenge_methods_supported"),
    metadata.code_challenge_methods_supported);
    reader.read (bool_member (doc, "authorization_response_iss_parameter_supported"),
    metadata.authorization_response_iss_parameter_supported);
    if (!reader.problem ().empty ()) {
        return std::unexpected (reader.problem ());
    }
    if (!registration_endpoint.empty ()) {
        metadata.registration_endpoint = std::move (registration_endpoint);
    }
    return metadata;
}

// ============================================================================
// The steps
// ============================================================================

/// Where the protected resource metadata is, and that document: the URL a
/// 401's Bearer challenge names, else the first well-known URL that answers.
std::expected<FetchedDocument, OAuthDiscoveryError>
locate_protected_resource (DiscoverySession& session, OAuthDiscovery& found) {
    auto probe = session.get (session.server_url ());
    if (!probe) {
        return std::unexpected (probe.error ());
    }
    const std::optional<BearerChallenge> challenge = bearer_challenge_of (*probe);
    const std::optional<std::string> named =
    challenge ? challenge->resource_metadata : std::nullopt;
    if (challenge) {
        found.challenge_scope = challenge->scope;
    }
    if (!named) {
        return fetch_first_document (session,
        protected_resource_metadata_urls (session.server_location ()),
        PROTECTED_RESOURCE_METADATA);
    }
    if (!is_http_url (*named)) {
        return refuse (oauth_discovery::INVALID_CHALLENGE,
        "The 401 challenge's `resource_metadata` " + *named + " is not an absolute http or https URL");
    }
    if (auto refusal =
        session.refuse_local ("The 401 challenge's `resource_metadata`", *named)) {
        return std::unexpected (std::move (*refusal));
    }
    found.resource_metadata_from_challenge = true;
    return fetch_first_document (session, { *named }, PROTECTED_RESOURCE_METADATA);
}

/// A protected resource metadata document discovery may follow, and the
/// issuer it names.
struct AcceptedResource {
    ProtectedResource document;
    std::string issuer;
    UrlLocation issuer_location;
};

std::expected<AcceptedResource, OAuthDiscoveryError>
accept_protected_resource (const DiscoverySession& session, const FetchedDocument& fetched) {
    auto document = read_protected_resource (fetched.body);
    if (!document) {
        return refuse (oauth_discovery::INVALID_RESOURCE_METADATA,
        invalid_document (PROTECTED_RESOURCE_METADATA, fetched.url, document.error ()));
    }
    if (!detail::resource_covers (document->resource, session.server_url ())) {
        return refuse (oauth_discovery::RESOURCE_MISMATCH,
        "The protected resource metadata at " + fetched.url + " is for " +
        document->resource + ", which does not cover " + session.server_url () +
        " (RFC 9728 section 3.3)");
    }
    // The first: the MCP spec leaves the choice among several to the client.
    std::string issuer = document->authorization_servers.front ();
    auto location      = issuer_location (issuer);
    if (!location) {
        return refuse (oauth_discovery::INVALID_RESOURCE_METADATA,
        invalid_document (PROTECTED_RESOURCE_METADATA, fetched.url,
        "its authorization server " + issuer +
        " is not an http or https URL free of a query and fragment"));
    }
    if (auto refusal = session.refuse_local ("The authorization server", issuer)) {
        return std::unexpected (std::move (*refusal));
    }
    return AcceptedResource{ std::move (*document), std::move (issuer),
        std::move (*location) };
}

/// The metadata of @p resource's issuer, from @p cache or fetched and then
/// kept there once its `issuer` is the one it was fetched for.
std::expected<AuthorizationServerMetadata, OAuthDiscoveryError>
authorization_server_metadata (DiscoverySession& session,
const AcceptedResource& resource,
AuthorizationServerMetadataCache& cache) {
    const std::string& issuer = resource.issuer;
    if (auto cached = cache.find (issuer, session.peer_rule_applies ())) {
        return std::move (*cached);
    }
    auto fetched = fetch_first_document (session,
    authorization_server_metadata_urls (resource.issuer_location),
    AUTHORIZATION_SERVER_METADATA);
    if (!fetched) {
        return std::unexpected (std::move (fetched.error ()));
    }
    auto metadata = read_authorization_server (*fetched);
    if (!metadata) {
        return refuse (oauth_discovery::INVALID_AUTHORIZATION_SERVER_METADATA,
        invalid_document (AUTHORIZATION_SERVER_METADATA, fetched->url, metadata.error ()));
    }
    if (metadata->issuer != issuer) {
        return refuse (oauth_discovery::ISSUER_MISMATCH,
        "The authorization server metadata at " + fetched->url +
        " names the issuer " + metadata->issuer + ", not " + issuer +
        ", the issuer it was fetched for (RFC 8414 section 3.3)");
    }
    cache.store (*metadata, session.peer_rule_applies ());
    return std::move (*metadata);
}

std::string listed_methods (const std::vector<std::string>& methods) {
    if (methods.empty ()) {
        return "it lists none";
    }
    std::string listed = "it lists ";
    std::string_view separator;
    for (const std::string& method : methods) {
        listed += separator;
        listed += method;
        separator = ", ";
    }
    return listed;
}

/// What refuses a discovered authorization server whatever the cache held:
/// no PKCE with S256, or an endpoint the local-host rule refuses.
std::optional<OAuthDiscoveryError> refuse_authorization_server (const DiscoverySession& session,
const AuthorizationServerMetadata& metadata) {
    if (!std::ranges::contains (metadata.code_challenge_methods_supported,
        oauth_discovery::PKCE_METHOD)) {
        return discovery_error (oauth_discovery::PKCE_UNSUPPORTED,
        "The authorization server " + metadata.issuer +
        " does not list S256 in `code_challenge_methods_supported` (" +
        listed_methods (metadata.code_challenge_methods_supported) +
        "), and the MCP authorization spec requires PKCE with S256");
    }
    std::vector<std::pair<std::string_view, const std::string*>> endpoints{
        { "Its authorization_endpoint", &metadata.authorization_endpoint },
        { "Its token_endpoint", &metadata.token_endpoint },
    };
    if (const auto& registration = metadata.registration_endpoint) {
        endpoints.emplace_back ("Its registration_endpoint", &*registration);
    }
    for (const auto& [what, url] : endpoints) {
        if (auto refusal = session.refuse_local (what, *url)) {
            return refusal;
        }
    }
    return std::nullopt;
}

} // namespace

// ============================================================================
// Public surface
// ============================================================================

std::optional<std::string> AuthChallenge::param (std::string_view name) const {
    const auto found = std::ranges::find_if (params, [name] (const auto& param) {
        return utils::ascii_lower_equal (param.first, name);
    });
    if (found == params.end ()) {
        return std::nullopt;
    }
    return found->second;
}

std::expected<std::vector<AuthChallenge>, std::string> parse_auth_challenges (
std::string_view field_value) {
    FieldCursor cursor (field_value);
    std::vector<AuthChallenge> challenges;
    cursor.skip_list_separators ();
    while (!cursor.at_end ()) {
        auto challenge = read_challenge (cursor);
        if (!challenge) {
            return std::unexpected (std::move (challenge.error ()));
        }
        challenges.push_back (std::move (*challenge));
        cursor.skip_list_separators ();
    }
    return challenges;
}

std::expected<std::optional<BearerChallenge>, std::string>
parse_bearer_challenge (std::string_view field_value) {
    auto challenges = parse_auth_challenges (field_value);
    if (!challenges) {
        return std::unexpected (std::move (challenges.error ()));
    }
    const auto bearer =
    std::ranges::find_if (*challenges, [] (const AuthChallenge& challenge) {
        return utils::ascii_lower_equal (challenge.scheme, "Bearer");
    });
    if (bearer == challenges->end ()) {
        return std::optional<BearerChallenge>{};
    }
    return BearerChallenge{ bearer->param ("resource_metadata"), bearer->param ("scope"),
        bearer->param ("error"), bearer->param ("error_description") };
}

AuthorizationServerMetadataCache::AuthorizationServerMetadataCache (Clock clock)
: clock_ (std::move (clock)) {
}

std::optional<AuthorizationServerMetadata>
AuthorizationServerMetadataCache::find (const std::string& issuer, bool needs_peer_rule) {
    const std::lock_guard<std::mutex> lock (mutex_);
    const auto found = entries_.find (issuer);
    if (found == entries_.end ()) {
        return std::nullopt;
    }
    const Entry& entry = found->second;
    const bool expired = clock_ () - entry.stored_at >= oauth_discovery::CACHE_TTL;
    if (expired || (needs_peer_rule && !entry.fetched_with_peer_rule)) {
        return std::nullopt;
    }
    return entry.metadata;
}

void AuthorizationServerMetadataCache::store (const AuthorizationServerMetadata& metadata,
bool fetched_with_peer_rule) {
    const std::lock_guard<std::mutex> lock (mutex_);
    const auto now = clock_ ();
    std::erase_if (entries_, [now] (const auto& entry) {
        return now - entry.second.stored_at >= oauth_discovery::CACHE_TTL;
    });
    entries_.insert_or_assign (
    metadata.issuer, Entry{ metadata, now, fetched_with_peer_rule });
    while (entries_.size () > oauth_discovery::MAX_CACHED_SERVERS) {
        entries_.erase (std::ranges::min_element (entries_, {},
        [] (const auto& entry) { return entry.second.stored_at; }));
    }
}

AuthorizationServerMetadataCache& shared_authorization_server_cache () {
    static AuthorizationServerMetadataCache cache;
    return cache;
}

OAuthDiscoveryResult discover_oauth_server (vayu::db::Database& db,
const std::string& server_url,
int timeout_ms,
const std::atomic<bool>* cancel,
AuthorizationServerMetadataCache& cache) {
    auto server_location = is_http_url (server_url) ? locate (server_url) : std::nullopt;
    if (!server_location) {
        return refuse (oauth_discovery::INVALID_SERVER_URL,
        "OAuth discovery needs an absolute http or https server URL, not '" + server_url + "'");
    }
    DiscoverySession session (
    db, server_url, std::move (*server_location), timeout_ms, cancel);
    OAuthDiscovery found;
    auto fetched = locate_protected_resource (session, found);
    if (!fetched) {
        return std::unexpected (std::move (fetched.error ()));
    }
    found.resource_metadata_url = fetched->url;
    auto resource               = accept_protected_resource (session, *fetched);
    if (!resource) {
        return std::unexpected (std::move (resource.error ()));
    }
    auto metadata = authorization_server_metadata (session, *resource, cache);
    if (!metadata) {
        return std::unexpected (std::move (metadata.error ()));
    }
    if (auto refusal = refuse_authorization_server (session, *metadata)) {
        return std::unexpected (std::move (*refusal));
    }
    found.resource = std::move (resource->document.resource);
    found.resource_scopes_supported = std::move (resource->document.scopes_supported);
    found.authorization_server = std::move (*metadata);
    return found;
}

bool detail::resource_covers (const std::string& resource, const std::string& server_url) {
    const UrlParts claimed = parse_url_parts (resource);
    const UrlParts server  = parse_url_parts (server_url);
    if (!claimed.parsed || !server.parsed || !claimed.hash.empty () ||
    !same_origin (claimed, server)) {
        return false;
    }
    const auto claimed_path = named_segments (claimed.path);
    const auto server_path  = named_segments (server.path);
    if (claimed_path.size () > server_path.size () ||
    !std::ranges::equal (claimed_path, server_path.first (claimed_path.size ()))) {
        return false;
    }
    return claimed.query.empty () ||
    (claimed.query == server.query && claimed_path.size () == server_path.size ());
}

bool detail::is_refused_local_endpoint (const std::string& server_url,
const std::string& endpoint_url) {
    return names_local_host (endpoint_url) && !names_local_host (server_url);
}

} // namespace vayu::http
