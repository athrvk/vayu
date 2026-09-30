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
#include "vayu/core/postman_export.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <cmath>
#include <ctime>
#include <limits>
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

/**
 * The null-vs-absent rule for `specExampleKey` (issue #1457): the `examples`
 * map key an OpenAPI import took this example from.
 *
 * Engine-side provenance, not a field the renderer ever sends - only the two
 * import writers (`POST /import/apply`, `POST /specs/sync`) name it, through
 * the same applier every other example write goes through. Nothing here
 * validates the value beyond the shape: a stale key the document no longer
 * declares is not this applier's to catch, since it can only be judged
 * against the document at export time.
 */
void apply_spec_example_key_field (const nlohmann::json& json,
std::optional<std::string>& out,
bool is_create) {
    if (!json.contains ("specExampleKey")) {
        if (is_create) {
            out = std::nullopt;
        }
        return;
    }
    out = json["specExampleKey"].is_string () ?
    std::make_optional (json["specExampleKey"].get<std::string> ()) :
    std::nullopt;
}

/**
 * `postmanResponse` (schema version 2): the Postman saved response an import
 * took this example from, as JSON text.
 *
 * A string rather than an object on purpose: the export writes the members
 * back in the order the source wrote them, and a body parsed into
 * `nlohmann::json` on its way here has already sorted them. Only an import
 * writes it - on create a string must parse as a JSON object within
 * `MAX_POSTMAN_RESPONSE_BYTES` - and an update may only clear it: the value
 * records what a file said, which no edit made in Vayu can author, and the
 * export already regenerates whatever an edit to `status` or `headers` makes
 * stale.
 */
RouteResult apply_postman_response_field (const nlohmann::json& json,
std::optional<std::string>& out,
bool is_create) {
    namespace example_bounds = vayu::core::constants::request_example;
    if (!json.contains ("postmanResponse")) {
        if (is_create) {
            out = std::nullopt;
        }
        return {};
    }
    const nlohmann::json& value = json["postmanResponse"];
    if (value.is_null ()) {
        out = std::nullopt;
        return {};
    }
    if (!is_create) {
        return route_error (400,
        "Invalid 'postmanResponse': an update can only clear it (null) - it "
        "records the "
        "Postman saved response the example was imported from");
    }
    if (!value.is_string ()) {
        return route_error (
        400, "Invalid 'postmanResponse': must be a string holding a JSON object, or null");
    }
    const auto& text = value.get_ref<const std::string&> ();
    if (text.size () > example_bounds::MAX_POSTMAN_RESPONSE_BYTES) {
        return route_error (400,
        "'postmanResponse' is " + std::to_string (text.size ()) + " bytes, over the " +
        std::to_string (example_bounds::MAX_POSTMAN_RESPONSE_BYTES) + "-byte limit");
    }
    const nlohmann::json parsed =
    nlohmann::json::parse (text, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_object ()) {
        return route_error (
        400, "Invalid 'postmanResponse': must be a string holding a JSON object, or null");
    }
    out = text;
    return {};
}

/// What a save in the app says produced the response (#1763): the request as
/// written when it was sent, and the server's own reason phrase.
struct SavedFrom {
    vayu::core::PostmanExportRequest request;
    std::string status_text;
    std::optional<double> response_time_ms;
    /// When the response came in, the clock a cookie's `Max-Age` counts
    /// from; nothing counts it from the save.
    std::optional<std::time_t> received_at;
};

/// @p json as the exporter's key-ordered JSON. A request body arrives parsed
/// into sorted `nlohmann::json`, which is also the order the request route
/// stores its own columns in, so nothing is lost the stored request keeps.
nlohmann::ordered_json as_ordered (const nlohmann::json& json) {
    return nlohmann::ordered_json::parse (json.dump ());
}

/// @p key of @p object as an array, `[]` when absent or null, or the 400
/// naming @p field.
RouteResult read_rows (const nlohmann::json& object,
const char* key,
const char* field,
nlohmann::ordered_json& out) {
    const auto found = object.find (key);
    if (found == object.end () || found->is_null ()) {
        out = nlohmann::ordered_json::array ();
        return {};
    }
    if (!found->is_array ()) {
        return route_error (400, std::string ("Invalid '") + field + "': must be an array");
    }
    out = as_ordered (*found);
    return {};
}

/// The Vayu verb @p text names, in any case, as the request column spells it.
std::optional<std::string> canonical_method (const std::string& text) {
    for (const vayu::HttpMethod method : { vayu::HttpMethod::GET,
         vayu::HttpMethod::POST, vayu::HttpMethod::PUT, vayu::HttpMethod::DELETE,
         vayu::HttpMethod::PATCH, vayu::HttpMethod::HEAD, vayu::HttpMethod::OPTIONS }) {
        if (vayu::utils::ascii_lower_equal (text, vayu::to_string (method))) {
            return std::make_optional<std::string> (vayu::to_string (method));
        }
    }
    return std::nullopt;
}

/// `savedFrom.request`: the stored request columns' shapes, as sent.
RouteResult read_sent_request (const nlohmann::json& request,
vayu::core::PostmanExportRequest& out) {
    if (!request.is_object ()) {
        return route_error (400, "Invalid 'savedFrom.request': must be an object");
    }
    const auto method = request.find ("method");
    std::optional<std::string> verb;
    if (method != request.end () && method->is_string ()) {
        verb = canonical_method (method->get<std::string> ());
    }
    if (!verb) {
        return route_error (400,
        "Invalid 'savedFrom.request.method': must be an HTTP method (GET, "
        "POST, "
        "PUT, DELETE, PATCH, HEAD or OPTIONS)");
    }
    out.method     = std::move (*verb);
    const auto url = request.find ("url");
    if (url == request.end () || !url->is_string ()) {
        return route_error (400, "Invalid 'savedFrom.request.url': must be a string");
    }
    out.url = url->get<std::string> ();
    if (auto outcome =
        read_rows (request, "params", "savedFrom.request.params", out.params);
    !outcome) {
        return outcome;
    }
    if (auto outcome =
        read_rows (request, "headers", "savedFrom.request.headers", out.headers);
    !outcome) {
        return outcome;
    }
    const auto body = request.find ("body");
    if (body == request.end () || body->is_null ()) {
        out.body = nlohmann::ordered_json{ { "mode", "none" } };
    } else if (body->is_object ()) {
        out.body = as_ordered (*body);
    } else {
        return route_error (400, "Invalid 'savedFrom.request.body': must be an object");
    }
    return {};
}

/**
 * `savedFrom` (#1763), create-only: the executed request and reason phrase a
 * save in the app hands over, from which the engine builds the example's
 * `postman_response` itself. Absent or null is no record. Read after
 * `apply_request_example_fields`, never inside it: it describes a live send,
 * which an import has none of, so `POST /import/apply` does not take it.
 * `postmanResponse` beside it would be two writers of one column, a 400.
 */
RouteResult read_saved_from (const nlohmann::json& json, std::optional<SavedFrom>& out) {
    const auto found = json.find ("savedFrom");
    if (found == json.end () || found->is_null ()) {
        return {};
    }
    if (const auto stored = json.find ("postmanResponse");
    stored != json.end () && !stored->is_null ()) {
        return route_error (400,
        "Invalid 'savedFrom': 'postmanResponse' is given too - the saved "
        "response is built from 'savedFrom', so send one or the other");
    }
    if (!found->is_object ()) {
        return route_error (400, "Invalid 'savedFrom': must be an object");
    }
    SavedFrom saved;
    const auto request = found->find ("request");
    if (request == found->end ()) {
        return route_error (400, "Invalid 'savedFrom.request': must be an object");
    }
    if (auto outcome = read_sent_request (*request, saved.request); !outcome) {
        return outcome;
    }
    const auto status_text = found->find ("statusText");
    if (status_text == found->end () || !status_text->is_string ()) {
        return route_error (400, "Invalid 'savedFrom.statusText': must be a string");
    }
    saved.status_text = status_text->get<std::string> ();
    if (const auto time = found->find ("responseTimeMs");
    time != found->end () && !time->is_null ()) {
        if (!time->is_number () || time->get<double> () < 0) {
            return route_error (400,
            "Invalid 'savedFrom.responseTimeMs': must be a number of "
            "milliseconds, "
            "0 or more");
        }
        saved.response_time_ms = time->get<double> ();
    }
    if (const auto received = found->find ("receivedAt");
    received != found->end () && !received->is_null ()) {
        if (!received->is_number () || received->get<double> () < 0) {
            return route_error (400,
            "Invalid 'savedFrom.receivedAt': must be a time in milliseconds "
            "since the epoch, 0 or more");
        }
        // Whole seconds, held to what `time_t` holds (2^63 itself does not
        // convert, hence `>=`).
        const double seconds = std::floor (received->get<double> () / 1000.0);
        constexpr auto LAST  = std::numeric_limits<std::time_t>::max ();
        saved.received_at    = seconds >= static_cast<double> (LAST) ?
           LAST :
           static_cast<std::time_t> (seconds);
    }
    out = std::move (saved);
    return {};
}

/**
 * The saved response @p saved records for the example just applied into
 * @p x, stored as its `postman_response`. Over the size cap the example is
 * kept without it (the export regenerates those members) and the loss logged.
 */
void record_saved_response (vayu::db::RequestExample& x, const SavedFrom& saved) {
    vayu::core::PostmanExportExample example;
    example.name   = x.name;
    example.status = x.status;
    example.headers =
    nlohmann::ordered_json::parse (x.headers, nullptr, /*allow_exceptions=*/false);
    if (!example.headers.is_array ()) {
        example.headers = nlohmann::ordered_json::array ();
    }
    x.postman_response = vayu::core::postman_saved_response_text (saved.request,
    example, saved.status_text, saved.response_time_ms,
    saved.received_at.value_or (std::time (nullptr)));
    if (!x.postman_response) {
        vayu::utils::log_warning ("http",
        "Saved example kept without its recorded request: over the size limit",
        { { "request", x.request_id },
        { "limit", vayu::core::constants::request_example::MAX_POSTMAN_RESPONSE_BYTES } });
    }
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
 * `postmanResponse` is create-only and cleared by `null` on update - see
 * `apply_postman_response_field`.
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
    apply_spec_example_key_field (json, x.spec_example_key, is_create);
    if (auto outcome = apply_postman_response_field (json, x.postman_response, is_create);
    !outcome) {
        return outcome;
    }
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
    std::optional<SavedFrom> saved;
    if (auto outcome = read_saved_from (json, saved); !outcome) {
        return as_response (outcome.error ());
    }
    if (saved) {
        record_saved_response (x, *saved);
    }
    if (order_is_defaulted (json)) {
        x.order = next_example_order (db, request_id);
    }

    db.save_request_example (x);
    return { 200, vayu::json::serialize (x) };
}

/**
 * The read-merge-write of PUT /requests/:id/examples/:exampleId, run under the
 * caller's lock.
 */
static std::pair<int, nlohmann::json> update_request_example_locked (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
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

    if (before_write) {
        before_write ();
    }
    db.save_request_example (x);
    return { 200, vayu::json::serialize (x) };
}

/**
 * Testable core of PUT /requests/:id/examples/:exampleId - **update only**,
 * merge-patch, 404 on a missing example rather than a silent create.
 *
 * **The read, the merge and the write are one lock scope** (#1440), for the
 * reason `update_request_response` states. The ownership check is inside it
 * too: an example reached through the wrong request is a 404, and a check that
 * released the lock before the write would answer for a row a concurrent
 * `delete_request` cascade could take in between.
 *
 * @param before_write Test seam, invoked inside the lock scope with the merged
 *        row staged and immediately before it is written; see
 *        `update_request_response` for why it is an overload.
 */
std::pair<int, nlohmann::json> update_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        result = update_request_example_locked (db, request_id, example_id, json, before_write);
    });
    return result;
}

std::pair<int, nlohmann::json> update_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id,
const nlohmann::json& json) {
    return update_request_example_response (db, request_id, example_id, json, nullptr);
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
                vayu::utils::log_warning ("http",
                "GET /requests/:id/examples - " + std::to_string (status) +
                " for request " + request_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
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
     * of the response it was captured from), savedFrom (optional, #1763:
     * `{request: {method, url, params?, headers?, body?}, statusText,
     * responseTimeMs?, receivedAt?}` - the request as written when it was
     * sent, the server's reason phrase and when the response came in (epoch
     * ms; a cookie's Max-Age counts from it), which the engine records as the
     * example's Postman saved response; a 400 beside a non-null
     * postmanResponse).
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
                vayu::utils::log_warning ("http",
                "POST /requests/:id/examples - " + std::to_string (status) +
                ": " + error_message_of (body));
            } else {
                vayu::utils::log_info ("http", "Created example",
                { { "id", body["id"].get<std::string> () }, { "request", request_id } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
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
                vayu::utils::log_warning ("http", "PUT /requests/:id/examples/:exampleId failed",
                { { "status", status }, { "id", example_id },
                { "error", error_message_of (body) } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
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
                vayu::utils::log_warning ("http", "DELETE /requests/:id/examples/:exampleId failed",
                { { "status", status }, { "id", example_id } });
            } else {
                vayu::utils::log_info ("http", "Deleted example", { { "id", example_id } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
            "DELETE /requests/:id/examples/:exampleId - Error: " +
            std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
