/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/compose.cpp
 * @brief POST /compose - engine-owned request composition (issue #226).
 *
 * Pure: composes and returns an execute-ready payload, sends nothing, creates
 * no run row. Clients POST the result to /execute or /runs unchanged; those
 * endpoints stay non-interpolating, so a payload is resolved exactly once.
 * The logic lives in compose_request_core (request_composer.cpp) so the tests
 * drive it without an in-process HTTP server.
 */

#include "vayu/http/request_composer.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

void register_compose_routes (RouteContext& ctx) {
    ctx.server.Post ("/compose", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const nlohmann::json::exception& e) {
            vayu::utils::log_warning (
            "POST /compose - Invalid JSON: " + std::string (e.what ()));
            // Nested error shape (issue #173's decided format) - this endpoint
            // postdates that decision, so it never speaks the flat legacy shape.
            res.status = 400;
            res.set_content (
            nlohmann::json{ { "error",
                            { { "code", "invalid_compose_request" },
                            { "message", "Invalid JSON: " + std::string (e.what ()) } } } }
            .dump (),
            "application/json");
            return;
        }

        auto [status, payload] = compose_request_core (ctx.db, body);
        if (status != 200) {
            vayu::utils::log_warning (
            "POST /compose - " + std::to_string (status) + ": " + payload.dump ());
        }
        res.status = status;
        res.set_content (payload.dump (), "application/json");
    });
}

} // namespace vayu::http::routes
