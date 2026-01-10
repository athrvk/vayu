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
        auto collections = ctx.db.get_collections();
        nlohmann::json response = nlohmann::json::array();
        for (const auto& c : collections) {
            response.push_back(vayu::json::serialize(c));
        }
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

            if (existing) {
                c = *existing;
            } else {
                if (!json.contains("name") || json["name"].is_null()) {
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

            ctx.db.create_collection(c);
            res.set_content(vayu::json::serialize(c).dump(), "application/json");
        } catch (const std::exception& e) {
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
                          try {
                              auto collection = ctx.db.get_collection(collection_id);
                              if (!collection) {
                                  send_error(res, 404, "Collection not found");
                                  return;
                              }

                              ctx.db.delete_collection(collection_id);

                              nlohmann::json response;
                              response["message"] = "Collection deleted successfully";
                              response["id"] = collection_id;
                              res.set_content(response.dump(), "application/json");
                          } catch (const std::exception& e) {
                              send_error(res, 500, e.what());
                          }
                      });
}

}  // namespace vayu::http::routes
