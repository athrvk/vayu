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
#include <optional>
#include <sstream>
#include <string>
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

/**
 * Validates a KeyValueEntry array field (`params` / `headers`) and stores it.
 * Under the one null-vs-absent rule a null resets to `[]`; a present value must
 * be an array whose every entry carries string `key`/`value` and boolean
 * `enabled`. Returns the 400 body on a malformed entry, nullopt otherwise.
 */
static std::optional<std::pair<int, nlohmann::json>>
apply_key_value_field (const nlohmann::json& json, const char* key, std::string& out, bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            out = "[]";
        }
        return std::nullopt;
    }
    const auto& value = json[key];
    if (value.is_null ()) {
        out = "[]";
        return std::nullopt;
    }
    if (!value.is_array ()) {
        return std::make_pair (400,
        nlohmann::json{ { "error",
        std::string ("Invalid '") + key + "': must be an array of {key, value, enabled}" } });
    }
    for (size_t i = 0; i < value.size (); ++i) {
        const auto& entry = value[i];
        if (!entry.contains ("key") || !entry["key"].is_string () ||
        !entry.contains ("value") || !entry["value"].is_string () ||
        !entry.contains ("enabled") || !entry["enabled"].is_boolean ()) {
            return std::make_pair (400,
            nlohmann::json{ { "error",
            std::string ("Invalid ") + key + " entry at index " + std::to_string (i) +
            ": missing required field (key, value, or enabled)" } });
        }
    }
    out = value.dump ();
    return std::nullopt;
}

/**
 * Applies the request body onto `r` under the one null-vs-absent rule (see the
 * helpers in routes.hpp). Shared by the create and update cores so the two
 * verbs cannot drift apart on what a field means.
 *
 * `collectionId`, `name`, `method` and `url` have no default, so each is
 * required on create and rejects an explicit null on either verb.
 */
static std::optional<std::pair<int, nlohmann::json>>
apply_request_fields (vayu::db::Request& r, const nlohmann::json& json, bool is_create) {
    if (auto err = apply_required_string_field (
        json, "collectionId", r.collection_id, is_create)) {
        return err;
    }
    if (auto err = apply_required_string_field (json, "name", r.name, is_create)) {
        return err;
    }

    std::string method_str = to_string (r.method);
    if (auto err = apply_required_string_field (json, "method", method_str, is_create)) {
        return err;
    }
    auto method = vayu::parse_method (method_str);
    if (!method) {
        return std::make_pair (400, nlohmann::json{ { "error", "Invalid HTTP method" } });
    }
    r.method = *method;

    if (auto err = apply_required_string_field (json, "url", r.url, is_create)) {
        return err;
    }

    apply_string_field (json, "description", r.description, "", is_create);

    if (auto err = apply_key_value_field (json, "params", r.params, is_create)) {
        return err;
    }
    if (auto err = apply_key_value_field (json, "headers", r.headers, is_create)) {
        return err;
    }

    apply_json_field (json, "body", r.body, R"({"mode":"none"})", is_create);
    apply_string_field (json, "bodyType", r.body_type, "none", is_create);
    // A request's auth may be 'inherit' - that is its default, and the app
    // resolves the collection chain before the request is executed.
    apply_json_field (json, "auth", r.auth, R"({"mode":"inherit"})", is_create);
    apply_string_field (json, "preRequestScript", r.pre_request_script, "", is_create);
    apply_string_field (json, "postRequestScript", r.post_request_script, "", is_create);
    apply_int_field (json, "order", r.order, 0, is_create);
    apply_bool_field (json, "followRedirects", r.follow_redirects, true, is_create);

    apply_int_field (json, "maxRedirects", r.max_redirects, 10, is_create);
    // Clamp to the range the UI offers; libcurl reads -1 as "unlimited", which
    // is not a policy we want a stray value to select.
    r.max_redirects = std::clamp (r.max_redirects, 0, 100);

    return std::nullopt;
}

/**
 * Testable core of POST /requests - **create only**, returning
 * {http_status, json_body}. An id that already exists is a 409 pointing at PUT;
 * POST never updates (issue #95). A client-supplied id is still honoured on
 * create for the import orchestrator's benefit until #96 lands.
 */
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json) {
    std::string id;
    if (json.contains ("id") && !json["id"].is_null ()) {
        id = json["id"].get<std::string> ();
    } else {
        id = vayu::utils::generate_id ("req_");
    }

    if (db.get_request (id).has_value ()) {
        return { 409,
            nlohmann::json{ { "error",
            "Request '" + id + "' already exists; use PUT /requests/:id to update" } } };
    }

    vayu::db::Request r;
    r.id         = id;
    r.created_at = now_ms ();
    r.updated_at = now_ms ();

    if (auto err = apply_request_fields (r, json, /*is_create=*/true)) {
        return *err;
    }

    db.save_request (r);
    return { 200, vayu::json::serialize (r) };
}

/**
 * Testable core of PUT /requests/:id - **update only**, returning
 * {http_status, json_body}. A missing id is a 404 rather than a silent create.
 * Merge-patch semantics, same as collections.
 */
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    auto existing = db.get_request (id);
    if (!existing) {
        return { 404, nlohmann::json{ { "error", "Request not found" } } };
    }

    vayu::db::Request r = *existing;
    if (auto err = apply_request_fields (r, json, /*is_create=*/false)) {
        return *err;
    }
    r.updated_at = now_ms ();

    db.save_request (r);
    return { 200, vayu::json::serialize (r) };
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
     * Creates a request. Create only - an `id` that already exists is a 409
     * pointing at PUT, never a silent update (issue #95).
     * Body params: id (optional string - generated when absent), collectionId,
     * name, method, url (all required), description, params/headers (arrays of
     * KeyValueEntry), body, bodyType, auth, preRequestScript,
     * postRequestScript, order, followRedirects, maxRedirects.
     * Returns: The created request object, 409 on an existing id, or 400.
     */
    ctx.server.Post (
    "/requests", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = create_request_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /requests - " +
                std::to_string (status) + ": " + body["error"].get<std::string> ());
            } else {
                vayu::utils::log_info (
                "POST /requests - Created request: id=" + body["id"].get<std::string> () +
                ", name=" + body["name"].get<std::string> () +
                ", method=" + body["method"].get<std::string> () +
                ", url=" + body["url"].get<std::string> () +
                ", collection_id=" + body["collectionId"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("POST /requests - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * PUT /requests/:id
     * Updates an existing request (merge-patch: absent fields keep their value,
     * null resets to the default). Update only - a missing id is a 404, never a
     * silent create (issue #95).
     * Path params: id - The request ID to update.
     * Returns: The updated request object, 404 if it does not exist, or 400.
     */
    ctx.server.Put (R"(/requests/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string request_id = req.matches[1];
        try {
            auto json = nlohmann::json::parse (req.body);
            auto [status, body] = update_request_response (ctx.db, request_id, json);
            if (status != 200) {
                vayu::utils::log_warning ("PUT /requests/:id - " + std::to_string (status) +
                " for id=" + request_id + ": " + body["error"].get<std::string> ());
            } else {
                vayu::utils::log_info (
                "PUT /requests/:id - Updated request: id=" + request_id +
                ", name=" + body["name"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "PUT /requests/:id - Error: " + std::string (e.what ()));
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
