/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/globals.cpp
 * @brief Global variables management routes
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <string>
#include <utility>

namespace vayu::http::routes {

/**
 * Testable core of POST /globals, returning {http_status, json_body}.
 *
 * Globals is a singleton with no create/update split - there is one row, always
 * addressed by the same id, so `POST /globals` saves it whole. That makes every
 * write a "create" as far as the one null-vs-absent rule is concerned (issue
 * #95, helpers in routes.hpp): absent and `null` both mean the default, `{}`.
 *
 * Globals was the resource the verb split did not reach, so it kept the bug
 * that split killed for environments - `g.variables = json["variables"].dump()`
 * with no null guard, which stored the four-character text `null` for
 * `{"variables": null}`. That value parses as JSON but is not an object, and
 * `GET /globals` falls back to `{}` on anything it cannot read as one, so the
 * corruption surfaced as globals silently disappearing rather than as an error.
 * Applying the shared helper here rather than re-deriving the rule is what
 * keeps the fourth resource from drifting again.
 */
std::pair<int, nlohmann::json>
save_globals_response (vayu::db::Database& db, const nlohmann::json& json) {
    vayu::db::Globals g;
    g.id = "globals"; // Singleton ID

    if (auto err = apply_json_field (json, "variables", g.variables, "{}", /*is_create=*/true)) {
        return *err;
    }

    g.updated_at = now_ms ();

    // Count variables for logging
    int var_count = 0;
    if (json.contains ("variables") && json["variables"].is_object ()) {
        var_count = static_cast<int> (json["variables"].size ());
    }

    vayu::utils::log_info (
    "POST /globals - Saving global variables, count=" + std::to_string (var_count));

    db.save_globals (g);

    nlohmann::json response;
    response["id"]        = g.id;
    response["updatedAt"] = g.updated_at;
    try {
        response["variables"] = nlohmann::json::parse (g.variables);
    } catch (...) {
        response["variables"] = nlohmann::json::object ();
    }

    return { 200, response };
}

void register_globals_routes (RouteContext& ctx) {
    /**
     * GET /globals
     * Retrieves the global variables.
     * Returns: Object with id, variables, and updatedAt.
     */
    ctx.server.Get ("/globals", [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info ("GET /globals - Fetching global variables");
        auto globals = ctx.db.get_globals ();

        if (!globals) {
            // Return empty globals if none exist
            nlohmann::json response;
            response["id"]        = "globals";
            response["variables"] = nlohmann::json::object ();
            response["updatedAt"] = 0;
            res.set_content (response.dump (), "application/json");
            return;
        }

        nlohmann::json response;
        response["id"]        = globals->id;
        response["updatedAt"] = globals->updated_at;

        // Parse variables JSON
        if (globals->variables.empty ()) {
            response["variables"] = nlohmann::json::object ();
        } else {
            try {
                response["variables"] = nlohmann::json::parse (globals->variables);
            } catch (...) {
                response["variables"] = nlohmann::json::object ();
            }
        }

        vayu::utils::log_debug ("GET /globals - Returning global variables");
        res.set_content (response.dump (), "application/json");
    });

    /**
     * POST /globals
     * Creates or updates global variables.
     * Body params: variables (object)
     * Returns: The saved globals object.
     */
    ctx.server.Post ("/globals", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse (req.body);

            auto [status, body] = save_globals_response (ctx.db, json);
            res.status          = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("POST /globals - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });
}

} // namespace vayu::http::routes
