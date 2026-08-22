/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/examples.cpp
 * @brief Saved example responses, nested under their request (issue #481).
 *
 * An example is the response an importer found next to a request - Postman's
 * `item.response[]`, an OpenAPI operation's `responses` - which until now had
 * nowhere to live and was dropped at parse time. It is owned by exactly one
 * request, so every path here is nested under `/requests/:id`: the owner is
 * checked before anything else, and an example whose `request_id` disagrees
 * with the path is a 404 rather than a cross-request write.
 */

#include "vayu/core/constants.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <optional>
#include <string>
#include <utility>

namespace vayu::http::routes {

namespace {

/** The lowest and highest values an HTTP status line can carry (RFC 9110 §15). */
constexpr int MIN_HTTP_STATUS = 100;
constexpr int MAX_HTTP_STATUS = 599;

/**
 * 404 for "no such request", shared by every route here.
 *
 * The owner check runs before the example lookup on purpose: `GET
 * /requests/gone/examples/exa_1` must answer "no such request" rather than
 * silently reading an example whose owner has been deleted.
 */
RouteResult reject_missing_request (vayu::db::Database& db, const std::string& request_id) {
    if (db.get_request (request_id).has_value ()) {
        return {};
    }
    return route_error (404, "Request not found");
}

/**
 * Loads an example and proves it belongs to @p request_id.
 *
 * An example that exists under another request answers 404, not 200 or 403:
 * from this path's point of view the resource genuinely does not exist, and
 * saying otherwise would leak which ids are taken.
 */
RouteResult load_owned_example (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id,
vayu::db::RequestExample& out) {
    auto stored = db.get_request_example (example_id);
    if (!stored || stored->request_id != request_id) {
        return route_error (404, "Example not found");
    }
    out = *stored;
    return {};
}

/**
 * The `order` a new example takes when the caller states none: one past the
 * highest among the request's current examples, so a created example lands at
 * the end. The same scan `next_request_order` does for requests, and for the
 * same reason - defaulting every row to 0 would make the column encode nothing
 * and hand the position back to the id tiebreak.
 */
int next_example_order (vayu::db::Database& db, const std::string& request_id) {
    int max_order = -1;
    for (const auto& existing : db.get_request_examples (request_id)) {
        max_order = std::max (max_order, existing.order);
    }
    return max_order + 1;
}

/** True when the body leaves `order` to the engine - absent, or an explicit null. */
bool order_is_defaulted (const nlohmann::json& json) {
    return !json.contains ("order") || json["order"].is_null ();
}

/**
 * The null-vs-absent rule for `origin`, with the value checked against the two
 * the column accepts (issue #588).
 *
 * A rejected value is a 400 rather than a silent fall back to the default, on
 * the `apply_http_version_field` reasoning: an unrecognised origin stored as
 * `import` would hand a user-saved example to the next spec sync to overwrite,
 * and a typo is a payload bug worth naming rather than absorbing.
 */
RouteResult apply_origin_field (const nlohmann::json& json, std::string& out, bool is_create) {
    namespace example_bounds = vayu::core::constants::request_example;
    const std::string default_origin{ example_bounds::ORIGIN_IMPORT };

    if (!json.contains ("origin")) {
        if (is_create) {
            out = default_origin;
        }
        return {};
    }
    if (json["origin"].is_null ()) {
        out = default_origin;
        return {};
    }
    if (json["origin"].is_string ()) {
        const std::string candidate = json["origin"].get<std::string> ();
        if (candidate == example_bounds::ORIGIN_IMPORT ||
        candidate == example_bounds::ORIGIN_USER) {
            out = candidate;
            return {};
        }
    }
    return route_error (400,
    std::string ("Invalid 'origin': must be '") + example_bounds::ORIGIN_IMPORT +
    "' or '" + example_bounds::ORIGIN_USER + "'");
}

} // namespace

/**
 * Applies an example write onto @p x under the one null-vs-absent rule (see
 * routes.hpp), returning the 400 body on a rejected field.
 *
 * `name` has no default and so rejects absent-on-create and null on either
 * verb, matching every other resource's required fields. `status` is validated
 * rather than clamped: a stored 0 or 700 would be re-served verbatim by a mock
 * server, and a status nobody can send is a payload bug worth naming. The body
 * cap is a 400 for the same reason - see `request_example::MAX_BODY_BYTES`.
 * `origin` is validated against its two values by `apply_origin_field` above,
 * and defaults to `import` on create - the honest answer for every caller that
 * does not claim otherwise, since import wrote every row until #588.
 * `bodyTruncated` takes the plain boolean rule: nothing can validate it, since
 * only the client that captured the response knows whether it was cut, and the
 * stored body is a legitimate length either way.
 *
 * Declared in routes.hpp because `POST /import/apply` applies the same fields
 * to every example nested in a bulk payload.
 */
RouteResult apply_request_example_fields (vayu::db::RequestExample& x,
const nlohmann::json& json,
bool is_create) {
    if (auto outcome = apply_required_string_field (json, "name", x.name, is_create); !outcome) {
        return outcome;
    }

    apply_int_field (json, "status", x.status, 200, is_create);
    if (x.status < MIN_HTTP_STATUS || x.status > MAX_HTTP_STATUS) {
        return route_error (400,
        "Invalid 'status': " + std::to_string (x.status) + " is not an HTTP status code (" +
        std::to_string (MIN_HTTP_STATUS) + "-" + std::to_string (MAX_HTTP_STATUS) + ")");
    }

    if (auto outcome = apply_key_value_field (json, "headers", x.headers, is_create); !outcome) {
        return outcome;
    }

    apply_string_field (json, "body", x.body, "", is_create);
    if (x.body.size () > vayu::core::constants::request_example::MAX_BODY_BYTES) {
        return route_error (400,
        "Example body is " + std::to_string (x.body.size ()) + " bytes, over the " +
        std::to_string (vayu::core::constants::request_example::MAX_BODY_BYTES) + "-byte limit");
    }

    apply_string_field (json, "contentType", x.content_type, "", is_create);
    apply_int_field (json, "order", x.order, 0, is_create);
    // Defaults to false, which is the honest answer for every caller that does
    // not claim otherwise: only the client that captured the response knows it
    // was cut, and no later read of the row can tell (issue #659).
    apply_bool_field (json, "bodyTruncated", x.body_truncated, false, is_create);
    return apply_origin_field (json, x.origin, is_create);
}

/**
 * Testable core of GET /requests/:id/examples - the request's examples oldest
 * first, or a 404 when the request itself does not exist.
 *
 * An empty array and "no such request" are deliberately different answers: a
 * client that gets `[]` knows the request has no examples yet, which is what
 * the app's Examples tab shows before an import brings any.
 */
std::pair<int, nlohmann::json> list_request_examples_response (vayu::db::Database& db,
const std::string& request_id) {
    if (auto outcome = reject_missing_request (db, request_id); !outcome) {
        return as_response (outcome.error ());
    }
    nlohmann::json out = nlohmann::json::array ();
    for (const auto& x : db.get_request_examples (request_id)) {
        out.push_back (vayu::json::serialize (x));
    }
    return { 200, out };
}

/**
 * Testable core of POST /requests/:id/examples - **create only**, matching the
 * repo's verb split (#95): the engine assigns the id (#97), so a body `id` is a
 * 400 and the 409 only ever guards a `generate_id` collision.
 *
 * The per-request count cap is checked here rather than in the field applier,
 * because it is a property of the owner rather than of the payload - bulk
 * import counts its own slice against the same limit.
 */
std::pair<int, nlohmann::json> create_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const nlohmann::json& json) {
    if (auto outcome = reject_client_supplied_id (json); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = reject_missing_request (db, request_id); !outcome) {
        return as_response (outcome.error ());
    }

    const auto limit = vayu::core::constants::request_example::MAX_PER_REQUEST;
    if (db.count_request_examples (request_id) >= static_cast<int64_t> (limit)) {
        return { 409,
            error_body (409,
            "Request already holds the maximum of " + std::to_string (limit) + " examples") };
    }

    const std::string id = vayu::utils::generate_id ("exa_");
    if (db.get_request_example (id).has_value ()) {
        const std::string conflict = "Example '" + id +
        "' already exists; use PUT /requests/:id/examples/:exampleId to update";
        return { 409, error_body (409, conflict) };
    }

    vayu::db::RequestExample x;
    x.id         = id;
    x.request_id = request_id;
    x.created_at = now_ms ();
    x.updated_at = x.created_at;

    if (auto outcome = apply_request_example_fields (x, json, /*is_create=*/true); !outcome) {
        return as_response (outcome.error ());
    }
    if (order_is_defaulted (json)) {
        x.order = next_example_order (db, request_id);
    }

    db.save_request_example (x);
    return { 200, vayu::json::serialize (x) };
}

/**
 * Testable core of PUT /requests/:id/examples/:exampleId - **update only**,
 * merge-patch, 404 on a missing example rather than a silent create.
 */
std::pair<int, nlohmann::json> update_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id,
const nlohmann::json& json) {
    if (auto outcome = reject_mismatched_body_id (json, example_id); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = reject_missing_request (db, request_id); !outcome) {
        return as_response (outcome.error ());
    }
    vayu::db::RequestExample x;
    if (auto outcome = load_owned_example (db, request_id, example_id, x); !outcome) {
        return as_response (outcome.error ());
    }

    if (auto outcome = apply_request_example_fields (x, json, /*is_create=*/false); !outcome) {
        return as_response (outcome.error ());
    }
    x.updated_at = now_ms ();

    db.save_request_example (x);
    return { 200, vayu::json::serialize (x) };
}

/**
 * Testable core of DELETE /requests/:id/examples/:exampleId.
 *
 * **An imported example is tombstoned rather than removed** (issue #722). A
 * spec sync replaces every `origin="import"` row of a request it applies any
 * change to, so a removed row came back on the next rename-only sync and the
 * delete this route performs was not a decision that lasted. Keeping the row
 * as a tombstone (`suppressed`) is what records the decision - the sync reads
 * them and leaves that status alone.
 *
 * A user's own example is still removed outright: nothing re-creates one, so
 * there is no intent to remember and a hidden row would be a leak with no
 * reader. Either way the answer is the same, because from the caller's side it
 * is: the example is gone from every read.
 */
std::pair<int, nlohmann::json> delete_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id) {
    if (auto outcome = reject_missing_request (db, request_id); !outcome) {
        return as_response (outcome.error ());
    }
    vayu::db::RequestExample x;
    if (auto outcome = load_owned_example (db, request_id, example_id, x); !outcome) {
        return as_response (outcome.error ());
    }

    if (x.origin == vayu::core::constants::request_example::ORIGIN_IMPORT) {
        db.suppress_request_example (example_id, now_ms ());
    } else {
        db.delete_request_example (example_id);
    }
    return { 200,
        nlohmann::json{ { "message", "Example deleted successfully" }, { "id", example_id } } };
}

void register_request_example_routes (RouteContext& ctx) {
    /**
     * GET /requests/:id/examples
     * Lists a request's saved example responses, oldest first (created_at, then
     * id). Path params: id - the owning request.
     * Returns: an array of example objects, or 404 if the request does not exist.
     */
    ctx.server.Get (R"(/requests/([^/]+)/examples)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string request_id = req.matches[1];
        try {
            auto [status, body] = list_request_examples_response (ctx.db, request_id);
            if (status != 200) {
                vayu::utils::log_warning ("GET /requests/:id/examples - " +
                std::to_string (status) + " for request " + request_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /requests/:id/examples - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * POST /requests/:id/examples
     * Creates one saved example response on a request. Create only - the engine
     * assigns the id, so a body `id` is a 400 (#97) and the 409 guards only an
     * id collision or the per-request cap.
     * Body params: name (required), status (default 200, must be 100-599),
     * headers (array of KeyValueEntry), body, contentType, order (absent or
     * null appends after the request's current examples), origin ("import" |
     * "user", default "import" - the app's save-as-example sends "user"),
     * bodyTruncated (default false - true when `body` is only the first slice
     * of the response it was captured from).
     * Returns: the created example, 404 if the request does not exist, 400 on a
     * rejected field, or 409 at the cap.
     */
    ctx.server.Post (R"(/requests/([^/]+)/examples)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string request_id = req.matches[1];
        try {
            auto json = nlohmann::json::parse (req.body);
            auto [status, body] =
            create_request_example_response (ctx.db, request_id, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /requests/:id/examples - " +
                std::to_string (status) + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info (
                "POST /requests/:id/examples - Created example: id=" +
                body["id"].get<std::string> () + ", request=" + request_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /requests/:id/examples - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * PUT /requests/:id/examples/:exampleId
     * Updates one saved example (merge-patch: absent keeps, null resets).
     * Update only - a missing example is a 404, never a silent create, and so is
     * one stored under a different request.
     * Returns: the updated example, 404, or 400.
     */
    ctx.server.Put (R"(/requests/([^/]+)/examples/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string request_id = req.matches[1];
        const std::string example_id = req.matches[2];
        try {
            auto json = nlohmann::json::parse (req.body);
            auto [status, body] =
            update_request_example_response (ctx.db, request_id, example_id, json);
            if (status != 200) {
                vayu::utils::log_warning (
                "PUT /requests/:id/examples/:exampleId - " + std::to_string (status) +
                " for id=" + example_id + ": " + error_message_of (body));
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "PUT /requests/:id/examples/:exampleId - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * DELETE /requests/:id/examples/:exampleId
     * Deletes one saved example. Returns a message and the id, or 404.
     */
    ctx.server.Delete (R"(/requests/([^/]+)/examples/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string request_id = req.matches[1];
        const std::string example_id = req.matches[2];
        try {
            auto [status, body] =
            delete_request_example_response (ctx.db, request_id, example_id);
            if (status != 200) {
                vayu::utils::log_warning (
                "DELETE /requests/:id/examples/:exampleId - " +
                std::to_string (status) + " for id=" + example_id);
            } else {
                vayu::utils::log_info (
                "DELETE /requests/:id/examples/:exampleId - Deleted example: "
                "id=" +
                example_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /requests/:id/examples/:exampleId - Error: " +
            std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
