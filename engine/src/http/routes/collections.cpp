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
     * Creates or updates a collection in the database.
     * If 'id' is provided and exists, performs a partial update.
     * Otherwise, creates a new collection (requires 'name').
     * Body params: id (optional string), name (string), parentId (optional
     * string), order (optional int) Returns: The saved collection object.
     */
    ctx.server.Post ("/collections",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse (req.body);

            std::string id;
            if (json.contains ("id") && !json["id"].is_null ()) {
                id = json["id"].get<std::string> ();
            } else {
                id = vayu::utils::generate_id ("col_");
            }

            vayu::db::Collection c;
            auto existing  = ctx.db.get_collection (id);
            bool is_update = existing.has_value ();

            if (existing) {
                c = *existing;
            } else {
                if (!json.contains ("name") || json["name"].is_null ()) {
                    vayu::utils::log_warning (
                    "POST /collections - Missing required field: name");
                    send_error (res, 400, "Missing required field: name");
                    return;
                }
                c.id         = id;
                c.created_at = now_ms ();
                c.updated_at = now_ms ();
                c.order      = 0;
            }

            if (json.contains ("name") && !json["name"].is_null ()) {
                c.name = json["name"].get<std::string> ();
            }

            if (json.contains ("description")) {
                c.description = json["description"].is_null ()
                ? ""
                : json["description"].get<std::string> ();
            }

            if (json.contains ("parentId")) {
                if (json["parentId"].is_null ()) {
                    c.parent_id = std::nullopt;
                } else {
                    c.parent_id = json["parentId"].get<std::string> ();
                }
            }

            if (json.contains ("order") && !json["order"].is_null ()) {
                c.order = json["order"].get<int> ();
            } else if (!is_update) {
                // New collection: assign next order among siblings for stable ordering
                auto all      = ctx.db.get_collections ();
                int max_order = -1;
                for (const auto& col : all) {
                    if (col.parent_id == c.parent_id && col.order > max_order) {
                        max_order = col.order;
                    }
                }
                c.order = max_order + 1;
            }

            // Collection variables
            if (json.contains ("variables")) {
                c.variables = json["variables"].is_null () ? "{}" : json["variables"].dump ();
            } else if (!is_update) {
                c.variables = "{}";
            }

            // Collection auth - never 'inherit'; defaults to {mode: "none"}
            if (json.contains ("auth")) {
                c.auth = json["auth"].is_null () ? "{\"mode\":\"none\"}" : json["auth"].dump ();
            } else if (!is_update) {
                c.auth = "{\"mode\":\"none\"}";
            }

            if (json.contains ("preRequestScript")) {
                c.pre_request_script = json["preRequestScript"].is_null ()
                ? ""
                : json["preRequestScript"].get<std::string> ();
            }

            if (json.contains ("postRequestScript")) {
                c.post_request_script = json["postRequestScript"].is_null ()
                ? ""
                : json["postRequestScript"].get<std::string> ();
            }

            if (is_update) {
                c.updated_at = now_ms ();
            }

            // Reject writes that would put a cycle in the collection tree
            // (self-parent, or reparent into a descendant) before they reach
            // the DB - a cycle makes cascade delete loop forever under the
            // global mutex. Cycle/self checks only; parent existence is not
            // required (import creates collections in bulk).
            if (auto err = validate_parent_assignment (ctx.db, c.id, c.parent_id)) {
                vayu::utils::log_warning (
                "POST /collections - Rejected cyclic parent for id=" + c.id + ": " +
                (*err).second["error"].get<std::string> ());
                res.status = (*err).first;
                res.set_content ((*err).second.dump (), "application/json");
                return;
            }

            std::string parent_id = c.parent_id.value_or ("root");
            vayu::utils::log_info ("POST /collections - " +
            std::string (is_update ? "Updating" : "Creating") +
            " collection: id=" + c.id + ", name=" + c.name + ", parent_id=" + parent_id);

            ctx.db.create_collection (c);
            res.set_content (vayu::json::serialize (c).dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /collections - Error: " + std::string (e.what ()));
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
