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
#include <functional>
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
 * HTTP server - see requests_route_test.cpp. The error body is built by
 * `error_body`, like every other error the engine emits.
 */
std::pair<int, nlohmann::json>
get_request_response (vayu::db::Database& db, const std::string& id) {
    auto request = db.get_request (id);
    if (!request) {
        return { 404, error_body (404, "Request not found") };
    }
    return { 200, vayu::json::serialize (*request) };
}

/**
 * Testable core of GET /requests: one DB fetch, one serialized JSON array.
 *
 * The rows arrive already ordered by `order`, then `created_at`, then `id`
 * (get_requests_in_collection has the ORDER BY), matching the ordering contract
 * collections have had all along - see the ordering section of
 * `docs/engine/api-reference.md` for why the tiebreak is part of the contract
 * rather than a detail.
 *
 * Each row is serialized into its own buffer inside the try, so a row
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
 * The value new/reset requests' httpVersion is seeded with: the live
 * "defaultHttpVersion" config entry, read fresh on every write (not cached,
 * not vayu::DEFAULT_HTTP_VERSION) so a user-changed global takes effect
 * immediately for the next create or explicit reset. Falls back to
 * vayu::DEFAULT_HTTP_VERSION only if the config entry is missing or somehow
 * holds a value outside all_http_versions().
 *
 * The validity check goes through the domain's own parser: a tampered config
 * row must not be able to plant an invalid value via the seed path, and the
 * rule for what counts as valid lives in exactly one place.
 */
static std::string http_version_seed (vayu::db::Database& db) {
    std::string configured = db.get_config_string (
    "defaultHttpVersion", vayu::to_string (vayu::DEFAULT_HTTP_VERSION));
    if (vayu::http_version_from_string (configured).has_value ()) {
        return configured;
    }
    return vayu::to_string (vayu::DEFAULT_HTTP_VERSION);
}

/**
 * Applies `specOperation` - which operation of the bound spec this request is
 * (issue #637) - under the same null-vs-absent rule as every other field, with
 * `null`/absent-on-create meaning "declares no operation" (a NULL column).
 *
 * Its own helper rather than `apply_json_field`, because the column is nullable:
 * `apply_json_field` resets to a *text* default, and `"{}"` there would be a
 * second spelling of "no operation" that every reader - the serializers, the
 * diff in #627, the coverage count in #629 - would have to learn.
 *
 * Contents are validated, not merely shaped. `method` and `path` are what make
 * the identity an identity: an operation with neither is not one, and a
 * `spec_operation` holding half of one would fail much later, as a request that
 * silently matches nothing in the spec it is supposedly bound to. `path` is the
 * templated path, so it is required to start with `/` - a concrete URL stored
 * here would never match the document it came from.
 */
static RouteResult apply_spec_operation_field (const nlohmann::json& json,
std::optional<std::string>& out,
bool is_create) {
    if (!json.contains ("specOperation")) {
        if (is_create) {
            out = std::nullopt;
        }
        return {};
    }
    const auto& value = json["specOperation"];
    if (value.is_null ()) {
        out = std::nullopt;
        return {};
    }
    if (!value.is_object ()) {
        return route_error (400, "Invalid 'specOperation': must be a JSON object or null");
    }

    for (const char* key : { "method", "path" }) {
        if (!value.contains (key) || !value[key].is_string () ||
        value[key].get<std::string> ().empty ()) {
            return route_error (400,
            std::string ("Invalid 'specOperation.") + key + "': must be a non-empty string");
        }
    }
    if (value["path"].get<std::string> ().front () != '/') {
        return route_error (400,
        "Invalid 'specOperation.path': must be the templated path from the "
        "document and start with '/' (e.g. '/pets/{petId}')");
    }
    if (value.contains ("operationId") && !value["operationId"].is_null () &&
    !value["operationId"].is_string ()) {
        return route_error (400, "Invalid 'specOperation.operationId': must be a string");
    }

    out = value.dump ();
    return {};
}

/**
 * Applies the request body onto `r` under the one null-vs-absent rule (see the
 * helpers in routes.hpp). Shared by the create and update cores so the two
 * verbs cannot drift apart on what a field means.
 *
 * `collectionId`, `name`, `method` and `url` have no default, so each is
 * required on create and rejects an explicit null on either verb.
 *
 * Declared in routes.hpp because `POST /import/apply` applies the same fields to
 * every request in a bulk payload (issue #96).
 */
RouteResult apply_request_fields (vayu::db::Database& db,
vayu::db::Request& r,
const nlohmann::json& json,
bool is_create) {
    if (auto outcome =
        apply_required_string_field (json, "collectionId", r.collection_id, is_create);
    !outcome) {
        return outcome;
    }
    if (auto outcome = apply_required_string_field (json, "name", r.name, is_create); !outcome) {
        return outcome;
    }

    std::string method_str = to_string (r.method);
    if (auto outcome = apply_required_string_field (json, "method", method_str, is_create);
    !outcome) {
        return outcome;
    }
    auto method = vayu::parse_method (method_str);
    if (!method) {
        return route_error (400, "Invalid HTTP method");
    }
    r.method = *method;

    if (auto outcome = apply_required_string_field (json, "url", r.url, is_create); !outcome) {
        return outcome;
    }

    apply_string_field (json, "description", r.description, "", is_create);

    if (auto outcome = apply_key_value_field (json, "params", r.params, is_create); !outcome) {
        return outcome;
    }
    if (auto outcome = apply_key_value_field (json, "headers", r.headers, is_create); !outcome) {
        return outcome;
    }

    if (auto outcome = apply_json_field (json, "body", r.body, R"({"mode":"none"})", is_create);
    !outcome) {
        return outcome;
    }
    apply_string_field (json, "bodyType", r.body_type, "none", is_create);
    // A request's auth may be 'inherit' - that is its default, and the app
    // resolves the collection chain before the request is executed.
    if (auto outcome =
        apply_json_field (json, "auth", r.auth, R"({"mode":"inherit"})", is_create);
    !outcome) {
        return outcome;
    }
    apply_string_field (json, "preRequestScript", r.pre_request_script, "", is_create);
    apply_string_field (json, "postRequestScript", r.post_request_script, "", is_create);
    apply_int_field (json, "order", r.order, 0, is_create);
    apply_bool_field (json, "followRedirects", r.follow_redirects, true, is_create);

    // TLS verification (issue #706). Through the shared applier like every
    // other stored field, so `POST /requests`, `PUT /requests/:id` and
    // `POST /import/apply` all carry it without three copies of the rule.
    apply_bool_field (json, "verifySSL", r.verify_ssl, true, is_create);

    apply_int_field (json, "maxRedirects", r.max_redirects, 10, is_create);
    // Clamp to the range the UI offers; libcurl reads -1 as "unlimited", which
    // is not a policy we want a stray value to select.
    r.max_redirects = std::clamp (r.max_redirects, 0, 100);

    // Unlike the fields above, an unrecognized httpVersion is rejected rather
    // than coerced - see apply_http_version_field in routes.hpp. The seed is
    // read fresh here (not hoisted above the field applications) so it always
    // reflects the config entry as of this write.
    if (auto outcome = apply_http_version_field (
        json, "httpVersion", r.http_version, http_version_seed (db), is_create);
    !outcome) {
        return outcome;
    }

    // Consume the response as an event stream (issue #574). Through the shared
    // applier rather than the by-id route alone, so `POST /import/apply` -
    // which runs this same function over a bulk payload - carries it too.
    apply_bool_field (json, "stream", r.stream, false, is_create);

    // Operation identity (issue #637). Here rather than in the by-id route, for
    // the same reason `stream` is: `POST /import/apply` runs this same applier,
    // and an importer that recovered the operation a request came from must be
    // able to store it in the one call that writes the tree.
    if (auto outcome = apply_spec_operation_field (json, r.spec_operation, is_create);
    !outcome) {
        return outcome;
    }

    return {};
}

/**
 * Rejects a write that would park a request under a collection that does not
 * exist. Without it a stale or mistyped `collectionId` succeeded and stranded
 * the row invisibly: no per-collection GET lists it, and the cascade delete of
 * any real collection never reaps it. This is the endpoint a cross-collection
 * move uses, so the check guards the move as much as the create.
 *
 * Lives in the route cores rather than in `apply_request_fields`, because
 * `POST /import/apply` runs the shared applier against collection rows it has
 * not written yet - every id would look missing there.
 */
static RouteResult reject_missing_collection (vayu::db::Database& db,
const std::string& collection_id) {
    if (db.get_collection (collection_id).has_value ()) {
        return {};
    }
    return route_error (400, "Collection '" + collection_id + "' does not exist");
}

/**
 * The `order` a new request takes when the caller states none: one past the
 * highest among the collection's current requests, so a created or duplicated
 * request lands at the *end* of its collection.
 *
 * It used to default to 0 (`apply_int_field`), which tied every UI-created
 * request with every other and meant the stored column encoded nothing. The
 * moment explicit orders existed - the first drag - every new request would
 * have jumped to the top.
 *
 * Mirrors the sibling scan `apply_collection_fields` already does for
 * collections, and sits here for the same reason `reject_missing_collection`
 * does: bulk import sends explicit orders and cannot scan rows it has yet to
 * write.
 */
static int next_request_order (vayu::db::Database& db, const std::string& collection_id) {
    int max_order = -1;
    for (const auto& existing : db.get_requests_in_collection (collection_id)) {
        max_order = std::max (max_order, existing.order);
    }
    return max_order + 1;
}

/** True when the body leaves `order` to the engine - absent, or an explicit null. */
static bool order_is_defaulted (const nlohmann::json& json) {
    return !json.contains ("order") || json["order"].is_null ();
}

/**
 * Testable core of POST /requests - **create only**, returning
 * {http_status, json_body}. An id that already exists is a 409 pointing at PUT;
 * POST never updates (issue #95). A body `id` is rejected outright (#97) - see
 * create_collection_response for why the 409 stays behind an engine-generated
 * id.
 */
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (auto outcome = reject_client_supplied_id (json); !outcome) {
        return as_response (outcome.error ());
    }
    const std::string id = vayu::utils::generate_id ("req_");

    if (db.get_request (id).has_value ()) {
        return { 409, error_body (409, "Request '" + id + "' already exists; use PUT /requests/:id to update") };
    }

    vayu::db::Request r;
    r.id         = id;
    r.created_at = now_ms ();
    r.updated_at = now_ms ();

    if (auto outcome = apply_request_fields (db, r, json, /*is_create=*/true); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = reject_missing_collection (db, r.collection_id); !outcome) {
        return as_response (outcome.error ());
    }
    if (order_is_defaulted (json)) {
        r.order = next_request_order (db, r.collection_id);
    }

    db.save_request (r);
    return { 200, vayu::json::serialize (r) };
}

/** The read-merge-write of PUT /requests/:id, run under the caller's lock. */
static std::pair<int, nlohmann::json> update_request_locked (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    if (auto outcome = reject_mismatched_body_id (json, id); !outcome) {
        return as_response (outcome.error ());
    }
    auto existing = db.get_request (id);
    if (!existing) {
        return { 404, error_body (404, "Request not found") };
    }

    vayu::db::Request r = *existing;
    if (auto outcome = apply_request_fields (db, r, json, /*is_create=*/false); !outcome) {
        return as_response (outcome.error ());
    }
    // Only when the write states a collection: an already-stranded row (written
    // before this check existed) must stay repairable by a PUT that moves it
    // somewhere real, rather than becoming unwritable.
    if (json.contains ("collectionId")) {
        if (auto outcome = reject_missing_collection (db, r.collection_id); !outcome) {
            return as_response (outcome.error ());
        }
    }
    // A move that states no `order` appends in the destination. Carrying the
    // source position across would drop the request into an arbitrary slot among
    // its new siblings - the same defect a collection reparent had. Ordering
    // *within* a collection is still the caller's to state.
    if (r.collection_id != existing->collection_id && order_is_defaulted (json)) {
        r.order = next_request_order (db, r.collection_id);
    }
    r.updated_at = now_ms ();

    if (before_write) {
        before_write ();
    }
    db.save_request (r);
    return { 200, vayu::json::serialize (r) };
}

/**
 * Testable core of PUT /requests/:id - **update only**, returning
 * {http_status, json_body}. A missing id is a 404 rather than a silent create.
 * Merge-patch semantics, same as collections - including the 400 on a body `id`
 * that disagrees with the path (#97).
 *
 * **The read, the merge and the write are one lock scope** (#1440, the rule
 * `POST /reorder` states at length under #386). Merge-patch means the write
 * carries every field the body did not name, read a moment earlier - so two
 * PUTs to one row interleaved as read, read, write, write leave the second
 * writer's stale copy of the fields it never mentioned on top of the first
 * writer's changes, and the first client's edit is gone with no error on either
 * side. cpp-httplib serves on a thread pool and the renderer's autosave and an
 * MCP agent are genuinely concurrent clients, so the interleaving is reachable
 * today. Holding the lock across the composite makes the row the merge was
 * computed from still the stored row when the merge lands; the merge itself is
 * microseconds, which is the whole cost to everything else serializing here.
 *
 * @param before_write Test seam, invoked inside the lock scope with the merged
 *        row staged and immediately before it is written - the only way to
 *        drive a competing writer into the window this closes. It is a separate
 *        overload rather than the defaulted parameter `reorder_response` uses
 *        because ten test files already declare the three-argument form, and a
 *        defaulted parameter would move the symbol they link against.
 */
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock (
    [&] { result = update_request_locked (db, id, json, before_write); });
    return result;
}

std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    return update_request_response (db, id, json, nullptr);
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
     * pointing at PUT, never a silent update (issue #95). The engine assigns
     * the id; a body carrying one is a 400 (issue #97).
     * Body params: collectionId, name, method, url (all required), description,
     * params/headers (arrays of KeyValueEntry), body, bodyType, auth,
     * preRequestScript, postRequestScript, order, followRedirects,
     * maxRedirects, stream, specOperation ({operationId?, method, path} naming
     * the operation of the collection's bound spec this request is, or null for
     * none), httpVersion (absent/null seeds from the "defaultHttpVersion"
     * config entry; an unrecognized value is a 400, never silently coerced).
     * Returns: The created request object, or 400 (body `id`, missing required
     * field, bad field shape).
     */
    ctx.server.Post (
    "/requests", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = create_request_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /requests - " +
                std::to_string (status) + ": " + error_message_of (body));
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
                " for id=" + request_id + ": " + error_message_of (body));
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
