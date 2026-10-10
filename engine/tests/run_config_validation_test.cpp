/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_config_validation_test.cpp
 * @brief POST /runs config range validation, and the collector's own guard.
 *
 * Every case here is a value that used to kill or wedge the daemon rather than
 * fail the request: `success_sample_rate: 0` reached a `% 0`, `concurrency: -1`
 * became ~1.8e19 eagerly pre-allocated curl handles, `timeout: 0` produced
 * transfers that never expire, and a JSON-number `duration` threw out of
 * RunContext's constructor after the run row had already been written.
 *
 * `validate_run_config` runs in the route before `create_run`, which is the
 * property that matters as much as the 400: a rejected config must leave no
 * run row behind. Most cases drive the function directly; the
 * `RunConfigValidationRouteTest` cases at the end go through the real
 * `POST /runs` handler for what only the route decides - that a `null` member
 * is absent by the time the run reads it, and that no answer but a 202 leaves
 * the row `pending` (#1893).
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`; `url_scheme_test.cpp`
// carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <array>
#include <chrono>
#include <cstdint>
#include <functional>
#include <gtest/gtest.h>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <httplib.h>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/monitor.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"

namespace vayu::http::routes {
// Declared here rather than in routes.hpp, matching apply_config_update in
// config_route_test.cpp: the extracted cores are implementation details of the
// route, and only their tests need the prototypes.
std::optional<std::string> validate_run_config (const nlohmann::json& config,
const vayu::core::MonitorLimits& monitor_limits = {});
std::optional<RouteError> start_created_run (vayu::db::Database& db,
const std::string& run_id,
const std::function<bool ()>& start);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::validate_run_config;

// A config that passes, so each test can change exactly one field and know the
// verdict came from that field.
nlohmann::json valid_config () {
    return nlohmann::json{ { "method", "GET" }, { "url", "http://localhost/" },
        { "mode", "constant_rps" }, { "duration", "60s" }, { "rps", 100 },
        { "concurrency", 10 }, { "success_sample_rate", 10 },
        { "response_sample_rate", 10 }, { "timeout", 30000 } };
}

// Assert rejection and that the message names the offending key - a 400 whose
// body does not say which field is wrong is barely better than a crash.
void expect_rejected (const nlohmann::json& config, const std::string& key) {
    auto reason = validate_run_config (config);
    ASSERT_HAS_VALUE (reason)
    << "expected rejection for " << key << " in " << config.dump ();
    EXPECT_NE (reason->find (key), std::string::npos)
    << "message should name '" << key << "', got: " << *reason;
}

} // namespace

TEST (RunConfigValidation, AcceptsATypicalConfig) {
    EXPECT_FALSE (validate_run_config (valid_config ()).has_value ());
}

TEST (RunConfigValidation, AcceptsAConfigThatOmitsEveryOptionalField) {
    // Absent is not out of range - every field here has a default.
    nlohmann::json config{ { "method", "GET" }, { "url", "http://localhost/" },
        { "iterations", 10 } };
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

TEST (RunConfigValidation, AcceptsExplicitNullsAsAbsent) {
    // The renderer omits fields by sending undefined, but a JSON `null` is what
    // some clients emit for "unset"; treating it as "out of range" would reject
    // a config that behaves identically to one that omitted the key. Accepting
    // it here is only half of that promise: the route erases every top-level
    // null before the run reads its config (`json::value` throws on one), held
    // by `RunConfigValidationRouteTest.NullMembersRunWithTheirDefaults`.
    auto config                   = valid_config ();
    config["concurrency"]         = nullptr;
    config["success_sample_rate"] = nullptr;
    config["duration"]            = nullptr;
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

// --- 1. Sample rates: 0 was `% 0`, a SIGFPE in the hot record path ---------

TEST (RunConfigValidation, ZeroSuccessSampleRateIsRejected) {
    auto config                   = valid_config ();
    config["success_sample_rate"] = 0;
    expect_rejected (config, "success_sample_rate");
}

TEST (RunConfigValidation, ZeroResponseSampleRateIsRejected) {
    auto config                    = valid_config ();
    config["response_sample_rate"] = 0;
    expect_rejected (config, "response_sample_rate");
}

TEST (RunConfigValidation, NegativeSampleRateIsRejected) {
    auto config                   = valid_config ();
    config["success_sample_rate"] = -1;
    expect_rejected (config, "success_sample_rate");
}

TEST (RunConfigValidation, SampleRateOfOneIsAccepted) {
    // 1 means "keep every request" - the busiest legal value, and the boundary.
    auto config                    = valid_config ();
    config["success_sample_rate"]  = 1;
    config["response_sample_rate"] = 1;
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

// --- 2. Concurrency and the in-flight ceiling: negative became ~1.8e19 -----

namespace {

/// One integer field `validate_run_config` holds to an inclusive
/// `[min, max]`. `mode`, when set, is written beside the field because the
/// field only means something in that mode.
struct BoundedCountCase {
    const char* name;
    const char* key;
    const char* mode;
    int64_t min;
    int64_t max;
};

constexpr auto BOUNDED_COUNT_CASES = std::to_array<BoundedCountCase> ({
// `{"concurrency": -1}` is the natural "unlimited" guess, and was the fastest
// way to OOM the daemon before any traffic flowed.
{ "Concurrency", "concurrency", nullptr, 1, vayu::core::constants::run_config::MAX_CONCURRENCY },
// `startConcurrency` seeds the ramp before the first duration check, and the
// MCP cap could not see it at all until it was checked here too.
{ "StartConcurrency", "startConcurrency", "ramp_up", 1,
vayu::core::constants::run_config::MAX_CONCURRENCY },
// `maxInFlight` is the only field here that bounds work *downward*: the harm
// of a bad value is not an allocation, it is the ceiling silently
// disappearing, so an open-loop run against a hanging target accumulates
// in-flight requests for its whole duration. 0 would be "drop everything",
// not "no cap" - either reading is a run that does not do what the caller
// asked, so it is rejected rather than guessed.
{ "MaxInFlight", "maxInFlight", nullptr, 1, vayu::core::constants::run_config::MAX_IN_FLIGHT },
// An iterations run stops on its count alone, and `-1` cast to a size_t was a
// run that never ended until stopped (#1893). 0 is not "unlimited" either.
{ "Iterations", "iterations", "iterations", 1, vayu::core::constants::run_config::MAX_ITERATIONS },
// The two spellings of the arrival rate. 0 asks for no rate, which is legal in
// a mode that does not need one; `constant_rps` has its own rule below.
{ "Rps", "rps", "constant_concurrency", 0, vayu::core::constants::run_config::MAX_TARGET_RPS },
{ "TargetRps", "targetRps", "constant_concurrency", 0, vayu::core::constants::run_config::MAX_TARGET_RPS },
});

class RunConfigBoundedCount : public ::testing::TestWithParam<BoundedCountCase> {
    protected:
    static nlohmann::json config_with (const BoundedCountCase& c, int64_t value) {
        auto config = valid_config ();
        if (c.mode != nullptr) {
            config["mode"] = c.mode;
        }
        config[c.key] = value;
        return config;
    }
};

} // namespace

TEST_P (RunConfigBoundedCount, BoundsAreInclusiveAndEverythingOutsideIsRejected) {
    const auto& c = GetParam ();
    EXPECT_FALSE (validate_run_config (config_with (c, c.min)).has_value ())
    << c.key << " = " << c.min;
    EXPECT_FALSE (validate_run_config (config_with (c, c.max)).has_value ())
    << c.key << " = " << c.max;
    expect_rejected (config_with (c, -1), c.key);
    expect_rejected (config_with (c, c.min - 1), c.key);
    expect_rejected (config_with (c, c.max + 1), c.key);
}

INSTANTIATE_TEST_SUITE_P (RunConfigValidation,
RunConfigBoundedCount,
::testing::ValuesIn (BOUNDED_COUNT_CASES),
[] (const ::testing::TestParamInfo<BoundedCountCase>& info) {
    return std::string (info.param.name);
});

// The backpressure ceiling is not the connection guard, and the two are not
// interchangeable: `MAX_CONCURRENCY` bounds an eager per-worker curl-handle
// pre-allocation, `maxInFlight` bounds a counter that pre-allocates nothing.
// Borrowing the connection guard for it refused, with a 400, exactly the
// ceilings the engine's own default formula reaches on its own.
TEST (RunConfigValidation, MaxInFlightAcceptsWhatTheDefaultFormulaReaches) {
    // `max(targetRps * 10, 1000)` (load_strategy.cpp) at the load dialog's
    // 50k RPS maximum. Omitted, this ceiling is used without complaint; asking
    // for it explicitly must not be a 400.
    auto config           = valid_config ();
    config["maxInFlight"] = 500000;
    EXPECT_FALSE (validate_run_config (config).has_value ());
    EXPECT_GT (config["maxInFlight"].get<int64_t> (),
    vayu::core::constants::run_config::MAX_CONCURRENCY)
    << "the case no longer covers the asymmetry it was written for";
}

// --- 3. Timeout: <= 0 left transfers that never expire ---------------------

TEST (RunConfigValidation, ZeroTimeoutIsRejected) {
    // 0 is curl's "wait forever": the run never reaches a terminal status and
    // (with the stop bug in #124) cannot be stopped either.
    auto config       = valid_config ();
    config["timeout"] = 0;
    expect_rejected (config, "timeout");
}

TEST (RunConfigValidation, NegativeTimeoutIsRejected) {
    auto config       = valid_config ();
    config["timeout"] = -5000;
    expect_rejected (config, "timeout");
}

// --- 4. Duration: a JSON number threw out of RunContext's constructor ------

TEST (RunConfigValidation, NumericDurationIsRejected) {
    // `config.value ("duration", "60s")` on a number throws type_error.302 from
    // RunContext's constructor - after the route has written the run row, which
    // then sits `pending` forever behind an opaque 500.
    auto config        = valid_config ();
    config["duration"] = 60;
    expect_rejected (config, "duration");
}

TEST (RunConfigValidation, NonStringDurationTypesAreRejected) {
    for (const nlohmann::json& bad :
    { nlohmann::json (true), nlohmann::json (nlohmann::json::array ({ 1 })),
    nlohmann::json (nlohmann::json::object ()) }) {
        auto config        = valid_config ();
        config["duration"] = bad;
        expect_rejected (config, "duration");
    }
}

TEST (RunConfigValidation, UnparseableDurationStringIsRejected) {
    for (const std::string bad : { "", "abc", "60 seconds", "-30s", "s", "1e3s" }) {
        auto config        = valid_config ();
        config["duration"] = bad;
        expect_rejected (config, "duration");
    }
}

TEST (RunConfigValidation, ZeroDurationIsRejected) {
    auto config        = valid_config ();
    config["duration"] = "0s";
    expect_rejected (config, "duration");
}

TEST (RunConfigValidation, DurationUnitsAndBareNumbersAreAccepted) {
    // The unit-aware *interpretation* is #126's; this guard only separates
    // "parses to something positive" from "wedges the run", so a bare "60" -
    // what a client that never read the docs sends - must still be accepted.
    for (const std::string good :
    { "60s", "500ms", "5m", "2h", "60", "1.5s", " 60s ", "30S" }) {
        auto config        = valid_config ();
        config["duration"] = good;
        EXPECT_FALSE (validate_run_config (config).has_value ())
        << "expected '" << good << "' to be accepted";
    }
}

// --- rampUpDuration: read at run time by the same parser, after the row ----
//
// It was not checked at all (#1893), so `"10sec"` created a row, flipped it
// `running` and then `failed`. Its rule is the reader's, not `duration`'s:
// zero is an instant ramp and a JSON number is seconds.

TEST (RunConfigValidation, AnUnreadableRampUpDurationIsRejected) {
    for (const nlohmann::json& bad : { nlohmann::json ("10sec"), nlohmann::json ("soon"),
         nlohmann::json ("-1s"), nlohmann::json (""), nlohmann::json ("1e3s"),
         nlohmann::json (-1), nlohmann::json (true), nlohmann::json::array ({ 1 }) }) {
        auto config              = valid_config ();
        config["mode"]           = "ramp_up";
        config["rampUpDuration"] = bad;
        expect_rejected (config, "rampUpDuration");
    }
}

TEST (RunConfigValidation, RampUpDurationAcceptsZeroAndNumbersOfSeconds) {
    for (const nlohmann::json& good : { nlohmann::json ("0"),
         nlohmann::json ("0s"), nlohmann::json (0), nlohmann::json (10),
         nlohmann::json (2.5), nlohmann::json ("10s"), nlohmann::json ("500ms"),
         nlohmann::json (" 1M "), nlohmann::json (nullptr) }) {
        auto config              = valid_config ();
        config["mode"]           = "ramp_up";
        config["rampUpDuration"] = good;
        EXPECT_FALSE (validate_run_config (config).has_value ())
        << "expected " << good.dump () << " to be accepted";
    }
}

// --- constant_rps without a rate silently ran closed-loop (#1893) ----------

TEST (RunConfigValidation, ConstantRpsWithoutAPositiveRateIsRejected) {
    auto absent = valid_config ();
    absent.erase ("rps");
    expect_rejected (absent, "targetRps");

    // `null` is absent, here as everywhere else.
    auto null_rate   = valid_config ();
    null_rate["rps"] = nullptr;
    expect_rejected (null_rate, "targetRps");

    for (const char* key : { "rps", "targetRps" }) {
        auto zero = valid_config ();
        zero.erase ("rps");
        zero[key] = 0;
        expect_rejected (zero, "targetRps");

        auto negative = valid_config ();
        negative.erase ("rps");
        negative[key] = -5;
        expect_rejected (negative, key);
    }
}

TEST (RunConfigValidation, ConstantRpsTakesEitherSpellingAndAFractionalRate) {
    // `rps: 0` falls through to `targetRps`, as the executor reads it.
    auto fallback         = valid_config ();
    fallback["rps"]       = 0;
    fallback["targetRps"] = 250;
    EXPECT_FALSE (validate_run_config (fallback).has_value ());

    auto slow   = valid_config ();
    slow["rps"] = 0.5;
    EXPECT_FALSE (validate_run_config (slow).has_value ());
}

TEST (RunConfigValidation, OnlyALiteralConstantRpsNeedsARate) {
    // An absent mode reaches the same strategy, but nothing in the payload
    // claims a rate, so there is nothing to contradict.
    for (const char* mode : { "constant_concurrency", "ramp_up", "iterations", "" }) {
        auto config = valid_config ();
        config.erase ("rps");
        if (*mode == '\0') {
            config.erase ("mode");
        } else {
            config["mode"] = mode;
        }
        EXPECT_FALSE (validate_run_config (config).has_value ()) << "mode '" << mode << "'";
    }
}

// --- Type guards: a wrong-typed number also throws from `config.value` -----

TEST (RunConfigValidation, NonNumericNumericFieldsAreRejected) {
    auto config           = valid_config ();
    config["concurrency"] = "ten";
    expect_rejected (config, "concurrency");

    config            = valid_config ();
    config["timeout"] = true;
    expect_rejected (config, "timeout");
}

TEST (RunConfigValidation, NonObjectConfigIsRejected) {
    EXPECT_TRUE (validate_run_config (nlohmann::json::array ()).has_value ());
    EXPECT_TRUE (validate_run_config (nlohmann::json ("nope")).has_value ());
}

// --- `transient` belongs to POST /execute, never to a run (issue #382) -----

TEST (RunConfigValidation, TransientIsRejectedOnALoadRun) {
    // A run *is* its row - the run id is what POST /runs returns and what the
    // live stream, the report and the step store are all keyed by. Ignoring the
    // flag would leave a caller believing a load run left nothing behind while
    // it wrote the largest trace the store holds.
    auto config         = valid_config ();
    config["transient"] = true;
    expect_rejected (config, "transient");
}

TEST (RunConfigValidation, TransientIsRejectedOnAScenarioRun) {
    // A scenario payload has no method/url of its own, so it is the shape most
    // likely to be hand-assembled from an /execute payload - the one place the
    // flag could realistically be carried over by accident.
    nlohmann::json config{ { "scenario", { { "collectionId", "col_1" } } },
        { "iterations", 2 }, { "transient", true } };
    expect_rejected (config, "transient");
}

TEST (RunConfigValidation, TransientFalseIsRejectedToo) {
    // Presence is the error, not the value: `false` on a run is not "recorded
    // as usual", it is a caller who thinks this endpoint has a mode it does not.
    auto config         = valid_config ();
    config["transient"] = false;
    expect_rejected (config, "transient");
}

TEST (RunConfigValidation, ANullTransientIsAcceptedAsAbsent) {
    // Same absent-vs-null rule the numeric fields follow above: a client that
    // spells "unset" as `null` sent no flag.
    auto config         = valid_config ();
    config["transient"] = nullptr;
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

// --- `stream` is a run's execution model now, with caps (issue #576) -------

TEST (RunConfigValidation, StreamIsAcceptedOnALoadRun) {
    // Refused outright through phase 3, because a load run's completion
    // accounting has no place for a response that never ends. What changed is
    // that a load stream always ends: the caps below - or the engine's `sse*`
    // settings when the caller names none - bound every transfer.
    auto config      = valid_config ();
    config["stream"] = true;
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

TEST (RunConfigValidation, StreamIsAcceptedWithExplicitCaps) {
    auto config                   = valid_config ();
    config["stream"]              = true;
    config["maxStreamDurationMs"] = 30000;
    config["maxStreamEvents"]     = 200;
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

TEST (RunConfigValidation, ACapOutOfRangeIsRejected) {
    // The same bounds `POST /execute` enforces, because both endpoints read
    // through `read_stream_flag`. A cap of 0 events is the one that matters
    // most: it would be a stream that must end before it begins.
    auto config               = valid_config ();
    config["stream"]          = true;
    config["maxStreamEvents"] = 0;
    expect_rejected (config, "maxStreamEvents");

    auto slow                   = valid_config ();
    slow["stream"]              = true;
    slow["maxStreamDurationMs"] = 10; // below MIN_STREAM_DURATION_MS
    expect_rejected (slow, "maxStreamDurationMs");
}

TEST (RunConfigValidation, ANonBooleanStreamIsRejected) {
    auto config      = valid_config ();
    config["stream"] = "true";
    expect_rejected (config, "stream");
}

TEST (RunConfigValidation, CapsWithoutStreamAreRejected) {
    // A cap on a non-streaming run reads as a bound the caller expects to
    // apply, and silently ignoring it is how an unbounded run gets mistaken for
    // a capped one. Same refusal, same message, as on a send.
    auto config               = valid_config ();
    config["maxStreamEvents"] = 100;
    expect_rejected (config, "maxStreamEvents");
}

TEST (RunConfigValidation, ANullStreamIsAcceptedAsAbsent) {
    auto config      = valid_config ();
    config["stream"] = nullptr;
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

TEST (RunConfigValidation, StreamMetricsMustBeABoolean) {
    // Read with `config.value(..., bool)` in RunContext's constructor, which
    // throws on a string - after the run row exists, which is the stranded
    // `pending` failure this whole function prevents.
    auto config              = valid_config ();
    config["stream_metrics"] = "off";
    expect_rejected (config, "stream_metrics");

    auto ok              = valid_config ();
    ok["stream_metrics"] = false;
    EXPECT_FALSE (validate_run_config (ok).has_value ());
}

// --- The collector's own guard, independent of the route ------------------

TEST (MetricsCollectorSampleRateGuard, ZeroSampleRatesDoNotDivideByZero) {
    // Belt and braces: the route rejects a 0, but the collector is a library
    // type any caller can construct. Before the clamp this SIGFPE'd twice -
    // once in the constructor's `expected / success_sample_rate` reserve, once
    // per recorded request in `counter % success_sample_rate`.
    vayu::core::MetricsCollectorConfig config;
    config.success_sample_rate  = 0;
    config.response_sample_rate = 0;
    config.store_success_traces = true;
    config.expected_requests    = 1000;

    vayu::core::MetricsCollector collector ("run_zero_rate", config);

    vayu::Response response;
    response.status_code = 200;

    // Each of these hits one of the former divide-by-zero sites.
    for (int i = 0; i < 5; ++i) {
        collector.record_success (200, 1.5, 0.0, R"({"timing":{}})");
        collector.record_response_sample (response);
    }

    EXPECT_EQ (collector.success_count (), 5);
    // Clamped to 1, so "keep 1 in N" keeps every one of them.
    EXPECT_EQ (collector.response_sample_count (), 5U);
}

// --- 6. Retention limits: reserved up front, so a negative is an eager
//        allocation of ~1.8e19 records, and the threshold decides what is even
//        a candidate -------------------------------------------------------

TEST (RunConfigValidation, NegativeRetentionLimitsAreRejected) {
    for (const char* key : { "max_success_results", "max_slow_results" }) {
        auto config = valid_config ();
        config[key] = -1;
        expect_rejected (config, key);
    }
}

TEST (RunConfigValidation, HugeRetentionLimitsAreRejected) {
    auto config = valid_config ();
    config["max_success_results"] =
    vayu::core::constants::run_config::MAX_RETAINED_RESULTS + 1;
    expect_rejected (config, "max_success_results");
}

TEST (RunConfigValidation, ZeroRetentionLimitIsAcceptedAsUnlimited) {
    // 0 is the documented "keep everything" opt-out, not an out-of-range value.
    auto config                   = valid_config ();
    config["max_success_results"] = 0;
    config["max_slow_results"]    = 0;
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

// The reservoir's other dimension (issue #1155). Read as a size_t like its
// neighbours, so a negative is ~1.8e19 - a budget that removes the bound it
// exists to provide rather than widening it.
TEST (RunConfigValidation, SampleBudgetBoundsAreInclusive) {
    auto config                         = valid_config ();
    config["max_response_sample_bytes"] = 0;
    EXPECT_FALSE (validate_run_config (config).has_value ());
    config["max_response_sample_bytes"] =
    vayu::core::constants::run_config::MAX_RESPONSE_SAMPLE_BYTES;
    EXPECT_FALSE (validate_run_config (config).has_value ());
    config["max_response_sample_bytes"] =
    vayu::core::constants::run_config::MAX_RESPONSE_SAMPLE_BYTES + 1;
    expect_rejected (config, "max_response_sample_bytes");
    config["max_response_sample_bytes"] = -1;
    expect_rejected (config, "max_response_sample_bytes");
}

TEST (RunConfigValidation, NegativeSlowThresholdIsRejected) {
    // A negative threshold would make every completion an outlier, filling the
    // slow store with the whole run.
    auto config                 = valid_config ();
    config["slow_threshold_ms"] = -1;
    expect_rejected (config, "slow_threshold_ms");
}

TEST (RunConfigValidation, ZeroSlowThresholdIsAcceptedAsDisabled) {
    auto config                 = valid_config ();
    config["slow_threshold_ms"] = 0;
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

// --- 7. Thresholds: the one nested object the route gates ------------------
//
// The rule itself is `vayu::core::validate_thresholds` and is tested against
// every metric in threshold_eval_test.cpp. What matters here is that the run
// route reaches it at all: an unusable budget must be a 400 before a run row
// exists, not a run that completes carrying a verdict nobody can compute.

TEST (RunConfigValidation, AConfigWithoutThresholdsIsStillValid) {
    EXPECT_FALSE (validate_run_config (valid_config ()).has_value ());
}

TEST (RunConfigValidation, AValidThresholdsObjectIsAccepted) {
    auto config = valid_config ();
    config["thresholds"] = { { "latencyP99Ms", 50 }, { "maxErrorRatePct", 0.1 } };
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

TEST (RunConfigValidation, AnUnknownThresholdKeyIsRejectedByTheRunRoute) {
    auto config          = valid_config ();
    config["thresholds"] = { { "latencyP42Ms", 50 } };
    expect_rejected (config, "latencyP42Ms");
}

TEST (RunConfigValidation, AnEmptyThresholdsObjectIsRejectedByTheRunRoute) {
    auto config          = valid_config ();
    config["thresholds"] = nlohmann::json::object ();
    expect_rejected (config, "thresholds");
}

// --- 8. Monitor: the other nested object the route gates -------------------
//
// Same split as thresholds above: the rule lives with the scrape loop
// (`vayu::core::validate_monitor_config`, exercised field by field in
// monitor_test.cpp), and what matters here is that the run route reaches it -
// an unusable monitor block must be a 400 before a run row exists, not a run
// that starts a scrape thread with nothing to read.

TEST (RunConfigValidation, AConfigWithoutAMonitorIsStillValid) {
    auto config = valid_config ();
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

TEST (RunConfigValidation, AValidMonitorBlockIsAccepted) {
    auto config       = valid_config ();
    config["monitor"] = { { "url", "http://127.0.0.1:9100/metrics" },
        { "intervalMs", 1000 },
        { "series", nlohmann::json::array ({ "node_cpu_seconds_total" }) } };
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

TEST (RunConfigValidation, AMonitorWithoutSeriesIsRejectedByTheRunRoute) {
    auto config       = valid_config ();
    config["monitor"] = { { "url", "http://127.0.0.1:9100/metrics" } };
    expect_rejected (config, "monitor.series");
}

TEST (RunConfigValidation, AMonitorIntervalOutOfRangeIsRejectedByTheRunRoute) {
    auto config       = valid_config ();
    config["monitor"] = { { "url", "http://127.0.0.1:9100/metrics" },
        { "intervalMs", 10 }, { "series", nlohmann::json::array ({ "up" }) } };
    expect_rejected (config, "monitor.intervalMs");
}

// --- Capacity discovery: the two fields the mode adds ----------------------
//
// `stepDuration` reads through the same string parser `duration` does, so it
// has to be gated by the same rule - it went through a shared helper for
// exactly that reason. `sloMs` is a plain numeric field, and the bound it gets
// is the app's own clamp on the SLO setting, so a budget the dialog can express
// is one the engine accepts.

TEST (RunConfigValidation, AValidCapacityConfigIsAccepted) {
    auto config            = valid_config ();
    config["mode"]         = "capacity";
    config["sloMs"]        = 250;
    config["stepDuration"] = "5s";
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

TEST (RunConfigValidation, AnUnparseableStepDurationIsRejected) {
    for (const nlohmann::json& bad : { nlohmann::json (5000), nlohmann::json ("soon"),
         nlohmann::json ("0s"), nlohmann::json ("-1s"), nlohmann::json (true) }) {
        auto config            = valid_config ();
        config["stepDuration"] = bad;
        expect_rejected (config, "stepDuration");
    }
}

TEST (RunConfigValidation, StepDurationAcceptsTheSameSpellingsAsDuration) {
    for (const std::string good : { "5s", "500ms", "1m", "5", "2.5s" }) {
        auto config            = valid_config ();
        config["stepDuration"] = good;
        EXPECT_FALSE (validate_run_config (config).has_value ())
        << "expected '" << good << "' to be accepted";
    }
}

TEST (RunConfigValidation, ANullStepDurationIsAcceptedAsAbsent) {
    auto config            = valid_config ();
    config["stepDuration"] = nullptr;
    EXPECT_FALSE (validate_run_config (config).has_value ());
}

TEST (RunConfigValidation, AnOutOfRangeSloIsRejected) {
    for (const nlohmann::json& bad : { nlohmann::json (0), nlohmann::json (-1),
         nlohmann::json (60001), nlohmann::json ("fast") }) {
        auto config     = valid_config ();
        config["sloMs"] = bad;
        expect_rejected (config, "sloMs");
    }
}

// --- 8. The boolean run-config settings (issues #476, #504) ---------------

// Each is read as a bool inside RunContext's constructor, which throws on a
// string - after the run row exists. Rejected here so a rejected request leaves
// no trace, like every other field in this function.
//
// Mutation check: delete any one key from the guard's list in
// validate_run_config and that key's string case below is accepted.
TEST (RunConfigValidation, ANonBooleanBooleanSettingIsRejected) {
    for (const char* key :
    { "phase_histograms", "save_timing_breakdown", "capture_response_bodies" }) {
        for (const nlohmann::json& bad : { nlohmann::json ("true"),
             nlohmann::json (1), nlohmann::json (nlohmann::json::array ()) }) {
            auto config = valid_config ();
            config[key] = bad;
            expect_rejected (config, key);
        }
    }
}

TEST (RunConfigValidation, BothValuesOfEveryBooleanSettingAreAccepted) {
    for (const char* key :
    { "phase_histograms", "save_timing_breakdown", "capture_response_bodies" }) {
        for (const bool value : { true, false }) {
            auto config = valid_config ();
            config[key] = value;
            EXPECT_FALSE (validate_run_config (config).has_value ())
            << key << " = " << value << " was refused";
        }
        // Absent and null both mean "use the engine setting".
        auto config = valid_config ();
        config[key] = nullptr;
        EXPECT_FALSE (validate_run_config (config).has_value ())
        << "a null " << key << " was refused";
    }
}

// --- Through the real POST /runs handler (#1893) ---------------------------
//
// What only the route decides: a `null` member is erased before anything that
// runs reads the config, and no answer but a 202 leaves the row `pending`.

namespace {

using nlohmann::json;
using vayu::http::routes::start_created_run;

class RunConfigValidationRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH =
    "test_run_config_validation_route.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<vayu::http::SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr,
        authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
        mock_server_manager_, *manager_, run_summary_cache_ });
        vayu::http::routes::register_execution_routes (*ctx_);
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    void TearDown () override {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
        // A load run's worker writes through the database until it is joined.
        run_manager_.shutdown ();
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// The status and body `POST /runs` answered @p payload with.
    std::pair<int, json> post_run (const json& payload) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/runs", payload.dump (), "application/json");
        if (!response) {
            ADD_FAILURE () << "no response from POST /runs";
            return { 0, json::object () };
        }
        return { response->status, json::parse (response->body, nullptr, false) };
    }

    /// One request, once, against @p echo: the smallest run that completes.
    static json iterations_run (const vayu::tests::EchoServer& echo) {
        return json{ { "method", "GET" }, { "url", echo.url () },
            { "mode", "iterations" }, { "iterations", 1 }, { "concurrency", 1 } };
    }

    /// The status @p run_id settles on once its worker is done with it, or
    /// what it was still stuck at when the wait gave up.
    vayu::RunStatus settled_status (const std::string& run_id) const {
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (15);
        while (true) {
            const auto run = db_->get_run (run_id);
            if (!run) {
                ADD_FAILURE () << "no row for " << run_id;
                return vayu::RunStatus::Pending;
            }
            if (run->status != vayu::RunStatus::Pending &&
            run->status != vayu::RunStatus::Running) {
                return run->status;
            }
            if (std::chrono::steady_clock::now () >= deadline) {
                ADD_FAILURE ()
                << run_id << " never left " << vayu::to_string (run->status);
                return run->status;
            }
            std::this_thread::sleep_for (std::chrono::milliseconds (20));
        }
    }

    /// A `pending` row with nothing running it, the state `create_run` leaves.
    void create_pending_run (const std::string& run_id) const {
        vayu::db::Run run;
        run.id     = run_id;
        run.type   = vayu::RunType::Load;
        run.status = vayu::RunStatus::Pending;
        db_->create_run (run);
    }

    std::unique_ptr<vayu::db::Database> db_;
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    vayu::core::RunManager run_manager_;
    vayu::http::OAuth2AuthorizeManager authorize_manager_;
    vayu::http::CookieJar cookie_jar_;
    vayu::http::MockIssuerManager mock_issuer_manager_;
    vayu::http::InboxManager inbox_manager_;
    vayu::http::MockServerManager mock_server_manager_;
    vayu::http::RunSummaryCache run_summary_cache_;
    std::unique_ptr<vayu::http::SseStreamManager> manager_;
    std::unique_ptr<vayu::http::routes::RouteContext> ctx_;
};

} // namespace

// Every key here is read through `json::value (key, default)`, which throws on
// a `null`: the first three in RunContext's constructor, after the row exists,
// which left it `pending` behind a 500; `rps` and `concurrency` already in the
// route's own start log line. Mutation check: drop the `erase_null_members`
// call and every case answers 500.
TEST_F (RunConfigValidationRouteTest, NullMembersRunWithTheirDefaults) {
    const vayu::tests::EchoServer echo;
    for (const char* key : { "success_sample_rate", "save_timing_breakdown",
         "slow_threshold_ms", "rps", "concurrency" }) {
        auto payload              = iterations_run (echo);
        payload[key]              = nullptr;
        const auto [status, body] = post_run (payload);
        ASSERT_EQ (status, 202) << key << ": " << body.dump ();

        const std::string run_id = body.value ("runId", std::string ());
        EXPECT_EQ (settled_status (run_id), vayu::RunStatus::Completed) << key;
        // The stored config is what ran, so it carries no `null` either: a
        // report reading `rps` off it would otherwise lose `targetRps`.
        const auto run = db_->get_run (run_id);
        ASSERT_HAS_VALUE (run) << key;
        EXPECT_FALSE (json::parse (run->config_snapshot).contains (key)) << run->config_snapshot;
    }
}

TEST_F (RunConfigValidationRouteTest, AnUnusableFieldIsRefusedBeforeAnyRow) {
    const vayu::tests::EchoServer echo;
    const json url{ { "method", "GET" }, { "url", echo.url () } };
    const std::vector<std::pair<std::string, json>> cases = {
        { "rampUpDuration",
        { { "mode", "ramp_up" }, { "duration", "1s" }, { "rampUpDuration", "10sec" } } },
        { "iterations", { { "mode", "iterations" }, { "iterations", -1 } } },
        { "targetRps", { { "mode", "constant_rps" }, { "duration", "1s" } } },
    };
    for (const auto& [field, fields] : cases) {
        auto payload = url;
        payload.update (fields);
        const auto [status, body] = post_run (payload);
        EXPECT_EQ (status, 400) << field << ": " << body.dump ();
        const auto error = body.find ("error");
        ASSERT_TRUE (error != body.end () && error->is_object ()) << body.dump ();
        EXPECT_EQ (error->value ("code", std::string ()), "invalid_run_config")
        << body.dump ();
        EXPECT_NE (vayu::http::routes::error_message_of (body).find (field), std::string::npos)
        << body.dump ();
    }
    EXPECT_TRUE (db_->get_all_runs ().empty ());
}

// A collection run (a scenario with a missing, empty or non-string `mode`)
// scrapes nothing, so a `monitor` block beside it used to be accepted and never
// read (#1939). Mutation check: drop the `refuse_monitor_on_collection_run`
// call in `validate_load_request` and the missing-mode, empty-mode and
// non-string-mode cases fall through to `invalid_scenario`.
TEST_F (RunConfigValidationRouteTest, AMonitorBesideACollectionRunIsRefusedBeforeAnyRow) {
    const json scenario{ { "source", "collection" }, { "collectionId", "x" } };
    const json monitor{ { "url", "http://127.0.0.1:9100/metrics" },
        { "series", json::array ({ "up" }) } };
    const std::vector<std::pair<std::string, json>> cases = {
        { "no mode", json::object () },
        { "empty mode", { { "mode", "" } } },
        { "non-string mode", { { "mode", 7 } } },
    };
    for (const auto& [label, fields] : cases) {
        json payload{ { "scenario", scenario }, { "monitor", monitor } };
        payload.update (fields);
        const auto [status, body] = post_run (payload);
        EXPECT_EQ (status, 400) << label << ": " << body.dump ();
        const auto error = body.find ("error");
        ASSERT_TRUE (error != body.end () && error->is_object ()) << body.dump ();
        EXPECT_EQ (error->value ("code", std::string ()), "invalid_run_config")
        << label << ": " << body.dump ();
        EXPECT_NE (
        vayu::http::routes::error_message_of (body).find ("'monitor'"), std::string::npos)
        << label << ": " << body.dump ();
    }
    EXPECT_TRUE (db_->get_all_runs ().empty ());
}

// The refusal is the collection-run shape's alone: a `null` monitor is "no
// block", and a real load mode beside `scenario` moves on to resolving the
// collection, which this database does not hold.
TEST_F (RunConfigValidationRouteTest, TheMonitorRefusalIsScopedToACollectionRun) {
    const json scenario{ { "source", "collection" }, { "collectionId", "x" } };
    const json monitor{ { "url", "http://127.0.0.1:9100/metrics" },
        { "series", json::array ({ "up" }) } };
    const std::vector<std::pair<std::string, json>> cases = {
        { "load mode with a monitor",
        { { "scenario", scenario }, { "monitor", monitor }, { "mode", "iterations" } } },
        { "no mode with a null monitor", { { "scenario", scenario }, { "monitor", nullptr } } },
    };
    for (const auto& [label, payload] : cases) {
        const auto [status, body] = post_run (payload);
        EXPECT_EQ (status, 400) << label << ": " << body.dump ();
        const auto error = body.find ("error");
        ASSERT_TRUE (error != body.end () && error->is_object ()) << body.dump ();
        EXPECT_EQ (error->value ("code", std::string ()), "invalid_scenario")
        << label << ": " << body.dump ();
    }
    EXPECT_TRUE (db_->get_all_runs ().empty ());
}

TEST_F (RunConfigValidationRouteTest, ASingleRequestLoadRunKeepsItsMonitor) {
    const vayu::tests::EchoServer echo;
    auto payload = iterations_run (echo);
    payload["monitor"] = { { "url", echo.url () }, { "series", json::array ({ "up" }) } };
    const auto [status, body] = post_run (payload);
    ASSERT_EQ (status, 202) << body.dump ();
    EXPECT_EQ (settled_status (body.value ("runId", std::string ())),
    vayu::RunStatus::Completed);
}

TEST_F (RunConfigValidationRouteTest, ADrainingEngineFailsTheRowItAlreadyWrote) {
    const vayu::tests::EchoServer echo;
    run_manager_.shutdown ();
    const auto [status, body] = post_run (iterations_run (echo));
    EXPECT_EQ (status, 503) << body.dump ();

    const auto runs = db_->get_all_runs ();
    ASSERT_EQ (runs.size (), 1U);
    EXPECT_EQ (runs.front ().status, vayu::RunStatus::Failed);
}

// No payload `validate_run_config` accepts reaches a throw in RunContext's
// constructor any more, so the throw is planted: this holds the net under the
// validator, which the route test above cannot reach.
TEST_F (RunConfigValidationRouteTest, AStartThatThrowsFailsTheRowAndSaysWhy) {
    create_pending_run ("run_throws");
    const auto refusal = start_created_run (*db_, "run_throws", [] () -> bool {
        throw std::runtime_error ("type must be number, but is null");
    });
    ASSERT_HAS_VALUE (refusal);
    EXPECT_EQ (refusal->status, 500);
    EXPECT_NE (vayu::http::routes::error_message_of (refusal->body).find ("but is null"),
    std::string::npos)
    << refusal->body.dump ();

    const auto run = db_->get_run ("run_throws");
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Failed);
}

TEST_F (RunConfigValidationRouteTest, AStartThatSucceedsLeavesTheRowToItsWorker) {
    create_pending_run ("run_started");
    EXPECT_FALSE (
    start_created_run (*db_, "run_started", [] () { return true; }).has_value ());

    const auto run = db_->get_run ("run_started");
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Pending);
}
