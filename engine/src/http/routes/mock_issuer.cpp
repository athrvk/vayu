/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The local OAuth 2.0 mock issuer: manager, spawned listener and the
 * `/mock-issuer` lifecycle routes. With the routes, as `oauth_authorize.cpp`
 * is, because the listener needs httplib, linked into the engine and the test
 * binary but not into `vayu_core`.
 */

#include "vayu/http/mock_issuer.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/http/managed_listener.hpp"
#include "vayu/http/oauth_discovery.hpp"
#include "vayu/http/pkce.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/sha256.hpp"
#include "vayu/utils/stop_signal.hpp"

#include <httplib.h>
#include <sodium.h>

#include <algorithm>
#include <chrono>
#include <expected>
#include <map>
#include <mutex>
#include <optional>
#include <span>
#include <string_view>

namespace vayu::http {

namespace mi = vayu::core::constants::mock_issuer;

namespace {

/// What a malformed `/mock-issuer` body or settings value answers with.
constexpr std::string_view INVALID_CONFIG_CODE = "mock_issuer_invalid_config";

int64_t now_ms () {
    return vayu::http::routes::now_ms ();
}

// ---------------------------------------------------------------------------
// Payload reading
// ---------------------------------------------------------------------------

/**
 * Read an integer field. Absent leaves @p out alone; present with a non-integer
 * type or outside [min,max] is an error, never a silent fallback to the default.
 */
bool read_int (const nlohmann::json& body,
const char* key,
int64_t min,
int64_t max,
int64_t& out,
std::string& error) {
    const auto it = body.find (key);
    if (it == body.end () || it->is_null ()) {
        return true;
    }
    if (!it->is_number_integer ()) {
        error = std::string (key) + " must be an integer";
        return false;
    }
    const auto value = it->get<int64_t> ();
    if (value < min || value > max) {
        error = std::string (key) + " must be between " + std::to_string (min) +
        " and " + std::to_string (max);
        return false;
    }
    out = value;
    return true;
}

bool read_bool (const nlohmann::json& body, const char* key, bool& out, std::string& error) {
    const auto it = body.find (key);
    if (it == body.end () || it->is_null ()) {
        return true;
    }
    if (!it->is_boolean ()) {
        error = std::string (key) + " must be a boolean";
        return false;
    }
    out = it->get<bool> ();
    return true;
}

bool read_failure_mode (const nlohmann::json& body, std::string& out, std::string& error) {
    const auto it = body.find ("failureMode");
    if (it == body.end () || it->is_null ()) {
        return true;
    }
    if (!it->is_string ()) {
        error = "failureMode must be a string";
        return false;
    }
    const auto mode = it->get<std::string> ();
    if (!std::ranges::contains (MOCK_ISSUER_FAILURE_MODES, mode)) {
        error                      = "failureMode must be one of";
        std::string_view separator = " ";
        for (const std::string_view known : MOCK_ISSUER_FAILURE_MODES) {
            error += separator;
            error += known;
            separator = ", ";
        }
        return false;
    }
    out = mode;
    return true;
}

/// RFC 6749 section 3.3 `scope-token`: any visible ASCII but `"` and `\`,
/// which is also what keeps the scope safe inside a challenge's quoted-string.
bool is_scope_token_char (char c) {
    return c == '\x21' || (c >= '\x23' && c <= '\x5B') || (c >= '\x5D' && c <= '\x7E');
}

/// Whether @p scope is scope-tokens joined by single spaces (RFC 6749 3.3).
bool is_scope (std::string_view scope) {
    if (scope.empty () || scope.front () == ' ' || scope.back () == ' ' ||
    scope.find ("  ") != std::string_view::npos) {
        return false;
    }
    return std::ranges::all_of (
    scope, [] (char c) { return c == ' ' || is_scope_token_char (c); });
}

bool read_resource_scope (const nlohmann::json& body, std::string& out, std::string& error) {
    const auto it = body.find ("resourceScope");
    if (it == body.end () || it->is_null ()) {
        return true;
    }
    if (!it->is_string ()) {
        error = "resourceScope must be a string";
        return false;
    }
    auto scope = it->get<std::string> ();
    if (scope.size () > mi::MAX_RESOURCE_SCOPE_BYTES) {
        error = "resourceScope may be at most " +
        std::to_string (mi::MAX_RESOURCE_SCOPE_BYTES) + " bytes";
        return false;
    }
    if (!scope.empty () && !is_scope (scope)) {
        error = "resourceScope must be scope tokens separated by single spaces "
                "(RFC 6749 section 3.3: visible ASCII other than \" and \\)";
        return false;
    }
    out = std::move (scope);
    return true;
}

bool read_clients (const nlohmann::json& body,
std::vector<MockIssuerClient>& out,
std::string& error) {
    const auto it = body.find ("clients");
    if (it == body.end () || it->is_null ()) {
        return true;
    }
    if (!it->is_array ()) {
        error = "clients must be an array";
        return false;
    }
    if (it->size () > mi::MAX_CLIENTS) {
        error = "clients may hold at most " + std::to_string (mi::MAX_CLIENTS) + " entries";
        return false;
    }
    std::vector<MockIssuerClient> clients;
    for (const auto& entry : *it) {
        if (!entry.is_object ()) {
            error = "each clients entry must be an object";
            return false;
        }
        const auto id = entry.find ("clientId");
        if (id == entry.end () || !id->is_string () || id->get<std::string> ().empty ()) {
            error = "each clients entry needs a non-empty clientId";
            return false;
        }
        MockIssuerClient client;
        client.client_id = id->get<std::string> ();
        if (const auto secret = entry.find ("clientSecret");
        secret != entry.end () && !secret->is_null ()) {
            if (!secret->is_string ()) {
                error = "clientSecret must be a string";
                return false;
            }
            client.client_secret = secret->get<std::string> ();
        }
        clients.push_back (std::move (client));
    }
    out = std::move (clients);
    return true;
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

std::string base64url_json (const nlohmann::json& value) {
    return vayu::utils::base64url_encode (value.dump ());
}

/**
 * `base64url(header).base64url(payload).base64url(HMAC-SHA256(key, ...))`,
 * keyed by this issuer's own random secret.
 */
std::string mint_jwt (const std::string& key, const nlohmann::json& payload) {
    static const nlohmann::json header = { { "alg", "HS256" }, { "typ", "JWT" } };
    const std::string signing_input =
    base64url_json (header) + "." + base64url_json (payload);
    const auto tag = vayu::utils::hmac_sha256 (key, signing_input);
    return signing_input + "." +
    vayu::utils::base64url_encode (vayu::utils::byte_view (tag));
}

std::optional<std::string> base64url_decode (std::string_view text) {
    std::string standard (text);
    std::ranges::replace (standard, '-', '+');
    std::ranges::replace (standard, '_', '/');
    return vayu::utils::base64_decode (standard);
}

/**
 * The claims of @p jwt when it is one `mint_jwt` signed with @p key and its
 * `exp` is after @p now_s; nullopt otherwise. The tag is a bearer's, so it is
 * compared with `sodium_memcmp`. Only a verified payload is parsed, which makes
 * it text this issuer wrote from settings `parse_request_json` bounded.
 */
std::optional<nlohmann::json>
verify_jwt (const std::string& key, std::string_view jwt, int64_t now_s) {
    const auto last_dot  = jwt.rfind ('.');
    const auto first_dot = jwt.find ('.');
    if (first_dot == std::string_view::npos || first_dot == last_dot) {
        return std::nullopt;
    }
    const std::string_view signing_input = jwt.substr (0, last_dot);
    const std::string_view presented     = jwt.substr (last_dot + 1);
    const std::string expected           = vayu::utils::base64url_encode (
    vayu::utils::byte_view (vayu::utils::hmac_sha256 (key, signing_input)));
    if (presented.size () != expected.size () ||
    sodium_memcmp (presented.data (), expected.data (), expected.size ()) != 0) {
        return std::nullopt;
    }
    const auto payload = base64url_decode (signing_input.substr (first_dot + 1));
    if (!payload) {
        return std::nullopt;
    }
    auto claims = nlohmann::json::parse (*payload, nullptr, false);
    if (!claims.is_object ()) {
        return std::nullopt;
    }
    const auto exp = claims.find ("exp");
    if (exp == claims.end () || !exp->is_number_integer () || exp->get<int64_t> () <= now_s) {
        return std::nullopt;
    }
    // In place: a json converts to an optional too (-Wconversion).
    return std::optional<nlohmann::json> (std::in_place, std::move (claims));
}

// ---------------------------------------------------------------------------
// Issuer-side helpers
// ---------------------------------------------------------------------------

/// Client credentials as the token endpoint received them, from either of the
/// two placements RFC 6749 §2.3.1 allows (and `apply_client_auth` sends).
struct ClientAuth {
    std::string client_id;
    std::string client_secret;
};

ClientAuth read_client_auth (const httplib::Request& req) {
    ClientAuth out;
    const std::string header = req.get_header_value ("Authorization");
    if (header.rfind ("Basic ", 0) == 0) {
        if (const auto decoded = vayu::utils::base64_decode (header.substr (6))) {
            const auto colon = decoded->find (':');
            if (colon != std::string::npos) {
                // §2.3.1 form-encodes both halves before the base64.
                out.client_id = vayu::utils::url_decode (decoded->substr (0, colon));
                out.client_secret =
                vayu::utils::url_decode (decoded->substr (colon + 1));
                return out;
            }
        }
    }
    out.client_id     = req.get_param_value ("client_id");
    out.client_secret = req.get_param_value ("client_secret");
    return out;
}

/**
 * A client id is always required. With no `clients` configured any id is
 * accepted (the common "I just need a token" case); with clients configured the
 * id must be one of them. `/authorize` asks only this: a browser redirect never
 * carries a secret, so the secret is `/token`'s to check.
 */
bool is_known_client (const MockIssuerSettings& settings, const std::string& client_id) {
    if (client_id.empty ()) {
        return false;
    }
    if (settings.clients.empty ()) {
        return true;
    }
    for (const auto& client : settings.clients) {
        if (client.client_id == client_id) {
            return true;
        }
    }
    return false;
}

/// A known client that carries a secret must also present it.
bool authenticate_client (const MockIssuerSettings& settings, const ClientAuth& auth) {
    if (!is_known_client (settings, auth.client_id)) {
        return false;
    }
    for (const auto& client : settings.clients) {
        if (client.client_id == auth.client_id) {
            return client.client_secret.empty () || client.client_secret == auth.client_secret;
        }
    }
    return true; // no clients configured
}

void send_oauth_error (httplib::Response& res,
int status,
const char* error,
const std::string& description = {}) {
    nlohmann::json body = { { "error", error } };
    if (!description.empty ()) {
        body["error_description"] = description;
    }
    res.status = status;
    res.set_content (body.dump (), "application/json");
}

} // namespace

// ---------------------------------------------------------------------------
// Settings parsing (pure - the testable core)
// ---------------------------------------------------------------------------

namespace {

MockIssuerConfig read_mutable_settings (const nlohmann::json& body, MockIssuerSettings settings) {
    MockIssuerConfig out;
    std::string error;
    if (!read_int (body, "expiresInSeconds", 1, mi::MAX_EXPIRES_IN_SECONDS,
        settings.expires_in_seconds, error) ||
    !read_int (body, "slowMs", 0, mi::MAX_SLOW_MS, settings.slow_ms, error) ||
    !read_failure_mode (body, settings.failure_mode, error)) {
        out.ok    = false;
        out.error = error;
        return out;
    }
    out.settings = std::move (settings);
    return out;
}

} // namespace

MockIssuerConfig parse_mock_issuer_settings (const nlohmann::json& body) {
    MockIssuerConfig out;
    if (!body.is_object ()) {
        out.ok    = false;
        out.error = "Body must be a JSON object";
        return out;
    }

    out = read_mutable_settings (body, MockIssuerSettings{});
    if (!out.ok) {
        return out;
    }

    std::string error;
    int64_t port = 0;
    if (!read_int (body, "port", 0, 65535, port, error) ||
    !read_bool (body, "issueRefreshTokens", out.settings.issue_refresh_tokens, error) ||
    !read_clients (body, out.settings.clients, error) ||
    !read_resource_scope (body, out.settings.resource_scope, error)) {
        out.ok    = false;
        out.error = error;
        return out;
    }
    out.settings.port = static_cast<int> (port);

    if (const auto claims = body.find ("claims");
    claims != body.end () && !claims->is_null ()) {
        if (!claims->is_object ()) {
            out.ok    = false;
            out.error = "claims must be an object";
            return out;
        }
        out.settings.claims = *claims;
    }
    return out;
}

MockIssuerConfig apply_mock_issuer_patch (const nlohmann::json& body,
const MockIssuerSettings& current) {
    MockIssuerConfig out;
    if (!body.is_object ()) {
        out.ok    = false;
        out.error = "Body must be a JSON object";
        return out;
    }
    // A port, client list or claim set cannot change under a bound listener, so
    // asking for one is refused rather than half-applied.
    for (const char* immutable :
    { "port", "clients", "claims", "issueRefreshTokens", "resourceScope" }) {
        if (body.contains (immutable)) {
            out.ok = false;
            out.error = std::string (immutable) + " cannot be updated on a running issuer - stop it and start a new one";
            return out;
        }
    }
    return read_mutable_settings (body, current);
}

// ---------------------------------------------------------------------------
// Issuer + manager
// ---------------------------------------------------------------------------

namespace {

/// Where the protected resource is served on an issuer's listener.
constexpr std::string_view RESOURCE_PATH = "/resource";

} // namespace

namespace detail {

struct MockIssuerState {
    std::string id;
    int port = 0;
    std::string signing_key;
    std::string issuer_url;
    int64_t created_at = 0;

    struct IssuedCode {
        std::string client_id;
        std::string redirect_uri;
        std::string code_challenge; // empty = the authorize call used no PKCE
        std::string scope;
        int64_t issued_at = 0;
        uint64_t sequence = 0;
    };
    struct IssuedRefresh {
        std::string client_id;
        std::string scope;
        std::string subject;
        uint64_t sequence = 0;
    };
    /// A public client `POST /register` issued: it authenticates by id alone
    /// and may only be redirected to one of its own `redirect_uris`.
    struct RegisteredClient {
        std::vector<std::string> redirect_uris;
        uint64_t sequence = 0;
    };

    // Guards everything the listener threads touch: the settings a PUT can
    // change under them, and the issued-credential and registration maps.
    std::mutex state_mutex;
    MockIssuerSettings settings;
    // Each map is bounded by `evict_earliest_issued`, which keeps a
    // long-lived daemon's issuer from growing one per abandoned authorize
    // call or looping registration.
    std::map<std::string, IssuedCode> codes;
    std::map<std::string, IssuedRefresh> refresh_tokens;
    std::map<std::string, RegisteredClient> registered_clients;
    /// The last `sequence` handed out, across all three maps.
    uint64_t issue_sequence = 0;

    /// Requested when the issuer stops, before its listener is joined.
    vayu::utils::StopSignal stop_signal;

    /// Declared last so it is destroyed first: `/token` and `/authorize` read
    /// every field above it while the accept loop is alive.
    ManagedListener listener;

    std::string token_url () const {
        return issuer_url + "/token";
    }
    std::string authorize_url () const {
        return issuer_url + "/authorize";
    }
    std::string registration_url () const {
        return issuer_url + "/register";
    }
    std::string metadata_url () const {
        return issuer_url + std::string (oauth_discovery::AUTHORIZATION_SERVER_WELL_KNOWN);
    }
    /// The protected resource, and so the server URL discovery starts from.
    std::string resource_url () const {
        return issuer_url + std::string (RESOURCE_PATH);
    }
    std::string resource_metadata_url () const {
        return issuer_url + std::string (oauth_discovery::PROTECTED_RESOURCE_WELL_KNOWN);
    }

    /// Description shared by `GET /mock-issuer` and the `PUT` reply.
    nlohmann::json describe () {
        std::lock_guard<std::mutex> lock (state_mutex);
        return nlohmann::json{ { "issuerId", id }, { "issuerUrl", issuer_url },
            { "tokenUrl", token_url () }, { "authorizeUrl", authorize_url () },
            { "metadataUrl", metadata_url () },
            { "discoverUrl", resource_url () }, { "signingKey", signing_key },
            { "port", port }, { "expiresInSeconds", settings.expires_in_seconds },
            { "failureMode", settings.failure_mode }, { "slowMs", settings.slow_ms },
            { "issueRefreshTokens", settings.issue_refresh_tokens },
            { "resourceScope", settings.resource_scope },
            { "clientCount", settings.clients.size () }, { "createdAt", created_at } };
    }
};

} // namespace detail

namespace {

using Issuer = detail::MockIssuerState;

/// What `POST /register` issues a client for, and all `/token` lets one use.
constexpr auto REGISTERED_GRANT_TYPES =
std::to_array<std::string_view> ({ "authorization_code", "refresh_token" });

/// The `iss` a `wrong_iss` issuer misstates its authorization responses with.
constexpr std::string_view WRONG_ISS_SUFFIX = "/other";

nlohmann::json string_array (std::span<const std::string_view> values) {
    auto array = nlohmann::json::array ();
    for (const std::string_view value : values) {
        array.push_back (std::string (value));
    }
    return array;
}

/// The client `POST /register` issued as @p client_id, or null. Called with
/// `issuer.state_mutex` held.
const Issuer::RegisteredClient*
find_registered_client (const Issuer& issuer, const std::string& client_id) {
    const auto it = issuer.registered_clients.find (client_id);
    return it == issuer.registered_clients.end () ? nullptr : &it->second;
}

/**
 * `/token`'s client check, answering the refusal itself. A registered client
 * is public: it authenticates by id alone, for the grants it registered. Any
 * other is `authenticate_client`'s. Called with `issuer.state_mutex` held.
 */
bool admit_token_client (const Issuer& issuer,
const ClientAuth& auth,
const std::string& grant,
httplib::Response& res) {
    if (find_registered_client (issuer, auth.client_id) != nullptr) {
        if (std::ranges::contains (REGISTERED_GRANT_TYPES, grant)) {
            return true;
        }
        send_oauth_error (res, 400, "unauthorized_client",
        "A registered client may use only the authorization_code and "
        "refresh_token grants");
        return false;
    }
    if (!authenticate_client (issuer.settings, auth)) {
        send_oauth_error (res, 401, "invalid_client",
        auth.client_id.empty () ? "client_id is required" : "Unknown client or bad secret");
        return false;
    }
    return true;
}

/**
 * `/authorize`'s client check, answered in place because an unverified
 * redirect target must never be redirected to (RFC 6749 section 4.1.2.1). A
 * registered client must name one of its own redirect URIs exactly and, being
 * public, send PKCE. Any other is `is_known_client`'s. Called with
 * `issuer.state_mutex` held.
 */
bool admit_authorize_client (const Issuer& issuer,
const std::string& client_id,
const std::string& redirect_uri,
const std::string& challenge,
httplib::Response& res) {
    const auto* registered = find_registered_client (issuer, client_id);
    if (registered == nullptr) {
        if (is_known_client (issuer.settings, client_id)) {
            return true;
        }
        send_oauth_error (res, 400, "invalid_client",
        client_id.empty () ? "client_id is required" : "Unknown client");
        return false;
    }
    if (!std::ranges::contains (registered->redirect_uris, redirect_uri)) {
        send_oauth_error (res, 400, "invalid_request",
        "redirect_uri is not one this client registered");
        return false;
    }
    if (challenge.empty ()) {
        send_oauth_error (res, 400, "invalid_request",
        "A registered client is public and must send a PKCE code_challenge");
        return false;
    }
    return true;
}

/// Where `/authorize` sends the browser: @p redirect_uri with the code, the
/// state when one was sent, and `iss` (RFC 9207), which `wrong_iss` misstates.
/// Called with `issuer.state_mutex` held.
std::string authorization_redirect (const Issuer& issuer,
const std::string& redirect_uri,
const std::string& code,
const std::string& state) {
    std::string iss = issuer.issuer_url;
    if (issuer.settings.failure_mode == "wrong_iss") {
        iss += WRONG_ISS_SUFFIX;
    }
    std::string location = redirect_uri;
    location.push_back (location.find ('?') == std::string::npos ? '?' : '&');
    location += "code=" + vayu::utils::url_encode (code);
    if (!state.empty ()) {
        location += "&state=" + vayu::utils::url_encode (state);
    }
    location += "&iss=" + vayu::utils::url_encode (iss);
    return location;
}

/**
 * The password grant's own requirement. Answers the refusal itself and returns
 * false, the shape every grant helper here takes.
 */
bool read_password_grant (const httplib::Request& req, httplib::Response& res, std::string& subject) {
    const std::string username = req.get_param_value ("username");
    if (username.empty () || !req.has_param ("password")) {
        send_oauth_error (res, 400, "invalid_request",
        "password grant needs username and password");
        return false;
    }
    subject = username;
    return true;
}

/**
 * Spends an authorization code: single use, whatever happens after, then the
 * checks RFC 6749 §4.1.3 puts on redeeming one.
 *
 * Called with `issuer.state_mutex` held - it reads and erases issuer state.
 */
bool redeem_authorization_code (Issuer& issuer,
const ClientAuth& auth,
const httplib::Request& req,
httplib::Response& res,
std::string& scope) {
    const std::string code = req.get_param_value ("code");
    const auto it          = issuer.codes.find (code);
    if (code.empty () || it == issuer.codes.end ()) {
        send_oauth_error (res, 400, "invalid_grant", "Unknown or already-used code");
        return false;
    }
    const Issuer::IssuedCode issued = it->second;
    issuer.codes.erase (it); // single use, whatever happens below
    if (now_ms () > issued.issued_at + mi::CODE_TTL_MS) {
        send_oauth_error (res, 400, "invalid_grant", "Authorization code expired");
        return false;
    }
    if (issued.client_id != auth.client_id) {
        send_oauth_error (res, 400, "invalid_grant", "Code was issued to another client");
        return false;
    }
    if (const std::string redirect = req.get_param_value ("redirect_uri");
    redirect != issued.redirect_uri) {
        send_oauth_error (res, 400, "invalid_grant",
        "redirect_uri does not match the authorize call");
        return false;
    }
    if (!issued.code_challenge.empty ()) {
        const std::string verifier = req.get_param_value ("code_verifier");
        if (verifier.empty () || pkce::code_challenge (verifier) != issued.code_challenge) {
            send_oauth_error (res, 400, "invalid_grant", "PKCE verification failed");
            return false;
        }
    }
    if (scope.empty ()) {
        scope = issued.scope;
    }
    return true;
}

/**
 * Spends a refresh token. Rotation: the presented token is spent here and
 * `mint_token_response` issues its replacement, so a client keeping the old one
 * fails, the path worth exercising locally. Called with `issuer.state_mutex`
 * held.
 */
bool redeem_refresh_token (Issuer& issuer,
const ClientAuth& auth,
const httplib::Request& req,
httplib::Response& res,
std::string& subject,
std::string& scope) {
    const std::string token = req.get_param_value ("refresh_token");
    const auto it           = issuer.refresh_tokens.find (token);
    if (token.empty () || it == issuer.refresh_tokens.end ()) {
        send_oauth_error (res, 400, "invalid_grant", "Unknown or already-rotated refresh token");
        return false;
    }
    const Issuer::IssuedRefresh issued = it->second;
    issuer.refresh_tokens.erase (it);
    if (issued.client_id != auth.client_id) {
        send_oauth_error (res, 400, "invalid_grant", "Refresh token was issued to another client");
        return false;
    }
    if (!issued.subject.empty ()) {
        subject = issued.subject;
    }
    if (scope.empty ()) {
        scope = issued.scope;
    }
    return true;
}

/**
 * Build the access token for one grant. Called with the issuer's state lock
 * held, so `settings` cannot change between the expiry stamped in the payload
 * and the `expires_in` reported beside it.
 */
nlohmann::json mint_token_response (Issuer& issuer,
const std::string& subject,
const std::string& client_id,
const std::string& scope) {
    const MockIssuerSettings& settings = issuer.settings;
    const int64_t issued_at_s          = now_ms () / 1000;

    nlohmann::json claims = settings.claims;
    // The configured claims are the base; the four below describe *this* token
    // and would contradict the response beside them if a claim set overrode
    // them, so they win. `sub`/`client_id`/`scope` yield to a configured value.
    claims["iss"] = issuer.issuer_url;
    claims["iat"] = issued_at_s;
    claims["exp"] = issued_at_s + settings.expires_in_seconds;
    claims["jti"] = pkce::random_token (12);
    if (!claims.contains ("sub") && !subject.empty ()) {
        claims["sub"] = subject;
    }
    if (!claims.contains ("client_id") && !client_id.empty ()) {
        claims["client_id"] = client_id;
    }
    if (!claims.contains ("scope") && !scope.empty ()) {
        claims["scope"] = scope;
    }

    nlohmann::json body = { { "access_token", mint_jwt (issuer.signing_key, claims) },
        { "token_type", "Bearer" }, { "expires_in", settings.expires_in_seconds } };
    if (!scope.empty ()) {
        body["scope"] = scope;
    }
    if (settings.issue_refresh_tokens) {
        const std::string refresh = pkce::random_token (24);
        issuer.refresh_tokens[refresh] =
        Issuer::IssuedRefresh{ client_id, scope, subject, ++issuer.issue_sequence };
        detail::evict_earliest_issued (issuer.refresh_tokens, mi::MAX_REFRESH_TOKENS);
        body["refresh_token"] = refresh;
    }
    return body;
}

void handle_token (Issuer& issuer, const httplib::Request& req, httplib::Response& res) {
    // The failure mode is read (and `slow` waited out) before anything else, so
    // a caller testing retry behaviour sees the same reply whatever it asked
    // for. A stop cuts the wait short and the reply goes out without the rest
    // of it; the stop's join keeps the issuer's state alive until then.
    std::string failure_mode;
    int64_t slow_ms = 0;
    {
        std::lock_guard<std::mutex> lock (issuer.state_mutex);
        failure_mode = issuer.settings.failure_mode;
        slow_ms      = issuer.settings.slow_ms;
    }
    if (failure_mode == "server_error") {
        send_oauth_error (res, 500, "temporarily_unavailable");
        return;
    }
    if (failure_mode == "invalid_client") {
        send_oauth_error (res, 401, "invalid_client");
        return;
    }
    if (failure_mode == "slow" && slow_ms > 0) {
        issuer.stop_signal.wait_for (std::chrono::milliseconds (slow_ms));
    }

    const std::string grant = req.get_param_value ("grant_type");
    if (grant.empty ()) {
        // Either no grant_type, or a body the endpoint cannot read: RFC 6749
        // §3.2 requires application/x-www-form-urlencoded and that is the only
        // shape parsed here, so say so rather than reporting a missing field.
        send_oauth_error (res, 400, "invalid_request",
        "grant_type is required, sent as application/x-www-form-urlencoded");
        return;
    }

    const ClientAuth auth = read_client_auth (req);

    std::lock_guard<std::mutex> lock (issuer.state_mutex);
    if (!admit_token_client (issuer, auth, grant, res)) {
        return;
    }

    std::string subject = auth.client_id;
    std::string scope   = req.get_param_value ("scope");

    if (grant == "client_credentials") {
        // Nothing further to check.
    } else if (grant == "password") {
        if (!read_password_grant (req, res, subject)) {
            return;
        }
    } else if (grant == "authorization_code") {
        if (!redeem_authorization_code (issuer, auth, req, res, scope)) {
            return;
        }
    } else if (grant == "refresh_token") {
        if (!redeem_refresh_token (issuer, auth, req, res, subject, scope)) {
            return;
        }
    } else {
        send_oauth_error (res, 400, "unsupported_grant_type", grant);
        return;
    }

    const auto body = mint_token_response (issuer, subject, auth.client_id, scope);
    res.status = 200;
    res.set_content (body.dump (), "application/json");
}

void handle_authorize (Issuer& issuer, const httplib::Request& req, httplib::Response& res) {
    const std::string client_id    = req.get_param_value ("client_id");
    const std::string redirect_uri = req.get_param_value ("redirect_uri");
    const std::string state        = req.get_param_value ("state");
    const std::string challenge    = req.get_param_value ("code_challenge");

    if (redirect_uri.empty ()) {
        // An invalid redirect target must never be redirected to (RFC 6749
        // §4.1.2.1), so this and the client failure below answer in place.
        send_oauth_error (res, 400, "invalid_request", "redirect_uri is required");
        return;
    }
    if (const std::string response_type = req.get_param_value ("response_type");
    !response_type.empty () && response_type != "code") {
        send_oauth_error (res, 400, "unsupported_response_type", response_type);
        return;
    }

    std::lock_guard<std::mutex> lock (issuer.state_mutex);
    if (!admit_authorize_client (issuer, client_id, redirect_uri, challenge, res)) {
        return;
    }
    if (!challenge.empty () && req.get_param_value ("code_challenge_method") != "S256") {
        // S256 is the only method implemented; `plain` would let a test pass
        // that a real provider rejects, which is worse than refusing it here.
        send_oauth_error (res, 400, "invalid_request", "code_challenge_method must be S256");
        return;
    }

    const std::string code = pkce::random_token (24);
    issuer.codes[code] = Issuer::IssuedCode{ client_id, redirect_uri, challenge,
        req.get_param_value ("scope"), now_ms (), ++issuer.issue_sequence };
    detail::evict_earliest_issued (issuer.codes, mi::MAX_PENDING_CODES);
    res.set_redirect (authorization_redirect (issuer, redirect_uri, code, state), 302);
}

bool is_ascii_alpha (char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/// RFC 3986 `scheme`, less its first letter.
bool is_scheme_char (char c) {
    return is_ascii_alpha (c) || (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.';
}

/// Whether @p uri can be registered as a redirect target: an absolute URI (an
/// RFC 3986 scheme, then `:`) with no fragment (RFC 6749 section 3.1.2), no
/// space or control byte, within `MAX_REDIRECT_URI_BYTES`.
bool is_redirect_uri (std::string_view uri) {
    if (uri.empty () || uri.size () > mi::MAX_REDIRECT_URI_BYTES ||
    uri.find ('#') != std::string_view::npos || !is_ascii_alpha (uri.front ())) {
        return false;
    }
    const bool visible = std::ranges::all_of (uri, [] (char c) {
        const auto byte = static_cast<unsigned char> (c);
        return byte > 0x20 && byte < 0x7F;
    });
    const auto colon   = uri.find (':');
    return visible && colon != std::string_view::npos &&
    std::ranges::all_of (uri.substr (0, colon), is_scheme_char);
}

/// A registration request's `redirect_uris` (RFC 7591 section 2), or why not.
std::expected<std::vector<std::string>, std::string> read_redirect_uris (
const nlohmann::json& body) {
    const auto it = body.find ("redirect_uris");
    if (it == body.end () || !it->is_array () || it->empty ()) {
        return std::unexpected (
        "redirect_uris must be a non-empty array of strings");
    }
    if (it->size () > mi::MAX_REDIRECT_URIS) {
        return std::unexpected ("redirect_uris may hold at most " +
        std::to_string (mi::MAX_REDIRECT_URIS) + " entries");
    }
    std::vector<std::string> uris;
    for (const auto& entry : *it) {
        if (!entry.is_string () ||
        !is_redirect_uri (entry.get_ref<const std::string&> ())) {
            return std::unexpected (
            "each redirect_uris entry must be an absolute URI without a "
            "fragment, at most " +
            std::to_string (mi::MAX_REDIRECT_URI_BYTES) + " bytes");
        }
        uris.push_back (entry.get<std::string> ());
    }
    return uris;
}

/**
 * RFC 7591 dynamic client registration. Every client it issues is public
 * (`token_endpoint_auth_method` `none`, no secret) whatever the request asked
 * for, which RFC 7591 section 3.2.1 lets a server decide.
 */
void handle_register (Issuer& issuer, const httplib::Request& req, httplib::Response& res) {
    {
        // Read first, like `/token`'s failure mode: the refusal does not
        // depend on what was sent.
        std::lock_guard<std::mutex> lock (issuer.state_mutex);
        if (issuer.settings.failure_mode == "registration_refused") {
            send_oauth_error (res, 400, "invalid_client_metadata",
            "Registration is refused (failureMode registration_refused)");
            return;
        }
    }
    const auto body = routes::parse_request_json (req.body);
    if (!body || !body->is_object ()) {
        send_oauth_error (res, 400, "invalid_client_metadata",
        "The registration request must be a JSON object");
        return;
    }
    auto redirect_uris = read_redirect_uris (*body);
    if (!redirect_uris) {
        send_oauth_error (res, 400, "invalid_redirect_uri", redirect_uris.error ());
        return;
    }

    const int64_t issued_at         = now_ms ();
    const std::string client_id     = "client_" + pkce::random_token (16);
    const nlohmann::json registered = { { "client_id", client_id },
        { "client_id_issued_at", issued_at / 1000 },
        { "redirect_uris", *redirect_uris }, { "token_endpoint_auth_method", "none" },
        { "grant_types", string_array (REGISTERED_GRANT_TYPES) },
        { "response_types", nlohmann::json::array ({ "code" }) } };
    {
        std::lock_guard<std::mutex> lock (issuer.state_mutex);
        issuer.registered_clients[client_id] =
        Issuer::RegisteredClient{ std::move (*redirect_uris), ++issuer.issue_sequence };
        detail::evict_earliest_issued (issuer.registered_clients, mi::MAX_REGISTERED_CLIENTS);
    }
    res.status = 201;
    res.set_content (registered.dump (), "application/json");
}

/// RFC 8414 authorization server metadata, or the `404` `metadata_not_found`
/// answers instead.
void handle_metadata (Issuer& issuer, const httplib::Request& /*req*/, httplib::Response& res) {
    std::lock_guard<std::mutex> lock (issuer.state_mutex);
    if (issuer.settings.failure_mode == "metadata_not_found") {
        send_oauth_error (res, 404, "not_found",
        "No authorization server metadata (failureMode metadata_not_found)");
        return;
    }
    const nlohmann::json metadata = { { "issuer", issuer.issuer_url },
        { "authorization_endpoint", issuer.authorize_url () },
        { "token_endpoint", issuer.token_url () },
        { "registration_endpoint", issuer.registration_url () },
        { "response_types_supported", nlohmann::json::array ({ "code" }) },
        { "grant_types_supported",
        nlohmann::json::array (
        { "authorization_code", "refresh_token", "client_credentials", "password" }) },
        { "code_challenge_methods_supported",
        nlohmann::json::array ({ std::string (oauth_discovery::PKCE_METHOD) }) },
        { "token_endpoint_auth_methods_supported",
        nlohmann::json::array ({ "client_secret_basic", "client_secret_post", "none" }) },
        { "authorization_response_iss_parameter_supported", true } };
    res.status                    = 200;
    res.set_content (metadata.dump (), "application/json");
}

/// RFC 9728 protected resource metadata for `/resource`.
void handle_resource_metadata (Issuer& issuer,
const httplib::Request& /*req*/,
httplib::Response& res) {
    std::lock_guard<std::mutex> lock (issuer.state_mutex);
    const nlohmann::json metadata = { { "resource", issuer.resource_url () },
        { "authorization_servers", nlohmann::json::array ({ issuer.issuer_url }) },
        { "bearer_methods_supported", nlohmann::json::array ({ "header" }) } };
    res.status                    = 200;
    res.set_content (metadata.dump (), "application/json");
}

/// The bearer token of @p req's `Authorization` header (RFC 6750 section
/// 2.1), or nullopt when it sends none.
std::optional<std::string> bearer_token (const httplib::Request& req) {
    constexpr std::string_view SCHEME = "Bearer ";
    const std::string header          = req.get_header_value ("Authorization");
    if (header.size () <= SCHEME.size () ||
    !vayu::utils::ascii_lower_equal (
    std::string_view (header).substr (0, SCHEME.size ()), SCHEME)) {
        return std::nullopt;
    }
    return header.substr (SCHEME.size ());
}

/// The words of a space-separated scope (RFC 6749 section 3.3).
std::vector<std::string_view> scope_words (std::string_view scope) {
    std::vector<std::string_view> words;
    while (!scope.empty ()) {
        const auto space = scope.find (' ');
        if (const auto word = scope.substr (0, space); !word.empty ()) {
            words.push_back (word);
        }
        scope.remove_prefix (space == std::string_view::npos ? scope.size () : space + 1);
    }
    return words;
}

/// Whether the space-separated @p granted holds every word of @p required.
bool scope_grants (std::string_view granted, std::string_view required) {
    const auto held = scope_words (granted);
    return std::ranges::all_of (scope_words (required), [&held] (std::string_view word) {
        return std::ranges::contains (held, word);
    });
}

/**
 * The `/resource` refusal's Bearer challenge (RFC 6750 section 3): @p error
 * when the request sent a token (section 3.1 names none for a request without
 * one), the required scope when one is set, and where the metadata is (RFC
 * 9728 section 5.1), which is what an MCP client's discovery follows. Called
 * with `issuer.state_mutex` held.
 */
std::string resource_challenge (const Issuer& issuer, std::string_view error) {
    std::string challenge = "Bearer ";
    if (!error.empty ()) {
        challenge += "error=\"" + std::string (error) + "\", ";
    }
    if (const std::string& scope = issuer.settings.resource_scope; !scope.empty ()) {
        challenge += "scope=\"" + scope + "\", ";
    }
    challenge += "resource_metadata=\"" + issuer.resource_metadata_url () + "\"";
    return challenge;
}

/// The protected resource: a token this issuer signed, unexpired and holding
/// `resourceScope`, reads a small JSON answer.
void handle_resource (Issuer& issuer, const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock (issuer.state_mutex);
    const auto token = bearer_token (req);
    if (!token) {
        res.set_header ("WWW-Authenticate", resource_challenge (issuer, {}));
        send_oauth_error (res, 401, "unauthorized", "A Bearer access token is required");
        return;
    }
    const auto claims = verify_jwt (issuer.signing_key, *token, now_ms () / 1000);
    if (!claims) {
        res.set_header ("WWW-Authenticate", resource_challenge (issuer, "invalid_token"));
        send_oauth_error (res, 401, "invalid_token",
        "The access token is not one this issuer signed, or it has expired");
        return;
    }
    const auto scope_claim = claims->find ("scope");
    const std::string granted =
    scope_claim != claims->end () && scope_claim->is_string () ?
    scope_claim->get<std::string> () :
    "";
    if (!scope_grants (granted, issuer.settings.resource_scope)) {
        res.set_header ("WWW-Authenticate", resource_challenge (issuer, "insufficient_scope"));
        send_oauth_error (res, 403, "insufficient_scope",
        "The access token's scope does not hold " + issuer.settings.resource_scope);
        return;
    }
    res.status = 200;
    res.set_content (
    nlohmann::json{ { "resource", issuer.resource_url () }, { "scope", granted } }
    .dump (),
    "application/json");
}

/// Every route a running issuer serves, bound to @p issuer.
void serve_issuer_routes (Issuer& issuer) {
    // httplib compiles each route path into a std::regex, and libstdc++ fills
    // its `ctype<char>::narrow` cache with unsynchronised writes, so two issuers
    // starting on two handler threads race in a fresh process (ThreadSanitizer
    // reports it). One registration at a time keeps the cache single-writer.
    static std::mutex registration_mutex;
    const std::lock_guard<std::mutex> registering (registration_mutex);
    using Handler = void (*) (Issuer&, const httplib::Request&, httplib::Response&);
    const auto bind = [&issuer] (Handler handler) {
        return [&issuer, handler] (const httplib::Request& req,
               httplib::Response& res) { handler (issuer, req, res); };
    };
    httplib::Server& server = issuer.listener.server ();
    server.Post ("/token", bind (handle_token));
    server.Get ("/authorize", bind (handle_authorize));
    server.Post ("/register", bind (handle_register));
    server.Get (std::string (oauth_discovery::AUTHORIZATION_SERVER_WELL_KNOWN),
    bind (handle_metadata));
    // RFC 9728 section 3.1 inserts the resource's path after the well-known
    // one; a client that probes only that form never tries the bare path.
    const std::string resource_metadata =
    std::string (oauth_discovery::PROTECTED_RESOURCE_WELL_KNOWN);
    server.Get (resource_metadata, bind (handle_resource_metadata));
    server.Get (resource_metadata + std::string (RESOURCE_PATH),
    bind (handle_resource_metadata));
    server.Get (std::string (RESOURCE_PATH), bind (handle_resource));
}

} // namespace

MockIssuerManager::MockIssuerManager () : issuers_ (mi::MAX_ISSUERS) {
}

MockIssuerManager::~MockIssuerManager () = default;

void MockIssuerManager::shutdown () {
    issuers_.shutdown ();
}

MockIssuerStart MockIssuerManager::start (const nlohmann::json& body) {
    MockIssuerStart out;

    auto parsed = parse_mock_issuer_settings (body);
    if (!parsed.ok) {
        out.ok            = false;
        out.error_code    = std::string (INVALID_CONFIG_CODE);
        out.error_message = parsed.error;
        return out;
    }

    auto slot = issuers_.reserve ();
    if (!slot) {
        if (slot.error () == RegistryRefusal::ShutDown) {
            refuse_shut_down (out);
            return out;
        }
        out.ok            = false;
        out.http_status   = 429;
        out.error_code    = "mock_issuer_limit_reached";
        out.error_message = "At most " + std::to_string (mi::MAX_ISSUERS) +
        " mock issuers may run at once - stop one first";
        return out;
    }

    auto issuer        = std::make_unique<Issuer> ();
    issuer->id         = vayu::utils::generate_id ("issuer_");
    issuer->created_at = now_ms ();
    issuer->settings   = std::move (parsed.settings);
    // The signing key is base64url text rather than raw bytes so it can be
    // handed to a service under test as a shared secret verbatim.
    issuer->signing_key = pkce::random_token (32);

    serve_issuer_routes (*issuer);

    // 127.0.0.1 only, never configurable: the issuer mints bearer tokens and
    // the engine has no route auth, so a wider bind would hand them to the LAN.
    const auto started = issuer->listener.start (
    "127.0.0.1", issuer->settings.port, "mock issuer " + issuer->id);
    if (started.port <= 0) {
        const std::string requested =
        "Couldn't bind 127.0.0.1:" + std::to_string (issuer->settings.port);
        out.ok          = false;
        out.http_status = 500;
        out.error_code  = "mock_issuer_bind_failed";
        if (!started.held_by.empty ()) {
            out.error_message =
            requested + " - " + started.held_by + " is already listening there";
        } else {
            out.error_message = issuer->settings.port == 0 ?
            "Couldn't bind a local port for the mock issuer" :
            requested;
        }
        return out;
    }
    {
        // The listener's threads read the URL under this lock, and they are
        // already running.
        std::lock_guard<std::mutex> lock (issuer->state_mutex);
        issuer->port = started.port;
        issuer->issuer_url = "http://127.0.0.1:" + std::to_string (started.port);
    }

    out.issuer_id     = issuer->id;
    out.issuer_url    = issuer->issuer_url;
    out.token_url     = issuer->token_url ();
    out.authorize_url = issuer->authorize_url ();
    out.metadata_url  = issuer->metadata_url ();
    out.discover_url  = issuer->resource_url ();
    out.signing_key   = issuer->signing_key;

    const std::string issuer_url = issuer->issuer_url;
    if (!issuers_.commit (std::move (*slot), out.issuer_id, std::move (issuer))) {
        out = MockIssuerStart{};
        refuse_shut_down (out);
        return out;
    }
    vayu::utils::log_info ("mock",
    "Mock OAuth2 issuer started at " + issuer_url + " (" + out.issuer_id + ")");
    return out;
}

bool MockIssuerManager::stop (const std::string& issuer_id) {
    if (!issuers_.remove (issuer_id)) {
        return false;
    }
    vayu::utils::log_info ("mock", "Mock OAuth2 issuer stopped (" + issuer_id + ")");
    return true;
}

nlohmann::json MockIssuerManager::list () const {
    auto issuers = issuers_.with_entries ([] (const auto& entries) {
        auto described = nlohmann::json::array ();
        for (const auto& [id, issuer] : entries) {
            described.push_back (issuer->describe ());
        }
        return described;
    });
    return nlohmann::json{ { "issuers", std::move (issuers) } };
}

MockIssuerManager::UpdateResult
MockIssuerManager::update (const std::string& issuer_id, const nlohmann::json& body) {
    return issuers_.with_entries ([&] (const auto& entries) {
        UpdateResult out;
        const auto it = entries.find (issuer_id);
        if (it == entries.end ()) {
            return out;
        }
        out.found      = true;
        Issuer& issuer = *it->second;

        MockIssuerConfig parsed;
        {
            std::lock_guard<std::mutex> state_lock (issuer.state_mutex);
            parsed = apply_mock_issuer_patch (body, issuer.settings);
            if (parsed.ok) {
                issuer.settings = std::move (parsed.settings);
            }
        }
        if (!parsed.ok) {
            out.ok    = false;
            out.error = parsed.error;
            return out;
        }
        out.issuer = issuer.describe ();
        return out;
    });
}

namespace routes {

void register_mock_issuer_routes (RouteContext& ctx) {
    ctx.server.Post ("/mock-issuer/start",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body = nlohmann::json::object ();
        if (!req.body.empty ()) {
            auto parsed = parse_request_json (
            req.body, INVALID_CONFIG_CODE, {}, INVALID_CONFIG_CODE);
            if (!parsed) {
                refuse_request_body (res, "POST /mock-issuer/start", parsed.error ());
                return;
            }
            body = std::move (*parsed);
        }
        const auto result = ctx.mock_issuer_manager.start (body);
        if (!result.ok) {
            send_error (res, result.http_status, result.error_message, result.error_code);
            return;
        }
        res.status = 200;
        res.set_content (
        nlohmann::json{ { "issuerId", result.issuer_id },
        { "issuerUrl", result.issuer_url }, { "tokenUrl", result.token_url },
        { "authorizeUrl", result.authorize_url }, { "metadataUrl", result.metadata_url },
        { "discoverUrl", result.discover_url }, { "signingKey", result.signing_key } }
        .dump (),
        "application/json");
    });

    ctx.server.Get ("/mock-issuer", [&ctx] (const httplib::Request&, httplib::Response& res) {
        res.status = 200;
        res.set_content (ctx.mock_issuer_manager.list ().dump (), "application/json");
    });

    ctx.server.Post (R"(/mock-issuer/([^/]+)/stop)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        if (!ctx.mock_issuer_manager.stop (id)) {
            send_error (res, 404, "Mock issuer not found: " + id);
            return;
        }
        res.status = 200;
        res.set_content (R"({"stopped":true})", "application/json");
    });

    ctx.server.Put (R"(/mock-issuer/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        const auto body =
        parse_request_json (req.body, INVALID_CONFIG_CODE, {}, INVALID_CONFIG_CODE);
        if (!body) {
            refuse_request_body (res, "PUT /mock-issuer/:id", body.error ());
            return;
        }
        const auto result = ctx.mock_issuer_manager.update (id, *body);
        if (!result.found) {
            send_error (res, 404, "Mock issuer not found: " + id);
            return;
        }
        if (!result.ok) {
            send_error (res, 400, result.error, INVALID_CONFIG_CODE);
            return;
        }
        res.status = 200;
        res.set_content (result.issuer.dump (), "application/json");
    });
}

} // namespace routes

} // namespace vayu::http
