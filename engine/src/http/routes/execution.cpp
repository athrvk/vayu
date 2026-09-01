/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/execution.cpp
 * @brief Request execution routes (Design mode & Load test)
 *
 * HTTP Status Code Philosophy:
 * - Engine returns 200 if it successfully processed the request (regardless of server response)
 * - Engine returns 400 for malformed requests (invalid JSON, missing fields)
 * - Engine returns 500 only for internal engine failures (should be rare)
 * - Server's HTTP status code is always in the response body, never translated to engine status
 */

#include <array>
#include <cmath>
#include <optional>
#include <regex>
#include <string>

#include "vayu/core/constants.hpp"
#include "vayu/core/monitor.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/schema_validation.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/status.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

// Resolve the effective HTTP request timeout for design-mode POST /request.
// An explicit per-request "timeout" wins; otherwise fall back to the engine's
// user-configurable `defaultTimeout` setting (passed in by the caller) rather
// than the compile-time DEFAULT_TIMEOUT_MS, so raising the setting actually
// extends how long a slow request is allowed to run.
int resolve_request_timeout_ms (const nlohmann::json& json, int configured_default) {
    if (json.contains ("timeout") && json["timeout"].is_number ()) {
        return json["timeout"].get<int> ();
    }
    return configured_default;
}

// Resolve what a script reads as `pm.info.requestName` for a POST /execute
// payload (issue #300). Two sources, in order:
//
// 1. The payload's own `requestName`. This is the inline path: the renderer
//    sends editor state, which may be unsaved or a detached replay copy, and
//    therefore carries a name no stored row has. `POST /compose` puts the
//    stored name here too on its by-id path, so a composed payload arrives
//    already carrying it.
// 2. The row named by `requestId`, for a caller that linked a saved request
//    without sending its name (MCP's run_request does exactly this).
//
// An empty name is not a name: it resolves to absent, so a script's
// `typeof pm.info.requestName === "undefined"` answers truthfully rather than
// seeing "". An unknown `requestId` is not an error here - the run row already
// tolerates one - it just yields no name.
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
            vayu::utils::log_warning (
            "pm.info.requestName lookup failed: " + std::string (e.what ()));
        }
    }

    return resolved;
}

// Stamp a freshly built run row's timestamps. `end_time` is seeded to
// `start_time` rather than left at its default, because a run killed by a
// daemon crash never reaches a terminal status: `reconcile_orphaned_runs`
// marks it Failed and leaves `end_time` as recorded, and the report route
// reads `end_time > 0 ? end_time : now_ms()` - so an unseeded row would
// report a duration spanning however long the daemon was down. Seeded, a
// crashed run reports a zero duration, which is honest about knowing nothing.
// Both insert sites (design and load) go through here so the invariant has one
// home; `Run::end_time` still defaults to 0 as the backstop for any future one.
void seed_run_times (vayu::db::Run& run, int64_t started_at) {
    run.start_time = started_at;
    run.end_time   = started_at;
}

// Validate and normalize the optional "httpVersion" on a POST /runs body.
// Absent leaves `json` untouched: the request's own httpVersion field, read
// like any other field by build_request/deserialize_request further down the
// pipeline, decides. This is NOT a per-run override - the request builder's
// Settings tab holds the single protocol control and it governs Send and load
// test alike. The field exists on this payload because that is how a run
// states its protocol at all, the same way it states its redirect policy, and
// because MCP's ad-hoc runs have no saved request to read one from. It never
// touches the stored request - `json` here is the handler's local copy of the
// request body, not anything persisted.
//
// Present is validated through apply_http_version_field/http_version_valid_list
// (the same helpers Task 5's CRUD routes use - see routes.hpp), so a typo'd
// protocol name is a 400 naming the field and the valid values, rather than
// deserialize_request's lenient string-to-Auto coercion, which exists to keep
// a corrupted *stored* row executable and is the wrong behavior for a
// hand-crafted /runs body.
//
// An explicit `null` is erased, making it behave exactly like an absent key,
// so this function has two outcomes rather than three.
//
// Be precise about why, because the obvious justification is wrong: there is
// no stored-request lookup in this pipeline. `build_request` deserializes the
// same POST body this function mutates, so the only `httpVersion` in play is
// the one the client sent (clients send the whole request here, the same way
// they do followRedirects/maxRedirects). The `db.get_request` calls further
// down this file read `collection_id` to persist collection variables; they
// never read `http_version`.
//
// So today, erasing and writing the seed are indistinguishable: both end at
// `Auto`, because `Request::http_version`'s default member initializer is
// `DEFAULT_HTTP_VERSION` - the very value the seed would have written. That
// equivalence is incidental, and erasing is what keeps it from becoming a bug.
// The moment a config-backed default is resolved at this layer, writing a seed
// would start pinning a concrete value onto a run that asked for none, while
// erasing keeps deferring to whatever decides later.
//
// This is also why CLAUDE.md's null-means-reset-to-default rule does not apply:
// that rule resets a *stored* field on POST/PUT of a resource, and a run has no
// stored field to reset.
//
// The validated value is written back onto `json["httpVersion"]` so it reaches
// deserialize_request as a concrete string; `null` would otherwise hit
// `.get<std::string>()` there and throw.
RouteResult normalize_run_http_version (nlohmann::json& json) {
    if (!json.contains ("httpVersion")) {
        return {};
    }
    if (json["httpVersion"].is_null ()) {
        json.erase ("httpVersion");
        return {};
    }
    // Both early returns above mean the key is present and non-null by now, so
    // the two branches of apply_http_version_field that consume `seed` are
    // unreachable from here. The argument is required by the signature; it does
    // not select behaviour at this call site.
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
 * @brief Replace a scenario run's raw `scenario` block with its step manifest.
 *
 * `sanitize_config_snapshot` strips credentials out of `auth` and keeps
 * everything else, which is not enough here: the block as sent carries the
 * `data` rows, which are user data of unknown sensitivity and are deliberately
 * never snapshotted (only their count survives, on the manifest). The manifest
 * also records the **stored** URL per step rather than the composed one, so a
 * step whose auth is `apikey` with `in: "query"` cannot put a live key in the
 * run store.
 *
 * A snapshot that is not JSON (which `sanitize_config_snapshot` passes through
 * verbatim) is left alone rather than being rebuilt from nothing - there is no
 * request in it to describe.
 *
 * Non-static: run_row_seed_test.cpp drives it directly, because "the composed
 * plan is never persisted" is a security property and deserves a test that does
 * not need a run to exist.
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

/**
 * @brief Read `POST /execute`'s `transient` flag (issue #382).
 *
 * A transient execution runs the request in full - same composition, same
 * cookie jar, same scripts, same response - but records nothing: no run row, no
 * result trace, no retention prune. It exists because GraphQL schema
 * introspection is a background fetch, not something the user sent: filing it
 * as a design run put runs nobody made into History, snapshotted the
 * post-auth request headers into a result trace on disk, and evicted real runs
 * through the count-based retention prune.
 *
 * Absent and `null` both mean `false`: recording is the default, and only a
 * caller that explicitly asks opts out. A present non-boolean is a **400**
 * rather than a silent `false` - a client that sends `"true"` is asking for
 * privacy it would not get, and that must not fail quietly. (This is stricter
 * than `allowScriptRequests`, whose non-boolean-means-no is safe in the other
 * direction: it denies a capability rather than granting exposure.)
 *
 * Non-static: transient_execute_test.cpp drives it directly, the suite having
 * no in-process HTTP route harness.
 */
TransientFlag read_transient_flag (const nlohmann::json& json) {
    TransientFlag flag;
    auto field = json.find ("transient");
    if (field == json.end () || field->is_null ()) {
        return flag;
    }
    if (!field->is_boolean ()) {
        flag.ok    = false;
        flag.error = "'transient' must be a boolean";
        return flag;
    }
    flag.value = field->get<bool> ();
    return flag;
}

/**
 * @brief Read a payload's `stream` flag and its caps (issue #573), for both
 *        `POST /execute` and - since #576 - `POST /runs`.
 *
 * Non-static: sse_stream_test.cpp drives it directly, the suite having no
 * in-process HTTP route harness. See routes.hpp for the refusal set.
 */
StreamFlag read_stream_flag (const nlohmann::json& json) {
    StreamFlag flag;

    // A cap on a non-streaming payload is refused too. It reads as a bound the
    // caller expects to apply, and silently ignoring it is how an unbounded run
    // gets mistaken for a capped one.
    const auto read_cap = [&json, &flag] (const char* key, int64_t low,
                          int64_t high, std::optional<int64_t>& out) {
        const auto field = json.find (key);
        if (field == json.end () || field->is_null ()) {
            return true;
        }
        if (!field->is_number_integer ()) {
            flag.ok    = false;
            flag.error = std::string ("'") + key +
            "' must be an integer (got " + field->type_name () + ")";
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
    };

    const auto field = json.find ("stream");
    if (field != json.end () && !field->is_null ()) {
        if (!field->is_boolean ()) {
            flag.ok = false;
            // Stricter than a silent false, and for the loudest of the reasons:
            // a caller that sends `"true"` would get a buffered send and wait
            // for a response the endpoint never finishes.
            flag.error = "'stream' must be a boolean (got " +
            std::string (field->type_name ()) + ")";
            return flag;
        }
        flag.value = field->get<bool> ();
    }

    namespace sse_limits = vayu::core::constants::sse;
    if (!read_cap ("maxStreamDurationMs", sse_limits::MIN_STREAM_DURATION_MS,
        sse_limits::STREAM_DURATION_MS_CEILING, flag.max_duration_ms) ||
    !read_cap ("maxStreamEvents", sse_limits::MIN_STREAM_EVENTS,
    sse_limits::STREAM_EVENTS_CEILING, flag.max_events)) {
        return flag;
    }

    if (!flag.value) {
        if (flag.max_duration_ms || flag.max_events) {
            flag.ok = false;
            flag.error =
            "'maxStreamDurationMs' and 'maxStreamEvents' apply to a "
            "streaming request only - set 'stream': true, or drop them";
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

/**
 * @brief Read `POST /execute`'s `data` row (issue #601).
 *
 * Non-static: send_with_row_test.cpp drives it directly, the suite having no
 * in-process HTTP route harness. See routes.hpp for what the field means.
 */
DataRow read_data_row (const nlohmann::json& json, size_t max_bytes) {
    DataRow row;
    const auto field = json.find ("data");
    if (field == json.end () || field->is_null ()) {
        return row;
    }
    if (!field->is_object ()) {
        row.ok = false;
        // Named as an object of name/value pairs rather than "an object",
        // because the near miss is an *array* - the shape `scenario.data` takes
        // - and a caller that sent one has to hear that a single send binds one
        // row, not a set.
        row.error = "'data' must be an object of name/value pairs (got " +
        std::string (field->type_name ()) +
        "). A single send binds one row; a set of rows is a collection run.";
        return row;
    }

    // The same bound a run's whole data set is measured against, applied to the
    // one row this endpoint takes. Measured before the row is kept, so an
    // oversized payload is refused rather than held.
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

/**
 * @brief How a send-with-row resolves its credentials (issue #642).
 *
 * Non-static: send_with_row_test.cpp drives it directly. See routes.hpp for the
 * contract and for why the ordinary send is untouched.
 */
SendRowAuth plan_send_row_auth (const nlohmann::json& json,
const vayu::http::BoundColumnNames& bound_columns) {
    SendRowAuth out;
    const auto auth_json = json.value ("auth", nlohmann::json ());
    // Asked of the payload's own JSON before anything is parsed, and this is
    // why: `parse_auth` warns on an unresolved `inherit`, and the build is
    // about to parse the very same block, so a second parse would double every
    // such warning on the ordinary send. A block spelling no token at all -
    // which is every ordinary send - is answered here, unparsed, exactly as the
    // `has_row` test used to answer it (issue #1055).
    if (!vayu::core::first_deferrable_token_in (auth_json, bound_columns)) {
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
    if (!out.credentials.empty ()) {
        out.resolution = vayu::http::AuthResolution::Defer;
    }
    return out;
}

/**
 * @brief Read `POST /runs`' top-level `data` rows (issue #993).
 *
 * Non-static: load_data_test.cpp drives it directly, the suite having no
 * in-process HTTP route harness. See routes.hpp for what the field means.
 */
LoadDataRows read_load_data_set (const nlohmann::json& json,
const vayu::core::ScenarioLimits& limits,
bool is_scenario) {
    LoadDataRows out;
    const auto field       = json.find ("data");
    const bool carries_set = field != json.end () && !field->is_null ();

    // A collection run states its rows inside the block that names the
    // collection, and the two are bound differently - one row per iteration
    // shared by every step there, one per submission here. Refused rather than
    // silently ignored: a caller that sent rows and had them dropped would read
    // a run of literal `{{data.*}}` tokens as the feature working.
    if (carries_set && is_scenario) {
        out.ok    = false;
        out.error = "'data' is the single-request form of a data set. A "
                    "collection run states its rows as 'scenario.data', where "
                    "one row is bound per iteration and shared by every step - "
                    "move them there, or drop the 'scenario' block.";
        return out;
    }

    std::unique_ptr<vayu::core::LoadDataSet> set;
    if (carries_set) {
        set = std::make_unique<vayu::core::LoadDataSet> ();
        // The same reader the scenario block goes through, so the two shapes
        // cannot come to disagree about what a row is or which limit refuses
        // it.
        if (auto reason =
            vayu::core::read_data_rows (*field, limits, "data", set->rows)) {
            out.ok    = false;
            out.error = *reason;
            return out;
        }
        set->bound_columns = vayu::core::bound_columns_of (set->rows);
    }

    // A scenario load run's credentials are its steps', resolved when the plan
    // was: there is no single request here whose build could defer, and asking
    // would refuse a top-level oauth2 block no step uses.
    if (is_scenario) {
        out.set = std::move (set);
        return out;
    }

    // How the credentials resolve, decided here because it is the *build* that
    // would otherwise encode them out of reach - the same call, and the same
    // reasoning, as a send that carries one row (issue #642). The refusal it
    // can carry is an oauth2 config carrying a token deferral would bind, which
    // no deferral can serve.
    //
    // Asked of every run rather than only of one carrying rows (issue #1055):
    // a credential spelling `{{$vu}}` defers without a set behind it, and it is
    // this call that finds out. A run whose credentials spell no token parses
    // nothing here and resolves its auth in the build, as it always did.
    auto row_auth = plan_send_row_auth (
    json, set ? set->bound_columns : vayu::http::BoundColumnNames{});
    if (!row_auth.ok) {
        out.ok    = false;
        out.error = std::move (row_auth.error);
        return out;
    }
    out.auth.auth        = std::move (row_auth.auth);
    out.auth.credentials = std::move (row_auth.credentials);
    out.set              = std::move (set);
    return out;
}

/**
 * @brief Replace a single-request run's `data` rows with their count in the
 *        stored snapshot (issue #993).
 *
 * `sanitize_config_snapshot` strips credentials out of `auth` and keeps
 * everything else, which is not enough here for the reason `scenario_snapshot`
 * exists: the rows are user data of unknown sensitivity and are deliberately
 * never snapshotted. `dataRowCount` is what survives, exactly as it does on a
 * scenario manifest, so a stored run still says it was data-driven and how
 * large the set was.
 *
 * A snapshot that is not JSON (which `sanitize_config_snapshot` passes through
 * verbatim) is left alone - there is nothing in it to rewrite.
 *
 * Non-static: run_row_seed_test.cpp declares and drives it, the way it does
 * `scenario_snapshot`, because "the rows are never persisted" is a privacy
 * property and deserves a test that does not need a run to exist.
 */
std::string load_data_snapshot (const std::string& sanitized, size_t row_count) {
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
    parsed["dataRowCount"] = row_count;
    return parsed.dump ();
}

namespace {

/**
 * @brief The stored `config_snapshot` for a run, with whatever this run's shape
 *        deliberately keeps out of it already out (issue #993).
 *
 * The two rewrites are exclusive by construction - a scenario run states its
 * work as a collection and refuses a `data` block beside it - so which one
 * applies is a property of the payload rather than a decision the caller makes.
 * It lives here rather than inline in `handle_start_load_test` because both
 * arms are the same rule (a shape whose payload carries user data of unknown
 * sensitivity is stored described rather than verbatim), and the route reads
 * better asking for the snapshot than spelling the choice out a third time.
 */
std::string run_config_snapshot (const std::string& body,
bool is_scenario,
const nlohmann::json& scenario_manifest,
const vayu::core::LoadDataSet* data) {
    std::string sanitized = vayu::json::sanitize_config_snapshot (body);
    if (is_scenario) {
        return scenario_snapshot (sanitized, scenario_manifest);
    }
    if (data != nullptr && !data->rows.empty ()) {
        // The rows out, their count in - the same rule the scenario manifest
        // keeps, and for the same reason (issue #993).
        return load_data_snapshot (sanitized, data->rows.size ());
    }
    return sanitized;
}

/**
 * @brief The row-set limits a single-request run's `data` block is held to.
 *
 * The same two config rows the scenario path reads, so one payload cannot be
 * refused for a size the other would accept.
 */
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

// Build the final response JSON with script results
nlohmann::json build_response_json (const vayu::Response& response,
const nlohmann::json& scripts,
const std::optional<vayu::core::ValidationVerdict>& validation) {
    nlohmann::json response_json = vayu::json::serialize (response);
    // The schema verdict (#628), on the same terms as the script keys below:
    // one builder, and the stored trace gets the *same* object, so a restored
    // response cannot show a different verdict than the live one did. Absent
    // entirely for an unbound collection - `std::nullopt` here is the "never
    // judged against a contract" state, not a failure.
    if (validation) {
        response_json["validation"] = vayu::core::build_validation_payload (*validation);
    }
    // Merged in at the top level, which is where every client has read these
    // four keys since before there was a second placement for them. The node
    // arrives built, because the caller hands the *same* object to
    // `record_design_result` for the trace's `scripts` key - one object, two
    // homes, so a key can never mean one thing live and another restored.
    response_json.update (scripts);
    return response_json;
}

// One numeric field of a run config: what it is called on the wire, and the
// closed interval it must fall in. Kept as data so the four checks below read
// as a table rather than four hand-written branches that can drift apart.
struct NumericRunField {
    const char* key;
    int64_t min;
    int64_t max;
    const char* why; // appended to the message, explains the bound
};

// Reject a numeric field that is present but of the wrong JSON type or outside
// its range. Absent is always fine - every field has a default.
std::optional<std::string> check_numeric_field (const nlohmann::json& config,
const NumericRunField& field) {
    if (!config.contains (field.key) || config[field.key].is_null ()) {
        return std::nullopt;
    }
    const auto& value = config[field.key];
    if (!value.is_number ()) {
        return std::string ("'") + field.key + "' must be a number (got " +
        std::string (value.type_name ()) + ")";
    }
    // Read as a double first: an integer read of a fractional or huge value is
    // itself undefined, and this is the guard that has to be total.
    const double raw = value.get<double> ();
    if (!std::isfinite (raw) || raw < static_cast<double> (field.min) ||
    raw > static_cast<double> (field.max)) {
        return std::string ("'") + field.key + "' must be between " +
        std::to_string (field.min) + " and " + std::to_string (field.max) +
        " (got " + value.dump () + "). " + field.why;
    }
    return std::nullopt;
}

// Reject a duration-shaped field that is present but not a positive magnitude
// with an optional ms/s/m/h unit. Absent or null is always fine - every such
// field has a default. Shared by `duration` and `stepDuration` rather than
// copied, so the two cannot drift into accepting different spellings.
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
    // Accept an optional unit: the unit-aware parser is #126's, and a bare
    // "60" is what a client that never read the docs sends. This only has to
    // separate "parses to something positive" from "wedges the run".
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
    // The regex already proved group 1 is a plain decimal, so `stod` cannot
    // fail on it - but this guard exists precisely because a conversion threw
    // somewhere nobody was catching, so it stays total here too.
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

} // namespace

/**
 * @brief Build the four script-result keys - see routes.hpp for why one builder
 *        serves both the live response body and the stored trace.
 */
nlohmann::json build_script_result_node (const vayu::ScriptResult& pre_script_result,
const vayu::ScriptResult& post_script_result) {
    nlohmann::json node = nlohmann::json::object ();

    /*
     * Both scripts' assertions, each carrying the script that made it.
     *
     * This listed the post-request script's alone, on the reading that "a
     * pre-request script runs before there is anything to assert about". That
     * is true of the *response* and not of everything a script asserts: a
     * pre-request script may call `pm.sendRequest`, and asserting on what came
     * back - a token fetch that failed, a fixture that is not there - is the
     * one place to catch it before the request goes out. `pm.test` is bound in
     * both phases and has always recorded there, and `describe_failed_tests`
     * fails a scenario step on a pre-request assertion, so listing the post
     * phase alone left a step failed by an assertion no surface could name
     * (issue #810).
     *
     * `source` is the same field `consoleLogs` carries below, spelled the same
     * two ways, because it answers the same question about the same pair of
     * scripts. Order is execution order - pre before test - so the list reads
     * as the run happened.
     */
    nlohmann::json test_results = nlohmann::json::array ();
    const auto append_tests     = [&test_results] (const char* source,
                              const std::vector<vayu::TestResult>& tests) {
        for (const auto& test : tests) {
            nlohmann::json test_json;
            test_json["name"]   = test.name;
            test_json["passed"] = test.passed;
            test_json["source"] = source;
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
     * Combine console output from both scripts.
     *
     * `source` is a field rather than the `"[pre] "` text prefix this used to
     * carry: the prefix was indistinguishable from a script that logged a line
     * beginning with those six characters, and adding a second prefix for the
     * level would have doubled that ambiguity instead of removing it.
     */
    nlohmann::json all_console_output = nlohmann::json::array ();
    const auto append = [&all_console_output] (const char* source,
                        const std::vector<vayu::ConsoleEntry>& entries) {
        for (const auto& entry : entries) {
            all_console_output.push_back ({ { "source", source },
            { "level", vayu::to_string (entry.level) }, { "message", entry.message } });
        }
    };
    append ("pre", pre_script_result.console_output);
    append ("test", post_script_result.console_output);
    if (!all_console_output.empty ()) {
        node["consoleLogs"] = all_console_output;
    }

    // Add script errors if any
    if (!pre_script_result.success && !pre_script_result.error_message.empty ()) {
        node["preScriptError"] = pre_script_result.error_message;
    }
    if (!post_script_result.success && !post_script_result.error_message.empty ()) {
        node["postScriptError"] = post_script_result.error_message;
    }

    return node;
}

/**
 * @brief Record a finished design execution against its run row.
 *
 * Declared in routes.hpp. Every `POST /execute` call site - the auth-failure
 * path, the completed-exchange path and the streaming worker's completion
 * callback - goes through here, so "transient leaves no trace" is decided in
 * exactly one place rather than guarded three times at the call sites.
 *
 * Non-static: transient_execute_test.cpp drives it against a real database,
 * the suite having no in-process HTTP route harness.
 */
void record_design_result (vayu::db::Database& db,
const std::optional<std::string>& run_id,
const vayu::Request& request,
const vayu::Response& response,
const StreamRecord* stream,
const std::optional<vayu::core::ValidationVerdict>& validation,
const nlohmann::json& scripts) {
    if (!run_id) {
        return;
    }
    try {
        const bool has_error = response.has_error ();

        vayu::db::Result db_result;
        db_result.run_id      = *run_id;
        db_result.timestamp   = now_ms ();
        db_result.status_code = response.status_code;
        db_result.status_text = response.status_text;
        db_result.latency_ms  = response.timing.total_ms;
        db_result.error       = has_error ? response.error_message : "";

        // Build the full-fidelity trace, then cap the request/response bodies at
        // the configured limit so one large exchange cannot bloat the DB forever.
        // When a body is cut, cap_trace_bodies records bodyTruncated/bodyBytes.
        nlohmann::json trace = build_result_trace (request, response);
        const auto max_trace_body_bytes =
        static_cast<size_t> (db.get_config_int ("maxTraceBodyBytes",
        static_cast<int> (vayu::core::constants::json::MAX_TRACE_BODY_BYTES)));
        vayu::json::cap_trace_bodies (trace, max_trace_body_bytes);

        // Added *after* the body cap deliberately: `cap_trace_bodies` walks the
        // request/response body nodes and does not reach this one, so the
        // events list carries its own cap, applied when it was built
        // (`stream_trace_node`). Putting it here rather than before makes that
        // impossible to misread as covered.
        // The verdict the live response carried, stored verbatim rather than
        // recomputed at restore time: `responseFromRunResult` and
        // `responseFromExecuteResult` are the named copy-does-not-receive-the-fix
        // pair, and a second computation here is exactly how they would drift.
        if (validation) {
            trace["validation"] = vayu::core::build_validation_payload (*validation);
        }

        // Every design send that ran scripts, not only a streaming one (#725):
        // a buffered send's results used to reach the live body and stop there,
        // so a restored Tests tab could not tell "passed" from "never ran".
        // Only when the run had scripts at all - an empty node would put a
        // Tests pane's worth of nothing on every stored send.
        if (scripts.is_object () && !scripts.empty ()) {
            trace["scripts"] = scripts;
        }

        if (stream) {
            trace["events"] = stream->events;
        }

        // A capped body may split a UTF-8 sequence, and the raw response body can
        // be arbitrary bytes - dump with error_handler_t::replace so a lone
        // continuation byte becomes U+FFFD instead of throwing (import.cpp uses
        // the same guard).
        db_result.trace_data =
        trace.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
        db.add_result (db_result);

        // A stream names its own terminal status: one the user stopped is
        // `Stopped`, which neither the response nor the error flag can say.
        vayu::RunStatus status = vayu::RunStatus::Completed;
        if (stream) {
            status = stream->status;
        } else if (has_error) {
            status = vayu::RunStatus::Failed;
        }
        db.update_run_status_with_retry (*run_id, status);

        // A design run reached a terminal status - trim the run history so
        // per-request clicks do not accumulate forever (retention knobs, or 0
        // to disable). Best-effort: a prune failure must not fail the request.
        try {
            db.prune_runs_configured ();
        } catch (const std::exception& e) {
            vayu::utils::log_warning ("Run pruning failed: " + std::string (e.what ()));
        }

    } catch (const std::exception& e) {
        vayu::utils::log_error ("Failed to save result: " + std::string (e.what ()));
        try {
            db.update_run_status_with_retry (*run_id, vayu::RunStatus::Failed);
        } catch (...) {
            vayu::utils::log_error (
            "Failed to update run status after save error");
        }
    }
}

/**
 * @brief Validate a POST /runs config before the run row is created.
 *
 * Every field below is read downstream with `config.value (...)` and cast to
 * `size_t` or fed to a modulo, in code that runs on a detached worker thread
 * with no `catch` above it. Out of range there is not a bad run, it is a dead
 * daemon: `success_sample_rate: 0` is `% 0` (SIGFPE), `concurrency: -1` becomes
 * ~1.8e19 eagerly pre-allocated curl handles, `timeout: 0` leaves transfers
 * that never expire, and a JSON-number `duration` throws out of `RunContext`'s
 * constructor *after* the run row exists, stranding it `pending` forever.
 *
 * So this runs in the route, before `create_run`: a rejected request must leave
 * no trace. Non-static - `run_config_validation_test.cpp` drives it directly.
 *
 * @return The reason the config is invalid, or `std::nullopt` if it is usable.
 */
std::optional<std::string> validate_run_config (const nlohmann::json& config,
const vayu::core::MonitorLimits& monitor_limits) {
    if (!config.is_object ()) {
        return "Run config must be a JSON object";
    }

    // `transient` belongs to `POST /execute` alone (issue #382). A load or
    // scenario run *is* its run row - the run id is the return value, and the
    // live-metrics stream, the report and the scenario step store all key off
    // it - so there is nothing coherent for the flag to mean here. Rejected
    // rather than ignored: a caller that sends it believes this run will leave
    // no trace, and it is about to leave a large one.
    if (config.contains ("transient") && !config["transient"].is_null ()) {
        return "'transient' is not valid on a run - it applies to POST "
               "/execute "
               "only, because a run is identified by the row it creates";
    }

    // `stream` and its caps are read through the *same* parser `POST /execute`
    // uses (issue #576): one description of how a stream is declared, so the
    // two endpoints cannot drift on the spelling, the types or the ranges. It
    // was refused outright here through phase 3 (#573) because a load run's
    // completion accounting has no place for a response that never ends - what
    // changed is that a load stream now always ends, by a cap resolved below.
    //
    // The `transient` rule inside that parser is unreachable from here: a run
    // carrying `transient` was already rejected above.
    if (const auto stream = read_stream_flag (config); !stream.ok) {
        return stream.error;
    }

    // The duration-shaped fields are the only non-numeric ones here, and the
    // only ones whose bad value throws rather than miscomputes: they are read
    // as strings by `duration_field_ms`, which rejects an unknown unit at run
    // time - far too late, since the run row already exists by then.
    for (const char* key : { "duration", "stepDuration" }) {
        if (auto reason = check_duration_field (config, key)) {
            return reason;
        }
    }

    namespace limits  = vayu::core::constants::run_config;
    const auto fields = std::to_array<NumericRunField> ({
    { "success_sample_rate", 1, 100000, "It is a sampling period (keep 1 in N), and 0 is a division by zero." },
    { "response_sample_rate", 1, 100000, "It is a sampling period (keep 1 in N), and 0 is a division by zero." },
    { "max_response_samples", 0, limits::MAX_RESPONSE_SAMPLES,
    "Each retained sample holds a full response body." },
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
    { "timeout", 1, 86400000,
    "A transfer with no timeout never completes, so the run can never "
    "reach "
    "a terminal status." },
    });
    for (const auto& field : fields) {
        if (auto reason = check_numeric_field (config, field)) {
            return reason;
        }
    }

    // Each is read as a boolean only after the run row exists - by RunContext's
    // constructor via `config.value (..., bool)`, which throws `type_error.302`
    // on a string, or by the scenario runner - which is the stranded-`pending`
    // failure this whole function is here to prevent. Absent and `null` both
    // mean "use the default", matching the null-vs-absent rule the resource
    // routes follow.
    for (const char* key : { "phase_histograms", "save_timing_breakdown",
         "capture_response_bodies", "stream_metrics", "failOnSchemaError" }) {
        const auto it = config.find (key);
        if (it != config.end () && !it->is_null () && !it->is_boolean ()) {
            return "'" + std::string (key) + "' must be a boolean (got " +
            it->type_name () + ")";
        }
    }

    // `thresholds` is the one nested object here, so it gets its own pass
    // rather than a row in the flat table above. The rule lives with the
    // evaluator (`core/threshold_eval.cpp`), which reads the same metric table
    // - a budget this accepts is one the run will actually judge.
    if (auto reason = vayu::core::validate_thresholds (config)) {
        return reason;
    }

    // `monitor` is the other nested object, and its rule lives with the scrape
    // loop for the same reason: `core/monitor.cpp` holds one description of the
    // block, so a field this accepts is one the run will actually read. Its two
    // movable limits arrive resolved from the caller, which is what keeps this
    // function - and the core it delegates to - free of a `Database`.
    if (auto reason = vayu::core::validate_monitor_config (config, monitor_limits)) {
        return reason;
    }

    return std::nullopt;
}

namespace {
/** What `POST /execute` accepted off the wire, before any run row exists. */
struct ExecutePayload {
    nlohmann::json json;
    /// No row is recorded for this execution (issue #382).
    bool transient = false;
    StreamFlag stream;
    /// The row this send binds, if the caller named one (issue #601).
    std::optional<nlohmann::json> data_row;
    SendRowAuth row_auth;
    vayu::http::RequestBuild built;
};

/**
 * One design-mode execution, after the payload is accepted: the run row it
 * carries, the request it will send, and what the scripts around that send run
 * under. Both paths below take it.
 */
struct DesignSend {
    vayu::db::Run run;
    /// Absent for a transient execution - no row exists to record against, and
    /// every recording step keys off that.
    std::optional<std::string> run_id;
    vayu::Request request;
    std::string pre_script;
    std::string post_script;
    std::optional<std::string> script_request_name;
    std::string cookie_scope;
    vayu::runtime::ScriptConfig script_config;
    std::optional<nlohmann::json> data_row;
    StreamFlag stream;
};


/**
 * Everything `POST /execute` reads and can refuse before any run row exists.
 *
 * Each refusal here is a 400 with nothing recorded behind it - the rule the
 * whole pre-row section is ordered by: a request that could not be flagged,
 * bound or built must leave no trace of an execution that never happened.
 *
 * @return the message to answer with, already logged, or nothing.
 */
std::optional<std::string>
read_execute_payload (RouteContext& ctx, const httplib::Request& req, ExecutePayload& out) {
    // Parse and validate request
    nlohmann::json json;
    try {
        json = nlohmann::json::parse (req.body);
    } catch (const nlohmann::json::exception& e) {
        vayu::utils::log_warning (
        "POST /execute - Invalid JSON: " + std::string (e.what ()));
        return "Invalid JSON: " + std::string (e.what ());
    }

    // Read before anything is built or written, with the other pre-row
    // validation: a malformed flag must be a 400, not a run the caller
    // believed would leave no trace.
    const auto transient = read_transient_flag (json);
    if (!transient.ok) {
        vayu::utils::log_warning ("POST /execute - " + transient.error);
        return transient.error;
    }

    // Beside the transient flag and for the same reason: `stream` changes
    // the execution model, so a malformed one must be a 400 before anything
    // is built or written rather than a send the caller did not ask for.
    auto stream = read_stream_flag (json);
    if (!stream.ok) {
        vayu::utils::log_warning ("POST /execute - " + stream.error);
        return stream.error;
    }

    // The row this send binds, if the caller named one (issue #601). Read
    // here with the other pre-row validation for the reason the bind below
    // is also placed before the run record: a request whose tokens could
    // not bind must leave no trace of an execution that never happened.
    auto data_row = read_data_row (json,
    static_cast<size_t> (ctx.db.get_config_int ("maxScenarioDataBytes",
    static_cast<int> (vayu::core::constants::scenario::MAX_DATA_BYTES))));
    if (!data_row.ok) {
        vayu::utils::log_warning ("POST /execute - " + data_row.error);
        return data_row.error;
    }

    // How the credentials resolve, decided before the build because it is
    // the build that would otherwise encode them out of reach (issue #642).
    // The refusal it can carry - an oauth2 config with a data token - is a
    // 400 here, beside the row's own, and for the same reason: nothing has
    // been recorded or sent yet.
    // The one row's own columns, exactly as `bind_data_row` reads them below:
    // a credential spelled `{{username}}` binds from the row for the same
    // reason one spelled `{{data.username}}` does (issue #1007).
    const auto row_columns = data_row.value ?
    vayu::core::bound_columns_of (*data_row.value) :
    vayu::http::BoundColumnNames{};
    auto row_auth          = plan_send_row_auth (json, row_columns);
    if (!row_auth.ok) {
        vayu::utils::log_warning ("POST /execute - " + row_auth.error);
        return row_auth.error;
    }

    // Build the request once: deserialize + timeout + auth. A malformed
    // payload fails here (before any run record is created); an auth
    // failure is surfaced after the run exists (below). Credentials
    // carrying a `{{data.*}}` are the one case the build leaves alone - the
    // bind below applies them once the row has reached them.
    const int request_timeout_ms = resolve_request_timeout_ms (json,
    ctx.db.get_config_int ("defaultTimeout", vayu::core::constants::server::DEFAULT_TIMEOUT_MS));
    auto built =
    vayu::http::build_request (json, &ctx.db, request_timeout_ms, row_auth.resolution);
    if (built.parse_failed) {
        vayu::utils::log_warning ("POST /execute - Invalid request format");
        return built.error_message;
    }

    // Bind the row into what composition left written, before anything is
    // recorded or sent. A failure here is a `400` with the binder's own
    // message - it names the token, the row and the row's columns, which is
    // what lets the request be fixed without opening the file - and the
    // partially bound request is discarded rather than sent
    // (scenario_data.hpp). Nothing runs, so nothing is recorded: the
    // refusal precedes the run row exactly as the flag checks above do.
    // The identity binds here too, and for every send rather than only for one
    // carrying a row (issue #994): a single send is a run of one, so `{{$vu}}`
    // and `{{$iteration}}` answer `1` and `0` - the numbers this same request
    // would carry as the first iteration of a load run - instead of reaching
    // the wire written as they stand. The scan costs a request that spells
    // neither one walk of its fields, at the design path's rate rather than a
    // load run's.
    const vayu::core::IterationBinding binding{ data_row.value ? &*data_row.value : nullptr,
        /*row_index=*/0, vayu::core::IterationIdentity{} };
    // Both halves through the one binder both load paths drive, rather than the
    // two calls and the row test this used to spell itself: the order is the
    // whole of what makes a deferred credential correct, and a second copy of
    // it here would be a copy that stops receiving that one's fixes. The
    // credentials half is a no-op for the ordinary send, whose auth the build
    // already applied.
    auto bound = vayu::core::bind_iteration (built.request,
    vayu::core::tokenize_bindable_fields (built.request), row_auth.auth,
    row_auth.credentials, binding);
    if (!bound.ok) {
        vayu::utils::log_warning ("POST /execute - " + bound.error);
        return bound.error;
    }
    out.json      = std::move (json);
    out.transient = transient.value;
    out.stream    = std::move (stream);
    out.data_row  = std::move (data_row.value);
    out.row_auth  = std::move (row_auth);
    out.built     = std::move (built);
    return std::nullopt;
}

/**
 * The run row this execution carries, and the persisted half of it.
 *
 * Built even for a transient execution, because it is also how the handler
 * carries scope: `load_script_variable_scopes` and `persist_script_variables`
 * read its `request_id` / `environment_id`, and the cookie scope comes from the
 * same field. Only the *persisted* half - the id, the config snapshot, the
 * create - is conditional, so a transient execution resolves variables and
 * cookies exactly as a recorded one does.
 *
 * @return the message to answer 400 with, already logged, or nothing.
 */
std::optional<std::string> build_design_send (RouteContext& ctx,
const httplib::Request& req,
const ExecutePayload& payload,
DesignSend& send) {
    const nlohmann::json& json = payload.json;

    // Extract scripts
    send.pre_script  = vayu::http::read_pre_request_script (json);
    send.post_script = vayu::http::read_post_request_script (json);

    // The run row. Built even for a transient execution, because it is also
    // how this handler carries scope: `load_script_variable_scopes` and
    // `persist_script_variables` read its `request_id` / `environment_id`,
    // and the cookie scope below comes from the same field. Only the
    // *persisted* half - the id, the config snapshot, the create - is
    // conditional, so a transient execution resolves variables and cookies
    // exactly as a recorded one does.
    send.run.type   = vayu::RunType::Design;
    send.run.status = vayu::RunStatus::Running;
    seed_run_times (send.run, now_ms ());

    if (json.contains ("requestId") && !json["requestId"].is_null ()) {
        send.run.request_id = json["requestId"].get<std::string> ();
    }
    if (json.contains ("environmentId") && !json["environmentId"].is_null ()) {
        send.run.environment_id = json["environmentId"].get<std::string> ();
    }

    // What the scripts below read as `pm.info.requestName`. Resolved here,
    // with the rest of the payload validation, so a malformed field is a
    // 400 before any run row exists.
    auto resolved_name = resolve_script_request_name (ctx.db, json, send.run.request_id);
    if (!resolved_name.ok) {
        vayu::utils::log_warning ("POST /execute - " + resolved_name.error);
        return resolved_name.error;
    }
    send.script_request_name = std::move (resolved_name.name);

    // The persisted half of the run row, skipped entirely when the caller
    // asked for a transient execution. The config snapshot is built here
    // rather than above because it is storage, not scope: sanitizing a
    // payload nobody will store is work with no reader.
    if (!payload.transient) {
        send.run.id = vayu::utils::generate_id ("run_");
        send.run.config_snapshot = vayu::json::sanitize_config_snapshot (req.body);
        send.run_id = send.run.id;
    }

    // Log request details
    vayu::utils::log_info (
    "POST /execute - Design Mode: run_id=" + send.run_id.value_or ("none (transient)") +
    ", method=" + json.value ("method", "UNKNOWN") + ", url=" + json.value ("url", "UNKNOWN") +
    ", request_id=" + send.run.request_id.value_or ("none") +
    ", environment_id=" + send.run.environment_id.value_or ("none") +
    ", has_pre_script=" + std::string (!send.pre_script.empty () ? "true" : "false") +
    ", has_post_script=" + std::string (!send.post_script.empty () ? "true" : "false"));

    if (send.run_id) {
        try {
            ctx.db.create_run (send.run);
        } catch (const std::exception& e) {
            vayu::utils::log_error ("Failed to create run: " + std::string (e.what ()));
            return "Failed to create run record";
        }
    }

    // Which jar this execution reads and writes: one per environment, with the
    // no-environment jar for a request sent without one. Resolved once here so
    // the send, the pre-request script's `pm.sendRequest` and both scripts'
    // `pm.cookies` cannot disagree about which session they are looking at. See
    // cookie_jar.hpp for the scope decision.
    send.cookie_scope =
    send.run.environment_id.value_or (std::string (vayu::http::NO_ENVIRONMENT_SCOPE));

    // What both scripts run under. Read here rather than inside each path
    // because it is three config lookups; the QuickJS runtime itself - the part
    // that is not free - is still built only where a script exists.
    send.script_config.timeout_ms = static_cast<uint64_t> (ctx.db.get_config_int (
    "scriptTimeout", vayu::core::constants::script_engine::TIMEOUT_MS));
    send.script_config.memory_limit = static_cast<size_t> (ctx.db.get_config_int (
    "scriptMemoryLimit", vayu::core::constants::script_engine::MEMORY_LIMIT));
    send.script_config.stack_size = static_cast<size_t> (ctx.db.get_config_int (
    "scriptStackSize", vayu::core::constants::script_engine::STACK_SIZE));
    send.script_config.enable_console = ctx.db.get_config_bool (
    "scriptEnableConsole", vayu::core::constants::script_engine::ENABLE_CONSOLE);
    // Payload-level, not config-level: whether a script may send is a property
    // of *who asked for this execution*, not of the installation. Absent means
    // no - see ScriptConfig::allow_send_request.
    send.script_config.allow_send_request = vayu::http::read_allow_script_requests (json);

    send.data_row = payload.data_row;
    send.stream   = payload.stream;
    return std::nullopt;
}

/**
 * Refuse a streaming send before its stream opens, failing the run row behind
 * it.
 *
 * By the time either refusal is reached the row exists and nothing is going to
 * consume it, so it is failed here rather than left `running` forever - guarded,
 * because a throw while recording that would cost the caller the answer as well
 * as the stream.
 *
 * One helper for both refusals - the draining daemon's, and the header-name
 * ones the residual pass reports (#1051, #1084) - because they are the same three
 * statements, and a second copy is one that stops receiving this one's fixes.
 */
void refuse_stream_before_it_opens (RouteContext& ctx,
httplib::Response& res,
const std::string& run_id,
int status,
const std::string& reason,
std::string_view code = {}) {
    vayu::utils::log_warning (
    "POST /execute - Stream refused for run: " + run_id + " - " + reason);
    try {
        ctx.db.update_run_status_with_retry (run_id, vayu::RunStatus::Failed);
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "Failed to fail a refused stream run: " + std::string (e.what ()));
    }
    send_error (res, status, reason, code);
}

/**
 * The streaming half of a design send (issue #573).
 *
 * The same script/send/script ordering a buffered send performs, pulled apart
 * by the transfer that sits between the two halves (issue #575): the
 * pre-request script runs here, before anything is on the wire, so its
 * `pm.request` write-back reaches the stream; the post-request script runs on
 * the worker thread once the stream has terminated, because only then is there
 * a response - and an event list - to assert over.
 */
void run_streaming_execution (RouteContext& ctx, httplib::Response& res, DesignSend& send) {
    // The same script/send/script ordering a buffered send performs,
    // pulled apart by the transfer that sits between the two halves
    // (issue #575). The pre-request script runs here, before anything
    // is on the wire, so its `pm.request` write-back reaches the
    // stream; the post-request script runs on the worker thread once
    // the stream has terminated, because only then is there a response
    // - and an event list - to assert over.
    //
    // The scopes both halves read are loaded once and travel with the
    // completion callback, so a `pm.environment.set` in the
    // pre-request script is visible to the post-request script exactly
    // as it is on the buffered path.
    ScriptVariableScopes scopes;
    vayu::ScriptResult pre_script_result;
    std::vector<vayu::http::CookieWrite> pre_cookie_writes;
    // Resolved once here rather than at each of the three uses below
    // (the pre-request script's `pm.sendRequest`, the transfer, and
    // the post-request script's on the worker thread): they are one
    // stream, and a settings change between them would otherwise send
    // the two halves out by different routes.
    const auto transport = vayu::http::resolve_transport_policy (ctx.db);
    // Loaded whether or not this send carries a script, because the
    // residual-token pass below reads them too (issue #1008): a `{{token}}`
    // that resolves on the buffered path and stays literal here would be one
    // send behaving two ways.
    scopes = load_script_variable_scopes (ctx.db, send.run);
    if (!send.pre_script.empty ()) {
        vayu::runtime::ScriptEngine script_engine (send.script_config);
        auto pre_ctx = vayu::runtime::ScriptContext::for_prerequest (send.request);
        bind_script_scopes (
        pre_ctx, scopes, ctx.cookie_jar, send.cookie_scope, &pre_cookie_writes);
        pre_ctx.request_id   = send.run.request_id;
        pre_ctx.request_name = send.script_request_name;
        pre_ctx.transport    = transport;
        // The same row the transfer below carries, on the same terms
        // as the buffered path: a stream is still one send, and one
        // send with a row is iteration 0 of 1.
        if (send.data_row) {
            pre_ctx.iteration_data  = &*send.data_row;
            pre_ctx.iteration       = 0;
            pre_ctx.vu              = vayu::core::SOLE_VIRTUAL_USER;
            pre_ctx.iteration_count = 1;
        }
        pre_script_result =
        execute_script (script_engine, send.pre_script, pre_ctx, "Pre-request");
    }

    // `stream` and `transient` are mutually exclusive - `read_stream_flag`
    // refuses the pair with a 400 - so a streaming send always has a run row.
    // The rule holds in `read_execute_payload`, not here, which is what
    // `invariant_value` is for.
    const std::string run_id = vayu::utils::invariant_value (
    send.run_id, "a streaming send has a run row: stream and transient are mutually exclusive");

    // The same pass the buffered send makes between its script and its send
    // (issue #1008), here because this path runs the pre-request script itself
    // rather than through `execute_exchange`: a `{{token}}` the script has just
    // defined resolves before the stream opens.
    if (auto refusal = resolve_residual_tokens (send.request, scopes)) {
        // What that pass can refuse (issues #1051 and #1084), in the same words
        // the buffered send refuses it with and under the code composition
        // refuses it under; what differs is where the caller reads it, this
        // route not having answered yet. The code rides on the refusal because
        // naming it here is how it would come to name the wrong rule.
        refuse_stream_before_it_opens (
        ctx, res, run_id, 400, refusal->error.message, refusal->code);
        return;
    }

    vayu::http::SseStreamRequest spec;
    spec.run_id          = run_id;
    spec.request         = std::move (send.request);
    spec.limits          = vayu::http::read_sse_limits (ctx.db);
    spec.transport       = transport;
    spec.max_duration_ms = send.stream.max_duration_ms;
    spec.max_events      = send.stream.max_events;
    spec.cookie_jar      = &ctx.cookie_jar;
    spec.cookie_scope    = send.cookie_scope;
    // The pre-request script's jar writes ride this transfer, which is
    // what makes them happen exactly once - the same route
    // `ClientConfig::cookie_writes` gives them on the buffered path.
    spec.cookie_writes = std::move (pre_cookie_writes);
    // Persistence stays the route's decision even though it happens on
    // the worker thread - `ctx.db` outlives the manager, which is why
    // the manager is declared before `server_` (see server.hpp).
    // Copied into the callback rather than borrowed: the post-request
    // script runs on the worker thread once the stream has terminated,
    // long after this handler's frame - and its row must be the one the
    // pre-request script and the transfer used.
    spec.on_complete =
    [&db = ctx.db, &jar = ctx.cookie_jar, id = run_id,
    cookie_scope = send.cookie_scope, run = send.run,
    script_config = send.script_config, post_request_script = send.post_script,
    request_name = send.script_request_name, scopes, iteration_data = send.data_row,
    transport, pre_script_result] (const vayu::Request& sent,
    const vayu::Response& response, const vayu::http::SseStreamContext& context) mutable {
        StreamRecord record;
        nlohmann::json scripts = nlohmann::json::object ();
        record.events          = vayu::http::stream_trace_node (context);
        if (context.end_reason () == vayu::http::SseEndReason::Stopped) {
            record.status = vayu::RunStatus::Stopped;
        } else if (response.has_error ()) {
            record.status = vayu::RunStatus::Failed;
        } else {
            record.status = vayu::RunStatus::Completed;
        }

        const bool has_script_output = !post_request_script.empty () ||
        !pre_script_result.tests.empty () ||
        !pre_script_result.console_output.empty () || !pre_script_result.success;
        if (has_script_output) {
            // Guarded as a whole: a script surface that threw where
            // `execute_script` does not catch - building the runtime,
            // applying a cookie write - must not cost the run its
            // result row, which is the only record the stream leaves.
            try {
                vayu::ScriptResult post_script_result;
                if (!post_request_script.empty ()) {
                    vayu::runtime::ScriptEngine script_engine (script_config);
                    std::vector<vayu::http::CookieWrite> post_cookie_writes;
                    auto post_ctx = vayu::runtime::ScriptContext::for_test (sent, response);
                    bind_script_scopes (post_ctx, scopes, jar, cookie_scope, &post_cookie_writes);
                    post_ctx.request_id   = run.request_id;
                    post_ctx.request_name = request_name;
                    post_ctx.transport    = transport;
                    if (iteration_data) {
                        post_ctx.iteration_data = &*iteration_data;
                        post_ctx.iteration      = 0;
                        post_ctx.vu             = vayu::core::SOLE_VIRTUAL_USER;
                        post_ctx.iteration_count = 1;
                    }
                    // The node the trace is about to store, not a copy
                    // of it: `pm.response.eventsTruncated` and the
                    // stored marker are then the same value by
                    // construction rather than by agreement.
                    post_ctx.response_events = &record.events;
                    post_script_result       = execute_script (script_engine,
                          post_request_script, post_ctx, "Post-request");
                    // Nothing left to carry them - the transfer has
                    // already captured, exactly as on the buffered path.
                    jar.apply (cookie_scope, post_cookie_writes);
                }
                scripts = build_script_result_node (pre_script_result, post_script_result);
            } catch (const std::exception& e) {
                vayu::utils::log_error (
                "Stream post-request script failed: " + std::string (e.what ()));
            }
            // Best-effort and after both scripts, so one `set()` per
            // run reaches disk rather than one per half.
            persist_script_variables (
            db, run, scopes.environment, scopes.globals, scopes.collection);
        }

        // No verdict: a stream's body is an event stream, not a
        // document any response schema describes (see the contract on
        // the parameter).
        record_design_result (db, id, sent, response, &record, std::nullopt, scripts);
    };

    auto context = ctx.sse_manager.start (std::move (spec));
    if (!context) {
        // The daemon is draining its workers, or - impossibly - the id
        // collided.
        refuse_stream_before_it_opens (ctx, res, run_id, 503, "Engine is shutting down");
        return;
    }

    nlohmann::json body;
    body["runId"]     = run_id;
    body["eventsUrl"] = "/runs/" + run_id + "/events";
    body["status"]    = to_string (vayu::RunStatus::Running);
    res.status        = 202;
    res.set_content (body.dump (), "application/json");
}

/**
 * The buffered half of a design send: pre-request script, send, test script -
 * the sequence a scenario step performs too, which is why it lives in
 * request_exchange.cpp rather than here (issue #353).
 */
void run_buffered_execution (RouteContext& ctx, httplib::Response& res, DesignSend& send) {
    vayu::runtime::ScriptEngine script_engine (send.script_config);

    // Load variables. Mutated in place by both scripts, then persisted
    // once below.
    auto scopes = load_script_variable_scopes (ctx.db, send.run);

    // Pre-request script, send, test script - the sequence a scenario step
    // performs too, which is why it lives in request_exchange.cpp rather
    // than here (issue #353). `iteration` is left unset for a send carrying
    // no row: it has no iteration index, and a binding that cannot fail is
    // worse than a missing one (issue #300).
    ExchangeInputs inputs;
    inputs.request      = std::move (send.request);
    inputs.pre_script   = send.pre_script;
    inputs.post_script  = send.post_script;
    inputs.request_id   = send.run.request_id;
    inputs.request_name = send.script_request_name;
    // Read at the point of use, so a settings change applies to the next
    // send without a restart (issue #705). The body bound is read the same way
    // and for the same reason (issue #1157).
    inputs.transport          = vayu::http::resolve_transport_policy (ctx.db);
    inputs.max_response_bytes = design_response_body_bound (ctx.db);
    if (send.data_row) {
        inputs.iteration_data = &*send.data_row;
        // Row 0 of 1: a send-with-row *is* an iteration, and the one it is
        // is the row it bound. This is the exception the comment above
        // describes - an ordinary Send still leaves both unset, because it
        // has no row and an invented index would be the binding that cannot
        // fail (issue #300).
        inputs.iteration       = 0;
        inputs.vu              = vayu::core::SOLE_VIRTUAL_USER;
        inputs.iteration_count = 1;
    }
    auto exchange = execute_exchange (script_engine, ctx.cookie_jar,
    send.cookie_scope, scopes, std::move (inputs), ctx.verbose);

    // What the contract says this response should have been (#628).
    // Resolved from the *stored* request: an unsaved editor request is not
    // an operation of any document, and inventing a verdict for one would
    // be a claim about a contract it is not bound by.
    const auto validation =
    validate_design_response (ctx.db, send.run.request_id, exchange.response);

    // Built once, then sent *and* stored (#725). The live body and the
    // trace's `scripts` node are the same object, so a restored Tests tab
    // shows the assertions this send actually made rather than the
    // empty-state that used to make "passed" and "never ran" identical.
    const nlohmann::json scripts =
    build_script_result_node (exchange.pre_script_result, exchange.post_script_result);

    // Store result to database (non-blocking, errors logged). A transient
    // execution stops here: no trace row, so the post-auth headers this
    // exchange carries never reach disk - and neither do these results.
    record_design_result (ctx.db, send.run_id, exchange.request, exchange.response,
    /*send.stream=*/nullptr, validation, scripts);

    // Persist script-set variables (design mode only; best-effort)
    persist_script_variables (
    ctx.db, send.run, scopes.environment, scopes.globals, scopes.collection);

    // Build and send response
    // Engine returns 200 - the server's status is in the response body
    res.status = 200;
    res.set_content (
    build_response_json (exchange.response, scripts, validation).dump (2), "application/json");
}

/**
 * POST /execute  (alias: POST /request, deprecated)
 * Executes a single HTTP request (Design Mode).
 *
 * Returns:
 * - 200: Request was processed (check response body for server status/errors)
 * - 400: Invalid request format (malformed JSON, missing required fields)
 */
void handle_execute_request (RouteContext& ctx,
const httplib::Request& req,
httplib::Response& res) {
    ExecutePayload payload;
    if (auto rejection = read_execute_payload (ctx, req, payload)) {
        send_error (res, 400, *rejection);
        return;
    }

    DesignSend send;
    if (auto rejection = build_design_send (ctx, req, payload, send)) {
        send_error (res, 400, *rejection);
        return;
    }

    // Take the request built above. Auth is already resolved into its
    // headers/url - by the build, or by the bind for credentials that carried
    // the row - so pm.request reflects the real outgoing set - and because the
    // pre-request script runs after that and writes back into this same object,
    // a script-set Authorization header wins over the engine-applied one.
    send.request = std::move (payload.built.request);

    // Auth failure: record a failed result against the run and return the
    // error in the body (engine returns 200; the status lives in the body).
    if (!payload.built.ok) {
        vayu::Response auth_resp;
        auth_resp.status_code   = 0;
        auth_resp.status_text   = vayu::http::status_text (0);
        auth_resp.error_code    = payload.built.error_code;
        auth_resp.error_message = payload.built.error_message;
        record_design_result (ctx.db, send.run_id, send.request, auth_resp);
        nlohmann::json body   = vayu::json::serialize (auth_resp);
        body["authErrorCode"] = payload.built.detail_code;
        res.status            = 200;
        res.set_content (body.dump (2), "application/json");
        return;
    }

    // A streaming request diverges here: there is no synchronous exchange to
    // run. The transfer moves to a managed consumer worker and the route
    // answers at once with the run and the URL its events arrive on
    // (issue #573). `stream` and `transient` are mutually exclusive, so
    // `run_id` is always set on that path.
    if (send.stream.value) {
        run_streaming_execution (ctx, res, send);
        return;
    }
    run_buffered_execution (ctx, res, send);
}


/**
 * POST /runs  (alias: POST /run, deprecated)
 * Starts a load test run (Vayu Mode).
 *
 * Returns:
 * - 202: Load test accepted and started
 * - 400: Invalid request format
 */
/**
 * Every refusal `POST /runs` makes on the payload alone, before a run row
 * exists - so a rejected request leaves nothing behind.
 */
std::optional<RouteError>
validate_load_request (RouteContext& ctx, nlohmann::json& json, bool is_scenario, bool is_scenario_load) {
    // Refused before the run row exists, and never quietly downgraded to a
    // closed-loop mode: a run that measured something other than what was
    // asked for is worse than no run at all.
    if (is_scenario_load) {
        if (auto invalid = vayu::core::validate_scenario_load_config (json)) {
            vayu::utils::log_warning (
            "POST /runs - Invalid scenario load config: " + *invalid);
            return RouteError{ 400, error_body (400, *invalid, "invalid_run_config") };
        }
    }

    // Validate required fields
    if (!is_scenario) {
        if (!json.contains ("method") || !json.contains ("url")) {
            vayu::utils::log_warning (
            "POST /runs - Missing required fields: method, url");
            return RouteError{ 400, error_body (400, "Missing required fields: method, url") };
        }

        if (!json.contains ("mode") && !json.contains ("duration") &&
        !json.contains ("iterations")) {
            vayu::utils::log_warning (
            "POST /runs - Missing mode/duration/iterations config");
            return RouteError{ 400,
                error_body (400, "Must specify either 'mode' with 'duration' or 'iterations'") };
        }
    }

    // Range-check the numeric config *before* the run row exists, so a
    // rejected request leaves nothing behind. `invalid_run_config` is the
    // specific code this failure carries in place of the per-status default.
    if (auto invalid =
        validate_run_config (json, vayu::core::read_monitor_limits (ctx.db))) {
        vayu::utils::log_warning ("POST /runs - Invalid run config: " + *invalid);
        return RouteError{ 400, error_body (400, *invalid, "invalid_run_config") };
    }

    // Validate/normalize the body's httpVersion, beside the config check
    // above and for the same reason: both run before run.config_snapshot is
    // built, so a rejected request leaves no row behind, and the snapshot
    // still reflects the raw client body (sanitize_config_snapshot reads
    // req.body directly, not this normalized `json`).
    if (auto outcome = normalize_run_http_version (json); !outcome) {
        vayu::utils::log_warning (
        "POST /runs - Invalid httpVersion: " + outcome.error ().body.dump ());
        return outcome.error ();
    }
    return std::nullopt;
}

/**
 * The scenario block, resolved once - before the first send, and before any run
 * row exists.
 *
 * An unknown collection, an empty sequence or a step that cannot be composed
 * must leave no run behind, and resolution is what finds all three. It resolves
 * exactly once because a collection edited mid-run must not change the sequence
 * underneath itself, and the load-mode executor (phase 6) cannot query SQLite
 * per step per virtual user. The resolved plan is then shared immutably with
 * the run's worker and lives in memory for the run's life and nowhere else.
 */
std::optional<RouteError> resolve_run_scenario (RouteContext& ctx,
const nlohmann::json& json,
std::shared_ptr<const vayu::core::ScenarioExecution>& scenario_execution,
nlohmann::json& scenario_manifest) {
    vayu::core::ScenarioResolveOptions options;
    if (auto it = json.find ("environmentId"); it != json.end () && it->is_string ()) {
        options.environment_id = it->get<std::string> ();
    }
    options.timeout_ms       = resolve_request_timeout_ms (json,
          ctx.db.get_config_int ("defaultTimeout", vayu::core::constants::server::DEFAULT_TIMEOUT_MS));
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
        vayu::utils::log_warning ("POST /runs - Invalid scenario: " + resolved.error);
        return RouteError{ 400, error_body (400, resolved.error, "invalid_scenario") };
    }

    scenario_manifest = vayu::core::build_scenario_manifest (
    resolved.request, resolved.plan, resolved.spec);

    auto execution     = std::make_shared<vayu::core::ScenarioExecution> ();
    execution->request = std::move (resolved.request);
    execution->plan    = std::move (resolved.plan);
    // The manifest above was built before this move, and from
    // `resolved.request` - which carries the row *count* and never the
    // rows. That is what keeps user data out of `config_snapshot`.
    execution->data_rows = std::move (resolved.data_rows);
    // The contract this run is measured against, carried to the runner
    // so coverage counts against the document that was bound when the
    // plan resolved (issue #629) rather than whatever it is by the time
    // the run ends. The manifest above already stamped its identity.
    execution->spec    = std::move (resolved.spec);
    scenario_execution = std::move (execution);

    vayu::utils::log_info (
    "POST /runs - Scenario: collection=" + scenario_execution->request.collection_id +
    ", steps=" + std::to_string (scenario_execution->plan.steps.size ()) +
    ", iterations=" + std::to_string (scenario_execution->request.iterations));
    return std::nullopt;
}

/**
 * Pre-flight auth: reject an unauthorizable run before creating it, and warm
 * the token cache so the worker's `apply_auth` is a cache hit.
 *
 * A scenario payload carries no run-level `auth` - each step's auth was
 * resolved at plan time, and a step that could not be authorized already failed
 * resolution with a 400 - so this is the single-request path's check alone.
 */
std::optional<RouteError> preflight_run_auth (RouteContext& ctx, const nlohmann::json& json) {
    auto preflight =
    vayu::http::preflight_auth (json.value ("auth", nlohmann::json ()), ctx.db);
    if (!preflight.ok) {
        vayu::utils::log_warning (
        "POST /runs - Auth pre-flight failed: " + preflight.message);
        const int status = (preflight.code == vayu::ErrorCode::AuthRequired) ? 409 : 400;
        return RouteError{ status,
            error_body (status, preflight.message, preflight.detail_code) };
    }
    return std::nullopt;
}

/** What this run is, for the log: the two shapes read differently. */
void log_started_run (const nlohmann::json& json,
const vayu::db::Run& run,
const std::string& run_id,
const vayu::core::ScenarioExecution* scenario_execution) {

    // Extract duration for logging
    std::string duration_str = "0s";
    if (json.contains ("duration")) {
        if (json["duration"].is_string ()) {
            duration_str = json["duration"].get<std::string> ();
        } else if (json["duration"].is_number ()) {
            duration_str = std::to_string (json["duration"].get<int> ()) + "s";
        }
    }

    if (scenario_execution != nullptr) {
        vayu::utils::log_info ("POST /runs - Collection run: run_id=" + run_id +
        ", collection=" + scenario_execution->request.collection_id +
        ", steps=" + std::to_string (scenario_execution->plan.steps.size ()) +
        ", iterations=" + std::to_string (scenario_execution->request.iterations) +
        ", environment_id=" + run.environment_id.value_or ("none"));
    } else {
        vayu::utils::log_info ("POST /runs - Load Test: run_id=" + run_id +
        ", mode=" + json.value ("mode", "unspecified") +
        ", method=" + json.value ("method", "UNKNOWN") +
        ", url=" + json.value ("url", "UNKNOWN") + ", duration=" + duration_str +
        ", iterations=" + std::to_string (json.value ("iterations", 0)) +
        ", rps=" + std::to_string (json.value ("rps", json.value ("targetRps", 0))) +
        ", concurrency=" + std::to_string (json.value ("concurrency", 1)) +
        ", request_id=" + run.request_id.value_or ("none") +
        ", environment_id=" + run.environment_id.value_or ("none"));
    }
}

void handle_start_load_test (RouteContext& ctx,
const httplib::Request& req,
httplib::Response& res) {
    // Parse JSON
    nlohmann::json json;
    try {
        json = nlohmann::json::parse (req.body);
    } catch (const nlohmann::json::exception& e) {
        vayu::utils::log_warning ("POST /runs - Invalid JSON: " + std::string (e.what ()));
        send_error (res, 400, "Invalid JSON: " + std::string (e.what ()));
        return;
    }

    // A scenario run states its work as an ordered collection, so it has no
    // single method/url to require and states its iteration count inside
    // the block. Both checks in `validate_load_request` describe the
    // single-request payload only; the scenario block's own required fields are
    // checked by resolve_scenario, beside the shared numeric validation.
    const bool is_scenario = json.contains ("scenario") && !json["scenario"].is_null ();
    // A `scenario` block with a load `mode` beside it is a load-mode
    // scenario: the same plan, driven by virtual users on the event loop
    // instead of one sequence through the client. Without a mode it is the
    // design-mode collection run every caller sent before phase 6, so the
    // absence of `mode` cannot start meaning something new.
    const bool is_scenario_load = vayu::core::is_scenario_load_run (json);

    if (auto rejection = validate_load_request (ctx, json, is_scenario, is_scenario_load)) {
        res.status = rejection->status;
        res.set_content (rejection->body.dump (), "application/json");
        return;
    }

    std::shared_ptr<const vayu::core::ScenarioExecution> scenario_execution;
    nlohmann::json scenario_manifest;
    if (is_scenario) {
        if (auto rejection =
            resolve_run_scenario (ctx, json, scenario_execution, scenario_manifest)) {
            res.status = rejection->status;
            res.set_content (rejection->body.dump (), "application/json");
            return;
        }
    }

    // The rows a single-request run binds (issue #993), validated and credential-
    // planned here for the reason the scenario block is resolved here: a set the
    // engine cannot read must leave no run row behind.
    auto load_data = read_load_data_set (json, load_data_limits (ctx.db), is_scenario);
    if (!load_data.ok) {
        vayu::utils::log_warning ("POST /runs - " + load_data.error);
        send_error (res, 400, load_data.error, "invalid_run_config");
        return;
    }

    // Create run record
    std::string run_id = vayu::utils::generate_id ("run_");
    vayu::db::Run run;
    run.id = run_id;
    // A scenario *load* run is a load run whose target happens to be a
    // sequence: it publishes metric ticks, reports RPS and percentiles, and
    // stores no per-step `results` rows - so `Scenario`, which is what the
    // app reads to render a step list instead of the dashboard, would point
    // every consumer at the wrong view of it. The step breakdown reaches
    // the report through the summary's `scenario` object instead, and the
    // snapshot still carries the manifest, so the list row still says which
    // collection ran.
    run.type   = (is_scenario && !is_scenario_load) ? vayu::RunType::Scenario :
                                                      vayu::RunType::Load;
    run.status = vayu::RunStatus::Pending;
    run.config_snapshot = run_config_snapshot (
    req.body, is_scenario, scenario_manifest, load_data.set.get ());
    seed_run_times (run, now_ms ());

    if (json.contains ("requestId") && !json["requestId"].is_null ()) {
        run.request_id = json["requestId"].get<std::string> ();
    }
    if (json.contains ("environmentId") && !json["environmentId"].is_null ()) {
        run.environment_id = json["environmentId"].get<std::string> ();
    }

    log_started_run (json, run, run_id, scenario_execution.get ());

    if (!is_scenario) {
        if (auto rejection = preflight_run_auth (ctx, json)) {
            res.status = rejection->status;
            res.set_content (rejection->body.dump (), "application/json");
            return;
        }
    }

    try {
        ctx.db.create_run (run);
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "POST /runs - Failed to create run: " + std::string (e.what ()));
        send_error (res, 400, "Failed to create run record");
        return;
    }

    // Start run via RunManager. A refusal means the daemon is draining its
    // workers for shutdown; the row exists but nothing will ever run it, so
    // say so rather than returning a 202 for a run that never starts.
    // A load-mode scenario takes the load path: same event loop, metrics
    // thread, drain and summary as a single-request run, with the virtual-
    // user state machine in place of a LoadStrategy. Only the design-mode
    // sequential runner needs the cookie jar, which is why only it is
    // handed one.
    const bool started = (is_scenario && !is_scenario_load) ?
    ctx.run_manager.start_scenario_run (
    run_id, json, scenario_execution, ctx.db, ctx.cookie_jar, ctx.verbose) :
    ctx.run_manager.start_run (run_id, json, ctx.db, ctx.verbose,
    is_scenario_load ? scenario_execution : nullptr, std::move (load_data.set),
    std::move (load_data.auth));
    if (!started) {
        send_error (res, 503, "Engine is shutting down");
        return;
    }

    nlohmann::json response;
    response["runId"]  = run_id;
    response["status"] = to_string (vayu::RunStatus::Pending);
    if (is_scenario_load) {
        response["message"] = "Scenario load test started";
    } else if (is_scenario) {
        response["message"] = "Collection run started";
    } else {
        response["message"] = "Load test started";
    }

    res.status = 202;
    res.set_content (response.dump (), "application/json");
}

} // namespace

void register_execution_routes (RouteContext& ctx) {
    httplib::Server::Handler execute_request = [&ctx] (const httplib::Request& req,
                                               httplib::Response& res) {
        handle_execute_request (ctx, req, res);
    };
    ctx.server.Post ("/execute", execute_request);
    ctx.server.Post ("/request", deprecated_alias (execute_request));

    httplib::Server::Handler start_load_test = [&ctx] (const httplib::Request& req,
                                               httplib::Response& res) {
        handle_start_load_test (ctx, req, res);
    };
    ctx.server.Post ("/runs", start_load_test);
    ctx.server.Post ("/run", deprecated_alias (start_load_test));
}

} // namespace vayu::http::routes
