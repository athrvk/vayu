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

#include <cmath>
#include <optional>
#include <regex>
#include <string>

#include "vayu/core/constants.hpp"
#include "vayu/core/monitor.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_plan.hpp"
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
std::optional<std::pair<int, nlohmann::json>> normalize_run_http_version (
nlohmann::json& json) {
    if (!json.contains ("httpVersion")) {
        return std::nullopt;
    }
    if (json["httpVersion"].is_null ()) {
        json.erase ("httpVersion");
        return std::nullopt;
    }
    // Both early returns above mean the key is present and non-null by now, so
    // the two branches of apply_http_version_field that consume `seed` are
    // unreachable from here. The argument is required by the signature; it does
    // not select behaviour at this call site.
    std::string version;
    if (auto err = apply_http_version_field (json, "httpVersion", version,
        vayu::to_string (vayu::DEFAULT_HTTP_VERSION), /*is_create=*/false)) {
        return err;
    }
    json["httpVersion"] = version;
    return std::nullopt;
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
 * @brief Read `POST /execute`'s `stream` flag and its caps (issue #573).
 *
 * Non-static: sse_stream_test.cpp drives it directly, the suite having no
 * in-process HTTP route harness. See routes.hpp for the refusal set.
 */
StreamFlag read_stream_flag (const nlohmann::json& json) {
    StreamFlag flag;

    // A cap on a non-streaming payload is refused too. It reads as a bound the
    // caller expects to apply, and silently ignoring it is how an unbounded run
    // gets mistaken for a capped one.
    const auto read_cap = [&json, &flag] (const char* key, int64_t low, int64_t high,
                          std::optional<int64_t>& out) {
        const auto field = json.find (key);
        if (field == json.end () || field->is_null ()) {
            return true;
        }
        if (!field->is_number_integer ()) {
            flag.ok = false;
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
            flag.ok    = false;
            flag.error = "'maxStreamDurationMs' and 'maxStreamEvents' apply to a "
                         "streaming request only - set 'stream': true, or drop them";
        }
        return flag;
    }

    const auto transient = json.find ("transient");
    if (transient != json.end () && transient->is_boolean () && transient->get<bool> ()) {
        flag.ok    = false;
        flag.error = "'stream' and 'transient' cannot be combined: a stream is "
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
 * @brief The first `{{data.column}}` in a `POST /execute` payload's `auth`
 *        block (issue #601).
 *
 * Non-static: send_with_row_test.cpp drives it directly. See routes.hpp for why
 * the endpoint refuses rather than binds.
 */
std::optional<std::string> first_auth_data_token (const nlohmann::json& json) {
    const auto auth = json.find ("auth");
    if (auth == json.end () || auth->is_null ()) {
        return std::nullopt;
    }
    return vayu::core::first_data_token_in (*auth);
}

namespace {

// Build the final response JSON with script results
nlohmann::json build_response_json (const vayu::Response& response,
const vayu::ScriptResult& pre_script_result,
const vayu::ScriptResult& post_script_result) {
    nlohmann::json response_json = vayu::json::serialize (response);
    // Merged in at the top level, which is where every client has read these
    // four keys since before there was a second placement for them. The
    // streaming path stores the same object under the trace's `scripts` node -
    // one builder, two homes, so a key can never mean one thing live and
    // another restored.
    response_json.update (build_script_result_node (pre_script_result, post_script_result));
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
std::optional<std::string> check_duration_field (const nlohmann::json& config, const char* key) {
    if (!config.contains (key) || config[key].is_null ()) {
        return std::nullopt;
    }
    const auto& value = config[key];
    if (!value.is_string ()) {
        return std::string ("'") + key +
        "' must be a string with a unit, e.g. \"60s\" (got " +
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

    // Test results come from the post-request script alone: a pre-request
    // script runs before there is anything to assert about.
    if (!post_script_result.tests.empty ()) {
        nlohmann::json test_results = nlohmann::json::array ();
        for (const auto& test : post_script_result.tests) {
            nlohmann::json test_json;
            test_json["name"]   = test.name;
            test_json["passed"] = test.passed;
            if (!test.error_message.empty ()) {
                test_json["error"] = test.error_message;
            }
            test_results.push_back (test_json);
        }
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
const StreamRecord* stream) {
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
        const auto max_trace_body_bytes = static_cast<size_t> (db.get_config_int (
        "maxTraceBodyBytes",
        static_cast<int> (vayu::core::constants::json::MAX_TRACE_BODY_BYTES)));
        vayu::json::cap_trace_bodies (trace, max_trace_body_bytes);

        // Added *after* the body cap deliberately: `cap_trace_bodies` walks the
        // request/response body nodes and does not reach this one, so the
        // events list carries its own cap, applied when it was built
        // (`stream_trace_node`). Putting it here rather than before makes that
        // impossible to misread as covered.
        if (stream) {
            trace["events"] = stream->events;
            // Only when the run had scripts at all: an empty node would put a
            // Tests pane's worth of nothing on every stored stream.
            if (stream->scripts.is_object () && !stream->scripts.empty ()) {
                trace["scripts"] = stream->scripts;
            }
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
        auto status = stream ? stream->status :
        (has_error ? vayu::RunStatus::Failed : vayu::RunStatus::Completed);
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
        return "'transient' is not valid on a run - it applies to POST /execute "
               "only, because a run is identified by the row it creates";
    }

    // `stream` belongs to `POST /execute` alone in this phase (issue #573).
    // Refused rather than ignored, and for the same reason `transient` is: a
    // caller that sends it believes this run will deliver events live, and it
    // is about to buffer every response into a load test's metrics instead.
    // Load-mode streaming arrives with the caps that keep the completion-driven
    // refill loop's invariants (issue #576).
    if (config.contains ("stream") && !config["stream"].is_null ()) {
        return "'stream' is not valid on a run - it applies to POST /execute "
               "only, because a load run's completion accounting has no place "
               "for a response that never ends";
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

    namespace limits               = vayu::core::constants::run_config;
    const NumericRunField fields[] = {
        { "success_sample_rate", 1, 100000,
        "It is a sampling period (keep 1 in N), and 0 is a division by zero." },
        { "response_sample_rate", 1, 100000,
        "It is a sampling period (keep 1 in N), and 0 is a division by zero." },
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
    };
    for (const auto& field : fields) {
        if (auto reason = check_numeric_field (config, field)) {
            return reason;
        }
    }

    // Each is read with `config.value (..., bool)` inside RunContext's
    // constructor, which throws `type_error.302` on a string - after the run
    // row exists, which is the stranded-`pending` failure this whole function
    // is here to prevent. Absent and `null` both mean "use the engine setting",
    // matching the null-vs-absent rule the resource routes follow.
    for (const char* key :
    { "phase_histograms", "save_timing_breakdown", "capture_response_bodies" }) {
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

void register_execution_routes (RouteContext& ctx) {
    /**
     * POST /execute  (alias: POST /request, deprecated)
     * Executes a single HTTP request (Design Mode).
     *
     * Returns:
     * - 200: Request was processed (check response body for server status/errors)
     * - 400: Invalid request format (malformed JSON, missing required fields)
     */
    httplib::Server::Handler execute_request =
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        // Absent for a transient execution (issue #382): no row exists to
        // record against, and every recording step below keys off that.
        std::optional<std::string> run_id;

        // Parse and validate request
        nlohmann::json json;
        try {
            json = nlohmann::json::parse (req.body);
        } catch (const nlohmann::json::exception& e) {
            vayu::utils::log_warning (
            "POST /execute - Invalid JSON: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON: " + std::string (e.what ()));
            return;
        }

        // Read before anything is built or written, with the other pre-row
        // validation: a malformed flag must be a 400, not a run the caller
        // believed would leave no trace.
        const auto transient = read_transient_flag (json);
        if (!transient.ok) {
            vayu::utils::log_warning ("POST /execute - " + transient.error);
            send_error (res, 400, transient.error);
            return;
        }

        // Beside the transient flag and for the same reason: `stream` changes
        // the execution model, so a malformed one must be a 400 before anything
        // is built or written rather than a send the caller did not ask for.
        const auto stream = read_stream_flag (json);
        if (!stream.ok) {
            vayu::utils::log_warning ("POST /execute - " + stream.error);
            send_error (res, 400, stream.error);
            return;
        }

        // The row this send binds, if the caller named one (issue #601). Read
        // here with the other pre-row validation for the reason the bind below
        // is also placed before the run record: a request whose tokens could
        // not bind must leave no trace of an execution that never happened.
        const auto data_row = read_data_row (json,
        static_cast<size_t> (ctx.db.get_config_int ("maxScenarioDataBytes",
        static_cast<int> (vayu::core::constants::scenario::MAX_DATA_BYTES))));
        if (!data_row.ok) {
            vayu::utils::log_warning ("POST /execute - " + data_row.error);
            send_error (res, 400, data_row.error);
            return;
        }

        // Build the request once: deserialize + timeout + auth. A malformed
        // payload fails here (before any run record is created); an auth
        // failure is surfaced after the run exists (below).
        const int request_timeout_ms = resolve_request_timeout_ms (
        json, ctx.db.get_config_int (
        "defaultTimeout", vayu::core::constants::server::DEFAULT_TIMEOUT_MS));
        auto built = vayu::http::build_request (json, &ctx.db, request_timeout_ms);
        if (built.parse_failed) {
            vayu::utils::log_warning ("POST /execute - Invalid request format");
            send_error (res, 400, built.error_message);
            return;
        }

        // Bind the row into what composition left written, before anything is
        // recorded or sent. A failure here is a `400` with the binder's own
        // message - it names the token, the row and the row's columns, which is
        // what lets the request be fixed without opening the file - and the
        // partially bound request is discarded rather than sent
        // (scenario_data.hpp). Nothing runs, so nothing is recorded: the
        // refusal precedes the run row exactly as the flag checks above do.
        if (data_row.value) {
            if (auto token = first_auth_data_token (json)) {
                const std::string error = "Auth credentials carry " + *token +
                ", and a single send cannot bind them: the credentials are "
                "applied when the request is built, before the row is read. "
                "Move the token into the URL, a header or the body, or run the "
                "collection with a data file - a collection run binds "
                "credentials per iteration (issue #591).";
                vayu::utils::log_warning ("POST /execute - " + error);
                send_error (res, 400, error);
                return;
            }
            if (auto bound =
                vayu::core::bind_data_row (built.request, *data_row.value, 0);
                !bound.ok) {
                vayu::utils::log_warning ("POST /execute - " + bound.error);
                send_error (res, 400, bound.error);
                return;
            }
        }

        // Extract scripts
        std::string pre_request_script = vayu::http::read_pre_request_script (json);
        std::string post_request_script = vayu::http::read_post_request_script (json);

        // The run row. Built even for a transient execution, because it is also
        // how this handler carries scope: `load_script_variable_scopes` and
        // `persist_script_variables` read its `request_id` / `environment_id`,
        // and the cookie scope below comes from the same field. Only the
        // *persisted* half - the id, the config snapshot, the create - is
        // conditional, so a transient execution resolves variables and cookies
        // exactly as a recorded one does.
        vayu::db::Run run;
        run.type   = vayu::RunType::Design;
        run.status = vayu::RunStatus::Running;
        seed_run_times (run, now_ms ());

        if (json.contains ("requestId") && !json["requestId"].is_null ()) {
            run.request_id = json["requestId"].get<std::string> ();
        }
        if (json.contains ("environmentId") && !json["environmentId"].is_null ()) {
            run.environment_id = json["environmentId"].get<std::string> ();
        }

        // What the scripts below read as `pm.info.requestName`. Resolved here,
        // with the rest of the payload validation, so a malformed field is a
        // 400 before any run row exists.
        auto resolved_name = resolve_script_request_name (ctx.db, json, run.request_id);
        if (!resolved_name.ok) {
            vayu::utils::log_warning ("POST /execute - " + resolved_name.error);
            send_error (res, 400, resolved_name.error);
            return;
        }
        const std::optional<std::string> script_request_name = std::move (resolved_name.name);

        // The persisted half of the run row, skipped entirely when the caller
        // asked for a transient execution. The config snapshot is built here
        // rather than above because it is storage, not scope: sanitizing a
        // payload nobody will store is work with no reader.
        if (!transient.value) {
            run.id              = vayu::utils::generate_id ("run_");
            run.config_snapshot = vayu::json::sanitize_config_snapshot (req.body);
            run_id              = run.id;
        }

        // Log request details
        vayu::utils::log_info ("POST /execute - Design Mode: run_id=" +
        run_id.value_or ("none (transient)") +
        ", method=" + json.value ("method", "UNKNOWN") +
        ", url=" + json.value ("url", "UNKNOWN") +
        ", request_id=" + run.request_id.value_or ("none") +
        ", environment_id=" + run.environment_id.value_or ("none") +
        ", has_pre_script=" + std::string (!pre_request_script.empty () ? "true" : "false") +
        ", has_post_script=" + std::string (!post_request_script.empty () ? "true" : "false"));

        if (run_id) {
            try {
                ctx.db.create_run (run);
            } catch (const std::exception& e) {
                vayu::utils::log_error ("Failed to create run: " + std::string (e.what ()));
                send_error (res, 400, "Failed to create run record");
                return;
            }
        }

        // Take the request built above. Auth is already resolved into its
        // headers/url, so pm.request reflects the real outgoing set - and
        // because the pre-request script runs after that and writes back into
        // this same object, a script-set Authorization header wins over the
        // engine-applied one.
        auto request = std::move (built.request);

        // Auth failure: record a failed result against the run and return the
        // error in the body (engine returns 200; the status lives in the body).
        if (!built.ok) {
            vayu::Response auth_resp;
            auth_resp.status_code   = 0;
            auth_resp.status_text   = vayu::http::status_text (0);
            auth_resp.error_code    = built.error_code;
            auth_resp.error_message = built.error_message;
            record_design_result (ctx.db, run_id, request, auth_resp);
            nlohmann::json body   = vayu::json::serialize (auth_resp);
            body["authErrorCode"] = built.detail_code;
            res.status            = 200;
            res.set_content (body.dump (2), "application/json");
            return;
        }

        // Which jar this execution reads and writes: one per environment, with
        // the no-environment jar for a request sent without one. Resolved once
        // here so the send, the pre-request script's `pm.sendRequest` and both
        // scripts' `pm.cookies` cannot disagree about which session they are
        // looking at. See cookie_jar.hpp for the scope decision.
        const std::string cookie_scope =
        run.environment_id.value_or (std::string (vayu::http::NO_ENVIRONMENT_SCOPE));

        // What both scripts run under. Read here rather than inside each branch
        // because it is three config lookups; the QuickJS runtime itself - the
        // part that is not free - is still built only where a script exists.
        vayu::runtime::ScriptConfig script_config;
        script_config.timeout_ms = static_cast<uint64_t> (ctx.db.get_config_int (
        "scriptTimeout", vayu::core::constants::script_engine::TIMEOUT_MS));
        script_config.memory_limit = static_cast<size_t> (ctx.db.get_config_int (
        "scriptMemoryLimit", vayu::core::constants::script_engine::MEMORY_LIMIT));
        script_config.stack_size = static_cast<size_t> (ctx.db.get_config_int (
        "scriptStackSize", vayu::core::constants::script_engine::STACK_SIZE));
        script_config.enable_console = ctx.db.get_config_bool (
        "scriptEnableConsole", vayu::core::constants::script_engine::ENABLE_CONSOLE);
        // Payload-level, not config-level: whether a script may send is a
        // property of *who asked for this execution*, not of the installation.
        // Absent means no - see ScriptConfig::allow_send_request.
        script_config.allow_send_request = vayu::http::read_allow_script_requests (json);

        // A streaming request diverges here: there is no synchronous exchange to
        // run. The transfer moves to a managed consumer worker and the route
        // answers at once with the run and the URL its events arrive on
        // (issue #573). `stream` and `transient` are mutually exclusive, so
        // `run_id` is always set on this path.
        if (stream.value) {
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
            const bool has_scripts =
            !pre_request_script.empty () || !post_request_script.empty ();
            if (has_scripts) {
                scopes = load_script_variable_scopes (ctx.db, run);
            }
            if (!pre_request_script.empty ()) {
                vayu::runtime::ScriptEngine script_engine (script_config);
                auto pre_ctx = vayu::runtime::ScriptContext::for_prerequest (request);
                bind_script_scopes (pre_ctx, scopes, ctx.cookie_jar,
                cookie_scope, &pre_cookie_writes);
                pre_ctx.request_id   = run.request_id;
                pre_ctx.request_name = script_request_name;
                // The same row the transfer below carries, on the same terms
                // as the buffered path: a stream is still one send, and one
                // send with a row is iteration 0 of 1.
                if (data_row.value) {
                    pre_ctx.iteration_data  = &*data_row.value;
                    pre_ctx.iteration       = 0;
                    pre_ctx.iteration_count = 1;
                }
                pre_script_result = execute_script (
                script_engine, pre_request_script, pre_ctx, "Pre-request");
            }

            vayu::http::SseStreamRequest spec;
            spec.run_id          = *run_id;
            spec.request         = std::move (request);
            spec.limits          = vayu::http::read_sse_limits (ctx.db);
            spec.max_duration_ms = stream.max_duration_ms;
            spec.max_events      = stream.max_events;
            spec.cookie_jar      = &ctx.cookie_jar;
            spec.cookie_scope    = cookie_scope;
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
            spec.on_complete = [&db = ctx.db, &jar = ctx.cookie_jar, id = *run_id,
                               cookie_scope, run, script_config, post_request_script,
                               request_name = script_request_name, scopes,
                               iteration_data = data_row.value,
                               pre_script_result] (const vayu::Request& sent,
                               const vayu::Response& response,
                               const vayu::http::SseStreamContext& context) mutable {
                StreamRecord record;
                record.events = vayu::http::stream_trace_node (context);
                record.status =
                context.end_reason () == vayu::http::SseEndReason::Stopped ?
                vayu::RunStatus::Stopped :
                (response.has_error () ? vayu::RunStatus::Failed :
                                         vayu::RunStatus::Completed);

                const bool has_scripts = !post_request_script.empty () ||
                !pre_script_result.tests.empty () ||
                !pre_script_result.console_output.empty () || !pre_script_result.success;
                if (has_scripts) {
                    // Guarded as a whole: a script surface that threw where
                    // `execute_script` does not catch - building the runtime,
                    // applying a cookie write - must not cost the run its
                    // result row, which is the only record the stream leaves.
                    try {
                        vayu::ScriptResult post_script_result;
                        if (!post_request_script.empty ()) {
                            vayu::runtime::ScriptEngine script_engine (script_config);
                            std::vector<vayu::http::CookieWrite> post_cookie_writes;
                            auto post_ctx =
                            vayu::runtime::ScriptContext::for_test (sent, response);
                            bind_script_scopes (post_ctx, scopes, jar,
                            cookie_scope, &post_cookie_writes);
                            post_ctx.request_id   = run.request_id;
                            post_ctx.request_name = request_name;
                            if (iteration_data) {
                                post_ctx.iteration_data  = &*iteration_data;
                                post_ctx.iteration       = 0;
                                post_ctx.iteration_count = 1;
                            }
                            // The node the trace is about to store, not a copy
                            // of it: `pm.response.eventsTruncated` and the
                            // stored marker are then the same value by
                            // construction rather than by agreement.
                            post_ctx.response_events = &record.events;
                            post_script_result = execute_script (script_engine,
                            post_request_script, post_ctx, "Post-request");
                            // Nothing left to carry them - the transfer has
                            // already captured, exactly as on the buffered path.
                            jar.apply (cookie_scope, post_cookie_writes);
                        }
                        record.scripts = build_script_result_node (
                        pre_script_result, post_script_result);
                    } catch (const std::exception& e) {
                        vayu::utils::log_error (
                        "Stream post-request script failed: " + std::string (e.what ()));
                    }
                    // Best-effort and after both scripts, so one `set()` per
                    // run reaches disk rather than one per half.
                    persist_script_variables (db, run, scopes.environment,
                    scopes.globals, scopes.collection);
                }

                record_design_result (db, id, sent, response, &record);
            };

            auto context = ctx.sse_manager.start (std::move (spec));
            if (!context) {
                // The daemon is draining its workers, or - impossibly - the id
                // collided. The row exists but nothing will consume it, so it
                // is failed here rather than left `running` forever.
                vayu::utils::log_warning (
                "POST /execute - Stream refused for run: " + *run_id);
                try {
                    ctx.db.update_run_status_with_retry (*run_id, vayu::RunStatus::Failed);
                } catch (const std::exception& e) {
                    vayu::utils::log_error (
                    "Failed to fail a refused stream run: " + std::string (e.what ()));
                }
                send_error (res, 503, "Engine is shutting down");
                return;
            }

            nlohmann::json body;
            body["runId"]     = *run_id;
            body["eventsUrl"] = "/runs/" + *run_id + "/events";
            body["status"]    = to_string (vayu::RunStatus::Running);
            res.status        = 202;
            res.set_content (body.dump (), "application/json");
            return;
        }

        vayu::runtime::ScriptEngine script_engine (script_config);

        // Load variables. Mutated in place by both scripts, then persisted
        // once below.
        auto scopes = load_script_variable_scopes (ctx.db, run);

        // Pre-request script, send, test script - the sequence a scenario step
        // performs too, which is why it lives in request_exchange.cpp rather
        // than here (issue #353). `iteration` is left unset for a send carrying
        // no row: it has no iteration index, and a binding that cannot fail is
        // worse than a missing one (issue #300).
        ExchangeInputs inputs;
        inputs.request      = std::move (request);
        inputs.pre_script   = pre_request_script;
        inputs.post_script  = post_request_script;
        inputs.request_id   = run.request_id;
        inputs.request_name = script_request_name;
        if (data_row.value) {
            inputs.iteration_data = &*data_row.value;
            // Row 0 of 1: a send-with-row *is* an iteration, and the one it is
            // is the row it bound. This is the exception the comment above
            // describes - an ordinary Send still leaves both unset, because it
            // has no row and an invented index would be the binding that cannot
            // fail (issue #300).
            inputs.iteration       = 0;
            inputs.iteration_count = 1;
        }
        auto exchange       = execute_exchange (script_engine, ctx.cookie_jar,
        cookie_scope, scopes, std::move (inputs), ctx.verbose);

        // Store result to database (non-blocking, errors logged). A transient
        // execution stops here: no trace row, so the post-auth headers this
        // exchange carries never reach disk.
        record_design_result (ctx.db, run_id, exchange.request, exchange.response);

        // Persist script-set variables (design mode only; best-effort)
        persist_script_variables (
        ctx.db, run, scopes.environment, scopes.globals, scopes.collection);

        // Build and send response
        // Engine returns 200 - the server's status is in the response body
        res.status = 200;
        res.set_content (build_response_json (exchange.response,
        exchange.pre_script_result, exchange.post_script_result)
        .dump (2),
        "application/json");
    };
    ctx.server.Post ("/execute", execute_request);
    ctx.server.Post ("/request", deprecated_alias (execute_request));

    /**
     * POST /runs  (alias: POST /run, deprecated)
     * Starts a load test run (Vayu Mode).
     *
     * Returns:
     * - 202: Load test accepted and started
     * - 400: Invalid request format
     */
    httplib::Server::Handler start_load_test =
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        // Parse JSON
        nlohmann::json json;
        try {
            json = nlohmann::json::parse (req.body);
        } catch (const nlohmann::json::exception& e) {
            vayu::utils::log_warning (
            "POST /runs - Invalid JSON: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON: " + std::string (e.what ()));
            return;
        }

        // A scenario run states its work as an ordered collection, so it has no
        // single method/url to require and states its iteration count inside
        // the block. Both checks below describe the single-request payload
        // only; the scenario block's own required fields are checked by
        // resolve_scenario further down, beside the shared numeric validation.
        const bool is_scenario =
        json.contains ("scenario") && !json["scenario"].is_null ();
        // A `scenario` block with a load `mode` beside it is a load-mode
        // scenario: the same plan, driven by virtual users on the event loop
        // instead of one sequence through the client. Without a mode it is the
        // design-mode collection run every caller sent before phase 6, so the
        // absence of `mode` cannot start meaning something new.
        const bool is_scenario_load = vayu::core::is_scenario_load_run (json);

        // Refused before the run row exists, and never quietly downgraded to a
        // closed-loop mode: a run that measured something other than what was
        // asked for is worse than no run at all.
        if (is_scenario_load) {
            if (auto invalid = vayu::core::validate_scenario_load_config (json)) {
                vayu::utils::log_warning (
                "POST /runs - Invalid scenario load config: " + *invalid);
                send_error (res, 400, *invalid, "invalid_run_config");
                return;
            }
        }

        // Validate required fields
        if (!is_scenario) {
            if (!json.contains ("method") || !json.contains ("url")) {
                vayu::utils::log_warning (
                "POST /runs - Missing required fields: method, url");
                send_error (res, 400, "Missing required fields: method, url");
                return;
            }

            if (!json.contains ("mode") && !json.contains ("duration") &&
            !json.contains ("iterations")) {
                vayu::utils::log_warning (
                "POST /runs - Missing mode/duration/iterations config");
                send_error (res, 400,
                "Must specify either 'mode' with 'duration' or 'iterations'");
                return;
            }
        }

        // Range-check the numeric config *before* the run row exists, so a
        // rejected request leaves nothing behind. `invalid_run_config` is the
        // specific code this failure carries in place of the per-status default.
        if (auto invalid =
            validate_run_config (json, vayu::core::read_monitor_limits (ctx.db))) {
            vayu::utils::log_warning ("POST /runs - Invalid run config: " + *invalid);
            send_error (res, 400, *invalid, "invalid_run_config");
            return;
        }

        // Validate/normalize the body's httpVersion, beside the config check
        // above and for the same reason: both run before run.config_snapshot is
        // built, so a rejected request leaves no row behind, and the snapshot
        // still reflects the raw client body (sanitize_config_snapshot reads
        // req.body directly, not this normalized `json`).
        if (auto err = normalize_run_http_version (json)) {
            vayu::utils::log_warning (
            "POST /runs - Invalid httpVersion: " + err->second.dump ());
            res.status = err->first;
            res.set_content (err->second.dump (), "application/json");
            return;
        }

        // Resolve the scenario block here, with the rest of the pre-row
        // validation: an unknown collection, an empty sequence or a step that
        // cannot be composed must leave no run behind, and resolution is what
        // finds all three.
        //
        // Resolution happens exactly once, before the first send: a collection
        // edited mid-run must not change the sequence underneath itself, and
        // the load-mode executor (phase 6) cannot query SQLite per step per
        // virtual user. The resolved plan is then shared immutably with the
        // run's worker and lives in memory for the run's life and nowhere else.
        std::shared_ptr<const vayu::core::ScenarioExecution> scenario_execution;
        nlohmann::json scenario_manifest;
        if (is_scenario) {
            vayu::core::ScenarioResolveOptions options;
            if (auto it = json.find ("environmentId");
                it != json.end () && it->is_string ()) {
                options.environment_id = it->get<std::string> ();
            }
            options.timeout_ms = resolve_request_timeout_ms (json,
            ctx.db.get_config_int ("defaultTimeout",
            vayu::core::constants::server::DEFAULT_TIMEOUT_MS));
            options.limits.max_steps =
            static_cast<size_t> (ctx.db.get_config_int ("maxScenarioSteps",
            static_cast<int> (vayu::core::constants::scenario::MAX_STEPS)));
            options.limits.max_data_rows =
            static_cast<size_t> (ctx.db.get_config_int ("maxScenarioDataRows",
            static_cast<int> (vayu::core::constants::scenario::MAX_DATA_ROWS)));
            options.limits.max_data_bytes =
            static_cast<size_t> (ctx.db.get_config_int ("maxScenarioDataBytes",
            static_cast<int> (vayu::core::constants::scenario::MAX_DATA_BYTES)));

            auto resolved =
            vayu::core::resolve_scenario (ctx.db, json["scenario"], options);
            if (!resolved.ok) {
                vayu::utils::log_warning (
                "POST /runs - Invalid scenario: " + resolved.error);
                send_error (res, 400, resolved.error, "invalid_scenario");
                return;
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
            scenario_execution   = std::move (execution);

            vayu::utils::log_info ("POST /runs - Scenario: collection=" +
            scenario_execution->request.collection_id +
            ", steps=" + std::to_string (scenario_execution->plan.steps.size ()) +
            ", iterations=" + std::to_string (scenario_execution->request.iterations));
        }

        // Create run record
        std::string run_id = vayu::utils::generate_id ("run_");
        vayu::db::Run run;
        run.id     = run_id;
        // A scenario *load* run is a load run whose target happens to be a
        // sequence: it publishes metric ticks, reports RPS and percentiles, and
        // stores no per-step `results` rows - so `Scenario`, which is what the
        // app reads to render a step list instead of the dashboard, would point
        // every consumer at the wrong view of it. The step breakdown reaches
        // the report through the summary's `scenario` object instead, and the
        // snapshot still carries the manifest, so the list row still says which
        // collection ran.
        run.type = (is_scenario && !is_scenario_load) ? vayu::RunType::Scenario :
                                                        vayu::RunType::Load;
        run.status = vayu::RunStatus::Pending;
        run.config_snapshot = vayu::json::sanitize_config_snapshot (req.body);
        if (is_scenario) {
            run.config_snapshot =
            scenario_snapshot (run.config_snapshot, scenario_manifest);
        }
        seed_run_times (run, now_ms ());

        if (json.contains ("requestId") && !json["requestId"].is_null ()) {
            run.request_id = json["requestId"].get<std::string> ();
        }
        if (json.contains ("environmentId") && !json["environmentId"].is_null ()) {
            run.environment_id = json["environmentId"].get<std::string> ();
        }

        // Extract duration for logging
        std::string duration_str = "0s";
        if (json.contains ("duration")) {
            if (json["duration"].is_string ()) {
                duration_str = json["duration"].get<std::string> ();
            } else if (json["duration"].is_number ()) {
                duration_str = std::to_string (json["duration"].get<int> ()) + "s";
            }
        }

        if (is_scenario) {
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

        // Pre-flight auth: reject an unauthorizable run before creating it, and
        // warm the token cache so the worker's apply_auth is a cache hit. A
        // scenario payload carries no run-level `auth` - each step's auth was
        // resolved at plan time, and a step that could not be authorized
        // already failed resolution with a 400 - so this is the single-request
        // path's check alone.
        if (!is_scenario) {
            auto preflight =
            vayu::http::preflight_auth (json.value ("auth", nlohmann::json ()), ctx.db);
            if (!preflight.ok) {
                vayu::utils::log_warning ("POST /runs - Auth pre-flight failed: " +
                preflight.message);
                res.status =
                (preflight.code == vayu::ErrorCode::AuthRequired) ? 409 : 400;
                res.set_content (
                error_body (res.status, preflight.message, preflight.detail_code).dump (),
                "application/json");
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
        ctx.run_manager.start_scenario_run (run_id, json, scenario_execution,
        ctx.db, ctx.cookie_jar, ctx.verbose) :
        ctx.run_manager.start_run (run_id, json, ctx.db, ctx.verbose,
        is_scenario_load ? scenario_execution : nullptr);
        if (!started) {
            send_error (res, 503, "Engine is shutting down");
            return;
        }

        nlohmann::json response;
        response["runId"]   = run_id;
        response["status"]  = to_string (vayu::RunStatus::Pending);
        response["message"] = is_scenario_load ? "Scenario load test started" :
        (is_scenario ? "Collection run started" : "Load test started");

        res.status = 202;
        res.set_content (response.dump (), "application/json");
    };
    ctx.server.Post ("/runs", start_load_test);
    ctx.server.Post ("/run", deprecated_alias (start_load_test));
}

} // namespace vayu::http::routes
