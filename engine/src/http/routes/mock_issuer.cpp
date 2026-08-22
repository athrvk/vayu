/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/mock_issuer.cpp
 * @brief The local OAuth 2.0 mock issuer - manager, spawned listener, and the
 *        `/mock-issuer` lifecycle routes.
 *
 * Lives with the routes for the same reason `oauth_authorize.cpp` does: the
 * spawned listener needs httplib, which is linked into the engine and the test
 * binary but not into `vayu_core`.
 */

#include "vayu/http/mock_issuer.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/http/managed_listener.hpp"
#include "vayu/http/pkce.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/sha256.hpp"

#include <httplib.h>

#include <chrono>
#include <string_view>
#include <thread>

namespace vayu::http {

namespace mi = vayu::core::constants::mock_issuer;

namespace {

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
    if (mode != "none" && mode != "slow" && mode != "server_error" && mode != "invalid_client") {
        error =
        "failureMode must be one of none, slow, server_error, invalid_client";
        return false;
    }
    out = mode;
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
 * `base64url(header).base64url(payload).base64url(HMAC-SHA256(key, ...))`.
 *
 * The signing key is this issuer's own random secret, so the engine only ever
 * *produces* a tag here - nothing compares an attacker-supplied one, which is
 * the case sha256.hpp warns needs sodium_memcmp.
 */
std::string mint_jwt (const std::string& key, const nlohmann::json& payload) {
    static const nlohmann::json header = { { "alg", "HS256" }, { "typ", "JWT" } };
    const std::string signing_input =
    base64url_json (header) + "." + base64url_json (payload);
    const auto tag = vayu::utils::hmac_sha256 (key, signing_input);
    return signing_input + "." +
    vayu::utils::base64url_encode (
    std::string_view (reinterpret_cast<const char*> (tag.data ()), tag.size ()));
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
 * id must be one of them, and one carrying a secret must present it.
 */
bool authenticate_client (const MockIssuerSettings& settings, const ClientAuth& auth) {
    if (auth.client_id.empty ()) {
        return false;
    }
    if (settings.clients.empty ()) {
        return true;
    }
    for (const auto& client : settings.clients) {
        if (client.client_id != auth.client_id) {
            continue;
        }
        return client.client_secret.empty () || client.client_secret == auth.client_secret;
    }
    return false;
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

/// Evict the oldest entries until @p map holds at most @p cap. Codes and
/// refresh tokens are keyed by a random string, so age is the only ordering
/// there is - and the bound is what keeps a long-lived daemon's mock issuer
/// from growing a map per authorize call that never completed.
template <typename Map> void bound_by_age (Map& map, size_t cap) {
    while (map.size () > cap) {
        auto oldest = map.begin ();
        for (auto it = map.begin (); it != map.end (); ++it) {
            if (it->second.issued_at < oldest->second.issued_at) {
                oldest = it;
            }
        }
        map.erase (oldest);
    }
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
    !read_clients (body, out.settings.clients, error)) {
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
    for (const char* immutable : { "port", "clients", "claims", "issueRefreshTokens" }) {
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
    };
    struct IssuedRefresh {
        std::string client_id;
        std::string scope;
        std::string subject;
        int64_t issued_at = 0;
    };

    // Guards everything the listener threads touch: the settings a PUT can
    // change under them, and the two issued-credential maps.
    std::mutex state_mutex;
    MockIssuerSettings settings;
    std::map<std::string, IssuedCode> codes;
    std::map<std::string, IssuedRefresh> refresh_tokens;

    /// Declared last so it is destroyed first: `/token` and `/authorize` read
    /// every field above it while the accept loop is alive.
    ManagedListener listener;

    std::string token_url () const {
        return issuer_url + "/token";
    }
    std::string authorize_url () const {
        return issuer_url + "/authorize";
    }

    /// Description shared by `GET /mock-issuer` and the `PUT` reply.
    nlohmann::json describe () {
        std::lock_guard<std::mutex> lock (state_mutex);
        return nlohmann::json{ { "issuerId", id }, { "issuerUrl", issuer_url },
            { "tokenUrl", token_url () }, { "authorizeUrl", authorize_url () },
            { "signingKey", signing_key }, { "port", port },
            { "expiresInSeconds", settings.expires_in_seconds },
            { "failureMode", settings.failure_mode }, { "slowMs", settings.slow_ms },
            { "issueRefreshTokens", settings.issue_refresh_tokens },
            { "clientCount", settings.clients.size () }, { "createdAt", created_at } };
    }
};

} // namespace detail

namespace {

using Issuer = detail::MockIssuerState;

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
        Issuer::IssuedRefresh{ client_id, scope, subject, now_ms () };
        bound_by_age (issuer.refresh_tokens, mi::MAX_REFRESH_TOKENS);
        body["refresh_token"] = refresh;
    }
    return body;
}

void handle_token (Issuer& issuer, const httplib::Request& req, httplib::Response& res) {
    // The failure mode is read (and `slow` slept) before anything else, so a
    // caller testing retry behaviour sees the same reply whatever it asked for.
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
        std::this_thread::sleep_for (std::chrono::milliseconds (slow_ms));
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
    if (!authenticate_client (issuer.settings, auth)) {
        send_oauth_error (res, 401, "invalid_client",
        auth.client_id.empty () ? "client_id is required" : "Unknown client or bad secret");
        return;
    }

    std::string subject = auth.client_id;
    std::string scope   = req.get_param_value ("scope");

    if (grant == "client_credentials") {
        // Nothing further to check.
    } else if (grant == "password") {
        const std::string username = req.get_param_value ("username");
        if (username.empty () || !req.has_param ("password")) {
            send_oauth_error (res, 400, "invalid_request",
            "password grant needs username and password");
            return;
        }
        subject = username;
    } else if (grant == "authorization_code") {
        const std::string code = req.get_param_value ("code");
        const auto it          = issuer.codes.find (code);
        if (code.empty () || it == issuer.codes.end ()) {
            send_oauth_error (res, 400, "invalid_grant", "Unknown or already-used code");
            return;
        }
        const Issuer::IssuedCode issued = it->second;
        issuer.codes.erase (it); // single use, whatever happens below
        if (now_ms () > issued.issued_at + mi::CODE_TTL_MS) {
            send_oauth_error (res, 400, "invalid_grant", "Authorization code expired");
            return;
        }
        if (issued.client_id != auth.client_id) {
            send_oauth_error (res, 400, "invalid_grant", "Code was issued to another client");
            return;
        }
        if (const std::string redirect = req.get_param_value ("redirect_uri");
        redirect != issued.redirect_uri) {
            send_oauth_error (res, 400, "invalid_grant",
            "redirect_uri does not match the authorize call");
            return;
        }
        if (!issued.code_challenge.empty ()) {
            const std::string verifier = req.get_param_value ("code_verifier");
            if (verifier.empty () || pkce::code_challenge (verifier) != issued.code_challenge) {
                send_oauth_error (res, 400, "invalid_grant", "PKCE verification failed");
                return;
            }
        }
        if (scope.empty ()) {
            scope = issued.scope;
        }
    } else if (grant == "refresh_token") {
        const std::string token = req.get_param_value ("refresh_token");
        const auto it           = issuer.refresh_tokens.find (token);
        if (token.empty () || it == issuer.refresh_tokens.end ()) {
            send_oauth_error (res, 400, "invalid_grant",
            "Unknown or already-rotated refresh token");
            return;
        }
        const Issuer::IssuedRefresh issued = it->second;
        // Rotation: the presented token is spent here, and mint_token_response
        // issues its replacement - so a client that keeps the old one fails,
        // which is exactly the path worth being able to exercise locally.
        issuer.refresh_tokens.erase (it);
        if (issued.client_id != auth.client_id) {
            send_oauth_error (res, 400, "invalid_grant",
            "Refresh token was issued to another client");
            return;
        }
        if (!issued.subject.empty ()) {
            subject = issued.subject;
        }
        if (scope.empty ()) {
            scope = issued.scope;
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
    if (!authenticate_client (issuer.settings, ClientAuth{ client_id, {} })) {
        send_oauth_error (res, 400, "invalid_client",
        client_id.empty () ? "client_id is required" : "Unknown client");
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
        req.get_param_value ("scope"), now_ms () };
    bound_by_age (issuer.codes, mi::MAX_PENDING_CODES);

    std::string location = redirect_uri;
    location.push_back (location.find ('?') == std::string::npos ? '?' : '&');
    location += "code=" + vayu::utils::url_encode (code);
    if (!state.empty ()) {
        location += "&state=" + vayu::utils::url_encode (state);
    }
    res.set_redirect (location, 302);
}

} // namespace

MockIssuerManager::MockIssuerManager () = default;

MockIssuerManager::~MockIssuerManager () {
    std::lock_guard<std::mutex> lock (mutex_);
    for (auto& [id, issuer] : issuers_) {
        teardown (*issuer);
    }
    issuers_.clear ();
}

void MockIssuerManager::teardown (Issuer& issuer) {
    issuer.listener.stop ();
}

MockIssuerStart MockIssuerManager::start (const nlohmann::json& body) {
    MockIssuerStart out;

    auto parsed = parse_mock_issuer_settings (body);
    if (!parsed.ok) {
        out.ok            = false;
        out.error_code    = "mock_issuer_invalid_config";
        out.error_message = parsed.error;
        return out;
    }

    {
        std::lock_guard<std::mutex> lock (mutex_);
        if (issuers_.size () >= mi::MAX_ISSUERS) {
            out.ok            = false;
            out.http_status   = 429;
            out.error_code    = "mock_issuer_limit_reached";
            out.error_message = "At most " + std::to_string (mi::MAX_ISSUERS) +
            " mock issuers may run at once - stop one first";
            return out;
        }
    }

    auto issuer        = std::make_unique<Issuer> ();
    issuer->id         = vayu::utils::generate_id ("issuer_");
    issuer->created_at = now_ms ();
    issuer->settings   = std::move (parsed.settings);
    // The signing key is base64url text rather than raw bytes so it can be
    // handed to a service under test as a shared secret verbatim.
    issuer->signing_key = pkce::random_token (32);

    Issuer* raw = issuer.get ();
    raw->listener.server ().Post (
    "/token", [raw] (const httplib::Request& req, httplib::Response& res) {
        handle_token (*raw, req, res);
    });
    raw->listener.server ().Get (
    "/authorize", [raw] (const httplib::Request& req, httplib::Response& res) {
        handle_authorize (*raw, req, res);
    });

    // 127.0.0.1 only, never configurable: the issuer mints bearer tokens and
    // the engine has no route auth, so a wider bind would hand them to the LAN.
    const auto started = issuer->listener.start (
    "127.0.0.1", issuer->settings.port, "mock issuer " + issuer->id);
    if (started.port <= 0) {
        const std::string requested =
        "Could not bind 127.0.0.1:" + std::to_string (issuer->settings.port);
        out.ok          = false;
        out.http_status = 500;
        out.error_code  = "mock_issuer_bind_failed";
        if (!started.held_by.empty ()) {
            out.error_message =
            requested + " - " + started.held_by + " is already listening there";
        } else {
            out.error_message = issuer->settings.port == 0 ?
            "Could not bind a local port for the mock issuer" :
            requested;
        }
        return out;
    }
    issuer->port       = started.port;
    issuer->issuer_url = "http://127.0.0.1:" + std::to_string (started.port);

    out.issuer_id     = issuer->id;
    out.issuer_url    = issuer->issuer_url;
    out.token_url     = issuer->token_url ();
    out.authorize_url = issuer->authorize_url ();
    out.signing_key   = issuer->signing_key;

    vayu::utils::log_info (
    "Mock OAuth2 issuer started at " + issuer->issuer_url + " (" + issuer->id + ")");
    {
        std::lock_guard<std::mutex> lock (mutex_);
        issuers_[out.issuer_id] = std::move (issuer);
    }
    return out;
}

bool MockIssuerManager::stop (const std::string& issuer_id) {
    std::unique_ptr<Issuer> issuer;
    {
        std::lock_guard<std::mutex> lock (mutex_);
        const auto it = issuers_.find (issuer_id);
        if (it == issuers_.end ()) {
            return false;
        }
        issuer = std::move (it->second);
        issuers_.erase (it);
    }
    // Torn down outside the manager lock: stop() joins the listener thread, and
    // a handler still in flight there would otherwise block every other caller.
    teardown (*issuer);
    vayu::utils::log_info ("Mock OAuth2 issuer stopped (" + issuer_id + ")");
    return true;
}

nlohmann::json MockIssuerManager::list () const {
    std::lock_guard<std::mutex> lock (mutex_);
    auto issuers = nlohmann::json::array ();
    for (const auto& [id, issuer] : issuers_) {
        issuers.push_back (issuer->describe ());
    }
    return nlohmann::json{ { "issuers", std::move (issuers) } };
}

MockIssuerManager::UpdateResult
MockIssuerManager::update (const std::string& issuer_id, const nlohmann::json& body) {
    UpdateResult out;
    std::lock_guard<std::mutex> lock (mutex_);
    const auto it = issuers_.find (issuer_id);
    if (it == issuers_.end ()) {
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
}

namespace routes {

void register_mock_issuer_routes (RouteContext& ctx) {
    ctx.server.Post ("/mock-issuer/start",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        vayu::utils::log_info ("POST /mock-issuer/start");
        nlohmann::json body = nlohmann::json::object ();
        if (!req.body.empty ()) {
            try {
                body = nlohmann::json::parse (req.body);
            } catch (const nlohmann::json::exception& e) {
                send_error (res, 400, std::string ("Invalid JSON: ") + e.what (),
                "mock_issuer_invalid_config");
                return;
            }
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
        { "authorizeUrl", result.authorize_url }, { "signingKey", result.signing_key } }
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
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const nlohmann::json::exception& e) {
            send_error (res, 400, std::string ("Invalid JSON: ") + e.what (),
            "mock_issuer_invalid_config");
            return;
        }
        const auto result = ctx.mock_issuer_manager.update (id, body);
        if (!result.found) {
            send_error (res, 404, "Mock issuer not found: " + id);
            return;
        }
        if (!result.ok) {
            send_error (res, 400, result.error, "mock_issuer_invalid_config");
            return;
        }
        res.status = 200;
        res.set_content (result.issuer.dump (), "application/json");
    });
}

} // namespace routes

} // namespace vayu::http
