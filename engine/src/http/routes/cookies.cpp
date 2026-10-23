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

#include "vayu/http/list_page.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

// null, not "", for the no-environment jar: the app renders a name for an id
// and a placeholder for null, and an empty string would be an id it could
// never resolve.
nlohmann::json environment_id_json (const std::optional<std::string>& environment_id) {
    return environment_id.has_value () ? nlohmann::json (*environment_id) :
                                         nlohmann::json (nullptr);
}

nlohmann::json cookie_json (const vayu::http::JarCookie& cookie) {
    // No `includeSubdomains`: the panel has no reader for it, and the leading
    // dot libcurl writes on a `Domain=` cookie already shows the same thing
    // where it matters. It stays a jar field because `cookie_matches` needs it.
    return { { "name", cookie.name }, { "value", cookie.value },
        { "domain", cookie.domain }, { "path", cookie.path }, { "secure", cookie.secure },
        { "httpOnly", cookie.http_only }, { "expires", cookie.expires } };
}

/// One cookie of the paged answer, carrying the scope it sits in.
struct ScopedCookie {
    std::optional<std::string> environment_id;
    vayu::http::JarCookie cookie;
};

/// Every cookie in scope-key order, then each jar's own line order.
std::vector<ScopedCookie> flatten (std::vector<vayu::http::CookieScopeView> scopes) {
    std::vector<ScopedCookie> flat;
    for (auto& scope : scopes) {
        for (auto& cookie : scope.cookies) {
            flat.push_back ({ scope.environment_id, std::move (cookie) });
        }
    }
    return flat;
}

nlohmann::json scoped_cookie_json (const ScopedCookie& scoped) {
    auto row             = cookie_json (scoped.cookie);
    row["environmentId"] = environment_id_json (scoped.environment_id);
    return row;
}

} // namespace

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
        entry["environmentId"] = environment_id_json (scope.environment_id);
        nlohmann::json cookies = nlohmann::json::array ();
        for (const auto& cookie : scope.cookies) {
            cookies.push_back (cookie_json (cookie));
        }
        entry["cookies"] = std::move (cookies);
        scopes.push_back (std::move (entry));
    }

    nlohmann::json response;
    response["scopes"] = std::move (scopes);
    return response;
}

/**
 * Testable core of GET /cookies with its query, returning
 * {http_status, json_body}: `cookies_response` when @p page_query names none
 * of `q` / `limit` / `offset`, and otherwise one page of the cookies whose
 * name or domain holds `q`, flattened out of their scopes (each row carries
 * its scope's `environmentId`), in the `{data, pagination}` envelope (#2443).
 */
std::pair<int, nlohmann::json> cookies_response (const vayu::http::CookieJar& jar,
const ListPageQuery& page_query) {
    if (!page_query.present ()) {
        return { 200, cookies_response (jar) };
    }
    const auto page = parse_list_page (page_query);
    if (!page) {
        return as_response (page.error ());
    }
    return { 200,
        list_page_of (
        *page, flatten (jar.snapshot ()),
        [&page] (const ScopedCookie& scoped) {
            return page->matches (scoped.cookie.name) ||
            page->matches (scoped.cookie.domain);
        },
        scoped_cookie_json) };
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
     * Query params: q, limit, offset (optional) - any of them answers one page
     * of the cookies whose name or domain holds `q`, flattened out of their
     * scopes, in the `{data, pagination}` envelope (#2443).
     */
    ctx.server.Get ("/cookies", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto [status, body] =
            cookies_response (ctx.cookie_jar, list_page_query (req));
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "GET /cookies - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
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
        std::string scope_label;
        if (!scope) {
            scope_label = "all";
        } else if (scope->empty ()) {
            scope_label = "none";
        } else {
            scope_label = *scope;
        }
        vayu::utils::log_info ("http", "Cleared cookies",
        { { "scope", scope_label }, { "cleared", response["cleared"].get<size_t> () } });
        res.set_content (response.dump (), "application/json");
    });
}

} // namespace vayu::http::routes
