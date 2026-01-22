/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/requests.cpp
 * @brief Request management routes
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

void register_request_routes(RouteContext& ctx) {
    /**
     * GET /requests
     * Retrieves all requests belonging to a specific collection.
     * Uses streaming/chunked response to prevent OOM on large collections.
     * Query params: collectionId (required) - The collection ID to fetch requests from.
     * Returns: Array of request objects with method, url, headers, body, scripts, etc.
     */
    ctx.server.Get("/requests", [&ctx](const httplib::Request& req, httplib::Response& res) {
        try {
            if (req.has_param("collectionId")) {
                std::string collection_id = req.get_param_value("collectionId");
                vayu::utils::log_info("GET /requests - Streaming requests for collection: " +
                                      collection_id);
                
                // Use streaming response to avoid loading all requests into memory
                // Build response incrementally by iterating through requests
                std::ostringstream response_stream;
                response_stream << "[";
                
                bool is_first = true;
                size_t request_count = 0;
                
                // Iterate through requests and stream them one by one
                ctx.db.iterate_requests_in_collection(
                    collection_id,
                    [&response_stream, &is_first, &request_count](const vayu::db::Request& r) -> bool {
                        try {
                            // Write comma before each item except the first
                            if (!is_first) {
                                response_stream << ",";
                            }
                            is_first = false;
                            
                            // Serialize request directly to stream
                            vayu::json::serialize_to_stream(r, response_stream);
                            
                            request_count++;
                            return true;  // Continue iteration
                        } catch (const std::exception& e) {
                            vayu::utils::log_error("GET /requests - Error serializing request " +
                                                  r.id + ": " + std::string(e.what()));
                            // Continue with next request instead of failing entire response
                            return true;
                        }
                    }
                );
                
                response_stream << "]";
                
                vayu::utils::log_debug("GET /requests - Streamed " +
                                       std::to_string(request_count) + " requests");
                res.set_content(response_stream.str(), "application/json");
            } else {
                vayu::utils::log_warning("GET /requests - Missing required param: collectionId");
                send_error(res, 400, "collectionId required");
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error("GET /requests - Error: " + std::string(e.what()));
            send_error(res, 500, e.what());
        }
    });

    /**
     * POST /requests
     * Creates or updates a request in the database.
     * If 'id' is provided and exists, performs a partial update.
     * Otherwise, creates a new request (requires 'collectionId', 'name', 'method', 'url').
     * Body params: id, collectionId, name, method, url, headers (object), body (any),
     *              auth (object), preRequestScript (string), postRequestScript (string)
     * Returns: The saved request object.
     */
    ctx.server.Post("/requests", [&ctx](const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse(req.body);

            std::string id;
            if (json.contains("id") && !json["id"].is_null()) {
                id = json["id"].get<std::string>();
            } else {
                id = "req_" + std::to_string(now_ms());
            }

            vayu::db::Request r;
            auto existing = ctx.db.get_request(id);
            bool is_update = existing.has_value();

            if (existing) {
                r = *existing;
            } else {
                if (!json.contains("collectionId") || json["collectionId"].is_null()) {
                    vayu::utils::log_warning(
                        "POST /requests - Missing required field: collectionId");
                    send_error(res, 400, "Missing required field: collectionId");
                    return;
                }
                if (!json.contains("name") || json["name"].is_null()) {
                    vayu::utils::log_warning("POST /requests - Missing required field: name");
                    send_error(res, 400, "Missing required field: name");
                    return;
                }
                if (!json.contains("method") || json["method"].is_null()) {
                    vayu::utils::log_warning("POST /requests - Missing required field: method");
                    send_error(res, 400, "Missing required field: method");
                    return;
                }
                if (!json.contains("url") || json["url"].is_null()) {
                    vayu::utils::log_warning("POST /requests - Missing required field: url");
                    send_error(res, 400, "Missing required field: url");
                    return;
                }
                r.id = id;
                r.created_at = now_ms();
                r.updated_at = now_ms();
            }

            if (json.contains("collectionId") && !json["collectionId"].is_null()) {
                r.collection_id = json["collectionId"].get<std::string>();
            }
            if (json.contains("name") && !json["name"].is_null()) {
                r.name = json["name"].get<std::string>();
            }
            if (json.contains("method") && !json["method"].is_null()) {
                auto method = vayu::parse_method(json["method"].get<std::string>());
                if (!method) throw std::runtime_error("Invalid HTTP method");
                r.method = *method;
            }
            if (json.contains("url") && !json["url"].is_null()) {
                r.url = json["url"].get<std::string>();
            }
            if (json.contains("params")) r.params = json["params"].dump();
            if (json.contains("headers")) r.headers = json["headers"].dump();
            if (json.contains("body")) r.body = json["body"].dump();
            if (json.contains("bodyType") && !json["bodyType"].is_null()) {
                r.body_type = json["bodyType"].get<std::string>();
            }
            if (json.contains("auth")) r.auth = json["auth"].dump();
            if (json.contains("preRequestScript"))
                r.pre_request_script = json["preRequestScript"].get<std::string>();
            if (json.contains("postRequestScript"))
                r.post_request_script = json["postRequestScript"].get<std::string>();

            if (is_update) {
                r.updated_at = now_ms();
            }

            vayu::utils::log_info(
                "POST /requests - " + std::string(is_update ? "Updating" : "Creating") +
                " request: id=" + r.id + ", name=" + r.name + ", method=" + to_string(r.method) +
                ", url=" + r.url + ", collection_id=" + r.collection_id);

            ctx.db.save_request(r);
            res.set_content(vayu::json::serialize(r).dump(), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error("POST /requests - Error: " + std::string(e.what()));
            send_error(res, 400, e.what());
        }
    });

    /**
     * DELETE /requests/:id
     * Deletes a request from the database.
     * Path params: id - The request ID to delete.
     * Returns: Success message or 404 if not found.
     */
    ctx.server.Delete(R"(/requests/([^/]+))",
                      [&ctx](const httplib::Request& req, httplib::Response& res) {
                          std::string request_id = req.matches[1];
                          vayu::utils::log_info("DELETE /requests/:id - Deleting request: " +
                                                request_id);
                          try {
                              auto request = ctx.db.get_request(request_id);
                              if (!request) {
                                  vayu::utils::log_warning(
                                      "DELETE /requests/:id - Request not found: " + request_id);
                                  send_error(res, 404, "Request not found");
                                  return;
                              }

                              ctx.db.delete_request(request_id);
                              vayu::utils::log_info(
                                  "DELETE /requests/:id - Successfully deleted request: " +
                                  request_id + ", name=" + request->name);

                              nlohmann::json response;
                              response["message"] = "Request deleted successfully";
                              response["id"] = request_id;
                              res.set_content(response.dump(), "application/json");
                          } catch (const std::exception& e) {
                              vayu::utils::log_error("DELETE /requests/:id - Error: " +
                                                     std::string(e.what()));
                              send_error(res, 500, e.what());
                          }
                      });
}

}  // namespace vayu::http::routes
