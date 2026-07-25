/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/environments.cpp
 * @brief Environment management routes
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <optional>
#include <string>
#include <utility>

namespace vayu::http::routes {

/**
 * Applies the request body onto `e` under the one null-vs-absent rule (see the
 * helpers in routes.hpp). Shared by the create and update cores.
 *
 * This is where the `"null"`-string bug died: the old handler wrote
 * `e.variables = json["variables"].dump()` with no null guard, so
 * `{"variables": null}` stored the four-character text `null` - a value that
 * parses as JSON but is not an object, so every reader silently saw no
 * variables at all. `apply_json_field` resets it to `{}` instead.
 *
 * `isActive` used to be honoured only on create, which left an update unable to
 * change it; it now follows the same rule on both verbs.
 */
static std::optional<std::pair<int, nlohmann::json>>
apply_environment_fields (vayu::db::Environment& e, const nlohmann::json& json, bool is_create) {
    if (auto err = apply_required_string_field (json, "name", e.name, is_create)) {
        return err;
    }
    apply_string_field (json, "description", e.description, "", is_create);
    apply_json_field (json, "variables", e.variables, "{}", is_create);
    apply_bool_field (json, "isActive", e.is_active, false, is_create);
    return std::nullopt;
}

/**
 * Testable core of POST /environments - **create only**, returning
 * {http_status, json_body}. An id that already exists is a 409 pointing at PUT;
 * POST never updates (issue #95).
 */
std::pair<int, nlohmann::json>
create_environment_response (vayu::db::Database& db, const nlohmann::json& json) {
    std::string id;
    if (json.contains ("id") && !json["id"].is_null ()) {
        id = json["id"].get<std::string> ();
    } else {
        id = vayu::utils::generate_id ("env_");
    }

    if (db.get_environment (id).has_value ()) {
        return { 409,
            nlohmann::json{ { "error",
            "Environment '" + id + "' already exists; use PUT /environments/:id to update" } } };
    }

    vayu::db::Environment e;
    e.id         = id;
    e.created_at = now_ms ();
    e.updated_at = now_ms ();

    if (auto err = apply_environment_fields (e, json, /*is_create=*/true)) {
        return *err;
    }

    db.save_environment (e);
    return { 200, vayu::json::serialize (e) };
}

/**
 * Testable core of PUT /environments/:id - **update only**, returning
 * {http_status, json_body}. A missing id is a 404 rather than a silent create.
 * Merge-patch semantics, same as collections and requests.
 */
std::pair<int, nlohmann::json> update_environment_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    auto existing = db.get_environment (id);
    if (!existing) {
        return { 404, nlohmann::json{ { "error", "Environment not found" } } };
    }

    vayu::db::Environment e = *existing;
    if (auto err = apply_environment_fields (e, json, /*is_create=*/false)) {
        return *err;
    }
    e.updated_at = now_ms ();

    db.save_environment (e);
    return { 200, vayu::json::serialize (e) };
}

void register_environment_routes (RouteContext& ctx) {
    /**
     * GET /environments
     * Retrieves all saved environments from the database.
     * Environments contain variables that can be used in requests (e.g., API keys, base URLs).
     * Returns: Array of environment objects with id, name, variables, and timestamps.
     */
    ctx.server.Get ("/environments", [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info ("GET /environments - Fetching all environments");
        auto envs               = ctx.db.get_environments ();
        nlohmann::json response = nlohmann::json::array ();
        for (const auto& e : envs) {
            response.push_back (vayu::json::serialize (e));
        }
        vayu::utils::log_debug ("GET /environments - Returning " +
        std::to_string (envs.size ()) + " environments");
        res.set_content (response.dump (), "application/json");
    });

    /**
     * POST /environments
     * Creates an environment. Create only - an `id` that already exists is a
     * 409 pointing at PUT, never a silent update (issue #95).
     * Body params: id (optional string - generated when absent), name
     * (required string), description, variables (object), isActive (bool).
     * Returns: The created environment object, 409 on an existing id, or 400.
     */
    ctx.server.Post ("/environments",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = create_environment_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /environments - " +
                std::to_string (status) + ": " + body["error"].get<std::string> ());
            } else {
                vayu::utils::log_info (
                "POST /environments - Created environment: id=" + body["id"].get<std::string> () +
                ", name=" + body["name"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /environments - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * PUT /environments/:id
     * Updates an existing environment (merge-patch: absent fields keep their
     * value, null resets to the default - `variables: null` resets to `{}`).
     * Update only - a missing id is a 404, never a silent create (issue #95).
     * Path params: id - The environment ID to update.
     * Returns: The updated environment object, 404 if it does not exist, or 400.
     */
    ctx.server.Put (R"(/environments/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string environment_id = req.matches[1];
        try {
            auto json = nlohmann::json::parse (req.body);
            auto [status, body] =
            update_environment_response (ctx.db, environment_id, json);
            if (status != 200) {
                vayu::utils::log_warning ("PUT /environments/:id - " +
                std::to_string (status) + " for id=" + environment_id + ": " +
                body["error"].get<std::string> ());
            } else {
                vayu::utils::log_info (
                "PUT /environments/:id - Updated environment: id=" + environment_id +
                ", name=" + body["name"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "PUT /environments/:id - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * DELETE /environments/:id
     * Deletes an environment by ID.
     */
    ctx.server.Delete (R"(/environments/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string id = req.matches[1];
        vayu::utils::log_info ("DELETE /environments/" + id);

        auto existing = ctx.db.get_environment (id);
        if (!existing) {
            send_error (res, 404, "Environment not found");
            return;
        }

        ctx.db.delete_environment (id);
        res.set_content (R"({"success": true})", "application/json");
    });
}

} // namespace vayu::http::routes
