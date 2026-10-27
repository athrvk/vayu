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

#include <functional>
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
 * change it; it now follows the same rule on both verbs. Storing `true` here is
 * how a client says "make this the active environment": the DB layer clears the
 * previous one in the same transaction (`deactivate_other_environments_locked`),
 * so the route needs no deactivate step of its own and there is no verb for
 * "clear all" beyond writing `isActive: false` to the active one.
 *
 * Declared in routes.hpp because `POST /import/apply` applies the same fields to
 * every environment in a bulk payload (issue #96).
 */
RouteResult apply_environment_fields (vayu::db::Environment& e,
const nlohmann::json& json,
bool is_create) {
    if (auto outcome = apply_required_string_field (json, "name", e.name, is_create); !outcome) {
        return outcome;
    }
    apply_string_field (json, "description", e.description, "", is_create);
    if (auto outcome = apply_json_field (json, "variables", e.variables, "{}", is_create);
    !outcome) {
        return outcome;
    }
    apply_bool_field (json, "isActive", e.is_active, false, is_create);
    return {};
}

/**
 * Testable core of POST /environments - **create only**, returning
 * {http_status, json_body}. An id that already exists is a 409 pointing at PUT;
 * POST never updates (issue #95). A body `id` is rejected outright (#97) - see
 * create_collection_response for why the 409 stays behind an engine-generated
 * id.
 */
std::pair<int, nlohmann::json>
create_environment_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (auto outcome = reject_client_supplied_id (json); !outcome) {
        return as_response (outcome.error ());
    }
    const std::string id = vayu::utils::generate_id ("env_");

    if (db.get_environment (id).has_value ()) {
        return { 409, error_body (409, "Environment '" + id + "' already exists; use PUT /environments/:id to update") };
    }

    vayu::db::Environment e;
    e.id         = id;
    e.created_at = now_ms ();
    e.updated_at = now_ms ();

    if (auto outcome = apply_environment_fields (e, json, /*is_create=*/true); !outcome) {
        return as_response (outcome.error ());
    }

    db.save_environment (e);
    return { 200, vayu::json::serialize (e) };
}

/** The read-merge-write of PUT /environments/:id, run under the caller's lock. */
static std::pair<int, nlohmann::json> update_environment_locked (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::optional<vayu::http::IfMatch>& if_match,
const std::function<void ()>& before_write) {
    if (auto outcome = reject_mismatched_body_id (json, id); !outcome) {
        return as_response (outcome.error ());
    }
    auto existing = db.get_environment (id);
    if (!existing) {
        return { 404, error_body (404, "Environment not found") };
    }
    if (auto held = check_if_match (if_match, existing->updated_at); !held) {
        return as_response (held.error ());
    }

    vayu::db::Environment e = *existing;
    if (auto outcome = apply_environment_fields (e, json, /*is_create=*/false); !outcome) {
        return as_response (outcome.error ());
    }
    e.updated_at = next_updated_at (existing->updated_at);

    if (before_write) {
        before_write ();
    }
    db.save_environment (e);
    return { 200, vayu::json::serialize (e) };
}

/**
 * Testable core of PUT /environments/:id - **update only**, returning
 * {http_status, json_body}. A missing id is a 404 rather than a silent create.
 * Merge-patch semantics, same as collections and requests - including the 400
 * on a body `id` that disagrees with the path (#97).
 *
 * **The read, the merge and the write are one lock scope** (#1440), for the
 * reason `update_request_response` states: a merge-patch write carries the
 * fields the body did not name, so a read that is not held to the write loses
 * whichever writer read first. A client that merges across two round trips
 * (MCP's `update_environment`) closes its own window with @p if_match, which
 * is judged inside this scope (#2433).
 *
 * @param if_match The request's `If-Match`; a row it no longer names is a 412.
 * @param before_write Test seam, invoked inside the lock scope with the merged
 *        row staged and immediately before it is written; see
 *        `update_request_response` for why it is an overload.
 */
std::pair<int, nlohmann::json> update_environment_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::optional<vayu::http::IfMatch>& if_match,
const std::function<void ()>& before_write) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        result = update_environment_locked (db, id, json, if_match, before_write);
    });
    return result;
}

std::pair<int, nlohmann::json> update_environment_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    return update_environment_response (db, id, json, std::nullopt, before_write);
}

std::pair<int, nlohmann::json> update_environment_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    return update_environment_response (db, id, json, std::nullopt, nullptr);
}

/**
 * Testable core of DELETE /environments/:id - a soft delete (#2970): the row
 * is stamped and deactivated, `GET /trash` lists it, and every read here
 * answers 404 for it, a second delete included. The existence check and the
 * stamp are one lock scope, so of two racing deletes only one answers 200.
 */
std::pair<int, nlohmann::json>
delete_environment_response (vayu::db::Database& db, const std::string& id) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        if (!db.get_environment (id)) {
            result = error_response (404, "Environment not found");
            return;
        }
        db.delete_environment (id);
        result = { 200, nlohmann::json{ { "success", true } } };
    });
    return result;
}

void register_environment_routes (RouteContext& ctx) {
    /**
     * GET /environments
     * Retrieves all saved environments from the database.
     * Environments contain variables that can be used in requests (e.g., API keys, base URLs).
     * Returns: Array of environment objects with id, name, variables, and timestamps.
     */
    ctx.server.Get ("/environments", [&ctx] (const httplib::Request&, httplib::Response& res) {
        auto envs               = ctx.db.get_environments ();
        nlohmann::json response = nlohmann::json::array ();
        for (const auto& e : envs) {
            response.push_back (vayu::json::serialize (e));
        }
        vayu::utils::log_debug (
        "http", "Returning " + std::to_string (envs.size ()) + " environments");
        res.set_content (response.dump (), "application/json");
    });

    /**
     * POST /environments
     * Creates an environment. Create only - an `id` that already exists is a
     * 409 pointing at PUT, never a silent update (issue #95). The engine
     * assigns the id; a body carrying one is a 400 (issue #97).
     * Body params: name (required string), description, variables (object),
     * isActive (bool).
     * Returns: The created environment object, or 400 (body `id`, missing
     * `name`, bad field shape).
     */
    ctx.server.Post ("/environments",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const auto json = parse_request_json (req.body);
        if (!json) {
            refuse_request_body (res, "POST /environments", json.error ());
            return;
        }
        try {
            auto [status, body] = create_environment_response (ctx.db, *json);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "POST /environments - " + std::to_string (status) + ": " +
                error_message_of (body));
            } else {
                vayu::utils::log_info ("http", "Created environment",
                { { "id", body["id"].get<std::string> () },
                { "name", body["name"].get<std::string> () } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "POST /environments - Error: " + std::string (e.what ()));
            send_exception (res, e);
        }
    });

    /**
     * PUT /environments/:id
     * Updates an existing environment (merge-patch: absent fields keep their
     * value, null resets to the default - `variables: null` resets to `{}`).
     * Update only - a missing id is a 404, never a silent create (issue #95).
     * Path params: id - The environment ID to update.
     * Headers: If-Match (optional) - the row's `W/"<updatedAt>"` (#2433).
     * Returns: The updated environment object with its ETag, 404 if it does
     * not exist, 412 if If-Match no longer names it, or 400.
     */
    ctx.server.Put (R"(/environments/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string environment_id = req.matches[1];
        const auto json            = parse_request_json (req.body);
        if (!json) {
            refuse_request_body (res, "PUT /environments/:id", json.error ());
            return;
        }
        const auto if_match = read_if_match (req);
        if (!if_match) {
            refuse_request_body (res, "PUT /environments/:id", if_match.error ());
            return;
        }
        try {
            auto [status, body] = update_environment_response (
            ctx.db, environment_id, *json, *if_match, nullptr);
            if (status != 200) {
                vayu::utils::log_warning ("http", "PUT /environments/:id failed",
                { { "status", status }, { "id", environment_id },
                { "error", error_message_of (body) } });
            } else {
                vayu::utils::log_info ("http", "Updated environment",
                { { "id", environment_id }, { "name", body["name"].get<std::string> () } });
            }
            res.status = status;
            set_entity_tag (res, status, body);
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "PUT /environments/:id - Error: " + std::string (e.what ()));
            send_exception (res, e);
        }
    });

    /**
     * DELETE /environments/:id
     * Moves an environment to the trash (#2970): restorable through
     * `POST /trash/:id/restore` until a purge or retention destroys it.
     * Returns: {success: true}, or 404 if no live environment has that id.
     */
    ctx.server.Delete (R"(/environments/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        try {
            auto [status, body] = delete_environment_response (ctx.db, id);
            if (status != 200) {
                vayu::utils::log_warning ("http", "DELETE /environments/:id failed",
                { { "status", status }, { "id", id }, { "error", error_message_of (body) } });
            } else {
                vayu::utils::log_info ("http", "Deleted environment", { { "id", id } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
            "DELETE /environments/:id - Error: " + std::string (e.what ()));
            send_exception (res, e);
        }
    });
}

} // namespace vayu::http::routes
