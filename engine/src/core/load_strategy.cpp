/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/load_strategy.hpp"

#include <chrono>
#include <condition_variable>
#include <functional>
#include <iostream>
#include <limits>
#include <mutex>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <thread>

#include "vayu/core/load_pacing.hpp"
#include "vayu/core/refill_deficit.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {
const char* error_type_name (vayu::ErrorCode code) {
    switch (code) {
    case vayu::ErrorCode::Timeout: return "timeout";
    case vayu::ErrorCode::ConnectionFailed: return "connection_failed";
    case vayu::ErrorCode::DnsError: return "dns_failed";
    case vayu::ErrorCode::SslError: return "ssl_error";
    case vayu::ErrorCode::InvalidUrl: return "invalid_url";
    case vayu::ErrorCode::InvalidMethod: return "invalid_method";
    case vayu::ErrorCode::ScriptError: return "script_error";
    case vayu::ErrorCode::InternalError: return "internal_error";
    default: return "unknown";
    }
}
} // namespace

void handle_result (std::shared_ptr<RunContext> context,
vayu::db::Database& /* db - unused, kept for API compat */,
vayu::Result<vayu::Response> result) {
    // A transfer usually completes as a Response carrying error_code, but two
    // paths still produce a real Error: curl-handle creation failure, and the
    // stop(false) cancellation drain. Both raise ErrorCode::InternalError, so
    // the type is read off the code rather than assumed to be cancellation.
    // Dropping either would leave requests_sent counted with no completion,
    // permanently inflating in_flight() and shrinking effective concurrency
    // for the rest of the run.
    if (result.is_error ()) {
        const auto& error = result.error ();
        nlohmann::json error_json = { { "error_code", static_cast<int> (error.code) },
            { "error_type", error_type_name (error.code) }, { "message", error.message },
            { "request_number", context->total_requests () } };
        context->metrics_collector->record_error (
        error.code, error.message, error_json.dump ());

        if (context->closed_loop.load (std::memory_order_relaxed)) {
            context->notify_refill ();
        }
        return;
    }

    // Counted for both branches below, before either splits: a transfer that
    // connected, negotiated HTTP/1.1 against an explicit `http2`, and then
    // failed still tells the truth about the protocol the run is measuring.
    // Reading it off the Response (rather than off the request's httpVersion
    // and a string compare here) keeps the one definition in
    // http_version_downgraded - see curl_version_map.hpp.
    if (result.value ().http_version_downgraded) {
        context->metrics_collector->record_http_version_downgrade ();
    }

    if (result.value ().has_error ()) {
        // Response carrying a client-side error
        const auto& response = result.value ();

        // Build detailed error trace data
        nlohmann::json error_json = { { "error_code", static_cast<int> (response.error_code) },
            { "error_type", error_type_name (response.error_code) },
            { "message", response.error_message },
            { "request_number", context->total_requests () } };

        // Include timing info if available
        if (response.timing.total_ms > 0) {
            error_json["timing"] = { { "totalMs", response.timing.total_ms },
                { "wireMs", response.timing.wire_ms },
                { "queueWaitMs", response.timing.queue_wait_ms },
                { "dnsMs", response.timing.dns_ms },
                { "connectMs", response.timing.connect_ms },
                { "tlsMs", response.timing.tls_ms },
                { "firstByteMs", response.timing.first_byte_ms },
                { "downloadMs", response.timing.download_ms } };
        }

        // Every error is a capture candidate: a failure is exactly the sample a
        // user opens the Samples tab for, and errors are already bounded by
        // `maxStoredErrors`. Passing the response rather than a copy keeps the
        // body-sized work inside the collector, after it has decided to keep
        // the record (see MetricsCollector::record_error).
        context->metrics_collector->record_error (response.error_code,
        response.error_message, error_json.dump (),
        context->capture_response_bodies ? &response : nullptr);
        context->metrics_collector->record_bytes (
        response.timing.bytes_up, response.timing.bytes_down);
    } else {
        // Successful response
        const auto& response = result.value ();
        double latency       = response.timing.total_ms;

        // Two independent reasons to keep a trace, and both are decided before
        // anything is serialised: the 1-in-N sampler (which advances its period
        // on every completion, so this call is not optional) and the slow
        // threshold. Building first and sampling afterwards meant 99 of every
        // 100 traces were constructed and dumped inline in the completion
        // drain, then thrown away - work that delays socket processing for
        // every other transfer on the same worker.
        const bool is_slow = context->slow_threshold_ms > 0 &&
        latency >= static_cast<double> (context->slow_threshold_ms);
        const bool sampled = context->metrics_collector->should_sample_success ();
        // Third reason, and the cheapest: one relaxed fetch_add deciding
        // whether this completion is among the first few of its status code. A
        // uniform slice of a 30M-request run is a thousand identical 200s;
        // three of each code is what answers "what does this target's 503
        // look like".
        const bool exemplar =
        context->metrics_collector->claim_status_exemplar (response.status_code);

        std::string trace_data;
        auto trace_reason = SuccessTraceReason::None;

        if (sampled || is_slow || exemplar) {
            // Slow still wins, then sampled: the trace is identical either way,
            // and charging an outlier to the slow budget leaves the 1-in-N
            // budget for ordinary traffic.
            //
            // Exemplar is *last*, and only decides the store for a completion
            // no other budget wanted. Ranking it first stole outliers from the
            // slow store - the first few completions of a status code are
            // usually where a run's outliers are - which is a behaviour change
            // nobody asked for, on the store whose whole purpose is to hold
            // what the user asked for. Being retained is still guaranteed:
            // whichever budget claims it, the record is stored, and the
            // exemplar's real job (capturing a body for it) is decided
            // separately below.
            trace_reason = is_slow ? SuccessTraceReason::Slow :
            (sampled ? SuccessTraceReason::Sampled : SuccessTraceReason::Exemplar);

            nlohmann::json timing_json = { { "totalMs", response.timing.total_ms },
                { "wireMs", response.timing.wire_ms },
                { "queueWaitMs", response.timing.queue_wait_ms },
                { "dnsMs", response.timing.dns_ms },
                { "connectMs", response.timing.connect_ms },
                { "tlsMs", response.timing.tls_ms },
                { "firstByteMs", response.timing.first_byte_ms },
                { "downloadMs", response.timing.download_ms } };

            if (is_slow) {
                timing_json["isSlow"]      = true;
                timing_json["thresholdMs"] = context->slow_threshold_ms;
            }

            trace_data = timing_json.dump ();
        }

        // Whether a body is captured is decided here, not by which store won
        // above. Capture is failure-and-outlier-shaped: an outlier or a claimed
        // exemplar gets one, a plain 1-in-N sample does not - a thousand
        // identical 200s are not worth a thousand bodies. A completion that is
        // both sampled and an exemplar is stored in the sampled budget *and*
        // keeps its body, which is the case the old precedence-based version
        // could only express by moving the record.
        const bool capture_body = context->capture_response_bodies && (is_slow || exemplar);
        context->metrics_collector->record_success (response.status_code, latency,
        response.timing.queue_wait_ms, trace_data, trace_reason,
        capture_body ? &response : nullptr);
        context->metrics_collector->record_bytes (
        response.timing.bytes_up, response.timing.bytes_down);

        // Sample response for deferred script validation if test script is present
        if (!context->test_script.empty ()) {
            context->metrics_collector->record_response_sample (response);
        }
    }

    // Wake the closed-loop controller (no-op/near-free for open-loop modes).
    if (context->closed_loop.load (std::memory_order_relaxed)) {
        context->notify_refill ();
    }
}

// Declared in load_strategy.hpp - a JSON number is read as seconds, matching
// how the MCP duration cap reads the same field. See the header for why every
// executor goes through this one parser.
int64_t duration_field_ms (const nlohmann::json& config, const std::string& key, int64_t default_ms) {
    auto it = config.find (key);
    if (it == config.end () || it->is_null ())
        return default_ms;

    std::optional<int64_t> parsed;
    if (it->is_string ()) {
        parsed = parse_duration_ms (it->get<std::string> ());
    } else if (it->is_number ()) {
        const double seconds = it->get<double> ();
        if (std::isfinite (seconds) && seconds >= 0.0)
            parsed = static_cast<int64_t> (seconds * 1000.0);
    }

    if (!parsed) {
        throw std::invalid_argument ("Invalid " + key + " " + it->dump () +
        ": expected a non-negative number with an optional ms/s/m/h unit "
        "(e.g. \"500ms\", \"30s\", \"5m\", \"2h\")");
    }
    return *parsed;
}

namespace {

// Update the in-flight high-water mark (single writer: the strategy thread).
inline void update_peak (const std::shared_ptr<RunContext>& context) {
    size_t f    = context->in_flight ();
    size_t prev = context->peak_in_flight.load (std::memory_order_relaxed);
    while (f > prev &&
    !context->peak_in_flight.compare_exchange_weak (prev, f, std::memory_order_relaxed)) {
        // prev reloaded on failure
    }
}

} // namespace

// Declared in load_strategy.hpp - the scenario load executor drives the same
// loop with a different submit_one. See the header for the contract.
void maintain_concurrency (std::shared_ptr<RunContext> context,
const std::function<void ()>& submit_one,
const std::function<size_t (int64_t)>& target_fn,
const std::function<size_t ()>& budget_fn,
const std::function<bool (int64_t)>& should_continue) {
    using clock = std::chrono::steady_clock;
    auto start  = clock::now ();
    auto elapsed_ms = [&start] () {
        return std::chrono::duration_cast<std::chrono::milliseconds> (clock::now () - start)
        .count ();
    };

    // closed_loop must be true BEFORE seeding so no early completion's notify
    // is dropped.
    context->closed_loop.store (true, std::memory_order_relaxed);

    // The run's own predicate decides whether anything is owed at all. Seeding
    // target(0) first meant a 0s duration - or a 0-iteration run - still fired
    // a full target's worth of requests before the loop's time/quota check was
    // ever evaluated.
    if (context->should_stop || !should_continue (0)) {
        return;
    }

    size_t seed = compute_refill_deficit (target_fn (0), 0, budget_fn ());
    for (size_t i = 0; i < seed && !context->should_stop; ++i) {
        submit_one ();
    }
    update_peak (context);

    while (!context->should_stop) {
        {
            std::unique_lock<std::mutex> lk (context->refill_mtx);
            context->refill_cv.wait_for (lk, std::chrono::milliseconds (50), [&] () {
                return context->should_stop.load () ||
                context->in_flight () < target_fn (elapsed_ms ());
            });
        }

        int64_t el = elapsed_ms ();
        if (context->should_stop || !should_continue (el)) {
            break;
        }

        size_t deficit =
        compute_refill_deficit (target_fn (el), context->in_flight (), budget_fn ());
        for (size_t i = 0; i < deficit && !context->should_stop; ++i) {
            submit_one ();
        }
        update_peak (context);
    }
}

// ============================================================================
// Constant Load Strategy
// ============================================================================

class ConstantLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config  = context->config;
        int64_t duration_ms = duration_field_ms (config, "duration", 60000);

        // Check for targetRps - if specified, use rate-limited mode
        double target_rps = config.value ("rps", 0.0);
        if (target_rps == 0.0)
            target_rps = config.value ("targetRps", 0.0);

        if (target_rps > 0.0) {
            // Rate-limited mode
            vayu::utils::log_info (
            "Starting Constant Load Test (Rate-Limited)");
            vayu::utils::log_info ("  Duration: " + std::to_string (duration_ms) + " ms");
            vayu::utils::log_info ("  Target RPS: " + std::to_string (target_rps));

            // Calculate expected requests
            size_t expected = static_cast<size_t> (
            (static_cast<double> (duration_ms) / 1000.0) * target_rps);
            context->requests_expected = expected;

            // Tick length: the request interval up to 1000 RPS, 1ms above it
            // (below 1ms we would busy-spin). How many requests a tick owes is
            // not the tick's business - take_due_requests accrues the exact
            // fractional amount, so 1500 RPS owes 1 or 2 per 1ms tick rather
            // than the floored 1 the old batch_size gave.
            const int64_t base_interval_us = static_cast<int64_t> (1000000.0 / target_rps);
            const int64_t tick_us = std::max<int64_t> (base_interval_us, 1000);

            // Read once: the config cannot change mid-run.
            const size_t max_pending = config.value ("maxInFlight",
            std::max (static_cast<size_t> (target_rps * 10.0), size_t (1000)));

            vayu::utils::log_debug ("Submission config: tick_us=" + std::to_string (tick_us) +
            ", max_in_flight=" + std::to_string (max_pending) +
            ", expected_requests=" + std::to_string (expected));

            const auto test_start = std::chrono::steady_clock::now ();
            const auto duration_end = test_start + std::chrono::milliseconds (duration_ms);
            auto accrued_through = test_start;
            double debt          = 0.0;
            size_t submitted     = 0;

            while (!context->should_stop) {
                const auto now = std::chrono::steady_clock::now ();

                // The run is time-bound, not quota-bound: never accrue past the
                // deadline, so the final tick pays out only the slice of the
                // window it covers and the loop cannot push a backlog beyond it.
                const auto accrue_to = std::min (now, duration_end);
                const int64_t elapsed_us =
                std::chrono::duration_cast<std::chrono::microseconds> (accrue_to - accrued_through)
                .count ();
                accrued_through = accrue_to;

                const size_t due = take_due_requests (debt, target_rps, elapsed_us);
                if (due > 0) {
                    const size_t in_flight = context->in_flight ();
                    const size_t headroom =
                    max_pending > in_flight ? max_pending - in_flight : 0;
                    const size_t to_submit = std::min (due, headroom);

                    // Requests the in-flight cap refuses are dropped at the
                    // instant they came due, not deferred. Deferring is what
                    // let a saturated run submit its backlog past the deadline
                    // and still report itself on rate.
                    if (due > to_submit) {
                        context->metrics_collector->record_drop_batch (due - to_submit);
                    }

                    for (size_t i = 0; i < to_submit && !context->should_stop; ++i) {
                        context->event_loop->submit (request,
                        [context, &db] (size_t, vayu::Result<vayu::Response> result) {
                            handle_result (context, db, std::move (result));
                        });
                        submitted++;
                        context->requests_sent++;
                    }
                }

                if (now >= duration_end) {
                    break;
                }

                // Wait for the next tick. Oversleeping is self-correcting - the
                // next tick accrues the extra elapsed time - so the sleep can be
                // the full remainder; on Windows short waits still spin, since
                // 15.6ms timer rounding would make sub-tick sleeps bursty.
                const auto next_tick =
                accrued_through + std::chrono::microseconds (tick_us);
                const auto sleep_us = std::chrono::duration_cast<std::chrono::microseconds> (
                next_tick - std::chrono::steady_clock::now ())
                                      .count ();
                if (sleep_us > 100) {
#ifdef _WIN32
                    if (sleep_us <= 2000) {
                        while (std::chrono::steady_clock::now () < next_tick &&
                        !context->should_stop) {
                            /* spin */
                        }
                    } else
#endif
                    {
                        std::this_thread::sleep_for (std::chrono::microseconds (sleep_us));
                    }
                }
            }

            vayu::utils::log_info ("Submitted " + std::to_string (submitted) + " requests");

        } else {
            // Concurrency-based mode: closed-loop, hold ~N in flight.
            size_t concurrency =
            static_cast<size_t> (config.value ("concurrency", 100));

            vayu::utils::log_info (
            "Starting Constant Load Test (Concurrency-Based)");
            vayu::utils::log_info ("  Duration: " + std::to_string (duration_ms) + " ms");
            vayu::utils::log_info ("  Concurrency: " + std::to_string (concurrency));

            auto submit_one = [&context, &db, &request] () {
                context->event_loop->submit (request,
                [context, &db] (size_t, vayu::Result<vayu::Response> result) {
                    handle_result (context, db, std::move (result));
                });
                context->requests_sent++;
            };

            maintain_concurrency (
            context, submit_one,
            [concurrency] (int64_t) { return concurrency; },      // target(t) = N
            [] () { return std::numeric_limits<size_t>::max (); }, // unbounded budget
            [duration_ms] (int64_t el) { return el < duration_ms; }); // stop at duration
        }
    }
};

// ============================================================================
// Iterations Load Strategy
// ============================================================================

class IterationsLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config = context->config;
        size_t iterations = static_cast<size_t> (config.value ("iterations", 1000));
        size_t concurrency = static_cast<size_t> (config.value ("concurrency", 10));

        vayu::utils::log_info ("Starting Iterations Load Test");
        vayu::utils::log_info ("  Iterations: " + std::to_string (iterations));
        vayu::utils::log_info ("  Concurrency: " + std::to_string (concurrency));

        context->requests_expected = iterations;

        auto submit_one = [&context, &db, &request] () {
            context->event_loop->submit (request,
            [context, &db] (size_t, vayu::Result<vayu::Response> result) {
                handle_result (context, db, std::move (result));
            });
            context->requests_sent++;
        };

        maintain_concurrency (
        context, submit_one,
        [concurrency] (int64_t) { return concurrency; },     // target = N
        [context, iterations] () -> size_t {                 // budget = M - sent
            size_t sent = context->requests_sent.load ();
            return sent < iterations ? iterations - sent : 0;
        },
        [context, iterations] (int64_t) {                    // stop at M
            return context->requests_sent.load () < iterations;
        });

        vayu::utils::log_info (
        "Submitted " + std::to_string (context->requests_sent.load ()) + " requests");
    }
};

// ============================================================================
// Ramp Up Load Strategy
// ============================================================================

class RampUpLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config = context->config;

        int64_t duration_ms = duration_field_ms (config, "duration", 60000);
        int64_t ramp_duration_ms = duration_field_ms (config, "rampUpDuration", 10000);

        size_t start_concurrency =
        static_cast<size_t> (config.value ("startConcurrency", 1));
        size_t target_concurrency =
        static_cast<size_t> (config.value ("concurrency", 100));

        vayu::utils::log_info ("Starting Ramp Up Load Test");
        vayu::utils::log_info ("  Total Duration: " + std::to_string (duration_ms) + " ms");
        vayu::utils::log_info (
        "  Ramp Up Duration: " + std::to_string (ramp_duration_ms) + " ms");
        vayu::utils::log_info ("  Start Concurrency: " + std::to_string (start_concurrency));
        vayu::utils::log_info ("  Target Concurrency: " + std::to_string (target_concurrency));

        auto submit_one = [&context, &db, &request] () {
            context->event_loop->submit (request,
            [context, &db] (size_t, vayu::Result<vayu::Response> result) {
                handle_result (context, db, std::move (result));
            });
            context->requests_sent++;
        };

        // target(t): linear from start_concurrency to target_concurrency over
        // ramp_duration_ms, then flat at target_concurrency. Descends correctly
        // when the start is above the target - see ramp_target_concurrency.
        auto target_fn = [start_concurrency, target_concurrency,
                         ramp_duration_ms] (int64_t el) -> size_t {
            return ramp_target_concurrency (
            start_concurrency, target_concurrency, ramp_duration_ms, el);
        };

        maintain_concurrency (
        context, submit_one, target_fn,
        [] () { return std::numeric_limits<size_t>::max (); },
        [duration_ms] (int64_t el) { return el < duration_ms; });
    }
};

// ============================================================================
// Factory
// ============================================================================

std::unique_ptr<LoadStrategy> LoadStrategy::create (const nlohmann::json& config) {
    std::string mode = config.value ("mode", "constant_rps");
    auto type        = parse_load_test_type (mode);

    if (!type) {
        if (config.contains ("iterations")) {
            return std::make_unique<IterationsLoadStrategy> ();
        }
        return std::make_unique<ConstantLoadStrategy> ();
    }

    switch (*type) {
    case LoadTestType::ConstantRps:
    case LoadTestType::ConstantConcurrency:
        return std::make_unique<ConstantLoadStrategy> ();
    case LoadTestType::Iterations:
        return std::make_unique<IterationsLoadStrategy> ();
    case LoadTestType::RampUp: return std::make_unique<RampUpLoadStrategy> ();
    }

    return std::make_unique<ConstantLoadStrategy> ();
}

} // namespace vayu::core
