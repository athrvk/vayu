/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/oauth_authorize.cpp
 * @brief Interactive OAuth 2.0 authorization-code manager (engine-hosted
 *        loopback + PKCE) plus the URL builder. Lives with the routes because
 *        the loopback listener needs httplib (linked into the engine + tests).
 */

#include "vayu/http/oauth_authorize.hpp"

#include "vayu/http/oauth_client.hpp"
#include "vayu/http/pkce.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/logger.hpp"

#include <httplib.h>

#include <atomic>
#include <chrono>
#include <thread>
#include <variant>

namespace vayu::http {

namespace {

constexpr int64_t kAttemptTtlMs = 5 * 60 * 1000; // 5 minutes

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

std::string field (const nlohmann::json& obj, const char* key) {
    if (auto it = obj.find (key); it != obj.end () && it->is_string ()) {
        return it->get<std::string> ();
    }
    return {};
}

std::string url_decode (const std::string& in) {
    std::string out;
    out.reserve (in.size ());
    for (size_t i = 0; i < in.size (); ++i) {
        if (in[i] == '+') {
            out.push_back (' ');
        } else if (in[i] == '%' && i + 2 < in.size ()) {
            out.push_back (
            static_cast<char> (std::stoi (in.substr (i + 1, 2), nullptr, 16)));
            i += 2;
        } else {
            out.push_back (in[i]);
        }
    }
    return out;
}

// Parse a query string ("a=1&b=2") into decoded key/value pairs.
std::map<std::string, std::string> parse_query (const std::string& query) {
    std::map<std::string, std::string> out;
    size_t pos = 0;
    while (pos < query.size ()) {
        const auto amp = query.find ('&', pos);
        const auto pair =
        query.substr (pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (const auto eq = pair.find ('='); eq != std::string::npos) {
            out[url_decode (pair.substr (0, eq))] = url_decode (pair.substr (eq + 1));
        }
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return out;
}

std::string generate_attempt_id () {
    return "oauth_" + std::to_string (now_ms ()) + "_" + pkce::random_token (6);
}

} // namespace

std::string build_authorize_url (const nlohmann::json& config,
const std::string& state, const std::string& code_challenge,
const std::string& redirect_uri, bool pkce) {
    std::string url = field (config, "authorizationUrl");

    std::vector<std::pair<std::string, std::string>> params = {
        { "response_type", "code" },
        { "client_id", field (config, "clientId") },
        { "redirect_uri", redirect_uri },
        { "state", state },
    };
    if (const auto scope = field (config, "scope"); !scope.empty ()) {
        params.emplace_back ("scope", scope);
    }
    if (const auto audience = field (config, "audience"); !audience.empty ()) {
        params.emplace_back ("audience", audience);
    }
    if (const auto resource = field (config, "resource"); !resource.empty ()) {
        params.emplace_back ("resource", resource);
    }
    if (pkce) {
        params.emplace_back ("code_challenge", code_challenge);
        params.emplace_back ("code_challenge_method", "S256");
    }

    url.push_back (url.find ('?') == std::string::npos ? '?' : '&');
    url += vayu::utils::form_encode (params);
    return url;
}

// ---------------------------------------------------------------------------
// Attempt + manager
// ---------------------------------------------------------------------------

struct OAuth2AuthorizeManager::Attempt {
    std::string state;
    std::string code_verifier;
    nlohmann::json config;
    std::string redirect_uri;
    bool pkce = true;
    int64_t created_at = 0;

    // "pending" | "completed" | "failed"
    std::atomic<int> result_state{ 0 }; // 0 pending, 1 completed, 2 failed
    std::string error;
    std::string cache_key;

    std::unique_ptr<httplib::Server> server; // loopback mode only
    std::thread listen_thread;
};

OAuth2AuthorizeManager::OAuth2AuthorizeManager () = default;

OAuth2AuthorizeManager::~OAuth2AuthorizeManager () {
    std::lock_guard<std::mutex> lock (mutex_);
    for (auto& [id, attempt] : attempts_) {
        teardown_locked (*attempt);
    }
    attempts_.clear ();
}

void OAuth2AuthorizeManager::teardown_locked (Attempt& attempt) {
    if (attempt.server) {
        attempt.server->stop ();
    }
    if (attempt.listen_thread.joinable ()) {
        attempt.listen_thread.join ();
    }
    attempt.server.reset ();
}

void OAuth2AuthorizeManager::reap_timed_out_locked () {
    const int64_t now = now_ms ();
    for (auto& [id, attempt] : attempts_) {
        if (attempt->result_state.load () == 0 &&
            now > attempt->created_at + kAttemptTtlMs) {
            attempt->result_state.store (2);
            attempt->error = "Authorization timed out";
            teardown_locked (*attempt);
        }
    }
}

AuthorizeStart OAuth2AuthorizeManager::start (vayu::db::Database& db,
const nlohmann::json& config, const std::string& mode) {
    AuthorizeStart out;

    if (!config.is_object () || field (config, "authorizationUrl").empty () ||
        field (config, "clientId").empty ()) {
        out.ok            = false;
        out.error_code    = "oauth2_invalid_config";
        out.error_message = "authorizationUrl and clientId are required";
        return out;
    }

    auto attempt        = std::make_unique<Attempt> ();
    attempt->config     = config;
    attempt->created_at = now_ms ();
    attempt->pkce       = [&] {
        auto it = config.find ("pkce");
        return it == config.end () || !it->is_boolean () || it->get<bool> ();
    }();
    attempt->state         = pkce::random_token (16);
    attempt->code_verifier = attempt->pkce ? pkce::random_token (32) : std::string{};
    const std::string challenge =
    attempt->pkce ? pkce::code_challenge (attempt->code_verifier) : std::string{};

    const std::string attempt_id = generate_attempt_id ();

    if (mode == "embedded") {
        const std::string callback = field (config, "callbackUrl");
        if (callback.empty ()) {
            out.ok            = false;
            out.error_code    = "oauth2_invalid_config";
            out.error_message = "callbackUrl is required for embedded mode";
            return out;
        }
        attempt->redirect_uri = callback;
    } else {
        // Loopback: bind a one-shot listener on an ephemeral 127.0.0.1 port.
        attempt->server = std::make_unique<httplib::Server> ();
        Attempt* raw    = attempt.get ();

        attempt->server->Get ("/callback",
        [raw, &db] (const httplib::Request& req, httplib::Response& res) {
            const auto params = parse_query (req.target.find ('?') != std::string::npos
                    ? req.target.substr (req.target.find ('?') + 1)
                    : std::string{});
            std::string body =
            "<html><body style='font-family:sans-serif;padding:2rem'>";

            if (const auto err = params.find ("error"); err != params.end ()) {
                raw->error = err->second;
                if (auto d = params.find ("error_description"); d != params.end ()) {
                    raw->error += ": " + d->second;
                }
                raw->result_state.store (2);
                body += "<h3>Authorization failed</h3><p>You can close this tab.</p>";
            } else if (params.count ("state") == 0 ||
            params.at ("state") != raw->state) {
                raw->error = "State mismatch (possible CSRF)";
                raw->result_state.store (2);
                body += "<h3>Authorization failed</h3><p>You can close this tab.</p>";
            } else {
                const std::string code =
                params.count ("code") ? params.at ("code") : "";
                oauth::InteractiveExchange ex{ code, raw->code_verifier,
                    raw->redirect_uri };
                auto result = oauth::acquire_token (db, raw->config, false, ex);
                if (std::holds_alternative<vayu::db::OAuthToken> (result)) {
                    raw->cache_key = oauth::cache_key (raw->config);
                    raw->result_state.store (1);
                    body += "<h3>Authorization received</h3><p>You can close this tab.</p>";
                } else {
                    raw->error = std::get<oauth::TokenError> (result).message;
                    raw->result_state.store (2);
                    body += "<h3>Token exchange failed</h3><p>You can close this tab.</p>";
                }
            }
            body += "</body></html>";
            res.set_content (body, "text/html");
        });

        const int port = attempt->server->bind_to_any_port ("127.0.0.1");
        if (port <= 0) {
            out.ok            = false;
            out.http_status   = 500;
            out.error_code    = "oauth2_loopback_failed";
            out.error_message = "Could not bind a local callback port";
            return out;
        }
        attempt->redirect_uri =
        "http://127.0.0.1:" + std::to_string (port) + "/callback";
        httplib::Server* svr   = attempt->server.get ();
        attempt->listen_thread = std::thread ([svr] { svr->listen_after_bind (); });

        // Wait until the accept loop is live before returning; otherwise a
        // stop() that races ahead of listen() is missed and join() hangs.
        for (int i = 0; i < 200 && !svr->is_running (); ++i) {
            std::this_thread::sleep_for (std::chrono::milliseconds (1));
        }
    }

    out.attempt_id    = attempt_id;
    out.redirect_uri  = attempt->redirect_uri;
    out.authorize_url = build_authorize_url (config, attempt->state, challenge,
    attempt->redirect_uri, attempt->pkce);

    {
        std::lock_guard<std::mutex> lock (mutex_);
        reap_timed_out_locked ();
        attempts_[attempt_id] = std::move (attempt);
    }
    vayu::utils::log_info ("OAuth2 authorize started (" + mode + "): " + attempt_id);
    return out;
}

AuthorizeStatus OAuth2AuthorizeManager::complete (vayu::db::Database& db,
const std::string& attempt_id, const std::string& callback_url) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = attempts_.find (attempt_id);
    if (it == attempts_.end ()) {
        return { "not_found", "", "" };
    }
    Attempt& attempt = *it->second;

    const auto qpos = callback_url.find ('?');
    const auto params =
    parse_query (qpos == std::string::npos ? "" : callback_url.substr (qpos + 1));

    if (const auto err = params.find ("error"); err != params.end ()) {
        attempt.result_state.store (2);
        attempt.error = err->second;
    } else if (params.count ("state") == 0 || params.at ("state") != attempt.state) {
        attempt.result_state.store (2);
        attempt.error = "State mismatch (possible CSRF)";
    } else {
        const std::string code = params.count ("code") ? params.at ("code") : "";
        oauth::InteractiveExchange ex{ code, attempt.code_verifier, attempt.redirect_uri };
        auto result = oauth::acquire_token (db, attempt.config, false, ex);
        if (std::holds_alternative<vayu::db::OAuthToken> (result)) {
            attempt.cache_key = oauth::cache_key (attempt.config);
            attempt.result_state.store (1);
        } else {
            attempt.error = std::get<oauth::TokenError> (result).message;
            attempt.result_state.store (2);
        }
    }

    const int s = attempt.result_state.load ();
    return { s == 1 ? "completed" : "failed", attempt.error, attempt.cache_key };
}

AuthorizeStatus OAuth2AuthorizeManager::status (const std::string& attempt_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    reap_timed_out_locked ();
    auto it = attempts_.find (attempt_id);
    if (it == attempts_.end ()) {
        return { "not_found", "", "" };
    }
    Attempt& attempt = *it->second;
    const int s      = attempt.result_state.load ();
    if (s == 0) {
        return { "pending", "", "" };
    }
    // Terminal: free the listener but keep the (small) result record so repeat
    // polls are idempotent.
    teardown_locked (attempt);
    return { s == 1 ? "completed" : "failed", attempt.error, attempt.cache_key };
}

void OAuth2AuthorizeManager::cancel (const std::string& attempt_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    if (auto it = attempts_.find (attempt_id); it != attempts_.end ()) {
        teardown_locked (*it->second);
        attempts_.erase (it);
    }
}

} // namespace vayu::http
