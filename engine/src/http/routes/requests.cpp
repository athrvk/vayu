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
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <sstream>
#include <utility>

namespace vayu::http::routes {

/**
 * Testable core of GET /requests/:id, returning {http_status, json_body}.
 *
 * A missing request is a *definitive* 404, never a transport failure. That
 * distinction is the whole point of the endpoint: the app reads a single
 * request by id, so a real 404 means "deleted" and a 5xx means "engine
 * unreachable" - two states the previous collection-list scan could not tell
 * apart, because one swallowed list failure looked identical to "not in any
 * list". Present -> 200 with the same serialized shape a list entry carries
 * (`serialize(const db::Request&)`), so the client transforms it identically.
 *
 * Extracted so the wiring (404 vs 200 + body) is covered without an in-process
 * HTTP server - see requests_route_test.cpp. The error body matches
 * `send_error`'s flat `{"error": message}` shape.
 */
std::pair<int, nlohmann::json> get_request_response (vayu::db::Database& db,
const std::string& id) {
    auto request = db.get_request (id);
    if (!request) {
        return { 404, nlohmann::json{ { "error", "Request not found" } } };
    }
    return { 200, vayu::json::serialize (*request) };
}

/**
 * Testable core of GET /requests: one DB fetch, one serialized JSON array.
 *
 * The rows arrive already ordered by `order` (get_requests_in_collection has
 * the ORDER BY), matching the ordering contract collections have had all
 * along. Each row is serialized into its own buffer inside the try, so a row
 * that fails to serialize is skipped whole - it cannot leave a half-written
 * item behind and corrupt the array, and one bad row does not fail the whole
 * response. Extracted for requests_route_test.cpp, same as
 * get_request_response above.
 */
std::string list_requests_body (vayu::db::Database& db, const std::string& collection_id) {
    auto requests = db.get_requests_in_collection (collection_id);

    std::ostringstream out;
    out << "[";
    bool is_first = true;
    for (const auto& r : requests) {
        std::ostringstream item;
        try {
            vayu::json::serialize_to_stream (r, item);
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /requests - Error serializing request " + r.id + ": " +
            std::string (e.what ()));
            continue;
        }
        if (!is_first) {
            out << ",";
        }
        is_first = false;
        out << item.str ();
    }
    out << "]";
    return out.str ();
}

void register_request_routes (RouteContext& ctx) {
    /**
     * GET /requests
     * Retrieves all requests belonging to a specific collection, ordered by
     * their `order` field (matching GET /collections).
     * Query params: collectionId (required) - The collection ID to fetch requests from.
     * Returns: Array of request objects with method, url, headers, body, scripts, etc.
     */
    ctx.server.Get ("/requests", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            if (req.has_param ("collectionId")) {
                std::string collection_id =
                req.get_param_value ("collectionId");
                vayu::utils::log_info (
                "GET /requests - Fetching requests for collection: " + collection_id);
                res.set_content (list_requests_body (ctx.db, collection_id), "application/json");
            } else {
                vayu::utils::log_warning (
                "GET /requests - Missing required param: collectionId");
                send_error (res, 400, "collectionId required");
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error ("GET /requests - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * GET /requests/:id
     * Retrieves a single request by id in one lookup, so a restored tab or a
     * design-run copy does not have to fetch every collection's list and scan
     * them. Returns 200 with the request, or 404 if it genuinely does not
     * exist (as opposed to a transport failure, which the app must treat
     * differently). Path params: id - The request ID to fetch.
     */
    ctx.server.Get (R"(/requests/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string request_id = req.matches[1];
        vayu::utils::log_info ("GET /requests/:id - Fetching request: " + request_id);
        try {
            auto [status, body] = get_request_response (ctx.db, request_id);
            if (status == 404) {
                vayu::utils::log_warning (
                "GET /requests/:id - Request not found: " + request_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /requests/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * POST /requests
     * Creates or updates a request in the database.
     * If 'id' is provided and exists, performs a partial update.
     * Otherwise, creates a new request (requires 'collectionId', 'name',
     * 'method', 'url'). Body params: id, collectionId, name, method, url,
     * headers (object), body (any), auth (object), preRequestScript (string),
     * postRequestScript (string), followRedirects (bool), maxRedirects (int)
     * Returns: The saved request object.
     */
    ctx.server.Post (
    "/requests", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse (req.body);

            std::string id;
            if (json.contains ("id") && !json["id"].is_null ()) {
                id = json["id"].get<std::string> ();
            } else {
                id = vayu::utils::generate_id ("req_");
            }

            vayu::db::Request r;
            auto existing  = ctx.db.get_request (id);
            bool is_update = existing.has_value ();

            if (existing) {
                r = *existing;
            } else {
                if (!json.contains ("collectionId") || json["collectionId"].is_null ()) {
                    vayu::utils::log_warning (
                    "POST /requests - Missing required field: collectionId");
                    send_error (res, 400, "Missing required field: collectionId");
                    return;
                }
                if (!json.contains ("name") || json["name"].is_null ()) {
                    vayu::utils::log_warning (
                    "POST /requests - Missing required field: name");
                    send_error (res, 400, "Missing required field: name");
                    return;
                }
                if (!json.contains ("method") || json["method"].is_null ()) {
                    vayu::utils::log_warning (
                    "POST /requests - Missing required field: method");
                    send_error (res, 400, "Missing required field: method");
                    return;
                }
                if (!json.contains ("url") || json["url"].is_null ()) {
                    vayu::utils::log_warning (
                    "POST /requests - Missing required field: url");
                    send_error (res, 400, "Missing required field: url");
                    return;
                }
                r.id         = id;
                r.created_at = now_ms ();
                r.updated_at = now_ms ();
            }

            if (json.contains ("collectionId") && !json["collectionId"].is_null ()) {
                r.collection_id = json["collectionId"].get<std::string> ();
            }
            if (json.contains ("name") && !json["name"].is_null ()) {
                r.name = json["name"].get<std::string> ();
            }
            if (json.contains ("description")) {
                r.description = json["description"].is_null ()
                ? ""
                : json["description"].get<std::string> ();
            }
            if (json.contains ("method") && !json["method"].is_null ()) {
                auto method = vayu::parse_method (json["method"].get<std::string> ());
                if (!method)
                    throw std::runtime_error ("Invalid HTTP method");
                r.method = *method;
            }
            if (json.contains ("url") && !json["url"].is_null ()) {
                r.url = json["url"].get<std::string> ();
            }

            // Validate and store params - must be an array of KeyValueEntry
            if (json.contains ("params")) {
                const auto& p = json["params"];
                if (!p.is_array () && !p.is_null ()) {
                    send_error (res, 400,
                    "Invalid 'params': must be an array of {key, value, enabled}");
                    return;
                }
                if (p.is_array ()) {
                    for (size_t i = 0; i < p.size (); ++i) {
                        const auto& entry = p[i];
                        if (!entry.contains ("key") || !entry["key"].is_string () ||
                        !entry.contains ("value") || !entry["value"].is_string () ||
                        !entry.contains ("enabled") || !entry["enabled"].is_boolean ()) {
                            send_error (res, 400,
                            "Invalid params entry at index " + std::to_string (i) +
                            ": missing required field (key, value, or enabled)");
                            return;
                        }
                    }
                }
                r.params = p.is_null () ? "[]" : p.dump ();
            }

            // Validate and store headers - must be an array of KeyValueEntry
            if (json.contains ("headers")) {
                const auto& h = json["headers"];
                if (!h.is_array () && !h.is_null ()) {
                    send_error (res, 400,
                    "Invalid 'headers': must be an array of {key, value, enabled}");
                    return;
                }
                if (h.is_array ()) {
                    for (size_t i = 0; i < h.size (); ++i) {
                        const auto& entry = h[i];
                        if (!entry.contains ("key") || !entry["key"].is_string () ||
                        !entry.contains ("value") || !entry["value"].is_string () ||
                        !entry.contains ("enabled") || !entry["enabled"].is_boolean ()) {
                            send_error (res, 400,
                            "Invalid headers entry at index " + std::to_string (i) +
                            ": missing required field (key, value, or enabled)");
                            return;
                        }
                    }
                }
                r.headers = h.is_null () ? "[]" : h.dump ();
            }

            if (json.contains ("body"))
                r.body = json["body"].is_null () ? "{\"mode\":\"none\"}" : json["body"].dump ();
            if (json.contains ("bodyType") && !json["bodyType"].is_null ()) {
                r.body_type = json["bodyType"].get<std::string> ();
            }
            if (json.contains ("auth"))
                r.auth = json["auth"].is_null () ? "{\"mode\":\"inherit\"}" : json["auth"].dump ();
            if (json.contains ("preRequestScript"))
                r.pre_request_script = json["preRequestScript"].is_null ()
                ? ""
                : json["preRequestScript"].get<std::string> ();
            if (json.contains ("postRequestScript"))
                r.post_request_script = json["postRequestScript"].is_null ()
                ? ""
                : json["postRequestScript"].get<std::string> ();
            if (json.contains ("order") && !json["order"].is_null ()) {
                r.order = json["order"].get<int> ();
            }
            if (json.contains ("followRedirects") && json["followRedirects"].is_boolean ()) {
                r.follow_redirects = json["followRedirects"].get<bool> ();
            }
            if (json.contains ("maxRedirects") && json["maxRedirects"].is_number_integer ()) {
                // Clamp to the range the UI offers; libcurl reads -1 as
                // "unlimited", which is not a policy we want a stray value to
                // select.
                int max_redirects = json["maxRedirects"].get<int> ();
                r.max_redirects   = std::clamp (max_redirects, 0, 100);
            }

            if (is_update) {
                r.updated_at = now_ms ();
            }

            vayu::utils::log_info ("POST /requests - " +
            std::string (is_update ? "Updating" : "Creating") + " request: id=" +
            r.id + ", name=" + r.name + ", method=" + to_string (r.method) +
            ", url=" + r.url + ", collection_id=" + r.collection_id);

            ctx.db.save_request (r);
            res.set_content (vayu::json::serialize (r).dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("POST /requests - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * DELETE /requests/:id
     * Deletes a request from the database.
     * Path params: id - The request ID to delete.
     * Returns: Success message or 404 if not found.
     */
    ctx.server.Delete (R"(/requests/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string request_id = req.matches[1];
        vayu::utils::log_info ("DELETE /requests/:id - Deleting request: " + request_id);
        try {
            auto request = ctx.db.get_request (request_id);
            if (!request) {
                vayu::utils::log_warning (
                "DELETE /requests/:id - Request not found: " + request_id);
                send_error (res, 404, "Request not found");
                return;
            }

            ctx.db.delete_request (request_id);
            vayu::utils::log_info (
            "DELETE /requests/:id - Successfully deleted request: " + request_id +
            ", name=" + request->name);

            nlohmann::json response;
            response["message"] = "Request deleted successfully";
            response["id"]      = request_id;
            res.set_content (response.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /requests/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
