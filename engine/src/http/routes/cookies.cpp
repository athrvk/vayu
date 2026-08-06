/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/cookies.cpp
 * @brief See and clear the design-mode cookie jar (issue #301).
 *
 * A session the user cannot inspect or reset is a support problem: "why is
 * this request authenticated when I never sent a token" has no answer without
 * a way to look, and "clear cookies" is the first thing anyone reaches for
 * when a stale session breaks a call. These two endpoints are that, and they
 * are the whole user-visible surface of the jar's lifetime.
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <string>

namespace vayu::http::routes {

/**
 * Testable core of GET /cookies.
 *
 * Values are included. The response viewer already shows `Set-Cookie` in
 * full, so withholding them here would hide nothing the app cannot already
 * see, while making the panel useless for the case it exists to answer -
 * "which session is this request actually using". They stay out of the logs,
 * where redaction does apply (`debug_redact.hpp`).
 */
nlohmann::json cookies_response (const vayu::http::CookieJar& jar) {
    nlohmann::json scopes = nlohmann::json::array ();
    for (const auto& scope : jar.snapshot ()) {
        nlohmann::json entry;
        // null, not "", for the no-environment jar: the app renders a name for
        // an id and a placeholder for null, and an empty string would be an id
        // it could never resolve.
        entry["environmentId"] = scope.environment_id.has_value () ?
        nlohmann::json (*scope.environment_id) :
        nlohmann::json (nullptr);
        nlohmann::json cookies = nlohmann::json::array ();
        for (const auto& cookie : scope.cookies) {
            // No `includeSubdomains`: the panel has no reader for it, and the
            // leading dot libcurl writes on a `Domain=` cookie already shows
            // the same thing where it matters. It stays a jar field because
            // `cookie_matches` needs it.
            cookies.push_back ({ { "name", cookie.name },
            { "value", cookie.value }, { "domain", cookie.domain },
            { "path", cookie.path }, { "secure", cookie.secure },
            { "httpOnly", cookie.http_only }, { "expires", cookie.expires } });
        }
        entry["cookies"] = std::move (cookies);
        scopes.push_back (std::move (entry));
    }

    nlohmann::json response;
    response["scopes"] = std::move (scopes);
    return response;
}

/**
 * Testable core of DELETE /cookies.
 *
 * @param scope The `environmentId` query parameter if it was present at all -
 *        the engine's null-vs-absent rule (see routes.hpp) in a query string:
 *        absent clears every jar, present-and-empty clears the no-environment
 *        jar, present-with-an-id clears that environment's. An empty value is
 *        a real request rather than a mistake, because `NO_ENVIRONMENT_SCOPE`
 *        is exactly the jar an id cannot name.
 */
nlohmann::json clear_cookies_response (vayu::http::CookieJar& jar,
const std::optional<std::string>& scope) {
    const size_t cleared = scope ? jar.clear (*scope) : jar.clear_all ();
    nlohmann::json response;
    response["cleared"] = cleared;
    return response;
}

void register_cookie_routes (RouteContext& ctx) {
    /**
     * GET /cookies
     * The jar's contents, one entry per scope that holds anything.
     */
    ctx.server.Get ("/cookies", [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_debug ("GET /cookies - Reading the cookie jar");
        res.set_content (cookies_response (ctx.cookie_jar).dump (), "application/json");
    });

    /**
     * DELETE /cookies[?environmentId=<id>]
     * Clears one scope's jar, or every one when the parameter is absent.
     * Returns: { "cleared": <number of cookies dropped> }
     */
    ctx.server.Delete (
    "/cookies", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::optional<std::string> scope =
        req.has_param ("environmentId") ?
        std::optional<std::string> (req.get_param_value ("environmentId")) :
        std::nullopt;
        auto response = clear_cookies_response (ctx.cookie_jar, scope);
        vayu::utils::log_info ("DELETE /cookies - scope=" +
        (scope ? (scope->empty () ? std::string ("none") : *scope) : std::string ("all")) +
        ", cleared=" + std::to_string (response["cleared"].get<size_t> ()));
        res.set_content (response.dump (), "application/json");
    });
}

} // namespace vayu::http::routes
