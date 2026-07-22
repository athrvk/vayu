/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/import.cpp
 * @brief Import URL proxy - fetches a remote collection/spec past browser CORS.
 */

#include "vayu/http/routes.hpp"
#include "vayu/http/client.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <cctype>
#include <utility>

namespace vayu::http::routes {

/**
 * Fetch the URL in `request_body` ({"url": "..."}) via libcurl.
 * @return {http_status, json_body}. Separated from the route for unit testing.
 */
std::pair<int, nlohmann::json> import_fetch (const std::string& request_body) {
    nlohmann::json req;
    try {
        req = nlohmann::json::parse (request_body);
    } catch (const std::exception&) {
        return { 400, nlohmann::json{ { "error", "Invalid JSON body" } } };
    }

    if (!req.contains ("url") || !req["url"].is_string ()) {
        return { 400, nlohmann::json{ { "error", "Invalid URL" } } };
    }
    const std::string url = req["url"].get<std::string> ();
    if (url.rfind ("http://", 0) != 0 && url.rfind ("https://", 0) != 0) {
        return { 400, nlohmann::json{ { "error", "Invalid URL" } } };
    }

    vayu::http::Client client;
    auto result = client.get (url);
    if (!result.is_ok ()) {
        return { 502, nlohmann::json{ { "error", "Failed to fetch: " + client.last_error () } } };
    }

    const auto& resp = result.value ();
    if (resp.has_error ()) {
        const std::string detail =
        resp.error_message.empty () ? "connection error" : resp.error_message;
        return { 502, nlohmann::json{ { "error", "Failed to fetch: " + detail } } };
    }
    std::string content_type = "application/octet-stream";
    for (const auto& [key, value] : resp.headers) {
        std::string lower = key;
        std::transform (lower.begin (), lower.end (), lower.begin (),
        [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
        if (lower == "content-type") {
            content_type = value;
            break;
        }
    }

    return { 200, nlohmann::json{ { "content", resp.body }, { "contentType", content_type } } };
}

void register_import_routes (RouteContext& ctx) {
    ctx.server.Post ("/import/fetch",
    [] (const httplib::Request& req, httplib::Response& res) {
        vayu::utils::log_info ("POST /import/fetch");
        auto [status, body] = import_fetch (req.body);
        res.status = status;
        res.set_content (
        body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    });
}

} // namespace vayu::http::routes
