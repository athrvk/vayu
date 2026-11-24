/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * POST /execute and POST /runs. The engine's status describes its own work: 200
 * whenever it processed the request, whatever the target answered (that status
 * is in the body, never translated), a 4xx for a request it refuses, a 5xx only
 * for its own failure.
 */

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <functional>
#include <optional>
#include <regex>
#include <set>
#include <string>

#include "vayu/core/constants.hpp"
#include "vayu/core/monitor.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/schema_validation.hpp"
#include "vayu/core/script_config.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/disconnect_watch.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/http/header_names.hpp"
#include "vayu/http/mcp_reply.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/http/send_log.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/status.hpp"
#include "vayu/http/target_policy.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

// What a script reads as `pm.info.requestName` for a POST /execute payload
// (#300). First the payload's `requestName`: inline editor state may be unsaved
// or a detached replay with no stored row, and `POST /compose` puts the stored
// name there on its by-id path. Then the row named by `requestId`, for a caller
// linking a saved request without its name (MCP's run_request). An empty name
// resolves to absent, so `typeof pm.info.requestName === "undefined"` holds; an
// unknown `requestId` yields no name, not an error, as the run row tolerates
// one.
RequestNameResolution resolve_script_request_name (vayu::db::Database& db,
const nlohmann::json& json,
const std::optional<std::string>& request_id) {
    RequestNameResolution resolved;

    if (auto it = json.find ("requestName"); it != json.end () && !it->is_null ()) {
        if (!it->is_string ()) {
            resolved.ok    = false;
            resolved.error = "'requestName' must be a string";
            return resolved;
        }
        auto name = it->get<std::string> ();
        if (!name.empty ()) {
            resolved.name = std::move (name);
            return resolved;
        }
    }

    if (request_id && !request_id->empty ()) {
        try {
            if (auto stored = db.get_request (*request_id);
            stored && !stored->name.empty ()) {
                resolved.name = stored->name;
            }
        } catch (const std::exception& e) {
            // A lookup failure costs the script a name, never the request.
            vayu::utils::log_warning ("http",
            "pm.info.requestName lookup failed: " + std::string (e.what ()));
        }
    }

    return resolved;
}

// `end_time` is seeded to `start_time`, so a crashed run reports a zero
// duration, not one spanning the downtime. A load or collection run's move to
// Running clears the seed so a live report measures to now, and
// `reconcile_orphaned_runs` gives a row with no end its `start_time` again
// (#3340); a design send, inserted Running, keeps it until its terminal move.
// Both insert sites go through here; `Run::end_time`'s 0 default is the
// backstop.
void seed_run_times (vayu::db::Run& run, int64_t started_at) {
    run.start_time = started_at;
    run.end_time   = started_at;
}

// Validates a POST /runs body's optional `httpVersion`. This is how a run
// states its protocol (as it states its redirect policy; MCP's ad-hoc runs have
// no saved request), not a per-run override: the Settings tab's one control
// governs Send and load alike. `json` is the handler's copy; nothing stored is
// touched.
//
// Absent, or `null` (erased, so two outcomes, not three), leaves the protocol
// to the request field `deserialize_request` reads. Erasing rather than seeding
// `DEFAULT_HTTP_VERSION` ends at `Auto` either way today (the only
// `httpVersion` in play is the client's; no stored one is read here), but keeps
// deferring once a config-backed default is resolved at this layer. A run has
// no stored field, so the null-resets-to-default rule does not apply.
//
// A present value is held to `apply_http_version_field` (routes.hpp): a typo is
// a 400 naming the field and the valid values, not `deserialize_request`'s
// lenient coercion to `Auto`, which exists for a corrupted stored row. The
// validated string is written back because `null` would throw at
// `.get<std::string> ()` there.
RouteResult normalize_run_http_version (nlohmann::json& json) {
    if (!json.contains ("httpVersion")) {
        return {};
    }
    if (json["httpVersion"].is_null ()) {
        json.erase ("httpVersion");
        return {};
    }
    // Present and non-null by now, so the branches that consume `seed` are
    // unreachable; the signature requires it.
    std::string version;
    if (auto outcome = apply_http_version_field (json, "httpVersion", version,
        vayu::to_string (vayu::DEFAULT_HTTP_VERSION), /*is_create=*/false);
    !outcome) {
        return outcome;
    }
    json["httpVersion"] = version;
    return {};
}

/**
 * Replaces a scenario run's raw `scenario` block with its step manifest.
 * `sanitize_config_snapshot` only withholds credentials; the block also carries
 * the `data` rows, user data never snapshotted (the manifest keeps their
 * count), and the manifest records each step's stored URL, so an `apikey` in
 * the query cannot reach the run store. A non-JSON snapshot (passed through by
 * the sanitizer) is left alone: there is no request in it.
 *
 * Non-static so `run_row_seed_test.cpp` can pin "the composed plan is never
 * persisted", a security property, without a run.
 */
std::string scenario_snapshot (const std::string& sanitized, const nlohmann::json& manifest) {
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse (sanitized);
    } catch (const std::exception&) {
        return sanitized;
    }
    if (!parsed.is_object ()) {
        return sanitized;
    }
    parsed["scenario"] = manifest;
    return parsed.dump ();
}

namespace {
/// One boolean `POST /execute` flag: absent or `null` reads as @p fallback, any
/// other non-boolean is refused naming @p key.
ExecuteFlag read_execute_flag (const nlohmann::json& json, const char* key, bool fallback) {
    ExecuteFlag flag;
    flag.value       = fallback;
    const auto field = json.find (key);
    if (field == json.end () || field->is_null ()) {
        return flag;
    }
    if (!field->is_boolean ()) {
        flag.ok    = false;
        flag.error = std::string ("'") + key + "' must be a boolean";
        return flag;
    }
    flag.value = field->get<bool> ();
    return flag;
}
} // namespace

/**
 * `POST /execute`'s `transient` flag (#382): the request runs in full (same
 * composition, cookie jar, scripts, response) but records nothing: no run row,
 * no trace, no retention prune. GraphQL schema introspection is a background
 * fetch; recorded, it would put runs nobody made in History, write post-auth
 * headers to disk and evict real runs through the prune.
 *
 * Absent and `null` mean `false`. A non-boolean is a 400, not a silent `false`:
 * a client sending `"true"` asks for privacy it would not get. (Stricter than
 * `allowScriptRequests`, whose non-boolean-means-no only denies a capability.)
 *
 * Non-static for `transient_execute_test.cpp`.
 */
ExecuteFlag read_transient_flag (const nlohmann::json& json) {
    return read_execute_flag (json, "transient", false);
}

/**
 * `POST /execute`'s `persistVariables` flag (#1904). Absent and `null` mean
 * `true`, so existing callers keep writing back what scripts set; a non-boolean
 * is a 400, since a caller sending `"false"` believes nothing reaches disk.
 */
ExecuteFlag read_persist_variables_flag (const nlohmann::json& json) {
    return read_execute_flag (json, "persistVariables", true);
}

/**
 * `POST /execute`'s `includeParsedBody` flag (#2544). Absent and `null` mean
 * `true`, so existing callers keep `body`; a non-boolean is a 400.
 */
ExecuteFlag read_include_parsed_body_flag (const nlohmann::json& json) {
    return read_execute_flag (json, "includeParsedBody", true);
}

namespace {

/// One cap into @p out; a non-integer or out-of-range value is refused on
/// @p flag, naming the key.
bool read_stream_cap (const nlohmann::json& json,
const char* key,
int64_t low,
int64_t high,
std::optional<int64_t>& out,
StreamFlag& flag) {
    const auto field = json.find (key);
    if (field == json.end () || field->is_null ()) {
        return true;
    }
    if (!field->is_number_integer ()) {
        flag.ok    = false;
        flag.error = std::string ("'") + key + "' must be an integer (got " +
        field->type_name () + ")";
        return false;
    }
    const int64_t value = field->get<int64_t> ();
    if (value < low || value > high) {
        flag.ok    = false;
        flag.error = std::string ("'") + key + "' must be between " +
        std::to_string (low) + " and " + std::to_string (high) + " (got " +
        std::to_string (value) + ")";
        return false;
    }
    out = value;
    return true;
}

/// `maxStreamDurationMs` and `maxStreamEvents`, each range-checked.
bool read_stream_caps (const nlohmann::json& json, StreamFlag& flag) {
    namespace sse_limits = vayu::core::constants::sse;
    return read_stream_cap (json, "maxStreamDurationMs", sse_limits::MIN_STREAM_DURATION_MS,
           sse_limits::STREAM_DURATION_MS_CEILING, flag.max_duration_ms, flag) &&
    read_stream_cap (json, "maxStreamEvents", sse_limits::MIN_STREAM_EVENTS,
    sse_limits::STREAM_EVENTS_CEILING, flag.max_events, flag);
}

/// `streamTextPath` (#3773), held to `stream_text_path_problem`, onto
/// @p flag; refused on @p flag otherwise.
bool read_stream_text_path (const nlohmann::json& json, StreamFlag& flag) {
    if (auto problem = stream_text_path_problem (json)) {
        flag.ok    = false;
        flag.error = std::move (*problem);
        return false;
    }
    if (const auto field = json.find ("streamTextPath");
    field != json.end () && field->is_string ()) {
        flag.text_path = field->get<std::string> ();
    }
    return true;
}

/// `streamFirstContentMarker` (#3774), held to
/// `stream_first_content_marker_problem`; refused on @p flag otherwise. Only
/// checked, never kept: see `read_stream_flag` in routes.hpp.
bool check_stream_first_content_marker (const nlohmann::json& json, StreamFlag& flag) {
    if (auto problem = stream_first_content_marker_problem (json)) {
        flag.ok    = false;
        flag.error = std::move (*problem);
        return false;
    }
    return true;
}

/// Whether @p json states @p key as anything but `null`.
bool has_non_null (const nlohmann::json& json, const char* key) {
    const auto field = json.find (key);
    return field != json.end () && !field->is_null ();
}

} // namespace

/**
 * A payload's `stream` flag and caps (#573), for `POST /execute` and
 * `POST /runs` (#576); the refusal set is in routes.hpp. Non-static for
 * `sse_stream_test.cpp`, which has no in-process route harness.
 */
StreamFlag read_stream_flag (const nlohmann::json& json) {
    StreamFlag flag;

    const auto field = json.find ("stream");
    if (field != json.end () && !field->is_null ()) {
        if (!field->is_boolean ()) {
            flag.ok = false;
            // Not a silent false: a caller sending `"true"` would get a
            // buffered send and wait for a response the endpoint never
            // finishes.
            flag.error = "'stream' must be a boolean (got " +
            std::string (field->type_name ()) + ")";
            return flag;
        }
        flag.value = field->get<bool> ();
    }

    if (!read_stream_caps (json, flag) || !read_stream_text_path (json, flag) ||
    !check_stream_first_content_marker (json, flag)) {
        return flag;
    }

    // A cap or text path on a non-streaming payload is refused: ignoring a cap
    // lets an unbounded run pass for a capped one, and a buffered send has no
    // events to honour a text path with.
    if (!flag.value) {
        if (flag.max_duration_ms || flag.max_events) {
            flag.ok = false;
            flag.error =
            "'maxStreamDurationMs' and 'maxStreamEvents' apply to a "
            "streaming request only - set 'stream': true, or drop them";
        } else if (flag.text_path) {
            flag.ok = false;
            flag.error =
            "'streamTextPath' applies to a streaming request only - set "
            "'stream': true, or drop it";
        } else if (has_non_null (json, "streamFirstContentMarker")) {
            flag.ok = false;
            flag.error =
            "'streamFirstContentMarker' applies to a streaming request only - "
            "set 'stream': true, or drop it";
        }
        return flag;
    }

    const auto transient = json.find ("transient");
    if (transient != json.end () && transient->is_boolean () && transient->get<bool> ()) {
        flag.ok = false;
        flag.error =
        "'stream' and 'transient' cannot be combined: a stream is "
        "identified by its run row - that is what the events URL "
        "names, what carries its status, and what stopping it finds "
        "- and a transient execution creates none";
        return flag;
    }

    return flag;
}

StreamFlag read_collection_run_stream_caps (const nlohmann::json& json) {
    StreamFlag flag;
    const auto field = json.find ("stream");
    if (field != json.end () && !field->is_null ()) {
        flag.ok = false;
        flag.error =
        "'stream' is not valid on a collection run - a step streams when its "
        "stored request has 'stream' set. 'maxStreamDurationMs' and "
        "'maxStreamEvents' bound those steps without it, so drop 'stream'";
        return flag;
    }
    if (has_non_null (json, "streamTextPath")) {
        flag.ok = false;
        flag.error =
        "'streamTextPath' is not valid on a collection run - a step reads its "
        "stream's text through its stored request's 'streamTextPath', so set "
        "it there and drop it here";
        return flag;
    }
    if (has_non_null (json, "streamFirstContentMarker")) {
        flag.ok = false;
        flag.error =
        "'streamFirstContentMarker' is not valid on a collection run - a step "
        "watches its stream for its stored request's "
        "'streamFirstContentMarker', so set it there and drop it here";
        return flag;
    }
    read_stream_caps (json, flag);
    return flag;
}

namespace {

std::string_view trim_ascii_space (std::string_view text) {
    constexpr std::string_view SPACE = " \t\n\v\f\r";
    const auto first                 = text.find_first_not_of (SPACE);
    if (first == std::string_view::npos) {
        return {};
    }
    return text.substr (first, text.find_last_not_of (SPACE) - first + 1);
}

/// @p text cut to its first @p max_chars code points. A continuation byte is
/// never counted, so the cut lands on a sequence boundary.
std::string_view first_code_points (std::string_view text, std::size_t max_chars) {
    std::size_t offset = 0;
    std::size_t seen   = 0;
    for (const char byte : text) {
        const bool continuation = (static_cast<unsigned char> (byte) & 0xC0U) == 0x80U;
        if (!continuation) {
            if (seen == max_chars) {
                return text.substr (0, offset);
            }
            ++seen;
        }
        ++offset;
    }
    return text;
}

/// The stored form of `origin.client`: trimmed, capped, and absent when that
/// leaves nothing. Trimmed again after the cut so it cannot end in a space.
std::optional<std::string> stored_origin_client (std::string_view raw) {
    const auto client = trim_ascii_space (
    first_code_points (trim_ascii_space (raw), MAX_RUN_ORIGIN_CLIENT_CHARS));
    if (client.empty ()) {
        return std::nullopt;
    }
    return std::string (client);
}

} // namespace

std::expected<RunOrigin, std::string> read_run_origin (const nlohmann::json& json) {
    const auto field = json.find ("origin");
    if (field == json.end () || field->is_null ()) {
        return RunOrigin{};
    }
    if (!field->is_object ()) {
        return std::unexpected (
        std::string ("'origin' must be an object (got ") + field->type_name () + ")");
    }
    const auto kind = field->find ("kind");
    if (kind == field->end () || !kind->is_string () ||
    !is_run_origin_kind (kind->get_ref<const std::string&> ())) {
        return std::unexpected (
        std::string ("'origin.kind' must be one of app, mcp, other"));
    }
    const auto client     = field->find ("client");
    const bool has_client = client != field->end () && !client->is_null ();
    if (has_client && !client->is_string ()) {
        return std::unexpected (
        std::string ("'origin.client' must be a string (got ") + client->type_name () + ")");
    }

    RunOrigin origin{ .kind = kind->get<std::string> (), .client = std::nullopt };
    if (has_client && origin.kind == "mcp") {
        origin.client = stored_origin_client (client->get_ref<const std::string&> ());
    }
    return origin;
}

std::expected<std::optional<std::string>, std::string>
read_optional_string_field (const nlohmann::json& json, const char* key) {
    const auto field = json.find (key);
    if (field == json.end () || field->is_null ()) {
        return std::nullopt;
    }
    if (!field->is_string ()) {
        return std::unexpected (std::string ("'") + key +
        "' must be a string (got " + field->type_name () + ")");
    }
    return field->get<std::string> ();
}

namespace {

/**
 * Stamp the `requestId` and `environmentId` the payload names onto @p run, and
 * answer the collection whose chain its scripts read and whose secrets mask its
 * snapshot: `scope_collection_id` of that `requestId` and the payload's
 * `collectionId` (#3461), decided once here so the two readers cannot differ.
 * @return the 400's message when any of the three is not a string.
 */
std::expected<std::string, std::string>
read_run_scope (vayu::db::Database& db, const nlohmann::json& json, vayu::db::Run& run) {
    auto request_id = read_optional_string_field (json, "requestId");
    if (!request_id) {
        return std::unexpected (request_id.error ());
    }
    auto environment_id = read_optional_string_field (json, "environmentId");
    if (!environment_id) {
        return std::unexpected (environment_id.error ());
    }
    const auto collection_id = read_optional_string_field (json, "collectionId");
    if (!collection_id) {
        return std::unexpected (collection_id.error ());
    }
    run.request_id     = std::move (*request_id);
    run.environment_id = std::move (*environment_id);
    return scope_collection_id (db, run.request_id, *collection_id);
}

/// A top-level data-file key on a collection run, refused by name for the
/// reason a top-level `data` is: the block holds its own.
std::optional<std::string> refuse_top_level_data_file (const nlohmann::json& json) {
    for (const char* key : { "dataFileName", "dataFileHash", "dataFileCastNumbers" }) {
        if (auto field = json.find (key); field != json.end () && !field->is_null ()) {
            return std::string ("'") + key +
            "' is the single-request form. A collection run names its data "
            "file inside the block, as 'scenario." +
            key + "' beside 'scenario.data' - move it there, or drop the 'scenario' block.";
        }
    }
    return std::nullopt;
}

} // namespace

/// `POST /execute`'s `data` row (#601); the field's meaning is in routes.hpp.
/// Non-static for `send_with_row_test.cpp` (no in-process route harness).
DataRow read_data_row (const nlohmann::json& json, size_t max_bytes) {
    DataRow row;
    const auto field = json.find ("data");
    if (field == json.end () || field->is_null ()) {
        return row;
    }
    if (!field->is_object ()) {
        row.ok = false;
        // Says "name/value pairs" because the near miss is an array (the
        // `scenario.data` shape), and that caller must hear a send binds one
        // row.
        row.error = "'data' must be an object of name/value pairs (got " +
        std::string (field->type_name ()) +
        "). A single send binds one row; a set of rows is a collection run.";
        return row;
    }

    // Ahead of the measure: `dump ()` recurses, and a cell nested far enough
    // overflows the stack (#2362). Same rule and wording as a data set's rows.
    if (auto refusal = vayu::core::refuse_overdeep_cell (*field, "data", std::nullopt)) {
        row.ok    = false;
        row.error = std::move (*refusal);
        return row;
    }

    // The run data set's bound, applied to this one row before it is kept, so
    // an oversized payload is refused rather than held.
    const size_t bytes = field->dump ().size ();
    if (bytes > max_bytes) {
        row.ok    = false;
        row.error = "'data' is " + std::to_string (bytes) +
        " bytes, over the limit of " + std::to_string (max_bytes) +
        " (raise the 'maxScenarioDataBytes' setting to allow more)";
        return row;
    }

    row.value = *field;
    return row;
}

/// How a send-with-row resolves its credentials (#642); the contract, and why
/// the ordinary send is untouched, are in routes.hpp. Non-static for
/// `send_with_row_test.cpp`.
SendRowAuth plan_send_row_auth (const nlohmann::json& json,
const vayu::http::BoundColumnNames& bound_columns) {
    SendRowAuth out;
    const auto auth_json = json.value ("auth", nlohmann::json ());
    // Asked of the raw JSON first: `parse_auth` warns on an unresolved
    // `inherit` and the build parses this block again, so a second parse would
    // double that warning. A block with no token (every ordinary send) is
    // answered unparsed (#1055).
    if (!vayu::core::first_token_in (auth_json)) {
        return out;
    }
    out.auth = vayu::http::parse_auth (auth_json);

    if (auto token = vayu::core::first_oauth2_deferrable_token (out.auth, bound_columns)) {
        out.ok    = false;
        out.error = "Auth credentials carry " + *token +
        " in an OAuth 2.0 configuration, and nothing can reach it: the "
        "token is acquired against the token endpoint before the request "
        "is sent, not written into the request the way every other "
        "credential is. Use a static credential there, or move the token "
        "into the request itself.";
        return out;
    }

    out.credentials = vayu::core::tokenize_auth_fields (out.auth, bound_columns);
    out.after_scripts = vayu::core::credentials_await_scripts (out.auth, bound_columns);
    if (!out.credentials.empty () || out.after_scripts) {
        out.resolution = vayu::http::AuthResolution::Defer;
    }
    return out;
}

/// `POST /runs`' top-level `data` rows (#993); the field's meaning is in
/// routes.hpp. Non-static for `load_data_test.cpp` (no in-process route
/// harness).
LoadDataRows read_load_data_set (const nlohmann::json& json,
const vayu::core::ScenarioLimits& limits,
bool is_scenario) {
    LoadDataRows out;
    const auto field       = json.find ("data");
    const bool carries_set = field != json.end () && !field->is_null ();

    // A collection run states its rows in the block naming the collection,
    // bound one per iteration across its steps rather than one per submission.
    // Refused, not ignored: dropped rows would read as literal `{{data.*}}`
    // tokens working.
    if (carries_set && is_scenario) {
        out.ok    = false;
        out.error = "'data' is the single-request form of a data set. A "
                    "collection run states its rows as 'scenario.data', where "
                    "one row is bound per iteration and shared by every step - "
                    "move them there, or drop the 'scenario' block.";
        return out;
    }
    if (auto refusal = is_scenario ? refuse_top_level_data_file (json) : std::nullopt) {
        out.ok    = false;
        out.error = std::move (*refusal);
        return out;
    }

    std::unique_ptr<vayu::core::LoadDataSet> set;
    vayu::core::DataFileProvenance file;
    if (auto reason = vayu::core::read_data_file_fields (json, "", carries_set, file)) {
        out.ok    = false;
        out.error = std::move (*reason);
        return out;
    }
    if (carries_set) {
        set = std::make_unique<vayu::core::LoadDataSet> ();
        // The scenario block's reader, so the two shapes agree on what a row is
        // and which limit refuses it.
        if (auto reason =
            vayu::core::read_data_rows (*field, limits, "data", set->rows)) {
            out.ok    = false;
            out.error = *reason;
            return out;
        }
        set->bound_columns = vayu::core::bound_columns_of (set->rows);
        set->file          = std::move (file);
    }

    // A scenario's credentials are its steps', resolved with the plan: no
    // single request here could defer, and asking would refuse a top-level
    // oauth2 block no step uses.
    if (is_scenario) {
        out.set = std::move (set);
        return out;
    }

    // Decided here because the build would otherwise encode the credentials out
    // of reach, as for a one-row send (#642); the refusal it can carry is an
    // oauth2 config holding a token deferral would bind, which no deferral can
    // serve. Asked of every run, not only one with rows (#1055): `{{$vu}}`
    // defers without a set. Credentials spelling no token parse nothing here
    // and resolve in the build.
    const auto bound_columns = set ? set->bound_columns : vayu::http::BoundColumnNames{};
    auto row_auth = plan_send_row_auth (json, bound_columns);
    if (!row_auth.ok) {
        out.ok    = false;
        out.error = std::move (row_auth.error);
        return out;
    }
    // The token is acquired once, at the preflight below and before any script,
    // so nothing could answer the name and it would reach the token endpoint
    // as written (#2521).
    if (auto token = vayu::core::first_oauth2_scope_token (row_auth.auth, bound_columns)) {
        out.ok    = false;
        out.error = "Auth credentials carry " + *token +
        " in an OAuth 2.0 configuration, still a template when the run "
        "starts. A load run acquires its token once, before any script runs, "
        "so define the variable and compose the request for a run "
        "('deferDynamicVariables': true), which resolves it, or write the "
        "value into the configuration.";
        return out;
    }
    out.auth.auth        = std::move (row_auth.auth);
    out.auth.credentials = std::move (row_auth.credentials);
    // Held for the scripts only where something runs after the build to
    // answer it (issue #2473); see `LoadAuthPlan::after_scripts`.
    out.auth.after_scripts =
    row_auth.after_scripts && vayu::core::declares_request_elements (json);
    out.set = std::move (set);
    return out;
}

/**
 * Replaces a single-request run's `data` rows with `dataRowCount` in the stored
 * snapshot (#993): rows are user data never snapshotted, as in
 * `scenario_snapshot`. The count, `dataFileName` / `dataFileHash` when a file
 * was named (#2051) and `dataFileCastNumbers` when numbers were cast (#2540)
 * are written from the validated set, not left to what the sanitizer kept. A
 * non-JSON snapshot is left alone.
 *
 * Non-static so `run_row_seed_test.cpp` can pin "the rows are never persisted"
 * without a run.
 */
std::string load_data_snapshot (const std::string& sanitized,
const vayu::core::LoadDataSet& data) {
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse (sanitized);
    } catch (const std::exception&) {
        return sanitized;
    }
    if (!parsed.is_object ()) {
        return sanitized;
    }
    parsed.erase ("data");
    parsed["dataRowCount"] = data.rows.size ();
    vayu::core::stamp_data_file_fields (parsed, data.file);
    return parsed.dump ();
}

/**
 * Records the run's resolved default-header decisions in the stored snapshot
 * (#1488), so a baseline pinned before a config change (an engine upgrade
 * flipping `loadNegotiateCompression`'s default included) stays distinguishable
 * from a later run. `default_headers.hpp`'s "nothing here is stored" means the
 * saved request, where a default written back would replay a frozen
 * `X-Request-ID` (#1229); this is what the run decided, read by a later report
 * and never by a send.
 *
 * `userAgent` is verbatim, as it can change across upgrades; `requestId` and
 * `acceptEncoding` are booleans, since a comparison needs whether each was
 * negotiated; `expectContinue` (#2516) is whether libcurl could add
 * `Expect: 100-continue` above 1 MiB, which changes what a large-body run
 * measures. A non-JSON snapshot is left alone. Non-static for
 * `run_row_seed_test.cpp`.
 */
std::string with_default_headers_snapshot (const std::string& snapshot,
const vayu::http::DefaultHeaderPolicy& header_policy) {
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse (snapshot);
    } catch (const std::exception&) {
        return snapshot;
    }
    if (!parsed.is_object ()) {
        return snapshot;
    }
    parsed["defaultHeaders"] = {
        { "userAgent", header_policy.user_agent },
        { "requestId", !header_policy.correlation_header.empty () },
        { "acceptEncoding", !header_policy.accept_encoding.empty () },
        { "expectContinue", header_policy.expect_continue },
    };
    return parsed.dump ();
}

/**
 * The compression key a run's snapshot reads (#1488): `Load` for anything the
 * event loop drives (a load run, or a scenario with a load mode), `Design` for
 * a sequential collection run, which negotiates like any collection send.
 * Non-static for `run_row_seed_test.cpp`.
 */
vayu::http::DefaultHeaderScope compression_scope_of (vayu::RunType type) {
    return type == vayu::RunType::Load ? vayu::http::DefaultHeaderScope::Load :
                                         vayu::http::DefaultHeaderScope::Design;
}

namespace {

/**
 * The stored `config_snapshot`, with what the run's shape keeps out already out
 * (#993). The two rewrites are exclusive (a scenario run refuses a `data` block
 * beside it), so the payload picks one, not the caller; both are one rule: a
 * payload carrying user data is stored described, not verbatim.
 */
std::string run_config_snapshot (const std::string& body,
bool is_scenario,
const nlohmann::json& scenario_manifest,
const vayu::core::LoadDataSet* data,
const vayu::http::DefaultHeaderPolicy& header_policy,
size_t max_body_bytes,
const std::vector<std::string>& secret_values) {
    std::string sanitized =
    vayu::json::sanitize_config_snapshot (body, max_body_bytes, secret_values);
    std::string shaped = sanitized;
    if (is_scenario) {
        shaped = scenario_snapshot (sanitized, scenario_manifest);
    } else if (data != nullptr && !data->rows.empty ()) {
        // The rows out, their count in, as on a scenario manifest (#993).
        shaped = load_data_snapshot (sanitized, *data);
    }
    return with_default_headers_snapshot (shaped, header_policy);
}

/**
 * The secret-flagged values a `POST /runs` snapshot is masked against (#1803):
 * globals, the run's environment and the linked request's collection chain
 * (@p collection_id, `read_run_scope`'s answer), or for a scenario the chain of
 * every folder a step sits in plus the run collection's (#3270). A recursive
 * scenario composes each step through its own folder's chain (#3248), so a
 * sub-folder's secret reaches the values without being on the run collection's
 * chain. Deduplicated by value.
 */
std::vector<std::string> run_snapshot_secrets (vayu::db::Database& db,
const vayu::db::Run& run,
const std::string& collection_id,
const vayu::core::ScenarioExecution* scenario) {
    if (scenario == nullptr) {
        return secret_variable_values (
        load_script_variable_scopes (db, run.environment_id, collection_id));
    }
    const std::string& run_collection_id = scenario->request.collection_id;
    std::set<std::string> folder_ids{ run_collection_id };
    for (const auto& step : scenario->plan.steps) {
        folder_ids.insert (vayu::core::load_step_collection_id (step, run_collection_id));
    }
    std::set<std::string> unique_values;
    for (const auto& folder_id : folder_ids) {
        const auto values = secret_variable_values (
        load_script_variable_scopes (db, run.environment_id, folder_id));
        unique_values.insert (values.begin (), values.end ());
    }
    return { unique_values.begin (), unique_values.end () };
}

/// The row-set limits a single-request run's `data` is held to: the scenario
/// path's two config rows, so neither payload is refused at a size the other
/// accepts.
vayu::core::ScenarioLimits load_data_limits (vayu::db::Database& db) {
    vayu::core::ScenarioLimits limits;
    limits.max_data_rows =
    static_cast<size_t> (db.get_config_int ("maxScenarioDataRows",
    static_cast<int> (vayu::core::constants::scenario::MAX_DATA_ROWS)));
    limits.max_data_bytes =
    static_cast<size_t> (db.get_config_int ("maxScenarioDataBytes",
    static_cast<int> (vayu::core::constants::scenario::MAX_DATA_BYTES)));
    return limits;
}

/// Every compiled element's outcome (#1514), the array `record_design_result`
/// also stores (one object, two homes, as `build_script_result_node`); empty
/// when the exchange has no elements.
nlohmann::json build_element_outcomes_node (
const std::vector<vayu::core::ElementOutcome>& outcomes) {
    nlohmann::json node = nlohmann::json::array ();
    for (const auto& outcome : outcomes) {
        node.push_back (outcome.to_json ());
    }
    return node;
}

nlohmann::json build_response_json (const vayu::Response& response,
bool include_parsed_body,
const nlohmann::json& scripts,
const std::optional<vayu::core::ValidationVerdict>& validation,
const nlohmann::json& elements = nlohmann::json::array ()) {
    nlohmann::json response_json = vayu::json::serialize (response, include_parsed_body);
    // The schema verdict (#628), like the script keys: one builder, and the
    // stored trace gets the same object, so a restored response cannot show
    // another verdict. Absent for an unbound collection: `std::nullopt` means
    // never judged, not a failure.
    if (validation) {
        response_json["validation"] = vayu::core::build_validation_payload (*validation);
    }
    // Merged at the top level, where every client reads these four keys. The
    // caller hands `record_design_result` the same node for the trace's
    // `scripts`, so a key cannot mean one thing live and another restored.
    response_json.update (scripts);
    if (elements.is_array () && !elements.empty ()) {
        response_json["elements"] = elements;
    }
    return response_json;
}

// Refuses a duration field that is present but not a positive magnitude with an
// optional ms/s/m/h unit; absent or null is fine, as each has a default. Shared
// by `duration` and `stepDuration` so they accept the same spellings.
std::optional<std::string>
check_duration_field (const nlohmann::json& config, const char* key) {
    if (!config.contains (key) || config[key].is_null ()) {
        return std::nullopt;
    }
    const auto& value = config[key];
    if (!value.is_string ()) {
        return std::string ("'") + key + "' must be a string with a unit, e.g. \"60s\" (got " +
        std::string (value.type_name ()) + ")";
    }
    // The unit is optional: the parser is unit-aware (#126) and a bare "60" is
    // what a client that never read the docs sends. This only separates "parses
    // positive" from "wedges the run".
    static const std::regex duration_pattern (
    R"(^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$)", std::regex::icase);
    std::smatch match;
    const std::string text = value.get<std::string> ();
    if (!std::regex_match (text, match, duration_pattern)) {
        return std::string ("'") + key +
        "' must be a number with an optional unit (ms|s|m|h), e.g. \"60s\" "
        "(got \"" +
        text + "\")";
    }
    // The regex proved group 1 a plain decimal, so `stod` cannot fail; the
    // guard stays because an uncaught conversion throw is what this check
    // exists to stop.
    double magnitude = 0.0;
    try {
        magnitude = std::stod (match[1].str ());
    } catch (const std::exception&) {
        magnitude = 0.0; // out of double's range; falls into the check below
    }
    if (!(magnitude > 0.0)) {
        return std::string ("'") + key + "' must be greater than zero (got \"" + text + "\")";
    }
    return std::nullopt;
}

// `rampUpDuration` follows its reader, not the rule above: zero is an instant
// ramp and a JSON number is seconds. Asked of `duration_value_ms` itself so the
// 400 and the run agree on a spelling.
std::optional<std::string> check_ramp_duration_field (const nlohmann::json& config) {
    const auto ramp = config.find ("rampUpDuration");
    if (ramp == config.end () || ramp->is_null () ||
    vayu::core::duration_value_ms (*ramp).has_value ()) {
        return std::nullopt;
    }
    return "'rampUpDuration' must be a non-negative number with an optional "
           "unit (ms|s|m|h), e.g. \"10s\", or \"0\" for an instant ramp (got " +
    ramp->dump () + ")";
}

// `constant_rps` needs a positive rate (#1893). Read through `requested_rps`,
// the executor's own reading of the two fields, after the table has proved
// both are numbers.
std::optional<std::string> check_constant_rps_rate (const nlohmann::json& config) {
    const auto mode = config.find ("mode");
    if (mode == config.end () || *mode != "constant_rps" ||
    vayu::core::requested_rps (config) > 0.0) {
        return std::nullopt;
    }
    return "'constant_rps' needs a positive 'rps' or 'targetRps': it is an "
           "open-loop arrival rate, and without one the run would measure "
           "closed-loop concurrency instead. Set a rate, or use "
           "'constant_concurrency' with 'concurrency'.";
}

// The converse (#2396): a rate on another mode would switch it to open loop. An
// absent mode is `constant_rps` (as `LoadStrategy::create` reads it) and may
// carry a rate; an unrecognised one may not.
std::optional<std::string> check_rate_only_on_constant_rps (const nlohmann::json& config) {
    if (!(vayu::core::requested_rps (config) > 0.0) ||
    vayu::core::is_constant_rps_mode (config)) {
        return std::nullopt;
    }
    const auto rps = config.find ("rps");
    const bool rps_carries = rps != config.end () && rps->is_number () && *rps != 0;
    const auto& mode = config.at ("mode");
    const std::string mode_name =
    mode.is_string () ? mode.get<std::string> () : mode.dump ();
    return std::string ("'") + (rps_carries ? "rps" : "targetRps") +
    "' selects an open-loop arrival rate and is only available for mode "
    "'constant_rps'; for '" +
    mode_name + "' set 'concurrency' instead, or send a rate of 0.";
}

// `carriedBudgets` (#2195) is a label list stored and echoed, never
// interpreted: the bounds only keep an unbounded payload out of the snapshot
// and every report (the app sends one metric key per carried budget, far fewer
// than 64). A length is UTF-8 bytes, not characters, and must admit every key
// the app builds: `custom.<name>.<stat>` with a 100-unit name at 3 bytes a unit
// is about 320 bytes, and a refusal fails a run start over a field that never
// changes the run.
constexpr std::size_t MAX_CARRIED_BUDGETS      = 64;
constexpr std::size_t MAX_CARRIED_BUDGET_BYTES = 512;

std::optional<std::string> check_carried_budgets (const nlohmann::json& config) {
    const auto list = config.find ("carriedBudgets");
    if (list == config.end () || list->is_null ()) {
        return std::nullopt;
    }
    if (!list->is_array ()) {
        return "'carriedBudgets' must be an array of strings (got " +
        std::string (list->type_name ()) + ")";
    }
    if (list->size () > MAX_CARRIED_BUDGETS) {
        return "'carriedBudgets' must hold at most " +
        std::to_string (MAX_CARRIED_BUDGETS) + " entries (got " +
        std::to_string (list->size ()) + ")";
    }
    for (std::size_t i = 0; i < list->size (); ++i) {
        const auto& entry = list->at (i);
        if (!entry.is_string ()) {
            return "'carriedBudgets' entries must be strings (got " +
            std::string (entry.type_name ()) + " at index " + std::to_string (i) + ")";
        }
        const auto bytes = entry.get_ref<const std::string&> ().size ();
        if (bytes > MAX_CARRIED_BUDGET_BYTES) {
            return "'carriedBudgets' entries must be at most " +
            std::to_string (MAX_CARRIED_BUDGET_BYTES) + " bytes of UTF-8 (got " +
            std::to_string (bytes) + " bytes at index " + std::to_string (i) + ")";
        }
    }
    return std::nullopt;
}

} // namespace

namespace {

/// The word `script_failure_text` puts before an inherited level's phase, or
/// empty for the request's own script.
std::string_view inherited_level_word (const std::string& scope) {
    if (scope == "collection") {
        return "Collection";
    }
    if (scope == "folder") {
        return "Folder";
    }
    return {};
}

/// `preScriptError` / `postScriptError`: the request's own script's message
/// is stored as it always was, an inherited level's names that level.
std::string script_error_field (const vayu::ScriptResult& result, std::string_view phase) {
    if (inherited_level_word (result.error_scope).empty ()) {
        return result.error_message;
    }
    return script_failure_text (result, phase);
}

} // namespace

std::string script_failure_text (const vayu::ScriptResult& result, std::string_view phase) {
    std::string text;
    if (const auto level = inherited_level_word (result.error_scope); !level.empty ()) {
        text.append (level).append (" ").append (phase);
    } else if (!phase.empty ()) {
        text.push_back (vayu::utils::ascii_upper (phase.front ()));
        text.append (phase.substr (1));
    }
    return text + " script failed - " + result.error_message;
}

namespace {

/// Both phases' `pm.sendRequest` records (#3633), pre before test, each
/// stamped with its phase as a console line is, their bodies sharing one
/// budget: here, because this node is both the live answer and the stored
/// trace's.
nlohmann::json script_requests_node (const vayu::ScriptResult& pre_script_result,
const vayu::ScriptResult& post_script_result,
size_t max_trace_body_bytes) {
    nlohmann::json records = nlohmann::json::array ();
    const auto append      = [&records] (const char* source,
                             const std::vector<nlohmann::json>& phase) {
        for (const auto& record : phase) {
            records.push_back (record);
            records.back ()["source"] = source;
        }
    };
    append ("pre", pre_script_result.script_requests);
    append ("test", post_script_result.script_requests);
    vayu::json::cap_trace_bodies_together (
    records.get_ref<nlohmann::json::array_t&> (), max_trace_body_bytes);
    return records;
}

} // namespace

/// The script-result keys; routes.hpp says why one builder serves the live body
/// and the stored trace.
nlohmann::json build_script_result_node (const vayu::ScriptResult& pre_script_result,
const vayu::ScriptResult& post_script_result,
size_t max_trace_body_bytes) {
    nlohmann::json node = nlohmann::json::object ();

    /*
     * Both scripts' assertions, pre before test (execution order), each with
     * its `source`, spelled as `consoleLogs`' below. A pre-request script may
     * assert on a `pm.sendRequest` answer and `describe_failed_tests` fails a
     * scenario step on one, so both phases are listed (#810).
     */
    nlohmann::json test_results = nlohmann::json::array ();
    const auto append_tests     = [&test_results] (const char* source,
                                  const std::vector<vayu::TestResult>& tests) {
        for (const auto& test : tests) {
            nlohmann::json test_json;
            test_json["name"]   = test.name;
            test_json["passed"] = test.passed;
            test_json["source"] = source;
            if (!test.scope.empty ()) {
                test_json["scope"] = test.scope;
            }
            if (!test.error_message.empty ()) {
                test_json["error"] = test.error_message;
            }
            test_results.push_back (test_json);
        }
    };
    append_tests ("pre", pre_script_result.tests);
    append_tests ("test", post_script_result.tests);
    if (!test_results.empty ()) {
        node["testResults"] = test_results;
    }

    /*
     * Both scripts' console output. `source` is a field, not a `"[pre] "`
     * prefix, which a script logging those six characters would be
     * indistinguishable from. A `pm.sendRequest` summary line's `scriptRequest`
     * indexes `scriptRequests` below, so a test-phase line's index moves past
     * the pre-phase records.
     */
    nlohmann::json all_console_output = nlohmann::json::array ();
    const auto append = [&all_console_output] (const char* source,
                        const std::vector<vayu::ConsoleEntry>& entries,
                        size_t records_before) {
        for (const auto& entry : entries) {
            nlohmann::json line = { { "source", source },
                { "level", vayu::to_string (entry.level) }, { "message", entry.message } };
            if (!entry.scope.empty ()) {
                line["scope"] = entry.scope;
            }
            if (const auto& index = entry.script_request) {
                line["scriptRequest"] = *index + records_before;
            }
            all_console_output.push_back (std::move (line));
        }
    };
    append ("pre", pre_script_result.console_output, 0);
    append ("test", post_script_result.console_output,
    pre_script_result.script_requests.size ());
    if (!all_console_output.empty ()) {
        node["consoleLogs"] = all_console_output;
    }
    if (auto records = script_requests_node (
        pre_script_result, post_script_result, max_trace_body_bytes);
    !records.empty ()) {
        node["scriptRequests"] = std::move (records);
    }

    if (!pre_script_result.success && !pre_script_result.error_message.empty ()) {
        node["preScriptError"] = script_error_field (pre_script_result, "pre-request");
    }
    if (!post_script_result.success && !post_script_result.error_message.empty ()) {
        node["postScriptError"] = script_error_field (post_script_result, "test");
    }

    return node;
}

/**
 * One log record for how a design Send ended (#3677): a warning when it failed,
 * a debug line otherwise. The request is the one that was sent, so its URL is
 * final and resolved; a Send that failed before anything went out reports the
 * request as composed and status 0.
 */
void log_design_outcome (const std::optional<std::string>& run_id,
const vayu::Request& request,
const vayu::Response& response) {
    const auto record = vayu::http::describe_send_outcome ({ .subject = "Send",
    .method        = vayu::to_string (request.method),
    .url           = request.url,
    .status_code   = response.status_code,
    .elapsed_ms    = response.timing.total_ms,
    .error_code    = response.error_code,
    .error_message = response.error_message,
    .run_id = run_id ? std::optional<std::string_view>{ *run_id } : std::nullopt });
    if (record.failed) {
        vayu::utils::log_warning ("http", record.msg, record.fields);
        return;
    }
    vayu::utils::log_debug ("http", record.msg, record.fields);
}

/**
 * Records a finished design execution against its run row (declared in
 * routes.hpp). Every `POST /execute` path (auth failure, completed exchange,
 * the streaming worker's completion) goes through here, so "transient leaves no
 * trace" is decided once. The Send's `log_design_outcome` record is written
 * here too, before that rule: a transient Send is logged, without a `runId`.
 *
 * Non-static for `transient_execute_test.cpp`, against a real database.
 */
std::optional<int> record_design_result (vayu::db::Database& db,
const std::optional<std::string>& run_id,
const vayu::Request& request,
const vayu::Response& response,
const StreamRecord* stream,
const std::optional<vayu::core::ValidationVerdict>& validation,
const nlohmann::json& scripts,
const nlohmann::json& elements,
std::optional<double> engine_ms,
std::optional<double> script_ms) {
    log_design_outcome (run_id, request, response);
    if (!run_id) {
        return std::nullopt;
    }
    // Set once the row is in: a failure after the insert still leaves a row
    // the id reads back.
    std::optional<int> result_id;
    try {
        const bool has_error = response.has_error ();

        vayu::db::Result db_result;
        db_result.run_id      = *run_id;
        db_result.timestamp   = now_ms ();
        db_result.status_code = response.status_code;
        db_result.status_text = response.status_text;
        db_result.latency_ms  = response.timing.total_ms;
        db_result.error       = has_error ? response.error_message : "";

        // Bodies are capped at the configured limit so one large exchange
        // cannot bloat the DB; `cap_trace_bodies` records `bodyTruncated` /
        // `bodyBytes` on a cut.
        nlohmann::json trace = build_result_trace (request, response);
        if (engine_ms) {
            trace["engineMs"] = *engine_ms;
        }
        if (script_ms) {
            trace["scriptMs"] = *script_ms;
        }
        const auto max_trace_body_bytes =
        static_cast<size_t> (db.get_config_int ("maxTraceBodyBytes",
        static_cast<int> (vayu::core::constants::json::MAX_TRACE_BODY_BYTES)));
        vayu::json::cap_trace_bodies (trace, max_trace_body_bytes);

        // Stored verbatim, not recomputed at restore: `responseFromRunResult`
        // and `responseFromExecuteResult` are a named copy pair, and a second
        // computation is how they would drift.
        if (validation) {
            trace["validation"] = vayu::core::build_validation_payload (*validation);
        }

        // Every design send that ran scripts, streaming or not (#725), so a
        // restored Tests tab tells "passed" from "never ran"; none without
        // scripts, where an empty node would store a Tests pane of nothing on
        // every send.
        if (scripts.is_object () && !scripts.empty ()) {
            trace["scripts"] = scripts;
        }
        if (elements.is_array () && !elements.empty ()) {
            trace["elements"] = elements;
        }

        // The sidecar alone: the list is the capped body above, parsed back
        // when the trace is read (`expand_stored_stream_events`, #3770).
        if (stream) {
            trace["events"] = stream->events;
        }

        // A wire header value or request body can hold non-UTF-8 bytes:
        // `replace` makes them U+FFFD instead of throwing (import.cpp's guard
        // too).
        db_result.trace_data =
        trace.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
        result_id = db.add_result (db_result);

        // A stream names its terminal status: one the user stopped is
        // `Stopped`, which neither the response nor the error flag can say.
        // Only from Running: a buffered send has no context for
        // `POST /runs/:id/stop` to signal, so a Stop there writes the row
        // itself (as `stop_if_caller_left` does for a caller that hung up) and
        // stands over the exchange recorded above.
        vayu::RunStatus status = vayu::RunStatus::Completed;
        if (stream) {
            status = stream->status;
        } else if (has_error) {
            status = vayu::RunStatus::Failed;
        }
        db.transition_run_status (*run_id, { vayu::RunStatus::Running }, status);

        // Prune on each terminal design run so per-request sends do not
        // accumulate (retention settings; 0 disables). Best-effort: a prune
        // failure never fails the request.
        try {
            db.prune_runs_configured ();
        } catch (const std::exception& e) {
            vayu::utils::log_warning (
            "http", "Run pruning failed: " + std::string (e.what ()));
        }

    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "Failed to save result: " + std::string (e.what ()));
        try {
            db.transition_run_status (
            *run_id, { vayu::RunStatus::Running }, vayu::RunStatus::Failed);
        } catch (...) {
            vayu::utils::log_error ("http", "Failed to update run status after save error");
        }
    }
    return result_id;
}

/**
 * Validates a POST /runs config before the run row is created. Each field is
 * read with `config.value (...)` and cast to `size_t` or fed to a modulo on a
 * detached worker with no `catch` above, where out of range is a dead daemon:
 * `success_sample_rate: 0` is `% 0` (SIGFPE), `concurrency: -1` pre-allocates
 * ~1.8e19 curl handles, `timeout: 0` never expires a transfer, and a
 * JSON-number `duration` throws from `RunContext`'s constructor after the row
 * exists, stranding it `pending`. So it runs in the route, before `create_run`:
 * a rejected request leaves no trace. Non-static for
 * `run_config_validation_test.cpp`.
 *
 * @return why the config is invalid, or `std::nullopt` if it is usable.
 */
std::optional<std::string> validate_run_config (const nlohmann::json& config,
const vayu::core::MonitorLimits& monitor_limits) {
    if (!config.is_object ()) {
        return "Run config must be a JSON object";
    }

    // `transient` is `POST /execute`'s alone (#382): a load or scenario run is
    // its run row (the id is the answer, and live metrics, the report and the
    // step store key off it), so the flag means nothing here. Refused, not
    // ignored: the caller believes the run leaves no trace, and it leaves a
    // large one.
    if (config.contains ("transient") && !config["transient"].is_null ()) {
        return "'transient' is not valid on a run - it applies to POST "
               "/execute "
               "only, because a run is identified by the row it creates";
    }

    // `stream` and its caps go through `POST /execute`'s parser (#576), so the
    // two endpoints agree on spelling, types and ranges. A load stream always
    // ends, by a cap resolved below: load completion accounting has no place
    // for an endless response (#573). The parser's `transient` rule is
    // unreachable (refused above). A collection run reads the caps alone, for
    // steps whose stored request streams (#3235).
    const bool is_collection_run =
    config.contains ("scenario") && !config["scenario"].is_null ();
    if (const auto stream = is_collection_run ? read_collection_run_stream_caps (config) :
                                                read_stream_flag (config);
    !stream.ok) {
        return stream.error;
    }

    // The duration fields are the only non-numeric ones and the only ones whose
    // bad value throws rather than miscomputes: `duration_field_ms` refuses an
    // unknown unit at run time, after the row exists.
    for (const char* key : { "duration", "stepDuration" }) {
        if (auto reason = check_duration_field (config, key)) {
            return reason;
        }
    }
    if (auto reason = check_ramp_duration_field (config)) {
        return reason;
    }

    namespace limits  = vayu::core::constants::run_config;
    const auto fields = std::to_array<NumericRunField> ({
    { "success_sample_rate", 1, 100000, "It is a sampling period (keep 1 in N), and 0 is a division by zero." },
    { "response_sample_rate", 1, 100000, "It is a sampling period (keep 1 in N), and 0 is a division by zero." },
    { "max_response_samples", 0, limits::MAX_RESPONSE_SAMPLES,
    "Each retained sample holds a full response body." },
    { "max_response_sample_bytes", 0, limits::MAX_RESPONSE_SAMPLE_BYTES,
    "It is the whole-run budget for those bodies, held in memory for the "
    "run and its retention window; 0 retains no sample that has a body." },
    { "max_success_results", 0, limits::MAX_RETAINED_RESULTS,
    "Each retained record holds a serialised timing breakdown, and the "
    "store is reserved up front." },
    { "max_slow_results", 0, limits::MAX_RETAINED_RESULTS,
    "Each retained record holds a serialised timing breakdown, and the "
    "store is reserved up front." },
    { "slow_threshold_ms", 0, limits::MAX_SLOW_THRESHOLD_MS,
    "0 disables outlier capture; a negative threshold would mark every "
    "completion an outlier." },
    { "max_sample_body_bytes", 0, limits::MAX_SAMPLE_BODY_BYTES,
    "A captured body is copied on the completion callback, so the cap "
    "bounds hot-path work; 0 keeps headers and metadata and no body." },
    { "max_sample_bytes", 0, limits::MAX_SAMPLE_BYTES,
    "It is the whole-run capture budget, and every byte under it is held "
    "in memory until the run flushes." },
    { "max_exemplar_results", 0, limits::MAX_EXEMPLAR_RESULTS,
    "Each retained exemplar holds a captured exchange." },
    { "concurrency", 1, limits::MAX_CONCURRENCY,
    "Connections are pre-allocated per worker before any traffic flows." },
    { "startConcurrency", 1, limits::MAX_CONCURRENCY,
    "A ramp is seeded with this many in-flight requests before the first "
    "duration check, and it is read as a size_t, so a negative start is "
    "~1.8e19 of them." },
    { "maxInFlight", 1, limits::MAX_IN_FLIGHT,
    "It is a pending-request ceiling read as a size_t, so a negative value "
    "is ~1.8e19 - it removes the backpressure the field exists to provide "
    "rather than tightening it." },
    { "sloMs", 1, limits::MAX_SLO_MS,
    "It is the latency budget a capacity search looks for the edge of; a "
    "non-positive budget has no edge, and one past a minute is longer than "
    "the transfers any realistic run measures." },
    REQUEST_TIMEOUT_FIELD,
    { "iterations", 1, limits::MAX_ITERATIONS,
    "An iterations run stops on its request count alone, read as a size_t, "
    "so a negative count is ~1.8e19 requests and a run that never ends." },
    { "rps", 0, limits::MAX_TARGET_RPS, "It is an open-loop arrival rate per second; 0 asks for none." },
    { "targetRps", 0, limits::MAX_TARGET_RPS, "It is an open-loop arrival rate per second; 0 asks for none." },
    { "retryAfterMaxMs", 1, limits::MAX_RETRY_AFTER_MAX_MS,
    "It is the longest one virtual user waits on a Retry-After under "
    "retryAfterBackoff; past an hour it is waiting out a quota, not pacing "
    "against a limiter." },
    });
    for (const auto& field : fields) {
        if (auto reason = check_numeric_field (config, field)) {
            return reason;
        }
    }
    if (auto reason = check_constant_rps_rate (config)) {
        return reason;
    }
    if (auto reason = check_rate_only_on_constant_rps (config)) {
        return reason;
    }

    // Each is read as a boolean only after the row exists (`RunContext`'s
    // constructor through `config.value (..., bool)`, which throws
    // `type_error.302` on a string, or the scenario runner): the
    // stranded-`pending` failure this function prevents. Absent and `null` mean
    // the default, as on the resource routes.
    for (const char* key : { "phase_histograms", "save_timing_breakdown", "capture_response_bodies",
         "stream_metrics", "failOnSchemaError", "stopOnError", "retryAfterBackoff" }) {
        const auto it = config.find (key);
        if (it != config.end () && !it->is_null () && !it->is_boolean ()) {
            return "'" + std::string (key) + "' must be a boolean (got " +
            it->type_name () + ")";
        }
    }

    // `thresholds`, nested, gets its own pass. Its rule lives with the
    // evaluator (`core/threshold_eval.cpp`), which reads the same metric table,
    // so a budget accepted here is one the run judges.
    if (auto reason = vayu::core::validate_thresholds (config)) {
        return reason;
    }
    if (auto reason = check_carried_budgets (config)) {
        return reason;
    }

    // `monitor`'s rule lives with the scrape loop (`core/monitor.cpp`) for the
    // same reason. Its two movable limits arrive resolved from the caller,
    // keeping this function and that core free of a `Database`.
    if (auto reason = vayu::core::validate_monitor_config (config, monitor_limits)) {
        return reason;
    }

    return std::nullopt;
}

/**
 * Starts a run whose row `create_run` wrote, answering nothing but a 202 while
 * that row is `pending` (#1893), since nothing would move it again. A refusal
 * (the daemon draining its workers) is a 503 and a throw from the start (the
 * run context's constructor reads the config) a 500 naming it; both fail the
 * row first, guarded as `refuse_stream_before_it_opens` guards it.
 *
 * Non-static: `run_config_validation_test.cpp` drives it with a throwing start,
 * because no payload `validate_run_config` accepts reaches a throw there. The
 * catch is the net under the validator, not a client path.
 */
std::optional<RouteError> start_created_run (vayu::db::Database& db,
const std::string& run_id,
const std::function<bool ()>& start) {
    RouteError refusal;
    try {
        if (start ()) {
            return std::nullopt;
        }
        refusal = { 503, error_body (503, "Engine is shutting down") };
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run", "Run failed to start",
        { { "runId", run_id }, { "error", e.what () } });
        refusal = { 500,
            error_body (500, "Run failed to start: " + std::string (e.what ())) };
    }
    // Only from Pending: a worker that did start owns the row.
    try {
        db.transition_run_status (
        run_id, { vayu::RunStatus::Pending }, vayu::RunStatus::Failed);
    } catch (const std::exception& e) {
        vayu::utils::log_error ("run", "Failed to fail a run that never started",
        { { "runId", run_id }, { "error", e.what () } });
    }
    return refusal;
}

/**
 * Runs @p send, everything a design send does once its row exists, so a throw
 * fails that row and answers a JSON error (#2458) rather than httplib's
 * bodiless 500 over a row left `running`. The row is failed even when the
 * result was recorded: the caller got no response, and `completed` would
 * contradict that. Completed to Failed is the one move out of a terminal status
 * (#3340); a `stopped` or `failed` row already says the send did not succeed.
 *
 * Non-static: `execute_binary_body_test.cpp` drives it with a throwing send,
 * because no payload reaches a throw past #2458's fixes; the catch is the net
 * under them, as in `start_created_run`.
 */
void guard_recorded_send (vayu::db::Database& db,
httplib::Response& res,
const std::optional<std::string>& run_id,
const std::function<void ()>& send) {
    std::string reason;
    try {
        send ();
        return;
    } catch (const std::exception& e) {
        reason = e.what ();
    }
    vayu::utils::log_error ("http", "POST /execute failed after its run was recorded",
    { { "runId", run_id.value_or ("none (transient)") }, { "error", reason } });
    if (run_id) {
        try {
            db.transition_run_status (*run_id,
            { vayu::RunStatus::Running, vayu::RunStatus::Completed },
            vayu::RunStatus::Failed);
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http", "Failed to fail a send that threw",
            { { "runId", *run_id }, { "error", e.what () } });
        }
    }
    send_error (res, 500, "Execution failed: " + reason);
}

namespace {
/** What `POST /execute` accepted off the wire, before any run row exists. */
struct ExecutePayload {
    nlohmann::json json;
    /// No row is recorded for this execution (issue #382).
    bool transient = false;
    /// What the scripts and extractors set is written back to disk (#1904).
    bool persist_variables = true;
    /// The answer carries `body`, the parsed copy of `bodyRaw` (#2544).
    bool include_parsed_body = true;
    StreamFlag stream;
    RunOrigin origin;
    /// The hosts the caller allows this send to reach (#2521); none stated
    /// when absent.
    std::optional<vayu::http::TargetPolicy> target_policy;
    /// The row this send binds, if the caller named one (issue #601).
    std::optional<nlohmann::json> data_row;
    /// Auth the exchange applies after the pre-request script (issue #2473).
    std::optional<vayu::http::Auth> late_auth;
    vayu::http::RequestBuild built;
};

/**
 * One design-mode execution, after the payload is accepted: the run row it
 * carries, the request it will send, and what the scripts around that send run
 * under. Both paths below take it.
 */
struct DesignSend {
    vayu::db::Run run;
    /// The collection whose chain the scripts read and whose secrets mask the
    /// snapshot (`read_run_scope`); empty for none.
    std::string collection_id;
    /// Absent for a transient execution - no row exists to record against, and
    /// every recording step keys off that.
    std::optional<std::string> run_id;
    vayu::Request request;
    /// The payload's `elements`, resolved and compiled once (#1514);
    /// `script.pre` / `script.post` are the only script source, and an empty
    /// vector runs nothing.
    std::shared_ptr<const std::vector<vayu::core::CompiledElement>> elements;
    std::optional<std::string> script_request_name;
    std::string cookie_scope;
    vayu::runtime::ScriptConfig script_config;
    std::optional<nlohmann::json> data_row;
    StreamFlag stream;
    /// Copied from the payload; both paths hand it to `persist_send_variables`.
    bool persist_variables = true;
    /// Copied from the payload; only the buffered answer has a `body` to omit.
    bool include_parsed_body = true;
    /// What the build waited on an OAuth 2.0 provider for; `engine_cost_ms`
    /// leaves it out of Vayu's own cost.
    double auth_fetch_ms = 0.0;
    /// Auth neither the build nor the bind applied, for after the pre-request
    /// script (`apply_late_auth`, issue #2473).
    std::optional<vayu::http::Auth> late_auth;
    /// Copied from the payload; both paths judge the final URL by it.
    std::optional<vayu::http::TargetPolicy> target_policy;
    /// The caller's connection, watched for a buffered send alone (#3383): a
    /// stream outlives its caller by design. Owned by the handler.
    vayu::http::DisconnectWatch* caller_watch = nullptr;

    [[nodiscard]] const vayu::http::TargetPolicy* target_policy_or_null () const {
        return target_policy ? &*target_policy : nullptr;
    }
};

/// The variable scopes @p send runs under, read from the rows it names.
ScriptVariableScopes load_send_scopes (vayu::db::Database& db, const DesignSend& send) {
    return load_script_variable_scopes (db, send.run.environment_id, send.collection_id);
}


/// What a pre-row refusal of `POST /execute` answers with: the message and,
/// when it has one, the code (`invalid_header_name`). A bare message converts.
struct ExecuteRefusal {
    std::string message;
    std::string code;

    ExecuteRefusal (std::string text, std::string refusal_code = {})
    : message (std::move (text)), code (std::move (refusal_code)) {
    }
};

/// The `data` row's cell bound (#2362) as `parse_request_json`'s field bound, so
/// a deep cell is refused in `read_data_row`'s words rather than the body's.
RouteResult refuse_overdeep_send_row (const nlohmann::json& json) {
    const auto data = json.find ("data");
    if (data == json.end () || !data->is_object ()) {
        return {};
    }
    if (auto refusal = vayu::core::refuse_overdeep_cell (*data, "data", std::nullopt)) {
        return route_error (400, *refusal);
    }
    return {};
}

/// Whether a composed entry came from a collection or folder level
/// (`origin.kind`, the two-valued answer `compose_elements` and the renderer's
/// `elementsParts` both stamp).
bool is_collection_origin (const nlohmann::json& entry) {
    if (!entry.is_object ()) {
        return false;
    }
    const auto origin = entry.find ("origin");
    if (origin == entry.end () || !origin->is_object ()) {
        return false;
    }
    const auto kind = origin->find ("kind");
    return kind != origin->end () && kind->is_string () && *kind == "collection";
}

/**
 * `POST /execute`'s inline `elements` against the registry, as `POST /requests`
 * and `POST /runs` check them (#3052). The list is composed: an entry a
 * collection level contributes is judged as a collection's (`script.setup` is
 * allowed there, and a duplicated collection repeats ids across levels, so each
 * is checked alone); the rest are judged together as a request's, so a
 * refusal's `Item N` counts within those. Ids the caller left off are stamped
 * into @p json, so the send compiles the list that was validated.
 *
 * @return the refusal, or nothing for an absent or null `elements`.
 */
std::optional<std::string> validate_execute_elements (nlohmann::json& json) {
    const auto found = json.find ("elements");
    if (found == json.end () || found->is_null ()) {
        return std::nullopt;
    }
    const auto& registry = vayu::core::Registry::instance ();
    if (!found->is_array ()) {
        return registry.validate (*found, vayu::core::ElementOwner::Request);
    }

    vayu::core::stamp_default_element_ids (*found);
    nlohmann::json request_owned = nlohmann::json::array ();
    for (const auto& entry : *found) {
        if (!is_collection_origin (entry)) {
            request_owned.push_back (entry);
            continue;
        }
        if (auto reason = registry.validate (nlohmann::json::array ({ entry }),
            vayu::core::ElementOwner::Collection)) {
            return reason;
        }
    }
    return registry.validate (request_owned, vayu::core::ElementOwner::Request);
}

/**
 * Everything `POST /execute` reads and can refuse before any run row exists:
 * each refusal is a 400 with nothing recorded, the rule this section is ordered
 * by. A buffered send's @p caller_watch starts before the build, so an OAuth
 * 2.0 token the build acquires stops for a departed caller too (#3383).
 *
 * @return the message (and code, when it has one) to answer with, already
 *         logged, or nothing.
 */
std::optional<ExecuteRefusal> read_execute_payload (RouteContext& ctx,
const httplib::Request& req,
ExecutePayload& out,
std::optional<vayu::http::DisconnectWatch>& caller_watch) {
    // Depth-checked before anything copies the payload, `build_design_send`'s
    // snapshot of the same text included.
    auto parsed = parse_request_json (req.body, {}, refuse_overdeep_send_row);
    if (!parsed) {
        const auto& error   = parsed.error ().body.at ("error");
        std::string message = error.value ("message", std::string ());
        vayu::utils::log_warning ("http", "POST /execute - " + message);
        return ExecuteRefusal{ std::move (message), error.value ("code", std::string ()) };
    }
    nlohmann::json json = std::move (*parsed);

    // Pre-row: a malformed flag is a 400, not a run the caller believed would
    // leave no trace.
    const auto transient = read_transient_flag (json);
    if (!transient.ok) {
        vayu::utils::log_warning ("http", "POST /execute - " + transient.error);
        return transient.error;
    }
    const auto persist_variables = read_persist_variables_flag (json);
    if (!persist_variables.ok) {
        vayu::utils::log_warning ("http", "POST /execute - " + persist_variables.error);
        return persist_variables.error;
    }
    const auto include_parsed_body = read_include_parsed_body_flag (json);
    if (!include_parsed_body.ok) {
        vayu::utils::log_warning (
        "http", "POST /execute - " + include_parsed_body.error);
        return include_parsed_body.error;
    }

    // Pre-row too: `stream` changes the execution model, so a malformed one is
    // a 400, not a send the caller did not ask for.
    auto stream = read_stream_flag (json);
    if (!stream.ok) {
        vayu::utils::log_warning ("http", "POST /execute - " + stream.error);
        return stream.error;
    }

    // Recorded on the row, so refused before one exists (#1817).
    auto origin = read_run_origin (json);
    if (!origin) {
        vayu::utils::log_warning ("http", "POST /execute - " + origin.error ());
        return origin.error ();
    }

    // A malformed policy is a 400 rather than a send nothing holds to it.
    auto target_policy = vayu::http::read_target_policy (json);
    if (!target_policy) {
        vayu::utils::log_warning ("http", "POST /execute - " + target_policy.error ());
        return ExecuteRefusal{ target_policy.error (),
            std::string (vayu::http::INVALID_TARGET_POLICY_CODE) };
    }

    // Scripts are elements (#1514, no alias): `preRequestScript` /
    // `postRequestScript` / `tests` are refused before anything is built or
    // written, as the two write routes refuse them.
    if (auto refusal = refuse_legacy_script_fields (json)) {
        vayu::utils::log_warning ("http", "POST /execute - " + *refusal);
        return refusal;
    }

    if (auto refusal = validate_execute_elements (json)) {
        vayu::utils::log_warning ("http", "POST /execute - " + *refusal);
        return refusal;
    }

    // The bound row (#601), read pre-row like the bind below: a request whose
    // tokens cannot bind leaves no trace.
    auto data_row = read_data_row (json,
    static_cast<size_t> (ctx.db.get_config_int ("maxScenarioDataBytes",
    static_cast<int> (vayu::core::constants::scenario::MAX_DATA_BYTES))));
    if (!data_row.ok) {
        vayu::utils::log_warning ("http", "POST /execute - " + data_row.error);
        return data_row.error;
    }

    // Decided before the build, which would otherwise encode the credentials
    // out of reach (#642); its refusal (an oauth2 config with a data token) is
    // a 400 beside the row's own, as nothing is recorded or sent yet. The row's
    // columns are read as `bind_data_row` reads them, so `{{username}}` binds
    // from the row as `{{data.username}}` does (#1007).
    const auto row_columns = data_row.value ?
    vayu::core::bound_columns_of (*data_row.value) :
    vayu::http::BoundColumnNames{};
    auto row_auth          = plan_send_row_auth (json, row_columns);
    if (!row_auth.ok) {
        vayu::utils::log_warning ("http", "POST /execute - " + row_auth.error);
        return row_auth.error;
    }

    // Refused here, not clamped: `0` is libcurl's "no timeout" and a negative
    // value is a rejected option, so either would send with no deadline.
    if (auto reason = check_numeric_field (json, REQUEST_TIMEOUT_FIELD)) {
        vayu::utils::log_warning ("http", "POST /execute - " + *reason);
        return reason;
    }

    // Deserialize, timeout and auth, once. A malformed payload fails before any
    // run record; an auth failure surfaces after the run exists (below).
    // Credentials carrying `{{data.*}}` are left to the bind below, once the
    // row has reached them.
    const int request_timeout_ms = resolve_request_timeout_ms (json, ctx.db);
    if (!stream.value) {
        caller_watch.emplace (req.is_connection_closed, ctx.server_stopping);
    }
    const std::atomic<bool>& cancel =
    caller_watch ? caller_watch->cancel () : ctx.server_stopping;
    // An OAuth 2.0 token acquired here has its endpoints judged by the policy
    // before anything is posted (#2521).
    auto built = vayu::http::build_request (json, &ctx.db, request_timeout_ms,
    row_auth.resolution, *target_policy ? &**target_policy : nullptr, &cancel);
    if (built.parse_failed) {
        vayu::utils::log_warning ("http",
        "POST /execute - Invalid request format: " + built.error_message);
        return ExecuteRefusal{ built.error_message, built.detail_code };
    }

    // Binds the row into what composition left written, before anything is
    // recorded or sent. A failure is a 400 with the binder's message (it names
    // the token, the row and its columns, so the request can be fixed without
    // opening the file), the partly bound request is discarded
    // (scenario_data.hpp), and no run row exists, as for the flag checks. The
    // identity binds for every send (#994): a single send is a run of one, so
    // `{{$vu}}` and `{{$iteration}}` answer `1` and `0`, as on a load run's
    // first iteration, rather than reaching the wire as written. A request
    // spelling neither costs one walk of its fields.
    const vayu::core::IterationBinding binding{ data_row.value ? &*data_row.value : nullptr,
        /*row_index=*/0, vayu::core::IterationIdentity{} };
    // Both halves go through the binder both load paths drive: the order is
    // what makes a deferred credential correct, and a copy here would stop
    // receiving its fixes. The credentials half is a no-op for the ordinary
    // send, whose auth the build applied. `row_columns`, not the overload's
    // empty default, so a bare `{{username}}` binds from the row as on both
    // load paths (#1007). Credentials that also wait on the pre-request script
    // (#2473) take the row here and are applied after the script, by the
    // exchange.
    const auto fields = vayu::core::tokenize_bindable_fields (built.request, row_columns);
    auto bound = row_auth.after_scripts ?
    vayu::core::bind_iteration_holding_auth (
    built.request, fields, row_auth.auth, row_auth.credentials, binding) :
    vayu::core::bind_iteration (
    built.request, fields, row_auth.auth, row_auth.credentials, binding);
    if (!bound.ok) {
        vayu::utils::log_warning ("http", "POST /execute - " + bound.error);
        return bound.error;
    }
    if (row_auth.after_scripts) {
        out.late_auth = std::move (row_auth.auth);
    }
    out.json                = std::move (json);
    out.transient           = transient.value;
    out.persist_variables   = persist_variables.value;
    out.include_parsed_body = include_parsed_body.value;
    out.stream              = std::move (stream);
    out.origin              = std::move (*origin);
    out.target_policy       = std::move (*target_policy);
    out.data_row            = std::move (data_row.value);
    out.built               = std::move (built);
    return std::nullopt;
}

/**
 * The run row this execution carries, and its persisted half. Built even for a
 * transient execution, because it carries scope: `load_send_scopes` reads its
 * `environment_id` beside `collection_id` (and `persist_script_variables`
 * writes back to the rows that load named), and the cookie scope comes from the
 * same field. Only the persisted half (id, config snapshot, create) is
 * conditional, so a transient execution resolves variables and cookies as a
 * recorded one does. The create is the route's: a database refusing the row is
 * a 500, not a 400 (#2353).
 *
 * @return the message to answer 400 with, already logged, or nothing.
 */
std::optional<std::string> build_design_send (RouteContext& ctx,
const httplib::Request& req,
const ExecutePayload& payload,
DesignSend& send) {
    const nlohmann::json& json = payload.json;

    // This send's elements (issue #1514) - `preRequestScript` /
    // `postRequestScript` are refused before this point (`read_execute_payload`).
    send.elements = std::make_shared<const std::vector<vayu::core::CompiledElement>> (
    vayu::core::compile_elements (json.value ("elements", nlohmann::json::array ())));

    send.run.type   = vayu::RunType::Design;
    send.run.status = vayu::RunStatus::Running;
    seed_run_times (send.run, now_ms ());

    auto collection_id = read_run_scope (ctx.db, json, send.run);
    if (!collection_id) {
        vayu::utils::log_warning ("http", "POST /execute - " + collection_id.error ());
        return collection_id.error ();
    }
    send.collection_id     = std::move (*collection_id);
    send.run.origin        = payload.origin.kind;
    send.run.origin_client = payload.origin.client;

    // `pm.info.requestName`, resolved with the payload validation so a
    // malformed field is a 400 before any run row exists.
    auto resolved_name = resolve_script_request_name (ctx.db, json, send.run.request_id);
    if (!resolved_name.ok) {
        vayu::utils::log_warning ("http", "POST /execute - " + resolved_name.error);
        return resolved_name.error;
    }
    send.script_request_name = std::move (resolved_name.name);

    // The persisted half, skipped for a transient execution. The snapshot is
    // built here, not above, because it is storage, not scope: nobody reads a
    // sanitized payload that is never stored.
    if (!payload.transient) {
        send.run.id = vayu::utils::generate_id ("run_");
        const auto max_snapshot_body_bytes =
        static_cast<size_t> (ctx.db.get_config_int ("maxTraceBodyBytes",
        static_cast<int> (vayu::core::constants::json::MAX_TRACE_BODY_BYTES)));
        send.run.config_snapshot =
        vayu::json::sanitize_config_snapshot (req.body, max_snapshot_body_bytes,
        secret_variable_values (load_send_scopes (ctx.db, send)));
        send.run_id = send.run.id;
    }

    vayu::utils::log_info ("http", "Design Mode send",
    { { "runId", send.run_id.value_or ("none (transient)") },
    { "method", json.value ("method", "UNKNOWN") }, { "url", json.value ("url", "UNKNOWN") },
    { "requestId", send.run.request_id.value_or ("none") },
    { "environmentId", send.run.environment_id.value_or ("none") },
    { "elements", send.elements ? send.elements->size () : 0 } });

    // One jar per environment, the no-environment jar without one, resolved
    // once so the send, the pre-request script's `pm.sendRequest` and both
    // scripts' `pm.cookies` see one session (the scope decision:
    // cookie_jar.hpp).
    send.cookie_scope =
    send.run.environment_id.value_or (std::string (vayu::http::NO_ENVIRONMENT_SCOPE));

    // Four config lookups, read once for both paths; the QuickJS runtime, the
    // costly part, is built only where a script exists.
    send.script_config = vayu::core::read_script_config (ctx.db);
    // Payload-level: whether a script may send belongs to who asked for this
    // execution, not to the installation. Absent means no
    // (`ScriptConfig::allow_send_request`).
    send.script_config.allow_send_request = vayu::http::read_allow_script_requests (json);
    // A send stores one trace, and its scripts' requests ride it (#3633).
    vayu::core::record_script_requests (send.script_config, ctx.db);

    send.data_row            = payload.data_row;
    send.target_policy       = payload.target_policy;
    send.stream              = payload.stream;
    send.persist_variables   = payload.persist_variables;
    send.include_parsed_body = payload.include_parsed_body;
    return std::nullopt;
}

/**
 * Write back what a design send's scripts and extractors set, unless the
 * caller sent `persistVariables: false` (#1904). The one place both transports
 * decide it; best-effort, as `persist_script_variables` is.
 */
void persist_send_variables (vayu::db::Database& db, const ScriptVariableScopes& scopes, bool persist) {
    if (persist) {
        persist_script_variables (db, scopes);
    }
}

/**
 * Refuses a streaming send before its stream opens. The row exists and nothing
 * will consume it, so it is failed rather than left `running`, guarded, since a
 * throw while recording would cost the caller the answer as well. One helper
 * for the draining daemon's refusal and the residual pass's header-name ones
 * (#1051, #1084), so a copy cannot miss a fix.
 */
void refuse_stream_before_it_opens (RouteContext& ctx,
httplib::Response& res,
const std::string& run_id,
int status,
const std::string& reason,
std::string_view code = {}) {
    vayu::utils::log_warning ("http",
    "POST /execute - Stream refused for run: " + run_id + " - " + reason);
    try {
        ctx.db.transition_run_status (
        run_id, { vayu::RunStatus::Running }, vayu::RunStatus::Failed);
    } catch (const std::exception& e) {
        vayu::utils::log_error ("http",
        "Failed to fail a refused stream run: " + std::string (e.what ()));
    }
    send_error (res, status, reason, code);
}

/**
 * Gives a stream @p jar carrying the pre-request script's @p writes or, with
 * `disableCookies` (#1765), no jar, answering the writes for the caller to
 * apply once the stream starts, as no transfer will carry them. Exactly once
 * either way, as `execute_exchange` does, and never for a stream the manager
 * refuses: the jar-on writes go with the refused spec.
 */
[[nodiscard]] std::vector<vayu::http::CookieWrite> attach_stream_jar (
vayu::http::SseStreamRequest& spec,
vayu::http::CookieJar& jar,
const std::string& scope,
std::vector<vayu::http::CookieWrite> writes,
bool jar_off) {
    if (jar_off) {
        return writes;
    }
    spec.cookie_jar    = &jar;
    spec.cookie_scope  = scope;
    spec.cookie_writes = std::move (writes);
    return {};
}

/**
 * What refuses a streaming send before its stream opens, in the order the
 * buffered send meets them: the residual pass (issue #1008), the caller's
 * target policy (#2521), the auth that waited on the pre-request script
 * (issue #2473), then the file rule (`file_ref.hpp`) over the allowed folders
 * as they stand, code `unsendable_file`. A late OAuth 2.0 token request
 * carries @p cancel, the handler's `server_stopping` (#2683).
 */
std::optional<ResidualRefusal> refuse_before_stream (vayu::db::Database& db,
vayu::Request& request,
std::optional<vayu::http::Auth> late_auth,
const ScriptVariableScopes& scopes,
const vayu::http::TargetPolicy* target_policy,
const std::atomic<bool>* cancel) {
    if (auto refusal = resolve_residual_tokens (request, scopes)) {
        return refusal;
    }
    if (auto refusal = refuse_disallowed_target (target_policy, request)) {
        return refusal;
    }
    if (late_auth) {
        LateTokenAcquisition acquisition{ &db, target_policy, cancel };
        if (auto refusal =
            apply_late_auth (request, std::move (*late_auth), scopes, &acquisition)) {
            return refusal;
        }
    }
    if (!vayu::http::has_file_refs (request.body)) {
        return std::nullopt;
    }
    vayu::http::FilePlan files (vayu::http::FileAccessPolicy::from_database (db));
    if (auto refusal = files.prepare (request)) {
        return ResidualRefusal{
            vayu::Error{ vayu::ErrorCode::UnsendableFile, std::move (*refusal) }, "unsendable_file"
        };
    }
    return std::nullopt;
}

/// The status a stream's run row ends with. A shutdown ends it `stopped`, as
/// it ends a load run still sending; the trace's `endReason` is what tells it
/// from a user's Stop (#3342).
vayu::RunStatus stream_run_status (vayu::http::SseEndReason end,
const vayu::Response& response) {
    if (end == vayu::http::SseEndReason::Stopped || end == vayu::http::SseEndReason::Shutdown) {
        return vayu::RunStatus::Stopped;
    }
    return response.has_error () ? vayu::RunStatus::Failed : vayu::RunStatus::Completed;
}

/// The bound data row as the pointer `resolve_element_template` takes.
const nlohmann::json* row_or_null (const std::optional<nlohmann::json>& row) {
    return row ? &*row : nullptr;
}

/**
 * The streaming half of a design send (#573), in the buffered send's
 * script/send/script order, split by the transfer between them (#575): the
 * pre-request script runs here, before anything is on the wire, so its
 * `pm.request` write-back reaches the stream; the post-request script runs on
 * the worker thread once the stream ends, when there is a response and an event
 * list to assert over.
 */
void run_streaming_execution (RouteContext& ctx, httplib::Response& res, DesignSend& send) {
    // Loaded once and carried by the completion callback, so a pre-request
    // `pm.environment.set` reaches the post-request script as on the buffered
    // path.
    ScriptVariableScopes scopes;
    vayu::ScriptResult pre_script_result;
    vayu::ScriptResult post_script_result_placeholder; // unused; step.before touches only pre_script_result
    std::vector<vayu::core::ElementOutcome> pre_element_outcomes;
    std::vector<vayu::http::CookieWrite> pre_cookie_writes;
    // Resolved once for its three uses (the pre-request `pm.sendRequest`, the
    // transfer, the worker's post-request script): they are one stream, and a
    // settings change between them would route the halves differently.
    const auto transport = vayu::http::resolve_transport_policy (ctx.db);
    // Beside `transport`, for the same reason (#1229): the transfer and both
    // scripts' `pm.sendRequest` are one send and carry one default header set.
    const auto default_headers = vayu::http::resolve_default_header_policy (
    ctx.db, vayu::http::DefaultHeaderScope::Design);
    // The design bound, once, for the same reason: what either script's
    // `pm.sendRequest` may read (#1188) and what a stream whose reply is not
    // `text/event-stream` keeps as its body (#3238). The stream itself ends by
    // its event and duration caps, never a byte total.
    const size_t script_response_bound = design_response_body_bound (ctx.db);
    // A script's fetch takes the send's resolved timeout (#2833), copied out
    // here because the stream itself sets no whole-transfer deadline and the
    // request is moved into it below.
    const int script_request_timeout_ms = send.request.timeout_ms;
    // `ElementContext::max_body_bytes` for this stream's elements (#1514),
    // resolved now because the post-request pass runs on the worker thread,
    // long after this frame.
    const size_t element_body_bytes = element_body_bound (ctx.db);
    // Loaded with or without a script, as the residual-token pass reads them
    // too (#1008): a `{{token}}` resolving on the buffered path must not stay
    // literal here.
    scopes = load_send_scopes (ctx.db, send);

    static const std::vector<vayu::core::CompiledElement> NO_ELEMENTS;
    const std::vector<vayu::core::CompiledElement>& elements =
    send.elements ? *send.elements : NO_ELEMENTS;
    // Only where an element exists: the QuickJS runtime is the costly part, and
    // a `script.pre` element's `apply` is all that reaches it here.
    std::optional<vayu::runtime::ScriptEngine> script_engine;
    if (!elements.empty ()) {
        script_engine.emplace (send.script_config);
    }
    {
        // Never read: only `step.before` runs here; the post half runs on the
        // worker thread in its own `ElementContext` once the stream ends.
        vayu::ScriptResult unread_post_result;
        vayu::core::ElementContext element_ctx{
            .request  = send.request,
            .response = nullptr,
            .run_pre_script =
            [&] (const std::string& script) {
                auto pre_ctx =
                vayu::runtime::ScriptContext::for_prerequest (send.request);
                bind_script_scopes (pre_ctx, scopes, ctx.cookie_jar,
                send.cookie_scope, &pre_cookie_writes);
                pre_ctx.request_id         = send.run.request_id;
                pre_ctx.request_name       = send.script_request_name;
                pre_ctx.transport          = transport;
                pre_ctx.default_headers    = default_headers;
                pre_ctx.max_response_bytes = script_response_bound;
                pre_ctx.request_timeout_ms = script_request_timeout_ms;
                pre_ctx.cancel             = &ctx.server_stopping;
                // The row the transfer carries, as on the buffered path: a
                // stream is one send, and one send with a row is iteration 0 of
                // 1.
                if (send.data_row) {
                    pre_ctx.iteration_data  = &*send.data_row;
                    pre_ctx.iteration       = 0;
                    pre_ctx.vu              = vayu::core::SOLE_VIRTUAL_USER;
                    pre_ctx.iteration_count = 1;
                }
                return execute_script (*script_engine, script, pre_ctx, "Pre-request");
            },
            .run_post_script =
            [] (const std::string&) { return vayu::ScriptResult{}; },
            .pre_script_result  = pre_script_result,
            .post_script_result = unread_post_result,
            .set_variable =
            [&] (std::string_view scope, const std::string& name, const std::string& value) {
                set_scope_variable (scopes, scope, name, value);
            },
            .unset_variable =
            [&] (std::string_view scope, const std::string& name) {
                return unset_scope_variable (scopes, scope, name);
            },
            .should_stop = nullptr, // A single exchange has nothing to interrupt.
            .resolve_template =
            [&] (const std::string& text) {
                return resolve_element_template (text, scopes, row_or_null (send.data_row));
            },
            .record_metric = nullptr, // A streaming send has no run to record into.
        };
        vayu::core::ElementPipeline::run (vayu::core::Phase::StepBefore,
        element_ctx, elements, pre_element_outcomes);
    }

    // `read_stream_flag` refuses `stream` with `transient`, so a streaming send
    // always has a row; the rule holds in `read_execute_payload`, hence
    // `invariant_value`.
    const std::string run_id = vayu::utils::invariant_value (
    send.run_id, "a streaming send has a run row: stream and transient are mutually exclusive");

    // The pass the buffered send makes between script and send (#1008), here
    // because this path runs the pre-request script itself: a `{{token}}` the
    // script just defined resolves before the stream opens.
    if (auto refusal =
        refuse_before_stream (ctx.db, send.request, std::move (send.late_auth),
        scopes, send.target_policy_or_null (), &ctx.server_stopping)) {
        // What that pass refuses (#1051, #1084), in the buffered send's words
        // and composition's code; only where the caller reads it differs, as
        // this route has not answered yet. The code rides on the refusal
        // because naming it here is how it would come to name the wrong rule.
        refuse_stream_before_it_opens (
        ctx, res, run_id, 400, refusal->error.message, refusal->code);
        return;
    }

    vayu::http::SseStreamRequest spec;
    spec.run_id          = run_id;
    const bool jar_off   = send.request.disable_cookies;
    spec.request         = std::move (send.request);
    spec.limits          = vayu::http::read_sse_limits (ctx.db);
    spec.max_body_bytes  = script_response_bound;
    spec.transport       = transport;
    spec.default_headers = default_headers;
    spec.max_duration_ms = send.stream.max_duration_ms;
    spec.max_events      = send.stream.max_events;
    spec.text_path       = send.stream.text_path;
    const std::vector<vayu::http::CookieWrite> jarless_writes = attach_stream_jar (
    spec, ctx.cookie_jar, send.cookie_scope, std::move (pre_cookie_writes), jar_off);
    // Persistence stays the route's though it runs on the worker thread:
    // `ctx.db` outlives the manager, declared before `server_` for that
    // (server.hpp). Copied, not borrowed: the post-request script runs after
    // this frame is gone, and its row must be the one the pre-request script
    // and transfer used.
    spec.on_complete =
    [&db = ctx.db, &jar = ctx.cookie_jar, id = run_id, cookie_scope = send.cookie_scope,
    run = send.run, script_config = send.script_config, elements = send.elements,
    request_name = send.script_request_name, scopes, iteration_data = send.data_row,
    persist_variables = send.persist_variables, transport, default_headers,
    script_response_bound, script_request_timeout_ms, element_body_bytes,
    pre_script_result, pre_element_outcomes] (const vayu::Request& sent,
    const vayu::Response& response, const vayu::http::SseStreamContext& context) mutable {
        StreamRecord record;
        nlohmann::json scripts = nlohmann::json::object ();
        std::vector<vayu::core::ElementOutcome> element_outcomes =
        std::move (pre_element_outcomes);
        record.events = vayu::http::stream_trace_node (context);
        record.status = stream_run_status (context.end_reason (), response);
        const bool has_element_output = elements && !elements->empty ();
        // An `mcp` failure fails the stream's step as an assertion does
        // (#3762), with or without an element to run.
        std::optional<vayu::TestResult> mcp_failure =
        vayu::http::mcp_failure_test (response);
        const bool has_script_output = has_element_output ||
        mcp_failure.has_value () || !pre_script_result.tests.empty () ||
        !pre_script_result.console_output.empty () ||
        !pre_script_result.script_requests.empty () || !pre_script_result.success;
        if (has_script_output) {
            // Guarded whole: a script surface throwing where `execute_script`
            // does not catch (building the runtime, applying a cookie write)
            // must not cost the run its result row, the only record a stream
            // leaves.
            try {
                vayu::ScriptResult post_script_result;
                if (has_element_output) {
                    vayu::runtime::ScriptEngine script_engine (script_config);
                    std::vector<vayu::http::CookieWrite> post_cookie_writes;
                    // Mutable copies, not a const_cast: at `step.after` no wire
                    // is left to carry a `pm.request` edit back to, so a copy
                    // means as much as the reference.
                    vayu::Request mutable_sent      = sent;
                    vayu::Response mutable_response = response;
                    std::optional<vayu::Response> unwrapped;
                    vayu::core::ElementContext element_ctx{
                        .request = mutable_sent,
                        .response = vayu::http::mcp_element_view (mutable_response, unwrapped),
                        .run_pre_script =
                        [] (const std::string&) { return vayu::ScriptResult{}; },
                        .run_post_script =
                        [&] (const std::string& script) {
                            auto post_ctx =
                            vayu::runtime::ScriptContext::for_test (sent, response);
                            bind_script_scopes (post_ctx, scopes, jar,
                            cookie_scope, &post_cookie_writes);
                            post_ctx.request_id         = run.request_id;
                            post_ctx.request_name       = request_name;
                            post_ctx.transport          = transport;
                            post_ctx.default_headers    = default_headers;
                            post_ctx.max_response_bytes = script_response_bound;
                            post_ctx.request_timeout_ms = script_request_timeout_ms;
                            if (iteration_data) {
                                post_ctx.iteration_data = &*iteration_data;
                                post_ctx.iteration      = 0;
                                post_ctx.vu = vayu::core::SOLE_VIRTUAL_USER;
                                post_ctx.iteration_count = 1;
                            }
                            // Parsed from the bytes the trace stores, by the rule
                            // every later reader applies (#3770), and only when a
                            // script runs: the parse costs the held body's size.
                            const nlohmann::json script_events =
                            vayu::http::stream_events_node (response.body,
                            !response.body_truncated, record.events);
                            post_ctx.response_events = &script_events;
                            return execute_script (
                            script_engine, script, post_ctx, "Post-request");
                        },
                        .pre_script_result  = pre_script_result,
                        .post_script_result = post_script_result,
                        .set_variable =
                        [&] (std::string_view scope, const std::string& name,
                        const std::string& value) {
                            set_scope_variable (scopes, scope, name, value);
                        },
                        .unset_variable =
                        [&] (std::string_view scope, const std::string& name) {
                            return unset_scope_variable (scopes, scope, name);
                        },
                        .should_stop = nullptr,
                        .resolve_template =
                        [&] (const std::string& text) {
                            return resolve_element_template (
                            text, scopes, row_or_null (iteration_data));
                        },
                        .record_metric = nullptr, // A streaming send has no run to record into.
                        .max_body_bytes = element_body_bytes,
                    };
                    vayu::core::ElementPipeline::run (vayu::core::Phase::StepAfter,
                    element_ctx, *elements, element_outcomes);
                    // Nothing left to carry them: the transfer has captured, as
                    // on the buffered path.
                    jar.apply (cookie_scope, post_cookie_writes);
                }
                if (mcp_failure) {
                    post_script_result.tests.push_back (std::move (*mcp_failure));
                }
                scripts = build_script_result_node (pre_script_result,
                post_script_result, script_config.max_trace_body_bytes);
            } catch (const std::exception& e) {
                vayu::utils::log_error ("http",
                "Stream post-request script failed: " + std::string (e.what ()));
            }
            // Best-effort and after both scripts, so one `set()` per
            // run reaches disk rather than one per half.
            persist_send_variables (db, scopes, persist_variables);
        }

        // No verdict: a stream's body is an event stream, not a document a
        // response schema describes (the parameter's contract).
        record_design_result (db, id, sent, response, &record, std::nullopt,
        scripts, build_element_outcomes_node (element_outcomes));
    };

    auto context = ctx.sse_manager.start (std::move (spec));
    if (!context) {
        // The daemon is draining its workers, or - impossibly - the id
        // collided.
        refuse_stream_before_it_opens (ctx, res, run_id, 503, "Engine is shutting down");
        return;
    }
    // Started, so the pre-request script's writes stand - applied only now,
    // as a refused stream's jar-on writes are dropped with its spec.
    ctx.cookie_jar.apply (send.cookie_scope, jarless_writes);

    nlohmann::json body;
    body["runId"]     = run_id;
    body["eventsUrl"] = "/runs/" + run_id + "/events";
    body["status"]    = to_string (vayu::RunStatus::Running);
    res.status        = 202;
    res.set_content (body.dump (), "application/json");
}

/**
 * Vayu's own cost for one buffered exchange (#2132): the handler's time since
 * @p handler_start less what Vayu waited on others for: the transfer
 * (`wireMs`), the user's scripts (`pm.sendRequest` included) and an OAuth 2.0
 * token fetch on first use or expiry (@p auth_fetch_ms; a cached token costs a
 * lookup and stays in). What remains is composition, auth, cookies, the element
 * pipeline and assembling the answer.
 *
 * `queueWaitMs` stays inside: the sliver between the engine's stopwatch and
 * libcurl is engine-side. A design send waits on no timer (`timer.pacing` never
 * delays a first pass and `timer.think` runs at `step.between`, which
 * `execute_exchange` does not dispatch), so none is subtracted. Clamped at zero
 * because the three clocks are read independently.
 */
double engine_cost_ms (std::chrono::steady_clock::time_point handler_start,
const vayu::Response& response,
double script_ms,
double auth_fetch_ms) {
    const double elapsed_ms = std::chrono::duration<double, std::milli> (
    std::chrono::steady_clock::now () - handler_start)
                              .count ();
    return std::max (0.0, elapsed_ms - response.timing.wire_ms - script_ms - auth_fetch_ms);
}

/**
 * A send whose caller hung up is `Stopped`, as a user's Stop of a buffered
 * send is (#3383): the row leaves Running before the result is recorded, so
 * `record_design_result` stores the exchange as it ended and its own move to
 * Completed or Failed is refused. A server shutdown is not a caller leaving
 * and keeps the status its exchange earned.
 */
void stop_if_caller_left (vayu::db::Database& db, const DesignSend& send) {
    if (!send.run_id || send.caller_watch == nullptr || !send.caller_watch->caller_left ()) {
        return;
    }
    vayu::utils::log_info ("run", "Send stopped: its caller disconnected",
    { { "runId", *send.run_id } });
    db.transition_run_status (
    *send.run_id, { vayu::RunStatus::Running }, vayu::RunStatus::Stopped);
}

/**
 * The handle a buffered answer gives to the result it stored (#3704), which
 * `GET /runs/:runId/results/:resultId` reads back whole. Both keys or neither:
 * a transient send stored nothing, and a failed write has no row to name.
 */
void add_result_handle (nlohmann::json& body,
const std::optional<std::string>& run_id,
std::optional<int> result_id) {
    if (!run_id || !result_id) {
        return;
    }
    body["runId"]    = *run_id;
    body["resultId"] = *result_id;
}

/**
 * The buffered half of a design send: pre-request script, send, test script,
 * the sequence a scenario step performs too, hence in request_exchange.cpp
 * (#353).
 *
 * @return the response body bytes the exchange held, which decide whether the
 *         caller hands the freed heap back (#2544).
 */
[[nodiscard]] std::size_t run_buffered_execution (RouteContext& ctx,
httplib::Response& res,
DesignSend& send,
std::chrono::steady_clock::time_point handler_start) {
    vayu::runtime::ScriptEngine script_engine (send.script_config);

    // Mutated in place by both scripts, persisted once below.
    auto scopes = load_send_scopes (ctx.db, send);

    // `iteration` stays unset for a send with no row: it has no iteration
    // index, and a binding that cannot fail is worse than a missing one (#300).
    ExchangeInputs inputs;
    inputs.request       = std::move (send.request);
    inputs.late_auth     = std::move (send.late_auth);
    inputs.token_cache   = &ctx.db;
    inputs.target_policy = send.target_policy_or_null ();
    inputs.elements      = send.elements;
    inputs.request_id    = send.run.request_id;
    inputs.request_name  = send.script_request_name;
    // Read at use, so a settings change applies to the next send without a
    // restart (#705); the body bound likewise (#1157).
    inputs.transport       = vayu::http::resolve_transport_policy (ctx.db);
    inputs.default_headers = vayu::http::resolve_default_header_policy (
    ctx.db, vayu::http::DefaultHeaderScope::Design);
    inputs.max_response_bytes     = design_response_body_bound (ctx.db);
    inputs.max_element_body_bytes = element_body_bound (ctx.db);
    inputs.cancel = send.caller_watch != nullptr ? &send.caller_watch->cancel () :
                                                   &ctx.server_stopping;
    // The allowed folders as they stand at this send, read once.
    vayu::http::FilePlan files (vayu::http::FileAccessPolicy::from_database (ctx.db));
    inputs.files = &files;
    if (send.data_row) {
        inputs.iteration_data = &*send.data_row;
        // Row 0 of 1: a send-with-row is an iteration, the row it bound. An
        // ordinary Send leaves both unset (#300, above).
        inputs.iteration       = 0;
        inputs.vu              = vayu::core::SOLE_VIRTUAL_USER;
        inputs.iteration_count = 1;
    }
    auto exchange = execute_exchange (script_engine, ctx.cookie_jar,
    send.cookie_scope, scopes, std::move (inputs));

    // What the contract says this response should have been (#628), from the
    // stored request: an unsaved editor request is no document's operation, and
    // a verdict for it would claim a contract it is not bound by.
    const auto validation =
    validate_design_response (ctx.db, send.run.request_id, exchange.response);

    // Built once, sent and stored (#725): one object, so a restored Tests tab
    // shows the assertions this send made.
    const nlohmann::json scripts = build_script_result_node (exchange.pre_script_result,
    exchange.post_script_result, send.script_config.max_trace_body_bytes);
    // Every compiled element's outcome (#1514), `extract.*` / `assert.*` beside
    // the scripts, one object in two homes like `scripts`.
    const nlohmann::json elements = build_element_outcomes_node (exchange.element_outcomes);

    // Taken before the write below, then stored and returned, so the live body
    // and the restored trace carry one value; persistence and the final
    // serialisation fall outside it. A send has one acquisition: the build's or
    // the late one's (#2521).
    const double engine_ms = engine_cost_ms (handler_start, exchange.response,
    exchange.script_ms, send.auth_fetch_ms + exchange.auth_fetch_ms);
    // The script time `engineMs` leaves out, reported on its own (#3676): the
    // same reading, so the two never disagree about where the time went.
    const double script_ms = exchange.script_ms;

    // A failure is logged, not answered. A transient execution records no trace
    // row, so the post-auth headers and these results never reach disk.
    stop_if_caller_left (ctx.db, send);
    const auto result_id = record_design_result (ctx.db, send.run_id,
    exchange.request, exchange.response,
    /*send.stream=*/nullptr, validation, scripts, elements, engine_ms, script_ms);

    persist_send_variables (ctx.db, scopes, send.persist_variables);

    // 200: the target's status is in the body.
    res.status          = 200;
    nlohmann::json body = build_response_json (
    exchange.response, send.include_parsed_body, scripts, validation, elements);
    body["timing"]["engineMs"] = engine_ms;
    body["timing"]["scriptMs"] = script_ms;
    add_result_handle (body, send.run_id, result_id);
    if (auto file = body_file_node (exchange.request)) {
        body["bodyFile"] = std::move (*file);
    }
    // Where the send went and with what, since a pre-request script may have
    // retargeted it after the caller composed it (#3650).
    record_request_line (body, exchange.request);
    // What auth wrote, so a reader that masks the answer (the MCP server) can
    // tell the credential in `rawRequest` from any other query parameter (#1845).
    record_auth_provenance (body, exchange.request);
    // The refused rule's code (`ResidualRefusal`), the one a streaming send
    // answers its 400 with, beside the status-0 response carrying its words.
    if (!exchange.refusal_code.empty ()) {
        body["refusalCode"] = exchange.refusal_code;
        // Auth applied after the script that failed (an OAuth 2.0 token not
        // acquired, #2521) also carries the hint a build-time failure has.
        const auto error_code = exchange.response.error_code;
        if (error_code == vayu::ErrorCode::AuthRequired ||
        error_code == vayu::ErrorCode::AuthFailed) {
            body["authErrorCode"] = exchange.refusal_code;
        }
    }
    // `replace`: the body is UTF-8 or base64 by now, but a header value off
    // the wire can still carry a byte that is not (#2458).
    res.set_content (body.dump (2, ' ', false, nlohmann::json::error_handler_t::replace),
    "application/json");
    return exchange.response.body.size ();
}

/**
 * Answers a build that failed once the run row exists: its auth was not applied
 * (an OAuth 2.0 token not acquired), or the caller's target policy refused that
 * token's endpoint (#2521). The second answers as a refused final URL does, so
 * a token acquired at the build and one after the script are refused alike: a
 * stream's 400 under the code, a buffered send's `refusalCode`. Otherwise the
 * failed result is recorded and the error returned with its `authErrorCode`
 * under a 200.
 */
void answer_failed_build (RouteContext& ctx,
httplib::Response& res,
const vayu::http::RequestBuild& built,
DesignSend& send) {
    const bool target_refused = vayu::http::is_target_refusal_code (built.detail_code);
    if (target_refused && send.stream.value) {
        const std::string run_id = vayu::utils::invariant_value (
        send.run_id, "a streaming send has a run row: stream and transient are mutually exclusive");
        refuse_stream_before_it_opens (
        ctx, res, run_id, 400, built.error_message, built.detail_code);
        return;
    }
    vayu::Response failed;
    failed.status_code   = 0;
    failed.status_text   = vayu::http::status_text (0);
    failed.error_code    = built.error_code;
    failed.error_message = built.error_message;
    stop_if_caller_left (ctx.db, send);
    const auto result_id =
    record_design_result (ctx.db, send.run_id, send.request, failed);
    res.status          = 200;
    nlohmann::json body = vayu::json::serialize (failed);
    body[target_refused ? "refusalCode" : "authErrorCode"] = built.detail_code;
    add_result_handle (body, send.run_id, result_id);
    res.set_content (body.dump (2, ' ', false, nlohmann::json::error_handler_t::replace),
    "application/json");
}

/**
 * Everything a design send does once its run row exists: answer a failed
 * build, hand a stream to its worker, or run the buffered exchange.
 */
void dispatch_design_send (RouteContext& ctx,
httplib::Response& res,
const vayu::http::RequestBuild& built,
DesignSend& send,
std::chrono::steady_clock::time_point handler_start) {
    if (!built.ok) {
        answer_failed_build (ctx, res, built, send);
        return;
    }

    // A stream has no synchronous exchange: the transfer moves to a managed
    // consumer worker and the route answers at once with the run and its events
    // URL (#573). `stream` excludes `transient`, so `run_id` is set.
    if (send.stream.value) {
        run_streaming_execution (ctx, res, send);
        return;
    }
    const std::size_t body_bytes = run_buffered_execution (ctx, res, send, handler_start);
    // Out here, where the exchange, its body and the answer's parsed tree are
    // already freed and only the dumped answer is still held (#2544).
    if (body_bytes > vayu::core::constants::server::RELEASE_HEAP_AFTER_BODY_BYTES) {
        vayu::platform::release_free_heap ();
    }
}

/**
 * POST /execute: one request, Design Mode.
 *
 * Returns:
 * - 200: processed; the target's status and errors are in the body. A
 *        buffered send whose caller hangs up first is cancelled and recorded
 *        `stopped` (#3383).
 * - 400: a malformed request (bad JSON, a missing field)
 * - 500: the run record could not be written, or the send threw after it was
 *        (`guard_recorded_send` fails the row and names the error)
 */
void handle_execute_request (RouteContext& ctx,
const httplib::Request& req,
httplib::Response& res) {
    const auto handler_start = std::chrono::steady_clock::now ();
    ExecutePayload payload;
    // Joined before the handler returns: it reads the connection's socket.
    std::optional<vayu::http::DisconnectWatch> caller_watch;
    if (auto rejection = read_execute_payload (ctx, req, payload, caller_watch)) {
        send_error (res, 400, rejection->message, rejection->code);
        return;
    }

    DesignSend send;
    send.caller_watch = caller_watch ? &*caller_watch : nullptr;
    if (auto rejection = build_design_send (ctx, req, payload, send)) {
        send_error (res, 400, *rejection);
        return;
    }

    if (send.run_id) {
        try {
            ctx.db.create_run (send.run);
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
            "POST /execute - Failed to create run: " + std::string (e.what ()));
            send_error (res, 500, "Couldn't create the run record");
            return;
        }
    }

    // Auth is already in the headers/url (the build's, or the bind's for
    // credentials carrying the row) unless a credential waits on the
    // pre-request script (#2473), when the exchange applies it after. Either
    // way a script-set Authorization overrides the Auth tab's: the script
    // writes into this object, and `apply_auth` skips a header the request
    // already carries.
    send.request       = std::move (payload.built.request);
    send.auth_fetch_ms = payload.built.auth_fetch_ms;
    send.late_auth     = std::move (payload.late_auth);

    guard_recorded_send (ctx.db, res, send.run_id, [&] () {
        dispatch_design_send (ctx, res, payload.built, send, handler_start);
    });
}


/**
 * Drops every top-level `null` member of a run payload so it reads as absent
 * downstream (#1893): the validators treat the two alike, but the run's readers
 * use `json::value (key, default)`, which defaults only an absent key and
 * throws on `null`, after the row exists. Nested objects keep their own rules.
 */
void erase_null_members (nlohmann::json& json) {
    if (!json.is_object ()) {
        return;
    }
    for (auto it = json.begin (); it != json.end ();) {
        if (it->is_null ()) {
            it = json.erase (it);
        } else {
            ++it;
        }
    }
}

/**
 * The refusal for a data cell nested past the depth bound, in the two fields
 * carrying rows (#2362): `data` (`invalid_run_config`, as every refusal of it)
 * and `scenario.data` (`invalid_scenario`). `handle_start_load_test` dumps the
 * payload for the snapshot before either reader runs, and `dump ()` recurses,
 * so a deep cell would crash the engine first: this runs right after the parse,
 * as `parse_request_json`'s field bound. The readers keep their check for
 * callers of `resolve_scenario` and `read_load_data_set`.
 */
RouteResult refuse_overdeep_run_data (const nlohmann::json& json) {
    if (!json.is_object ()) {
        return {};
    }
    if (auto data = json.find ("data"); data != json.end ()) {
        if (auto reason = vayu::core::refuse_overdeep_data (*data, "data")) {
            return route_error (400, *reason, "invalid_run_config");
        }
    }
    const auto scenario = json.find ("scenario");
    if (scenario == json.end () || !scenario->is_object ()) {
        return {};
    }
    const auto data = scenario->find ("data");
    if (data == scenario->end ()) {
        return {};
    }
    if (auto reason = vayu::core::refuse_overdeep_data (*data, "scenario.data")) {
        return route_error (400, *reason, "invalid_scenario");
    }
    return {};
}

/**
 * A collection run (a scenario with no load `mode`) has no scrape lifecycle,
 * so a `monitor` block beside it would be accepted and never read (#1939).
 * The caller has already established the payload is that shape.
 */
std::optional<std::string> refuse_monitor_on_collection_run (const nlohmann::json& json) {
    const auto monitor = json.find ("monitor");
    if (monitor == json.end () || monitor->is_null ()) {
        return std::nullopt;
    }
    return "'monitor' is only read by a load run - a collection run scrapes no "
           "vitals; add a load 'mode' beside 'scenario', or drop 'monitor'";
}

/**
 * The run's `monitor.url` as @p policy judges it (#3121). Judged here, before
 * the run exists, because `collect_monitor` scrapes with no policy of its own.
 */
std::optional<vayu::http::TargetRefusal> refuse_monitor_outside_policy (
const nlohmann::json& json,
const std::optional<vayu::http::TargetPolicy>& policy) {
    const auto monitor = json.find ("monitor");
    if (!policy || monitor == json.end ()) {
        return std::nullopt;
    }
    return vayu::http::refuse_monitor_endpoint (*policy, *monitor);
}

/**
 * `failOnSchemaError: true` outside a collection run (#3039). Only the
 * sequential collection runner reads the flag (`read_fail_on_schema_error`).
 * `false` is the default and stays accepted; a non-boolean is left to
 * `validate_run_config`'s type check.
 */
std::optional<std::string> refuse_fail_on_schema_error_outside_collection_run (
const nlohmann::json& json,
bool collection_run) {
    const auto flag = json.find ("failOnSchemaError");
    if (collection_run || flag == json.end () || !flag->is_boolean () ||
    !flag->get<bool> ()) {
        return std::nullopt;
    }
    return "'failOnSchemaError' is only read by a collection run - a load run "
           "validates sampled responses once it drains and never fails a step "
           "on them; run a 'scenario' without a load 'mode', or drop "
           "'failOnSchemaError'";
}

/**
 * A single-request run payload that fails to parse because a header name is not
 * a token (`invalid_header_name`, #2467), as the 400's message and code. Any
 * other parse failure stays the run's own build to report; this is not where to
 * start refusing them.
 */
std::optional<std::pair<std::string, std::string>> refuse_invalid_header_name (
const nlohmann::json& json) {
    const auto parsed = vayu::json::deserialize_request (json);
    if (!parsed.is_error () || parsed.error ().code != vayu::ErrorCode::InvalidHeaderName) {
        return std::nullopt;
    }
    return std::pair{ parsed.error ().message,
        std::string (vayu::http::INVALID_HEADER_NAME_CODE) };
}

/// A single-request run's own required fields, and its header names.
std::optional<RouteError> refuse_incomplete_single_request (const nlohmann::json& json) {
    if (!json.contains ("method") || !json.contains ("url")) {
        vayu::utils::log_warning ("http", "POST /runs - Missing required fields: method, url");
        return RouteError{ 400, error_body (400, "Missing required fields: method, url") };
    }

    if (!json.contains ("mode") && !json.contains ("duration") &&
    !json.contains ("iterations")) {
        vayu::utils::log_warning ("http", "POST /runs - Missing mode/duration/iterations config");
        return RouteError{ 400,
            error_body (400, "Must specify either 'mode' with 'duration' or 'iterations'") };
    }

    if (auto refusal = refuse_invalid_header_name (json)) {
        vayu::utils::log_warning ("http", "POST /runs - " + refusal->first);
        return RouteError{ 400, error_body (400, refusal->first, refusal->second) };
    }
    return std::nullopt;
}

/**
 * Every refusal `POST /runs` makes on the payload alone, before a run row
 * exists, so a rejected request leaves nothing. @p origin and @p target_policy
 * receive the payload's `origin` and `targetPolicy`: reading them is validating
 * them.
 */
std::optional<RouteError> validate_load_request (RouteContext& ctx,
nlohmann::json& json,
bool is_scenario,
bool is_scenario_load,
RunOrigin& origin,
std::optional<vayu::http::TargetPolicy>& target_policy) {
    // Refused before the run row exists, and never quietly downgraded to a
    // closed-loop mode: a run that measured something other than what was
    // asked for is worse than no run at all.
    if (is_scenario_load) {
        if (auto invalid = vayu::core::validate_scenario_load_config (json)) {
            vayu::utils::log_warning (
            "http", "POST /runs - Invalid scenario load config: " + *invalid);
            return RouteError{ 400, error_body (400, *invalid, "invalid_run_config") };
        }
    }

    if (is_scenario && !is_scenario_load) {
        if (auto invalid = refuse_monitor_on_collection_run (json)) {
            vayu::utils::log_warning (
            "http", "POST /runs - Invalid collection run config: " + *invalid);
            return RouteError{ 400, error_body (400, *invalid, "invalid_run_config") };
        }
    }

    if (auto invalid = refuse_fail_on_schema_error_outside_collection_run (
        json, is_scenario && !is_scenario_load)) {
        vayu::utils::log_warning ("http", "POST /runs - Invalid run config: " + *invalid);
        return RouteError{ 400, error_body (400, *invalid, "invalid_run_config") };
    }

    // The `elements` override (#1495) is validated for both load-run shapes:
    // the validator does not tell them apart, and a single-request run's step
    // pipeline reads it too (#1594).
    if (auto invalid = vayu::core::validate_elements_run_override (json)) {
        vayu::utils::log_warning (
        "http", "POST /runs - Invalid elements override: " + *invalid);
        return RouteError{ 400, error_body (400, *invalid, "invalid_run_config") };
    }

    // A single-request run's place for `script.setup` / `script.teardown`
    // (#1573), refused beside `scenario`, whose collection has an `elements`
    // column for it.
    if (auto invalid = vayu::core::validate_lifecycle_elements_run_override (json)) {
        vayu::utils::log_warning (
        "http", "POST /runs - Invalid lifecycleElements: " + *invalid);
        return RouteError{ 400, error_body (400, *invalid, "invalid_run_config") };
    }

    // A single-request run's place for its request's step-level elements
    // (#1594), refused beside `scenario`, whose steps carry their resolved
    // elements.
    if (auto invalid = vayu::core::validate_request_elements_run_override (json)) {
        vayu::utils::log_warning ("http", "POST /runs - Invalid requestElements: " + *invalid);
        return RouteError{ 400, error_body (400, *invalid, "invalid_run_config") };
    }

    // `preRequestScript(s)` / `postRequestScript(s)` / `tests` are refused
    // (#1594). A single-request run's scripts live in `requestElements`
    // (`script.pre` / `script.post`), so the refusal names it rather than this
    // endpoint's run-level `elements` override, where the default message would
    // land a caller on a second 400. A scenario run keeps the default: its
    // scripts are the bound collection's stored `elements`.
    if (auto invalid = refuse_legacy_script_fields (
        json, is_scenario ? "elements" : "requestElements")) {
        vayu::utils::log_warning ("http", "POST /runs - " + *invalid);
        return RouteError{ 400, error_body (400, *invalid) };
    }

    auto read_origin = read_run_origin (json);
    if (!read_origin) {
        vayu::utils::log_warning ("http", "POST /runs - " + read_origin.error ());
        return RouteError{ 400, error_body (400, read_origin.error ()) };
    }
    origin = std::move (*read_origin);

    // Read again by the run itself (`RunContext::target_policy`); refused here
    // so a malformed one leaves no run behind, and kept for the token
    // acquisitions the plan and the pre-flight make before the run exists.
    auto policy = vayu::http::read_target_policy (json);
    if (!policy) {
        vayu::utils::log_warning ("http", "POST /runs - " + policy.error ());
        return RouteError{ 400,
            error_body (400, policy.error (), vayu::http::INVALID_TARGET_POLICY_CODE) };
    }
    target_policy = std::move (*policy);

    if (!is_scenario) {
        if (auto refusal = refuse_incomplete_single_request (json)) {
            return refusal;
        }
    }

    // Range-checked before the row exists, so a rejected request leaves
    // nothing; `invalid_run_config` replaces the per-status default code.
    if (auto invalid =
        validate_run_config (json, vayu::core::read_monitor_limits (ctx.db))) {
        vayu::utils::log_warning ("http", "POST /runs - Invalid run config: " + *invalid);
        return RouteError{ 400, error_body (400, *invalid, "invalid_run_config") };
    }

    // After the config check, so a `monitor` block without a string URL is
    // refused as malformed rather than passed over here.
    if (auto refusal = refuse_monitor_outside_policy (json, target_policy)) {
        vayu::utils::log_warning ("http", "POST /runs - " + refusal->message);
        return RouteError{ 400, error_body (400, refusal->message, refusal->code) };
    }

    // Beside the config check, for the same reason: both run before the run row
    // exists, so a rejection leaves none. The snapshot is built from the body
    // as sent less its nulls (credentials withheld), not from this normalized
    // `json`.
    if (auto outcome = normalize_run_http_version (json); !outcome) {
        vayu::utils::log_warning ("http",
        "POST /runs - Invalid httpVersion: " + outcome.error ().body.dump ());
        return outcome.error ();
    }
    return std::nullopt;
}

/**
 * The scenario block, resolved once, before the first send and any run row. An
 * unknown collection, an empty sequence or an uncomposable step must leave no
 * run, and resolution finds all three. Once, because a collection edited
 * mid-run must not change the sequence under it and the load executor cannot
 * query SQLite per step per virtual user. The plan is shared immutably with the
 * run's worker and lives only in memory, for the run's life.
 */
std::optional<RouteError> resolve_run_scenario (RouteContext& ctx,
const nlohmann::json& json,
bool is_scenario_load,
const vayu::http::TargetPolicy* target_policy,
std::shared_ptr<const vayu::core::ScenarioExecution>& scenario_execution,
nlohmann::json& scenario_manifest) {
    vayu::core::ScenarioResolveOptions options;
    // Only the sequential runner's steps acquire their token at the send.
    options.oauth2_after_scripts = !is_scenario_load;
    options.target_policy        = target_policy;
    if (auto it = json.find ("environmentId"); it != json.end () && it->is_string ()) {
        options.environment_id = it->get<std::string> ();
    }
    options.cancel           = &ctx.server_stopping;
    options.timeout_ms       = resolve_request_timeout_ms (json, ctx.db);
    options.stream_bounds    = vayu::http::resolve_stream_bounds (json,
    vayu::http::default_stream_bounds (vayu::http::read_sse_limits (ctx.db)));
    options.limits.max_steps = static_cast<size_t> (ctx.db.get_config_int (
    "maxScenarioSteps", static_cast<int> (vayu::core::constants::scenario::MAX_STEPS)));
    options.limits.max_data_rows =
    static_cast<size_t> (ctx.db.get_config_int ("maxScenarioDataRows",
    static_cast<int> (vayu::core::constants::scenario::MAX_DATA_ROWS)));
    options.limits.max_data_bytes =
    static_cast<size_t> (ctx.db.get_config_int ("maxScenarioDataBytes",
    static_cast<int> (vayu::core::constants::scenario::MAX_DATA_BYTES)));

    auto resolved = vayu::core::resolve_scenario (ctx.db, json["scenario"], options);
    if (!resolved.ok) {
        vayu::utils::log_warning (
        "http", "POST /runs - Invalid scenario: " + resolved.error);
        return RouteError{ 400,
            error_body (400, resolved.error,
            resolved.error_code.empty () ? "invalid_scenario" : resolved.error_code) };
    }
    scenario_manifest = vayu::core::build_scenario_manifest (
    resolved.request, resolved.plan, resolved.spec);

    auto execution     = std::make_shared<vayu::core::ScenarioExecution> ();
    execution->request = std::move (resolved.request);
    execution->plan    = std::move (resolved.plan);
    // The manifest was built before this move, from `resolved.request`, which
    // carries the row count and never the rows: that keeps user data out of
    // `config_snapshot`.
    execution->data_rows = std::move (resolved.data_rows);
    // The contract this run is measured against, so coverage counts against the
    // document bound when the plan resolved (#629), not whatever it is when the
    // run ends. The manifest already stamped its identity.
    execution->spec = std::move (resolved.spec);
    // Every file the steps can send, checked once while resolving.
    execution->files   = std::move (resolved.files);
    scenario_execution = std::move (execution);

    vayu::utils::log_info ("run", "Scenario resolved",
    { { "collection", scenario_execution->request.collection_id },
    { "steps", scenario_execution->plan.steps.size () },
    { "iterations", scenario_execution->request.iterations } });
    return std::nullopt;
}

/**
 * @ref resolve_run_scenario, plus, for a scenario load run only, the controller
 * refusal (#1515): `control.switch` / `control.loop` jump the plan, which a
 * scenario load run's virtual users cannot do
 * (`vayu::core::find_load_incompatible_controller`).
 */
std::optional<RouteError> resolve_and_validate_run_scenario (RouteContext& ctx,
const nlohmann::json& json,
bool is_scenario_load,
const vayu::http::TargetPolicy* target_policy,
std::shared_ptr<const vayu::core::ScenarioExecution>& scenario_execution,
nlohmann::json& scenario_manifest) {
    if (auto rejection = resolve_run_scenario (ctx, json, is_scenario_load,
        target_policy, scenario_execution, scenario_manifest)) {
        return rejection;
    }
    if (!is_scenario_load) {
        return std::nullopt;
    }
    if (auto offending_kind =
        vayu::core::find_load_incompatible_controller (scenario_execution->plan)) {
        return RouteError{ 400,
            error_body (400,
            "'" + *offending_kind +
            "' is not available on a scenario load run: it needs to jump or "
            "repeat a step, and a load run's virtual users only ever advance "
            "forward. Use a sequential (design-mode) collection run for a plan "
            "carrying it.",
            "invalid_scenario") };
    }
    return std::nullopt;
}

/**
 * A single-request run's `auth.config.privateKey` reference resolved in
 * @p json from the run's own scopes, once, before anything reads the config
 * (#3632). A load run acquires its token before any script, and its watchdog
 * re-signs from the same config mid-run, so the PEM is held in this in-memory
 * payload for the run's life. The stored snapshot was taken from the body as
 * sent, so it keeps the reference. A scenario's steps resolve their own when
 * the plan is (`core::resolve_scenario`); its payload carries no `auth`.
 *
 * @return the refusal naming the reference when no variable answers it.
 */
std::optional<std::string> resolve_run_signing_key (vayu::db::Database& db,
const vayu::db::Run& run,
const std::string& collection_id,
nlohmann::json& json) {
    auto* config = vayu::http::config_naming_private_key (json);
    if (config == nullptr) {
        return std::nullopt;
    }
    return vayu::http::resolve_private_key_reference (*config,
    flatten_variable_scopes (
    load_script_variable_scopes (db, run.environment_id, collection_id)));
}

/**
 * Rejects an unauthorizable run before creating it, and warms the token cache
 * so the worker's `apply_auth` hits it. Single-request only: a scenario payload
 * has no run-level `auth`, each step's resolved (or refused with a 400) at plan
 * time. A token endpoint @p target_policy refuses is a 400 under the policy's
 * code, before anything is posted (#2521); a payload with its own Authorization
 * header fetches no token (#3202).
 */
std::optional<RouteError> preflight_run_auth (RouteContext& ctx,
const nlohmann::json& json,
const vayu::http::TargetPolicy* target_policy) {
    // The headers the worker will build the request from, so a typed
    // Authorization header spares the token fetch here as it does there
    // (#3202). A payload that does not deserialize carries none; the run's
    // own build reports why.
    auto parsed = vayu::json::deserialize_request (json);
    const vayu::HeaderList request_headers =
    parsed.is_error () ? vayu::HeaderList{} : std::move (parsed).value ().headers;
    auto preflight = vayu::http::preflight_auth (
    json.value ("auth", nlohmann::json ()), request_headers, ctx.db,
    resolve_request_timeout_ms (json, ctx.db), target_policy, &ctx.server_stopping);
    if (!preflight.ok) {
        vayu::utils::log_warning (
        "http", "POST /runs - Auth pre-flight failed: " + preflight.message);
        const int status = (preflight.code == vayu::ErrorCode::AuthRequired) ? 409 : 400;
        auto body = error_body (status, preflight.message, preflight.detail_code);
        add_provider_reply (body, preflight.provider_status,
        preflight.provider_error, preflight.provider_error_description);
        return RouteError{ status, std::move (body) };
    }
    return std::nullopt;
}

/** What this run is, for the log: the two shapes read differently. */
void log_started_run (const nlohmann::json& json,
const vayu::db::Run& run,
const std::string& run_id,
const vayu::core::ScenarioExecution* scenario_execution) {

    std::string duration_str = "0s";
    if (json.contains ("duration")) {
        if (json["duration"].is_string ()) {
            duration_str = json["duration"].get<std::string> ();
        } else if (json["duration"].is_number ()) {
            duration_str = std::to_string (json["duration"].get<int> ()) + "s";
        }
    }

    if (scenario_execution != nullptr) {
        vayu::utils::log_info ("run", "Collection run started",
        { { "runId", run_id }, { "collection", scenario_execution->request.collection_id },
        { "steps", scenario_execution->plan.steps.size () },
        { "iterations", scenario_execution->request.iterations },
        { "environmentId", run.environment_id.value_or ("none") } });
    } else {
        vayu::utils::log_info ("run", "Load test started",
        { { "runId", run_id }, { "mode", json.value ("mode", "unspecified") },
        { "method", json.value ("method", "UNKNOWN") },
        { "url", json.value ("url", "UNKNOWN") }, { "duration", duration_str },
        { "iterations", json.value ("iterations", 0) },
        { "rps", vayu::core::requested_rps (json) },
        { "concurrency", json.value ("concurrency", 1) },
        { "requestId", run.request_id.value_or ("none") },
        { "environmentId", run.environment_id.value_or ("none") } });
    }
}

/**
 * The file rule for a single-request load run, before the run row exists
 * (`core::plan_load_files`). Leaves @p out null for a request naming no file,
 * and for one the payload cannot describe: the run's own build reports that.
 */
std::optional<std::string> plan_single_load_files (RouteContext& ctx,
const nlohmann::json& json,
bool is_scenario,
const vayu::core::LoadDataSet* data,
std::shared_ptr<vayu::http::FilePlan>& out,
std::optional<nlohmann::json>& body_file) {
    if (is_scenario) {
        return std::nullopt; // A scenario's steps are planned by `resolve_scenario`.
    }
    auto parsed = vayu::json::deserialize_request (json);
    if (parsed.is_error ()) {
        return std::nullopt;
    }
    vayu::Request request = std::move (parsed).value ();
    if (!vayu::http::has_file_refs (request.body)) {
        return std::nullopt;
    }
    auto files = std::make_shared<vayu::http::FilePlan> (
    vayu::http::FileAccessPolicy::from_database (ctx.db));
    if (auto refusal = vayu::core::plan_load_files (*files, request, data)) {
        return refusal;
    }
    if (!vayu::http::has_templated_file_path (request.body)) {
        body_file = body_file_node (request);
    }
    out = std::move (files);
    return std::nullopt;
}

/// A single-request run's inputs that must hold before a run row exists: the
/// data set (`invalid_run_config`), then its files (`unsendable_file`).
std::optional<std::pair<std::string, std::string>> refuse_load_inputs (RouteContext& ctx,
const nlohmann::json& json,
bool is_scenario,
const LoadDataRows& load_data,
std::shared_ptr<vayu::http::FilePlan>& files,
std::optional<nlohmann::json>& body_file) {
    if (!load_data.ok) {
        return std::pair{ load_data.error, std::string{ "invalid_run_config" } };
    }
    if (auto refusal = plan_single_load_files (
        ctx, json, is_scenario, load_data.set.get (), files, body_file)) {
        return std::pair{ std::move (*refusal), std::string{ "unsendable_file" } };
    }
    return std::nullopt;
}

/// @p snapshot with the planned file's `bodyFile` added, when there is one.
std::string with_body_file (std::string snapshot,
const std::optional<nlohmann::json>& body_file) {
    if (!body_file) {
        return snapshot;
    }
    auto parsed = nlohmann::json::parse (snapshot, nullptr, false);
    if (!parsed.is_object ()) {
        return snapshot;
    }
    parsed["bodyFile"] = *body_file;
    return parsed.dump ();
}

/// What a `POST /runs` 202 says it started, by the run's shape.
const char* started_message (bool is_scenario, bool is_scenario_load) {
    if (is_scenario_load) {
        return "Scenario load test started";
    }
    return is_scenario ? "Collection run started" : "Load test started";
}

/**
 * POST /runs: starts a load test or a collection run.
 *
 * Returns:
 * - 202: accepted and started; the row is `pending`
 * - 400: the payload is refused, and no run row exists
 * - 409: the auth pre-flight found a credential missing
 * - 500: the run record could not be written, or the start threw
 * - 503: the daemon is draining its workers
 */
void handle_start_load_test (RouteContext& ctx,
const httplib::Request& req,
httplib::Response& res) {
    // Depth-checked before anything copies or dumps the payload, `snapshot_body`
    // below first.
    auto parsed =
    parse_request_json (req.body, "invalid_run_config", refuse_overdeep_run_data);
    if (!parsed) {
        refuse_request_body (res, "POST /runs", parsed.error ());
        return;
    }
    nlohmann::json json = std::move (*parsed);
    erase_null_members (json);
    // What the stored snapshot is built from: the body as sent, less the
    // nulls, taken before validation normalizes anything in `json`.
    const std::string snapshot_body = json.dump ();

    // A scenario run states its work as an ordered collection, so it has no
    // single method/url to require and states its iteration count in the block;
    // `validate_load_request`'s two checks are for the single-request payload,
    // and `resolve_scenario` checks the block's own fields.
    const bool is_scenario = json.contains ("scenario") && !json["scenario"].is_null ();
    // A `scenario` with a load `mode` is a load-mode scenario: the same plan,
    // driven by virtual users on the event loop instead of one sequence through
    // the client. Without a mode it is the design-mode collection run, a
    // meaning the absent `mode` must keep.
    const bool is_scenario_load = vayu::core::is_scenario_load_run (json);

    RunOrigin origin;
    std::optional<vayu::http::TargetPolicy> target_policy;
    if (auto rejection = validate_load_request (
        ctx, json, is_scenario, is_scenario_load, origin, target_policy)) {
        res.status = rejection->status;
        res.set_content (rejection->body.dump (), "application/json");
        return;
    }

    const vayu::http::TargetPolicy* target_policy_ptr =
    target_policy ? &*target_policy : nullptr;

    std::shared_ptr<const vayu::core::ScenarioExecution> scenario_execution;
    nlohmann::json scenario_manifest;
    if (is_scenario) {
        if (auto rejection = resolve_and_validate_run_scenario (ctx, json, is_scenario_load,
            target_policy_ptr, scenario_execution, scenario_manifest)) {
            res.status = rejection->status;
            res.set_content (rejection->body.dump (), "application/json");
            return;
        }
    }

    std::string run_id = vayu::utils::generate_id ("run_");
    vayu::db::Run run;
    run.id = run_id;
    // A scenario load run is a load run whose target is a sequence: it
    // publishes metric ticks, reports RPS and percentiles and stores no
    // per-step `results`, so `Scenario`, which makes the app render a step list
    // instead of the dashboard, would be the wrong view. Its step breakdown
    // reaches the report through the summary's `scenario` object, and the
    // snapshot's manifest still names the collection.
    run.type   = (is_scenario && !is_scenario_load) ? vayu::RunType::Scenario :
                                                      vayu::RunType::Load;
    run.status = vayu::RunStatus::Pending;
    // Ahead of the snapshot, which reads the scopes these name, and of the
    // credential plan below, which reads the signing key they answer.
    const auto collection_id = read_run_scope (ctx.db, json, run);
    if (!collection_id) {
        vayu::utils::log_warning ("http", "POST /runs - " + collection_id.error ());
        send_error (res, 400, collection_id.error ());
        return;
    }
    if (auto refusal = resolve_run_signing_key (ctx.db, run, *collection_id, json)) {
        vayu::utils::log_warning ("http", "POST /runs - " + *refusal);
        send_error (res, 400, *refusal, "invalid_run_config");
        return;
    }

    // The rows a single-request run binds (#993), validated and
    // credential-planned here as the scenario block is resolved here: an
    // unreadable set leaves no run row.
    auto load_data = read_load_data_set (json, load_data_limits (ctx.db), is_scenario);
    // Every file the run's request can send, checked and read once here too,
    // for the same reason: a file the run cannot send leaves no run row.
    std::shared_ptr<vayu::http::FilePlan> load_files;
    std::optional<nlohmann::json> load_body_file;
    if (auto refusal = refuse_load_inputs (
        ctx, json, is_scenario, load_data, load_files, load_body_file)) {
        vayu::utils::log_warning ("http", "POST /runs - " + refusal->first);
        send_error (res, 400, refusal->first, refusal->second);
        return;
    }

    run.origin        = std::move (origin.kind);
    run.origin_client = std::move (origin.client);
    const auto max_snapshot_body_bytes =
    static_cast<size_t> (ctx.db.get_config_int ("maxTraceBodyBytes",
    static_cast<int> (vayu::core::constants::json::MAX_TRACE_BODY_BYTES)));
    // Issue #1488 - see compression_scope_of's doc comment.
    const auto header_policy = vayu::http::resolve_default_header_policy (
    ctx.db, compression_scope_of (run.type));
    run.config_snapshot = run_config_snapshot (snapshot_body, is_scenario,
    scenario_manifest, load_data.set.get (), header_policy, max_snapshot_body_bytes,
    run_snapshot_secrets (ctx.db, run, *collection_id, scenario_execution.get ()));
    // The file a single-request run sends, as the plan checked it: name, size
    // and digest for the report (`metadata.bodyFile`), never the bytes.
    run.config_snapshot = with_body_file (std::move (run.config_snapshot), load_body_file);
    seed_run_times (run, now_ms ());

    log_started_run (json, run, run_id, scenario_execution.get ());

    if (!is_scenario) {
        if (auto rejection = preflight_run_auth (ctx, json, target_policy_ptr)) {
            res.status = rejection->status;
            // The provider's reply is quoted, so a strict dump could throw.
            res.set_content (rejection->body.dump (-1, ' ', false,
                             nlohmann::json::error_handler_t::replace),
            "application/json");
            return;
        }
    }

    try {
        ctx.db.create_run (run);
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "POST /runs - Failed to create run: " + std::string (e.what ()));
        send_error (res, 500, "Couldn't create the run record");
        return;
    }

    // A load-mode scenario takes the load path (event loop, metrics thread,
    // drain, summary) with the virtual-user state machine in place of a
    // LoadStrategy. Only the sequential design-mode runner needs, and gets, the
    // cookie jar.
    const auto start = [&] () {
        return (is_scenario && !is_scenario_load) ?
        ctx.run_manager.start_scenario_run (
        run_id, json, scenario_execution, ctx.db, ctx.cookie_jar) :
        ctx.run_manager.start_run (run_id, json, ctx.db,
        is_scenario_load ? scenario_execution : nullptr, std::move (load_data.set),
        std::move (load_data.auth), std::move (load_files));
    };
    if (auto refusal = start_created_run (ctx.db, run_id, start)) {
        res.status = refusal->status;
        res.set_content (refusal->body.dump (), "application/json");
        return;
    }

    nlohmann::json response;
    response["runId"]   = run_id;
    response["status"]  = to_string (vayu::RunStatus::Pending);
    response["message"] = started_message (is_scenario, is_scenario_load);

    res.status = 202;
    res.set_content (response.dump (), "application/json");
}

} // namespace

void register_execution_routes (RouteContext& ctx) {
    ctx.server.Post ("/execute", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_execute_request (ctx, req, res);
    });
    ctx.server.Post ("/runs", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_start_load_test (ctx, req, res);
    });
}

} // namespace vayu::http::routes
