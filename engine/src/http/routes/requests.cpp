/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Request management routes. */

#include "vayu/core/constants.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/json_depth.hpp"
#include "vayu/core/query_encoding.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/list_page.hpp"
#include "vayu/http/mcp_body.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/ordered_json.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <format>
#include <functional>
#include <optional>
#include <ostream>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::http::routes {

/**
 * Testable core of GET /requests/:id, {http_status, json_body}. A missing
 * request is a definitive 404, never a transport failure: the app reads one
 * request by id, so 404 means "deleted" and a 5xx "engine unreachable". A hit
 * is 200 in a list entry's shape (`serialize(const db::Request&)`), with one
 * exception (#1485): it never substitutes a default for a column over the field
 * cap, so it carries no `truncatedFields` and answers what is stored, whole;
 * only `serialize_to_stream` (the list) produces that key. The error body is
 * `error_body`'s; `requests_route_test.cpp` covers the wiring.
 */
std::pair<int, nlohmann::json>
get_request_response (vayu::db::Database& db, const std::string& id) {
    auto request = db.get_request (id);
    if (!request) {
        return { 404, error_body (404, "Request not found") };
    }
    return { 200,
        vayu::json::serialize (*request, vayu::http::FileAccessPolicy::from_database (db)) };
}

/**
 * GET /requests answers one DB fetch as one serialized JSON array, rows already
 * ordered by `order`, `created_at`, `id` (the `get_request*_in_*` reads' ORDER
 * BY), the collections' ordering contract
 * (`docs/engine/api-reference/resource-writes.md` says why the tiebreak is
 * contract). Each row serializes into its own buffer inside the try, so a row
 * that fails is skipped whole: no half-written item corrupts the array, and one
 * bad row does not fail the response.
 */
namespace {
/// Hands @p on_item the text of every row of @p rows that serialized, in order.
template <typename Row, typename WriteRow, typename OnItem>
void serialize_each (const std::vector<Row>& rows, WriteRow write_row, OnItem on_item) {
    for (const auto& r : rows) {
        std::ostringstream item;
        try {
            write_row (r, item);
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
            "GET /requests - Error serializing request " + r.id + ": " +
            std::string (e.what ()));
            continue;
        }
        on_item (item.str ());
    }
}

template <typename Row, typename WriteRow>
std::string serialize_request_list (const std::vector<Row>& rows, WriteRow write_row) {
    std::string out = "[";
    bool is_first   = true;
    serialize_each (rows, write_row, [&] (const std::string& item) {
        if (!is_first) {
            out += ",";
        }
        is_first = false;
        out += item;
    });
    out += "]";
    return out;
}

/// One page of @p rows as the `{data, pagination}` envelope. `total` counts
/// the rows that matched `q` *and* serialized, so it agrees with what the
/// pages, read end to end, would hold; that means serializing every match,
/// though only the page's rows are kept.
template <typename Row, typename WriteRow>
std::string
serialize_request_page (std::vector<Row> rows, WriteRow write_row, const ListPage& page) {
    std::erase_if (
    rows, [&page] (const Row& r) { return !page.matches (r.name); });
    std::string data;
    std::size_t total    = 0;
    std::size_t returned = 0;
    serialize_each (rows, write_row, [&] (const std::string& item) {
        const std::size_t index = total++;
        if (index < page.offset || returned == page.limit) {
            return;
        }
        if (returned++ > 0) {
            data += ",";
        }
        data += item;
    });
    return "{\"data\":[" + data +
    "],\"pagination\":" + list_pagination (page, total, returned).dump () + "}";
}

auto full_row_writer (const vayu::http::FileAccessPolicy& files) {
    return [&files] (const vayu::db::Request& r, std::ostream& item) {
        vayu::json::serialize_to_stream (r, item, files);
    };
}

void write_summary_row (const vayu::db::RequestSummary& s, std::ostream& item) {
    item << vayu::json::serialize (s).dump ();
}

std::string serialize_full_rows (vayu::db::Database& db,
const std::vector<vayu::db::Request>& requests) {
    const auto files = vayu::http::FileAccessPolicy::from_database (db);
    return serialize_request_list (requests, full_row_writer (files));
}

std::string serialize_summary_rows (const std::vector<vayu::db::RequestSummary>& summaries) {
    return serialize_request_list (summaries, write_summary_row);
}

std::vector<vayu::db::Request> full_rows_of (vayu::db::Database& db,
const std::optional<std::string>& collection_id) {
    return collection_id ? db.get_requests_in_collection (*collection_id) :
                           db.get_requests_in_live_collections ();
}

std::vector<vayu::db::RequestSummary> summary_rows_of (vayu::db::Database& db,
const std::optional<std::string>& collection_id) {
    return collection_id ? db.get_request_summaries_in_collection (*collection_id) :
                           db.get_request_summaries_in_live_collections ();
}

/// The row shapes `GET /requests?fields=` can ask for (#2546).
enum class RequestListFields : std::uint8_t { Full, Summary };

/// Absent or empty is the full row; anything unknown is refused, not served as
/// the full list, so a typo cannot quietly cost the 10 MB the summary saves.
std::expected<RequestListFields, RouteError> parse_request_list_fields (
std::string_view fields) {
    if (fields.empty ()) {
        return RequestListFields::Full;
    }
    if (fields == "summary") {
        return RequestListFields::Summary;
    }
    return route_error (400,
    std::format ("'fields' must be one of [summary] (got '{}')", fields), "invalid_fields");
}
} // namespace

std::string list_requests_body (vayu::db::Database& db, const std::string& collection_id) {
    return serialize_full_rows (db, db.get_requests_in_collection (collection_id));
}

std::string list_all_requests_body (vayu::db::Database& db) {
    return serialize_full_rows (db, db.get_requests_in_live_collections ());
}

namespace {
std::string paged_requests_body (vayu::db::Database& db,
const std::optional<std::string>& collection_id,
RequestListFields shape,
const ListPage& page) {
    if (shape == RequestListFields::Summary) {
        return serialize_request_page (
        summary_rows_of (db, collection_id), write_summary_row, page);
    }
    const auto files = vayu::http::FileAccessPolicy::from_database (db);
    return serialize_request_page (
    full_rows_of (db, collection_id), full_row_writer (files), page);
}
} // namespace

/**
 * Testable core of the whole GET /requests route, {http_status, body_text}: one
 * collection's requests when @p collection_id is set, every live collection's
 * otherwise, in the row shape @p fields names. With any of `q` / `limit` /
 * `offset` in @p page_query, one page of the rows whose `name` matches, in the
 * `{data, pagination}` envelope (#2443); with none, a bare array.
 */
std::pair<int, std::string> list_requests_response (vayu::db::Database& db,
const std::optional<std::string>& collection_id,
std::string_view fields,
const ListPageQuery& page_query) {
    const auto shape = parse_request_list_fields (fields);
    if (!shape) {
        return { shape.error ().status, shape.error ().body.dump () };
    }
    if (page_query.present ()) {
        const auto page = parse_list_page (page_query);
        if (!page) {
            return { page.error ().status, page.error ().body.dump () };
        }
        return { 200, paged_requests_body (db, collection_id, *shape, *page) };
    }
    if (*shape == RequestListFields::Full) {
        return { 200, serialize_full_rows (db, full_rows_of (db, collection_id)) };
    }
    return { 200, serialize_summary_rows (summary_rows_of (db, collection_id)) };
}

/**
 * What a new or reset request's httpVersion is seeded with: the live
 * "defaultHttpVersion" config entry, read on every write (never cached, never
 * `vayu::DEFAULT_HTTP_VERSION`) so a changed global applies to the next create
 * or reset, falling back to `vayu::DEFAULT_HTTP_VERSION` only when the entry is
 * missing or outside `all_http_versions ()`. Validity goes through the domain's
 * parser: a tampered config row must not plant an invalid value, and what
 * counts as valid lives in one place.
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
 * Applies `specOperation`, which operation of the bound spec this request is
 * (#637), under the null-vs-absent rule, with `null` or absent-on-create
 * meaning "declares no operation" (a NULL column). Not `apply_json_field`,
 * which resets to a text default: `"{}"` would be a second spelling of "no
 * operation" every reader (the serializers, #627's diff, #629's coverage) would
 * have to learn.
 *
 * Contents are validated, not just shaped: `method` and `path` make the
 * identity, and half of one would fail much later as a request silently
 * matching nothing in its spec. `path` is the templated path, so it must start
 * with `/`: a concrete URL here would never match its document.
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
 * Applies `methodSource`, which app setting last wrote `method` while the user
 * has not claimed it (#1505), under `specOperation`'s rule: absent-on-create
 * and `null` mean no marker. The only value a client writes is `"graphql"` (the
 * GraphQL body mode's auto-`POST`), validated rather than opaque: an
 * unrecognised marker would outlive the setting meant to own it and revert a
 * method the user picked.
 */
static RouteResult apply_method_source_field (const nlohmann::json& json,
std::optional<std::string>& out,
bool is_create) {
    if (!json.contains ("methodSource")) {
        if (is_create) {
            out = std::nullopt;
        }
        return {};
    }
    const auto& value = json["methodSource"];
    if (value.is_null ()) {
        out = std::nullopt;
        return {};
    }
    if (!value.is_string () || value.get<std::string> () != "graphql") {
        return route_error (400, "Invalid 'methodSource': must be 'graphql' or null");
    }
    out = value.get<std::string> ();
    return {};
}

/// Why a stream setting's value cannot be stored (`stream_text_path_problem`,
/// `stream_first_content_marker_problem`); nothing when it can.
using StreamSettingProblem = std::optional<std::string> (*) (const nlohmann::json&);

/**
 * Applies one of a stream's string settings, `streamTextPath` (issue #3773) or
 * `streamFirstContentMarker` (#3774), onto @p out after `stream` has landed in
 * @p streams: absent keeps (or, on create, leaves none), `null` clears, and a
 * value is held to @p problem_of, the check `POST /execute` makes.
 *
 * A value the body states is refused on a row that does not stream after this
 * write, as `POST /execute` refuses one beside a buffered send: it reads as a
 * promise about events the request will not produce. A stored value is not
 * re-judged when only `stream` changes, so switching the stream off keeps it
 * for the next time it is switched on, and nothing reads it in between.
 */
static RouteResult apply_stream_setting_field (const nlohmann::json& json,
const char* key,
StreamSettingProblem problem_of,
bool streams,
std::optional<std::string>& out,
bool is_create) {
    const auto field = json.find (key);
    if (field == json.end () || field->is_null ()) {
        if (field != json.end () || is_create) {
            out = std::nullopt;
        }
        return {};
    }
    if (auto problem = problem_of (json)) {
        return route_error (400, *problem);
    }
    if (!streams) {
        return route_error (400,
        std::string ("'") + key + "' applies to a streaming request only - set 'stream': true, or drop it");
    }
    out = field->get<std::string> ();
    return {};
}

/// `stream` (issue #574) and the two settings that ride with it, each judged
/// against the row's `stream` as this write leaves it.
static RouteResult
apply_stream_fields (const nlohmann::json& json, vayu::db::Request& r, bool is_create) {
    apply_bool_field (json, "stream", r.stream, false, is_create);
    if (auto outcome = apply_stream_setting_field (json, "streamTextPath",
        stream_text_path_problem, r.stream, r.stream_text_path, is_create);
    !outcome) {
        return outcome;
    }
    return apply_stream_setting_field (json, "streamFirstContentMarker",
    stream_first_content_marker_problem, r.stream, r.stream_first_content_marker, is_create);
}

/**
 * Applies `mockResponseMode` / `mockExampleId` (#481 phase 3), which saved
 * example a mock server answers with. `mockResponseMode` absent-on-create
 * defaults to "first" (the shared string applier, like `httpVersion`);
 * `mockExampleId` absent keeps and `null` clears, like `specOperation`. The id
 * is not checked against `request_examples`: the target may be created after
 * this write, and its later delete must not make this row invalid;
 * `pick_example` (mock_server.cpp) falls back to "first" in either case.
 */
static RouteResult apply_mock_response_mode_field (const nlohmann::json& json,
std::string& mode,
std::optional<std::string>& example_id,
bool is_create) {
    if (!json.contains ("mockResponseMode")) {
        if (is_create) {
            mode = "first";
        }
    } else if (const auto& value = json["mockResponseMode"]; value.is_null ()) {
        mode = "first";
    } else if (!value.is_string () ||
    (value.get<std::string> () != "first" && value.get<std::string> () != "fixed" &&
    value.get<std::string> () != "random")) {
        return route_error (
        400, "Invalid 'mockResponseMode': must be 'first', 'fixed' or 'random'");
    } else {
        mode = value.get<std::string> ();
    }
    if (!json.contains ("mockExampleId")) {
        if (is_create) {
            example_id = std::nullopt;
        }
        return {};
    }
    const auto& value = json["mockExampleId"];
    if (value.is_null ()) {
        example_id = std::nullopt;
        return {};
    }
    if (!value.is_string () || value.get<std::string> ().empty ()) {
        return route_error (400, "Invalid 'mockExampleId': must be a non-empty string or null");
    }
    example_id = value.get<std::string> ();
    return {};
}

/**
 * A boolean protocol setting (issue #1765) under the one null-vs-absent rule,
 * with a non-boolean refused rather than ignored: `disableCookies: "true"`
 * read as nothing would send the jar the author turned off.
 */
static RouteResult
apply_strict_bool_field (const nlohmann::json& json, const char* key, bool& out, bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            out = false;
        }
        return {};
    }
    const auto& value = json[key];
    if (value.is_null ()) {
        out = false;
        return {};
    }
    if (!value.is_boolean ()) {
        return route_error (400, std::format ("Invalid '{}': must be a boolean", key));
    }
    out = value.get<bool> ();
    return {};
}

/**
 * Applies `disabledSystemHeaders` (issue #1765): the header names the engine
 * does not add to this request on its own, stored as a JSON array of lowercased
 * names, deduplicated, in first-appearance order. `null` resets to `[]`.
 *
 * A name is checked as a header token only (`invalid_header_token`), never
 * with the correlation-id rule: `user-agent` and `content-type` are exactly the
 * names this list exists to carry.
 */
static RouteResult apply_disabled_system_headers_field (const nlohmann::json& json,
std::string& out,
bool is_create) {
    constexpr const char* KEY = "disabledSystemHeaders";
    if (!json.contains (KEY)) {
        if (is_create) {
            out = "[]";
        }
        return {};
    }
    const auto& value = json[KEY];
    if (value.is_null ()) {
        out = "[]";
        return {};
    }
    if (!value.is_array ()) {
        return route_error (400,
        "Invalid 'disabledSystemHeaders': must be an array of header names");
    }
    nlohmann::json names = nlohmann::json::array ();
    std::vector<std::string> seen;
    for (const auto& entry : value) {
        if (!entry.is_string ()) {
            return route_error (
            400, "Invalid 'disabledSystemHeaders': must hold header names as strings");
        }
        const auto text = entry.get<std::string> ();
        if (auto rejection = vayu::http::invalid_header_token (text)) {
            return route_error (400, "Invalid 'disabledSystemHeaders': " + *rejection);
        }
        std::string folded = vayu::utils::ascii_lower (text);
        if (std::find (seen.begin (), seen.end (), folded) != seen.end ()) {
            continue;
        }
        seen.push_back (folded);
        names.push_back (std::move (folded));
    }
    std::string dumped = names.dump ();
    if (dumped.size () > vayu::core::constants::json::MAX_FIELD_SIZE) {
        return route_error (413,
        std::format (
        "'disabledSystemHeaders' is {} bytes, over the limit of {}",
        dumped.size (), vayu::core::constants::json::MAX_FIELD_SIZE));
    }
    out = std::move (dumped);
    return {};
}

/**
 * Applies `postmanProtocolBehavior` (#1765): the imported Postman item's
 * `protocolProfileBehavior`, kept for `POST /export/postman` and sent by
 * nothing; absent-on-create and `null` mean none. An object, or a string
 * holding a JSON object: the importer writes the string (the
 * `request_examples.postman_response` precedent) because an object crossing
 * this engine's JSON reader loses member order, which the export restores. The
 * text is stored as parsed by an order-preserving reader, so a string that is
 * not an object is refused like a non-object value.
 */
static RouteResult apply_postman_protocol_behavior_field (const nlohmann::json& json,
std::optional<std::string>& out,
bool is_create) {
    constexpr const char* KEY = "postmanProtocolBehavior";
    if (!json.contains (KEY)) {
        if (is_create) {
            out = std::nullopt;
        }
        return {};
    }
    const auto& value = json[KEY];
    if (value.is_null ()) {
        out = std::nullopt;
        return {};
    }
    std::string dumped;
    if (value.is_object ()) {
        dumped = value.dump ();
    } else if (value.is_string ()) {
        const auto parsed = vayu::utils::parse_ordered_json (
        value.get_ref<const std::string&> (), vayu::utils::ORDERED_JSON_UNBOUNDED);
        if (!parsed || !parsed->is_object ()) {
            return route_error (400,
            "Invalid 'postmanProtocolBehavior': must be an object, a string "
            "holding a JSON object, or null");
        }
        // The request body's depth bound (#2417) never looks inside a string,
        // and `dump ()` recurses (#2672). `json_within_depth` rather than
        // `exceeds_depth`: this tree is an `ordered_json`, and it is the
        // measure `parse_ordered_json`'s own bound uses.
        constexpr size_t max_depth = vayu::core::constants::request_body::MAX_JSON_DEPTH;
        if (!vayu::core::json_within_depth (*parsed, max_depth)) {
            return route_error (400,
            std::format (
            "Invalid 'postmanProtocolBehavior': nested deeper than {} levels", max_depth));
        }
        dumped = parsed->dump ();
    } else {
        return route_error (400,
        "Invalid 'postmanProtocolBehavior': must be an object, a string "
        "holding a JSON object, or null");
    }
    if (dumped.size () > vayu::core::constants::json::MAX_FIELD_SIZE) {
        return route_error (413,
        std::format (
        "'postmanProtocolBehavior' is {} bytes, over the limit of {}",
        dumped.size (), vayu::core::constants::json::MAX_FIELD_SIZE));
    }
    out = std::move (dumped);
    return {};
}

/** True when the body leaves `order` to the engine - absent, or an explicit null. */
static bool order_is_defaulted (const nlohmann::json& json) {
    return !json.contains ("order") || json["order"].is_null ();
}

/**
 * A request's `order`: a stated one through `read_order_field` (#3451). A
 * defaulted one is the append, which needs the stored siblings, so this
 * writes 0 and the cores and the batch writers replace it.
 */
static RouteResult
apply_request_order_field (const nlohmann::json& json, int& out, bool is_create) {
    if (!order_is_defaulted (json)) {
        return read_order_field (json["order"], out);
    }
    if (is_create || json.contains ("order")) {
        out = 0;
    }
    return {};
}

/**
 * A write that states `url` and not `params` brings the stored query rows into
 * line with the URL (issue #3551, `reconcile_query_rows`), on create and update
 * alike, so every reader of `params` sees the query the engine sends. A write
 * that states `params` is stored as sent, and one that states neither leaves
 * the rows alone. A reconcile that changes nothing writes nothing, so the
 * stored text stays byte for byte.
 */
static RouteResult
reconcile_params_with_url (const nlohmann::json& json, vayu::db::Request& r) {
    if (!json.contains ("url") || json.contains ("params")) {
        return {};
    }
    const auto stored =
    nlohmann::json::parse (r.params, nullptr, /*allow_exceptions=*/false);
    const nlohmann::json reconciled =
    vayu::core::reconcile_query_rows (stored, r.url);
    if (reconciled == stored) {
        return {};
    }
    std::string dumped = reconciled.dump ();
    if (dumped.size () > vayu::core::constants::json::MAX_FIELD_SIZE) {
        return route_error (413,
        std::format (
        "'params' read from 'url' is {} bytes, over the limit of {}",
        dumped.size (), vayu::core::constants::json::MAX_FIELD_SIZE));
    }
    r.params = std::move (dumped);
    return {};
}

/// A request's `params`: the rows a body states, through the shared validation,
/// then `reconcile_params_with_url`. `url` is applied first.
static RouteResult
apply_request_params_field (const nlohmann::json& json, vayu::db::Request& r, bool is_create) {
    if (auto outcome = apply_key_value_field (json, "params", r.params, is_create); !outcome) {
        return outcome;
    }
    return reconcile_params_with_url (json, r);
}

/// An `mcp` body's `mcpTool` that no send could read (#3762), refused where it
/// is written rather than at every send.
static RouteResult refuse_unreadable_mcp_tool (const nlohmann::json& body) {
    const auto mode = body.find ("mode");
    const auto tool = body.find ("mcpTool");
    if (mode == body.end () || *mode != "mcp" || tool == body.end () || tool->is_null ()) {
        return {};
    }
    if (auto read = vayu::http::read_mcp_tool (*tool); !read) {
        return route_error (400, read.error ());
    }
    return {};
}

/// Stores a stated object `body` on `r`, after `apply_json_field` has taken it
/// whole. Trust is derived on read and never stored (#2356): the `unresolved` an
/// older client still sends is dropped here, on every writer's path.
static RouteResult store_request_body (const nlohmann::json& json, vayu::db::Request& r) {
    const auto body = json.find ("body");
    if (body == json.end () || !body->is_object ()) {
        return {};
    }
    if (auto outcome = refuse_unreadable_mcp_tool (*body); !outcome) {
        return outcome;
    }
    nlohmann::json stored = *body;
    vayu::json::erase_file_trust (stored);
    r.body = stored.dump ();
    return {};
}

/**
 * Applies the request body onto `r` under the one null-vs-absent rule (the
 * helpers in routes.hpp), shared by the create and update cores so the verbs
 * agree on what a field means. `collectionId`, `name`, `method` and `url` have
 * no default: required on create, an explicit null refused on either verb.
 * `params` is the one field another field writes: a body stating `url` and no
 * `params` reconciles the query rows (`reconcile_params_with_url`). Declared in
 * routes.hpp because `POST /import/apply` runs it over every request in a bulk
 * payload (#96), which is how every field below reaches an imported row.
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

    // The method-source marker (#1505).
    if (auto outcome = apply_method_source_field (json, r.method_source, is_create); !outcome) {
        return outcome;
    }

    if (auto outcome = apply_required_string_field (json, "url", r.url, is_create); !outcome) {
        return outcome;
    }

    if (auto outcome = apply_string_field (json, "description", r.description, "", is_create);
    !outcome) {
        return outcome;
    }

    if (auto outcome = apply_request_params_field (json, r, is_create); !outcome) {
        return outcome;
    }
    if (auto outcome = apply_key_value_field (json, "headers", r.headers, is_create); !outcome) {
        return outcome;
    }

    if (auto outcome = apply_json_field (json, "body", r.body, R"({"mode":"none"})", is_create);
    !outcome) {
        return outcome;
    }
    if (auto outcome = store_request_body (json, r); !outcome) {
        return outcome;
    }
    if (auto outcome = apply_string_field (json, "bodyType", r.body_type, "none", is_create);
    !outcome) {
        return outcome;
    }
    // A request's auth may be 'inherit' - that is its default, and the app
    // resolves the collection chain before the request is executed.
    if (auto outcome =
        apply_json_field (json, "auth", r.auth, R"({"mode":"inherit"})", is_create);
    !outcome) {
        return outcome;
    }
    // An imported `postman` source that no longer describes the auth holds
    // the credential this write replaced; it goes with it.
    r.auth = vayu::core::without_stale_postman_source (std::move (r.auth));
    // Scripts are elements (#1514, no alias, per the owner's decision on
    // #1512): `preRequestScript` / `postRequestScript` refuse rather than
    // write.
    if (auto refusal = refuse_legacy_script_fields (json)) {
        return route_error (400, *refusal);
    }
    if (auto outcome = apply_elements_field (json, "elements", r.elements, is_create);
    !outcome) {
        return outcome;
    }
    if (auto outcome = apply_request_order_field (json, r.order, is_create); !outcome) {
        return outcome;
    }
    apply_bool_field (json, "followRedirects", r.follow_redirects, true, is_create);

    // TLS verification (#706).
    apply_bool_field (json, "verifySSL", r.verify_ssl, true, is_create);

    apply_int_field (json, "maxRedirects", r.max_redirects, 10, is_create);
    // Clamped to the UI's range: the redirect chain reads a negative limit as
    // unlimited (`redirect_limit_reached`), which a stray value must not
    // select.
    r.max_redirects = std::clamp (r.max_redirects, 0, 100);

    // The request's own timeout (issue #2937), refused rather than clamped
    // like `POST /execute`'s: `null` is "use the `defaultTimeout` setting".
    if (auto outcome = apply_nullable_int_field (
        json, REQUEST_TIMEOUT_FIELD, r.timeout_ms, is_create);
    !outcome) {
        return outcome;
    }

    // An unrecognised httpVersion is refused, not coerced
    // (`apply_http_version_field`, routes.hpp). The seed is read here, not
    // hoisted, so it reflects the config as of this write.
    if (auto outcome = apply_http_version_field (
        json, "httpVersion", r.http_version, http_version_seed (db), is_create);
    !outcome) {
        return outcome;
    }

    // Consume the response as an event stream (#574).
    if (auto outcome = apply_stream_fields (json, r, is_create); !outcome) {
        return outcome;
    }

    // Postman's per-request protocol settings (#1765).
    if (auto outcome =
        apply_strict_bool_field (json, "disableCookies", r.disable_cookies, is_create);
    !outcome) {
        return outcome;
    }
    if (auto outcome = apply_disabled_system_headers_field (
        json, r.disabled_system_headers, is_create);
    !outcome) {
        return outcome;
    }
    if (auto outcome = apply_strict_bool_field (
        json, "disableUrlEncoding", r.disable_url_encoding, is_create);
    !outcome) {
        return outcome;
    }
    if (auto outcome = apply_postman_protocol_behavior_field (
        json, r.postman_protocol_behavior, is_create);
    !outcome) {
        return outcome;
    }

    // Operation identity (#637), here so an importer that recovered a request's
    // operation stores it in the call that writes the tree.
    if (auto outcome = apply_spec_operation_field (json, r.spec_operation, is_create);
    !outcome) {
        return outcome;
    }

    // Which saved example a mock server answers with (#481 phase 3).
    if (auto outcome = apply_mock_response_mode_field (
        json, r.mock_response_mode, r.mock_example_id, is_create);
    !outcome) {
        return outcome;
    }

    return {};
}

/**
 * Refuses a write parking a request under a collection that does not exist: the
 * row would be stranded invisibly, listed by no per-collection GET and reaped
 * by no cascade delete. A cross-collection move uses this endpoint, so the
 * check guards moves as well as creates. In the route cores, not
 * `apply_request_fields`, because `POST /import/apply` runs the applier against
 * collection rows it has not written yet.
 */
static RouteResult reject_missing_collection (vayu::db::Database& db,
const std::string& collection_id) {
    if (db.get_collection (collection_id).has_value ()) {
        return {};
    }
    return route_error (400, "Collection '" + collection_id + "' does not exist");
}

/**
 * The `order` a request takes when the caller states none: one past the highest
 * of any sibling, sub-folders included (#2535), so it lands at the end of its
 * collection. A default of 0 would tie every UI-created request, and the first
 * drag would jump every new one to the top. Here, not in
 * `apply_request_fields`, for `reject_missing_collection`'s reason: bulk import
 * cannot scan unwritten rows and hands out its own slots.
 */
static RouteResult append_order (vayu::db::Database& db, vayu::db::Request& r) {
    return append_sibling_order (db, r.collection_id, r.order, r.id);
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
    if (auto outcome = reject_unknown_auth_mode (json); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = reject_inline_private_key (json); !outcome) {
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

    // The owner check, the append scan and the write are one lock scope
    // (#386's rule): a sibling created between the scan and the write would
    // take the same slot.
    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] {
        if (auto outcome = reject_missing_collection (db, r.collection_id); !outcome) {
            result = as_response (outcome.error ());
            return;
        }
        if (order_is_defaulted (json)) {
            if (auto outcome = append_order (db, r); !outcome) {
                result = as_response (outcome.error ());
                return;
            }
        }
        db.save_request (r);
        result = { 200,
            vayu::json::serialize (r, vayu::http::FileAccessPolicy::from_database (db)) };
    });
    return result;
}

/** The read-merge-write of PUT /requests/:id, run under the caller's lock. */
static std::pair<int, nlohmann::json> update_request_locked (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::optional<vayu::http::IfMatch>& if_match,
const std::function<void ()>& before_write) {
    if (auto outcome = reject_mismatched_body_id (json, id); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = reject_unknown_auth_mode (json); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = reject_inline_private_key (json); !outcome) {
        return as_response (outcome.error ());
    }
    auto existing = db.get_request (id);
    if (!existing) {
        return { 404, error_body (404, "Request not found") };
    }
    if (auto held = check_if_match (if_match, existing->updated_at); !held) {
        return as_response (held.error ());
    }

    vayu::db::Request r = *existing;
    if (auto outcome = apply_request_fields (db, r, json, /*is_create=*/false); !outcome) {
        return as_response (outcome.error ());
    }
    // Only when the write states a collection: a row stranded before this check
    // existed stays repairable by a PUT moving it somewhere real.
    if (json.contains ("collectionId")) {
        if (auto outcome = reject_missing_collection (db, r.collection_id); !outcome) {
            return as_response (outcome.error ());
        }
    }
    // A move stating no `order` appends in the destination: the source position
    // would drop it into an arbitrary slot among new siblings. An explicit null
    // resets to the default, the same append, as `apply_collection_fields` does
    // for a collection. Ordering within a collection is the caller's to state.
    const bool moved = r.collection_id != existing->collection_id;
    if (order_is_defaulted (json) && (moved || json.contains ("order"))) {
        if (auto outcome = append_order (db, r); !outcome) {
            return as_response (outcome.error ());
        }
    }
    // A move out of the contract that stamped the request declines its
    // operation there (#3446), as `delete_request_response` does. A body that
    // states `specOperation` has said what the moved row records.
    std::optional<std::string> declined_under;
    if (moved) {
        declined_under = declined_by_move (*existing,
        vayu::core::nearest_spec_binding (db, existing->collection_id),
        vayu::core::nearest_spec_binding (db, r.collection_id), db.get_collections ());
    }
    if (declined_under && !json.contains ("specOperation")) {
        r.spec_operation = std::nullopt;
    }
    r.updated_at = next_updated_at (existing->updated_at);

    if (before_write) {
        before_write ();
    }
    db.save_request (r, declined_under);
    return { 200,
        vayu::json::serialize (r, vayu::http::FileAccessPolicy::from_database (db)) };
}

/**
 * Testable core of PUT /requests/:id, **update only**, {http_status,
 * json_body}: a missing id is a 404, never a create. Merge-patch as for
 * collections, including the 400 on a body `id` disagreeing with the path
 * (#97).
 *
 * **The read, the merge and the write are one lock scope** (#1440; the rule
 * `POST /reorder` states under #386). A merge-patch write carries every field
 * the body did not name, read a moment earlier, so two PUTs interleaved read,
 * read, write, write lay the second writer's stale copy over the first's edit,
 * with no error on either side. cpp-httplib serves on a thread pool, and the
 * renderer's autosave and an MCP agent are concurrent clients, so this is
 * reachable. The merge is microseconds, the whole cost of serializing it.
 *
 * @param before_write Test seam, invoked inside the lock scope with the merged
 *        row staged and immediately before it is written, the only way to drive
 *        a competing writer into the window. A separate overload, not
 *        `reorder_response`'s defaulted parameter, because ten test files
 *        declare the three-argument form and a default would move the symbol
 *        they link against.
 * @param if_match The request's `If-Match`, judged inside the same scope; a row
 *        it no longer names is a 412 (#2433).
 */
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::optional<vayu::http::IfMatch>& if_match,
const std::function<void ()>& before_write) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        result = update_request_locked (db, id, json, if_match, before_write);
    });
    return result;
}

std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    return update_request_response (db, id, json, std::nullopt, before_write);
}

std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    return update_request_response (db, id, json, std::nullopt, nullptr);
}

/**
 * Testable core of DELETE /requests/:id, returning {http_status, json_body}.
 *
 * A request that records an operation of a bound document is that operation
 * declined (#3031): the delete records it under the binding that answers for
 * the request, `core::nearest_spec_binding`'s walk, so a later sync lists it
 * apart from what the document adds and a safe one leaves it out. The lookup,
 * the walk and the delete are one lock scope, or a binding moved in between
 * would be recorded against.
 */
std::pair<int, nlohmann::json>
delete_request_response (vayu::db::Database& db, const std::string& id) {
    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] {
        const auto request = db.get_request (id);
        if (!request) {
            result = { 404, error_body (404, "Request not found") };
            return;
        }
        std::optional<std::string> declined_under;
        if (const auto bound = vayu::core::nearest_spec_binding (db, request->collection_id)) {
            declined_under = bound->collection_id;
        }
        db.delete_request (id, declined_under);
        result = { 200,
            nlohmann::json{ { "message", "Request deleted successfully" }, { "id", id } } };
    });
    return result;
}

namespace {

/// `POST /requests`, registered below.
void handle_create_request (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    try {
        auto json = parse_request_json (req.body);
        if (!json) {
            refuse_request_body (res, "POST /requests", json.error ());
            return;
        }
        auto [status, body] = create_request_response (ctx.db, *json);
        if (status != 200) {
            vayu::utils::log_warning ("http",
            "POST /requests - " + std::to_string (status) + ": " + error_message_of (body));
        } else {
            vayu::utils::log_info ("http", "Created request",
            { { "id", body["id"].get<std::string> () },
            { "name", body["name"].get<std::string> () },
            { "method", body["method"].get<std::string> () },
            { "url", body["url"].get<std::string> () },
            { "collectionId", body["collectionId"].get<std::string> () } });
        }
        res.status = status;
        res.set_content (body.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "POST /requests - Error: " + std::string (e.what ()));
        send_exception (res, e);
    }
}

/// `PUT /requests/:id`, registered below.
void handle_update_request (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    std::string request_id = req.matches[1];
    try {
        auto json = parse_request_json (req.body);
        if (!json) {
            refuse_request_body (res, "PUT /requests/:id", json.error ());
            return;
        }
        const auto if_match = read_if_match (req);
        if (!if_match) {
            refuse_request_body (res, "PUT /requests/:id", if_match.error ());
            return;
        }
        auto [status, body] =
        update_request_response (ctx.db, request_id, *json, *if_match, nullptr);
        if (status != 200) {
            vayu::utils::log_warning ("http", "PUT /requests/:id failed",
            { { "status", status }, { "id", request_id },
            { "error", error_message_of (body) } });
        } else {
            vayu::utils::log_info ("http", "Updated request",
            { { "id", request_id }, { "name", body["name"].get<std::string> () } });
        }
        res.status = status;
        set_entity_tag (res, status, body);
        res.set_content (body.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "PUT /requests/:id - Error: " + std::string (e.what ()));
        send_exception (res, e);
    }
}

} // namespace

void register_request_routes (RouteContext& ctx) {
    /**
     * GET /requests
     * Retrieves the requests of one collection, or of every live collection,
     * ordered by their `order` field (matching GET /collections).
     * Query params: collectionId (optional) - The collection ID to fetch
     * requests from. Absent, every live request of every live collection,
     * grouped by `collectionId`. fields (optional) - `summary` answers only
     * the columns a tree is built from, which is what the app reads at launch
     * (#2546); absent, the full request objects. q, limit, offset
     * (optional) - any of them answers one page of the rows whose name holds
     * `q`, in the `{data, pagination}` envelope (#2443).
     */
    ctx.server.Get ("/requests", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            std::optional<std::string> collection_id;
            if (req.has_param ("collectionId")) {
                collection_id = req.get_param_value ("collectionId");
                vayu::utils::log_debug ("http",
                "GET /requests - Fetching requests for collection: " + *collection_id);
            }
            auto [status, body] = list_requests_response (ctx.db, collection_id,
            req.get_param_value ("fields"), list_page_query (req));
            res.status          = status;
            res.set_content (body, "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "GET /requests - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * GET /requests/:id
     * One request by id in one lookup, so a restored tab or a design-run copy
     * need not fetch and scan every list. Returns 200 with the request and its
     * ETag (#2433), or a definitive 404 the app tells from a transport failure.
     * Path params: id - The request ID to fetch.
     */
    ctx.server.Get (R"(/requests/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string request_id = req.matches[1];
        try {
            auto [status, body] = get_request_response (ctx.db, request_id);
            if (status == 404) {
                vayu::utils::log_warning (
                "http", "GET /requests/:id - Request not found: " + request_id);
            }
            res.status = status;
            set_entity_tag (res, status, body);
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "GET /requests/:id - Error: " + std::string (e.what ()));
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
     * elements, order, followRedirects, maxRedirects, verifySSL, timeout (ms,
     * 1..86400000, null for the defaultTimeout setting), stream,
     * streamTextPath, streamFirstContentMarker, disableCookies,
     * disableUrlEncoding, disabledSystemHeaders, postmanProtocolBehavior,
     * methodSource, mockResponseMode, mockExampleId, specOperation
     * ({operationId?, method, path} naming the operation of the collection's
     * bound spec this request is, or null for none), httpVersion (absent/null
     * seeds from the "defaultHttpVersion" config entry; an unrecognized value
     * is a 400, never silently coerced).
     * Returns: The created request object, or 400 (body `id`, missing required
     * field, bad field shape).
     */
    ctx.server.Post (
    "/requests", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_create_request (ctx, req, res);
    });

    /**
     * PUT /requests/:id
     * Updates an existing request (merge-patch: absent fields keep their value,
     * null resets to the default). Update only - a missing id is a 404, never a
     * silent create (issue #95). A `collectionId` that moves a stamped request
     * out of its spec contract declines its operation there and clears the
     * stamp, unless the body states `specOperation` (#3446).
     * Path params: id - The request ID to update.
     * Headers: If-Match (optional) - the row's `W/"<updatedAt>"` (#2433).
     * Returns: The updated request object with its ETag, 404 if it does not
     * exist, 412 if If-Match no longer names it, or 400.
     */
    ctx.server.Put (R"(/requests/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_update_request (ctx, req, res);
    });

    /**
     * DELETE /requests/:id
     * Moves a request to the trash; an operation of a bound document it
     * records is recorded as declined (#3031).
     * Path params: id - The request ID to delete.
     * Returns: Success message or 404 if not found.
     */
    ctx.server.Delete (R"(/requests/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string request_id = req.matches[1];
        try {
            auto [status, body] = delete_request_response (ctx.db, request_id);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "DELETE /requests/:id - Request not found: " + request_id);
            } else {
                vayu::utils::log_info ("http", "Successfully deleted request",
                { { "id", request_id } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "DELETE /requests/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
