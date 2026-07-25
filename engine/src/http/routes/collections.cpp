/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/collections.cpp
 * @brief Collection management routes
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <optional>
#include <unordered_set>
#include <utility>

namespace vayu::http::routes {

/**
 * Testable core of the parent-id validation for POST /collections, returning
 * an error response {http_status, json_body} when the proposed parent would
 * form a cycle in the collection tree, or std::nullopt when the assignment is
 * legal.
 *
 * Two shapes are rejected, both with 400:
 *   - Self-parent (`parentId == id`): a collection cannot be its own parent.
 *   - Reparent into a descendant: walking the proposed parent's ancestor chain
 *     reaches the collection being saved, so the move would make a node its own
 *     ancestor. A cycle here is what let `delete_collection`'s BFS loop forever
 *     under the global DB mutex, hanging every endpoint (see issue #79).
 *
 * The walk carries a visited set so pre-existing corrupt data (a cycle written
 * before this validation existed) cannot hang the validator itself. A parent id
 * that does not resolve to a stored collection ends the walk cleanly - parent
 * *existence* is intentionally not required here, because the import
 * orchestrator creates collections in bulk and an existence check would couple
 * this fix to import ordering.
 *
 * Extracted so the wiring is covered without an in-process HTTP server - see
 * collections_route_test.cpp. The error body matches send_error's flat
 * `{"error": message}` shape.
 */
std::optional<std::pair<int, nlohmann::json>> validate_parent_assignment (
vayu::db::Database& db, const std::string& id,
const std::optional<std::string>& parent_id) {
    if (!parent_id.has_value ()) {
        return std::nullopt; // No parent -> no cycle possible.
    }
    if (*parent_id == id) {
        return std::make_pair (400,
        nlohmann::json{ { "error", "A collection cannot be its own parent" } });
    }

    std::unordered_set<std::string> visited;
    std::optional<std::string> cursor = parent_id;
    while (cursor.has_value ()) {
        if (*cursor == id) {
            return std::make_pair (400,
            nlohmann::json{
            { "error", "Cannot move a collection into its own descendant" } });
        }
        if (!visited.insert (*cursor).second) {
            break; // Already seen -> pre-existing corrupt cycle; stop, bounded.
        }
        auto ancestor = db.get_collection (*cursor);
        if (!ancestor.has_value ()) {
            break; // Chain ends at a missing parent; existence is not required.
        }
        cursor = ancestor->parent_id;
    }
    return std::nullopt;
}

/**
 * Applies the request body onto `c` under the one null-vs-absent rule (see the
 * helpers in routes.hpp). Shared by the create and update cores so the two
 * verbs cannot drift apart on what a field means - the only thing that differs
 * between them is `is_create`.
 *
 * Returns an error response when a no-default field (`name`) is missing or
 * null, or when the proposed parent would form a cycle; nullopt on success.
 */
static std::optional<std::pair<int, nlohmann::json>> apply_collection_fields (
vayu::db::Database& db,
vayu::db::Collection& c,
const nlohmann::json& json,
bool is_create) {
    if (auto err = apply_required_string_field (json, "name", c.name, is_create)) {
        return err;
    }

    apply_string_field (json, "description", c.description, "", is_create);

    if (json.contains ("parentId")) {
        c.parent_id = json["parentId"].is_null () ?
        std::nullopt :
        std::optional<std::string> (json["parentId"].get<std::string> ());
    } else if (is_create) {
        c.parent_id = std::nullopt;
    }

    if (json.contains ("order") && !json["order"].is_null ()) {
        c.order = json["order"].get<int> ();
    } else if (is_create) {
        // Absent or null on create: append after the current siblings so a new
        // collection lands at the end rather than colliding on 0.
        auto all      = db.get_collections ();
        int max_order = -1;
        for (const auto& col : all) {
            if (col.parent_id == c.parent_id && col.order > max_order) {
                max_order = col.order;
            }
        }
        c.order = max_order + 1;
    } else if (json.contains ("order")) {
        c.order = 0; // Explicit null on update -> reset to the column default.
    }

    apply_json_field (json, "variables", c.variables, "{}", is_create);
    // Collection auth is never 'inherit' - a collection is the root of a chain.
    apply_json_field (json, "auth", c.auth, R"({"mode":"none"})", is_create);
    apply_string_field (json, "preRequestScript", c.pre_request_script, "", is_create);
    apply_string_field (json, "postRequestScript", c.post_request_script, "", is_create);

    // Reject writes that would put a cycle in the collection tree (self-parent,
    // or reparent into a descendant) before they reach the DB - a cycle makes
    // cascade delete loop forever under the global mutex. Cycle/self checks
    // only; parent existence is not required (import creates in bulk).
    if (auto err = validate_parent_assignment (db, c.id, c.parent_id)) {
        return err;
    }
    return std::nullopt;
}

/**
 * Testable core of POST /collections - **create only**, returning
 * {http_status, json_body}.
 *
 * POST used to be a silent upsert, so a stale or typo'd id quietly created a
 * second record instead of failing, and an id collision merged two records into
 * one. Now an id that already exists is a 409 and the caller is told to use
 * PUT; POST only ever creates. A client-supplied id is still honoured on create
 * because the import orchestrator pre-assigns ids to wire the tree together
 * before persisting (that need goes away with #96, and #97 then rejects the
 * field outright); an absent id is generated engine-side.
 */
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json) {
    std::string id;
    if (json.contains ("id") && !json["id"].is_null ()) {
        id = json["id"].get<std::string> ();
    } else {
        id = vayu::utils::generate_id ("col_");
    }

    if (db.get_collection (id).has_value ()) {
        return { 409,
            nlohmann::json{ { "error",
            "Collection '" + id + "' already exists; use PUT /collections/:id to update" } } };
    }

    vayu::db::Collection c;
    c.id         = id;
    c.created_at = now_ms ();
    c.updated_at = now_ms ();

    if (auto err = apply_collection_fields (db, c, json, /*is_create=*/true)) {
        return *err;
    }

    db.create_collection (c);
    return { 200, vayu::json::serialize (c) };
}

/**
 * Testable core of PUT /collections/:id - **update only**, returning
 * {http_status, json_body}. A missing id is a 404 rather than a silent create.
 *
 * Semantics are merge-patch: absent fields keep their stored value. We use PUT
 * loosely rather than adding a separate PATCH verb (documented in
 * api-reference.md) because that is what the update branch has always done and
 * what every renderer call site expects.
 */
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    auto existing = db.get_collection (id);
    if (!existing) {
        return { 404, nlohmann::json{ { "error", "Collection not found" } } };
    }

    vayu::db::Collection c = *existing;
    if (auto err = apply_collection_fields (db, c, json, /*is_create=*/false)) {
        return *err;
    }
    c.updated_at = now_ms ();

    db.create_collection (c);
    return { 200, vayu::json::serialize (c) };
}

void register_collection_routes (RouteContext& ctx) {
    /**
     * GET /collections
     * Retrieves all collections from the database.
     * Collections are folders that organize requests in a hierarchy.
     * Returns: Array of collection objects with id, name, parentId, order, and timestamps.
     */
    ctx.server.Get ("/collections", [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info ("GET /collections - Fetching all collections");
        auto collections        = ctx.db.get_collections ();
        nlohmann::json response = nlohmann::json::array ();
        for (const auto& c : collections) {
            response.push_back (vayu::json::serialize (c));
        }
        vayu::utils::log_debug ("GET /collections - Returning " +
        std::to_string (collections.size ()) + " collections");
        res.set_content (response.dump (), "application/json");
    });

    /**
     * POST /collections
     * Creates a collection. Create only - an `id` that already exists is a 409
     * pointing at PUT, never a silent update (issue #95).
     * Body params: id (optional string - generated when absent), name
     * (required string), description, parentId, order, variables, auth,
     * preRequestScript, postRequestScript.
     * Returns: The created collection object, 409 on an existing id, or 400.
     */
    ctx.server.Post ("/collections",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = create_collection_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /collections - " +
                std::to_string (status) + ": " + body["error"].get<std::string> ());
            } else {
                vayu::utils::log_info (
                "POST /collections - Created collection: id=" + body["id"].get<std::string> () +
                ", name=" + body["name"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /collections - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * PUT /collections/:id
     * Updates an existing collection (merge-patch: absent fields keep their
     * value, null resets to the default). Update only - a missing id is a 404,
     * never a silent create (issue #95).
     * Path params: id - The collection ID to update.
     * Returns: The updated collection object, 404 if it does not exist, or 400.
     */
    ctx.server.Put (R"(/collections/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string collection_id = req.matches[1];
        try {
            auto json = nlohmann::json::parse (req.body);
            auto [status, body] = update_collection_response (ctx.db, collection_id, json);
            if (status != 200) {
                vayu::utils::log_warning ("PUT /collections/:id - " +
                std::to_string (status) + " for id=" + collection_id + ": " +
                body["error"].get<std::string> ());
            } else {
                vayu::utils::log_info (
                "PUT /collections/:id - Updated collection: id=" + collection_id +
                ", name=" + body["name"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "PUT /collections/:id - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * DELETE /collections/:id
     * Deletes a collection and all its requests.
     * Path params: id - The collection ID to delete.
     * Returns: Success message or 404 if not found.
     */
    ctx.server.Delete (R"(/collections/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string collection_id = req.matches[1];
        vayu::utils::log_info (
        "DELETE /collections/:id - Deleting collection: " + collection_id);
        try {
            auto collection = ctx.db.get_collection (collection_id);
            if (!collection) {
                vayu::utils::log_warning (
                "DELETE /collections/:id - Collection not found: " + collection_id);
                send_error (res, 404, "Collection not found");
                return;
            }

            ctx.db.delete_collection (collection_id);
            vayu::utils::log_info (
            "DELETE /collections/:id - Successfully deleted collection: " + collection_id +
            ", name=" + collection->name);

            nlohmann::json response;
            response["message"] = "Collection deleted successfully";
            response["id"]      = collection_id;
            res.set_content (response.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /collections/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
