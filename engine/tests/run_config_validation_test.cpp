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
 * run row behind. Testing the function directly (the suite has no in-process
 * HTTP route harness) covers the decision; the ordering is held by the call
 * site, which sits above `ctx.db.create_run (run)` in execution.cpp.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

#include "vayu/core/constants.hpp"
#include "vayu/core/metrics_collector.hpp"

namespace vayu::http::routes {
// Declared here rather than in routes.hpp, matching apply_config_update in
// config_route_test.cpp: the extracted core is an implementation detail of the
// route, and only its test needs the prototype.
std::optional<std::string> validate_run_config (const nlohmann::json& config);
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
    ASSERT_TRUE (reason.has_value ())
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
    // a config that behaves identically to one that omitted the key.
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

// --- 2. Concurrency: negative became ~1.8e19 eager curl handles ------------

TEST (RunConfigValidation, NegativeConcurrencyIsRejected) {
    // `{"concurrency": -1}` is the natural "unlimited" guess, and was the
    // fastest way to OOM the daemon before any traffic flowed.
    auto config           = valid_config ();
    config["concurrency"] = -1;
    expect_rejected (config, "concurrency");
}

TEST (RunConfigValidation, ZeroConcurrencyIsRejected) {
    auto config           = valid_config ();
    config["concurrency"] = 0;
    expect_rejected (config, "concurrency");
}

TEST (RunConfigValidation, HugeConcurrencyIsRejected) {
    auto config           = valid_config ();
    config["concurrency"] = 100000000;
    expect_rejected (config, "concurrency");
}

TEST (RunConfigValidation, ConcurrencyBoundsAreInclusive) {
    auto config           = valid_config ();
    config["concurrency"] = 1;
    EXPECT_FALSE (validate_run_config (config).has_value ());
    config["concurrency"] = vayu::core::constants::run_config::MAX_CONCURRENCY;
    EXPECT_FALSE (validate_run_config (config).has_value ());
    config["concurrency"] = vayu::core::constants::run_config::MAX_CONCURRENCY + 1;
    expect_rejected (config, "concurrency");
}

// `startConcurrency` seeds the ramp before the first duration check, and the
// MCP cap could not see it at all until it was checked here too.
TEST (RunConfigValidation, NegativeStartConcurrencyIsRejected) {
    auto config                = valid_config ();
    config["mode"]             = "ramp_up";
    config["startConcurrency"] = -1;
    expect_rejected (config, "startConcurrency");
}

TEST (RunConfigValidation, StartConcurrencyBoundsAreInclusive) {
    auto config                = valid_config ();
    config["mode"]             = "ramp_up";
    config["startConcurrency"] = 1;
    EXPECT_FALSE (validate_run_config (config).has_value ());
    config["startConcurrency"] = vayu::core::constants::run_config::MAX_CONCURRENCY;
    EXPECT_FALSE (validate_run_config (config).has_value ());
    config["startConcurrency"] = vayu::core::constants::run_config::MAX_CONCURRENCY + 1;
    expect_rejected (config, "startConcurrency");
}

// `maxInFlight` is the only field here that bounds work *downward*: the harm of
// a bad value is not an allocation, it is the ceiling silently disappearing, so
// an open-loop run against a hanging target accumulates in-flight requests for
// its whole duration.
TEST (RunConfigValidation, NegativeMaxInFlightIsRejected) {
    auto config           = valid_config ();
    config["maxInFlight"] = -1;
    expect_rejected (config, "maxInFlight");
}

TEST (RunConfigValidation, ZeroMaxInFlightIsRejected) {
    // 0 would be "drop everything", not "no cap" - either reading is a run that
    // does not do what the caller asked, so it is rejected rather than guessed.
    auto config           = valid_config ();
    config["maxInFlight"] = 0;
    expect_rejected (config, "maxInFlight");
}

TEST (RunConfigValidation, MaxInFlightBoundsAreInclusive) {
    auto config           = valid_config ();
    config["maxInFlight"] = 1;
    EXPECT_FALSE (validate_run_config (config).has_value ());
    config["maxInFlight"] = vayu::core::constants::run_config::MAX_IN_FLIGHT;
    EXPECT_FALSE (validate_run_config (config).has_value ());
    config["maxInFlight"] = vayu::core::constants::run_config::MAX_IN_FLIGHT + 1;
    expect_rejected (config, "maxInFlight");
}

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
    for (const nlohmann::json bad :
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
    auto config          = valid_config ();
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
    config["monitor"] = { { "url", "http://127.0.0.1:9100/metrics" }, { "intervalMs", 1000 },
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
    config["monitor"] = { { "url", "http://127.0.0.1:9100/metrics" }, { "intervalMs", 10 },
        { "series", nlohmann::json::array ({ "up" }) } };
    expect_rejected (config, "monitor.intervalMs");
}
