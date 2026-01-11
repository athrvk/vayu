/**
 * @file http/routes/collections.cpp
 * @brief Collection management routes
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

void register_collection_routes(RouteContext& ctx) {
    /**
     * GET /collections
     * Retrieves all collections from the database.
     * Collections are folders that organize requests in a hierarchy.
     * Returns: Array of collection objects with id, name, parentId, order, and timestamps.
     */
    ctx.server.Get("/collections", [&ctx](const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info("GET /collections - Fetching all collections");
        auto collections = ctx.db.get_collections();
        nlohmann::json response = nlohmann::json::array();
        for (const auto& c : collections) {
            response.push_back(vayu::json::serialize(c));
        }
        vayu::utils::log_debug("GET /collections - Returning " +
                               std::to_string(collections.size()) + " collections");
        res.set_content(response.dump(), "application/json");
    });

    /**
     * POST /collections
     * Creates or updates a collection in the database.
     * If 'id' is provided and exists, performs a partial update.
     * Otherwise, creates a new collection (requires 'name').
     * Body params: id (optional string), name (string), parentId (optional string), order (optional
     * int) Returns: The saved collection object.
     */
    ctx.server.Post("/collections", [&ctx](const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse(req.body);

            std::string id;
            if (json.contains("id") && !json["id"].is_null()) {
                id = json["id"].get<std::string>();
            } else {
                id = "col_" + std::to_string(now_ms());
            }

            vayu::db::Collection c;
            auto existing = ctx.db.get_collection(id);
            bool is_update = existing.has_value();

            if (existing) {
                c = *existing;
            } else {
                if (!json.contains("name") || json["name"].is_null()) {
                    vayu::utils::log_warning("POST /collections - Missing required field: name");
                    send_error(res, 400, "Missing required field: name");
                    return;
                }
                c.id = id;
                c.created_at = now_ms();
                c.order = 0;
            }

            if (json.contains("name") && !json["name"].is_null()) {
                c.name = json["name"].get<std::string>();
            }

            if (json.contains("parentId")) {
                if (json["parentId"].is_null()) {
                    c.parent_id = std::nullopt;
                } else {
                    c.parent_id = json["parentId"].get<std::string>();
                }
            }

            if (json.contains("order") && !json["order"].is_null()) {
                c.order = json["order"].get<int>();
            }

            // Handle collection variables
            if (json.contains("variables")) {
                if (json["variables"].is_null()) {
                    c.variables = "{}";
                } else {
                    c.variables = json["variables"].dump();
                }
            } else if (!is_update) {
                // New collection - initialize with empty variables
                c.variables = "{}";
            }

            std::string parent_id = c.parent_id.value_or("root");
            vayu::utils::log_info(
                "POST /collections - " + std::string(is_update ? "Updating" : "Creating") +
                " collection: id=" + c.id + ", name=" + c.name + ", parent_id=" + parent_id);

            ctx.db.create_collection(c);
            res.set_content(vayu::json::serialize(c).dump(), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error("POST /collections - Error: " + std::string(e.what()));
            send_error(res, 400, e.what());
        }
    });

    /**
     * DELETE /collections/:id
     * Deletes a collection and all its requests.
     * Path params: id - The collection ID to delete.
     * Returns: Success message or 404 if not found.
     */
    ctx.server.Delete(R"(/collections/([^/]+))",
                      [&ctx](const httplib::Request& req, httplib::Response& res) {
                          std::string collection_id = req.matches[1];
                          vayu::utils::log_info("DELETE /collections/:id - Deleting collection: " +
                                                collection_id);
                          try {
                              auto collection = ctx.db.get_collection(collection_id);
                              if (!collection) {
                                  vayu::utils::log_warning(
                                      "DELETE /collections/:id - Collection not found: " +
                                      collection_id);
                                  send_error(res, 404, "Collection not found");
                                  return;
                              }

                              ctx.db.delete_collection(collection_id);
                              vayu::utils::log_info(
                                  "DELETE /collections/:id - Successfully deleted collection: " +
                                  collection_id + ", name=" + collection->name);

                              nlohmann::json response;
                              response["message"] = "Collection deleted successfully";
                              response["id"] = collection_id;
                              res.set_content(response.dump(), "application/json");
                          } catch (const std::exception& e) {
                              vayu::utils::log_error("DELETE /collections/:id - Error: " +
                                                     std::string(e.what()));
                              send_error(res, 500, e.what());
                          }
                      });
}

}  // namespace vayu::http::routes
