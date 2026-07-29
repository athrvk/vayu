/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/run_manager.hpp"

#include <algorithm>
#include <chrono>
#include <iostream>

#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {
inline int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/**
 * @brief Validate sampled responses using test scripts (deferred validation)
 * This runs after the load test completes to avoid impacting throughput.
 *
 * Returns the tallies for the run summary, or nullopt when validation did not
 * run at all (no test script, or no sampled responses) - which is what keeps
 * the report's testValidation section absent instead of all-zero.
 */
std::optional<ScriptValidationTotals>
validate_scripts (std::shared_ptr<RunContext> context, vayu::db::Database& db, bool verbose) {
    if (context->test_script.empty ()) {
        return std::nullopt; // No script to validate
    }

    const auto& samples = context->metrics_collector->response_samples ();
    if (samples.empty ()) {
        if (verbose) {
            vayu::utils::log_info (
            "No response samples collected for script validation");
        }
        return std::nullopt;
    }

    if (verbose) {
        vayu::utils::log_info ("Validating " + std::to_string (samples.size ()) +
        " response samples with test script...");
    }

    // Create script engine for validation, bounded by the same timeout/limits
    // the execute path reads so an infinite-loop test script cannot spin the
    // run's worker thread forever.
    vayu::runtime::ScriptConfig script_config;
    script_config.timeout_ms     = static_cast<uint64_t> (db.get_config_int (
    "scriptTimeout", vayu::core::constants::script_engine::TIMEOUT_MS));
    script_config.memory_limit   = static_cast<size_t> (db.get_config_int (
    "scriptMemoryLimit", vayu::core::constants::script_engine::MEMORY_LIMIT));
    script_config.stack_size     = static_cast<size_t> (db.get_config_int (
    "scriptStackSize", vayu::core::constants::script_engine::STACK_SIZE));
    script_config.enable_console = db.get_config_bool (
    "scriptEnableConsole", vayu::core::constants::script_engine::ENABLE_CONSOLE);

    vayu::runtime::ScriptEngine engine (script_config);
    vayu::Environment env;

    // Build a dummy request for script context (HTTP request fields are at root level)
    vayu::Request dummy_request;
    auto request_result = vayu::json::deserialize_request (context->config);
    if (request_result.is_ok ()) {
        dummy_request = request_result.value ();
    }

    size_t passed = 0;
    size_t failed = 0;
    std::vector<std::string> failure_messages;

    for (const auto& sample : samples) {
        // Build Response from sample
        vayu::Response response;
        response.status_code     = sample.status_code;
        response.status_text     = sample.status_text;
        response.body            = sample.body;
        response.headers         = sample.headers;
        response.timing.total_ms = sample.latency_ms;

        try {
            auto result =
            engine.execute_test (context->test_script, dummy_request, response, env);

            if (result.success) {
                // Check individual test results
                for (const auto& test : result.tests) {
                    if (test.passed) {
                        passed++;
                    } else {
                        failed++;
                        if (failure_messages.size () <
                        vayu::core::constants::script_validation::MAX_FAILURE_MESSAGES) {
                            failure_messages.push_back (test.name + ": " + test.error_message);
                        }
                    }
                }
                if (result.tests.empty ()) {
                    // Script ran but had no pm.test() calls - count as passed
                    passed++;
                }
            } else {
                failed++;
                if (failure_messages.size () <
                vayu::core::constants::script_validation::MAX_FAILURE_MESSAGES) {
                    failure_messages.push_back ("Script error: " + result.error_message);
                }
            }
        } catch (const std::exception& e) {
            failed++;
            if (failure_messages.size () <
            vayu::core::constants::script_validation::MAX_FAILURE_MESSAGES) {
                failure_messages.push_back ("Exception: " + std::string (e.what ()));
            }
        }
    }

    // Store failure summary as a result record
    auto timestamp = now_ms ();
    if (!failure_messages.empty ()) {
        nlohmann::json failure_json;
        failure_json["failures"]    = failure_messages;
        failure_json["totalFailed"] = failed;
        failure_json["totalPassed"] = passed;

        vayu::db::Result validation_result;
        validation_result.run_id    = context->run_id;
        validation_result.timestamp = timestamp;
        validation_result.status_code = failed > 0 ? 0 : 200; // 0 indicates test failures
        validation_result.latency_ms = 0;
        validation_result.error = failed > 0 ? "Script validation failures" : "";
        validation_result.trace_data = failure_json.dump ();

        db.add_result (validation_result);
    }

    if (verbose) {
        vayu::utils::log_info ("  Script validation: " + std::to_string (passed) +
        " passed, " + std::to_string (failed) + " failed");
    }

    return ScriptValidationTotals{ samples.size (), passed, failed };
}
} // namespace

RunContext::RunContext (const std::string& id, nlohmann::json cfg, size_t max_errors)
: run_id (id), config (cfg.is_object () ? std::move (cfg) : nlohmann::json::object ()), start_time_ms (0) {
    // Initialize MetricsCollector with configuration from test config
    MetricsCollectorConfig mc_config;
    mc_config.max_errors = max_errors;

    // Calculate expected requests from duration and RPS
    std::string duration_str = config.value ("duration", "60s");
    int64_t duration_ms      = 60000; // default 60s
    try {
        duration_ms =
        std::stoll (duration_str.substr (0, duration_str.length () - 1)) * 1000;
    } catch (...) {
    }

    double target_rps = config.value ("rps", 0.0);
    if (target_rps == 0.0)
        target_rps = config.value ("targetRps", 0.0);
    if (target_rps == 0.0)
        target_rps = 1000.0; // default estimate

    // Pre-allocate with 20% buffer
    mc_config.expected_requests = static_cast<size_t> (
    (static_cast<double> (duration_ms) / 1000.0) * target_rps * 1.2);
    mc_config.expected_requests = std::max (mc_config.expected_requests, size_t (10000));

    // Get sampling config
    mc_config.success_sample_rate =
    static_cast<size_t> (config.value ("success_sample_rate", 100));
    mc_config.store_success_traces = config.value ("save_timing_breakdown", false);

    // Configure response sampling for script validation
    mc_config.max_response_samples =
    static_cast<size_t> (config.value ("max_response_samples", 1000));
    mc_config.response_sample_rate =
    static_cast<size_t> (config.value ("response_sample_rate", 100));

    // Extract test script from config (now at root level)
    if (config.contains ("tests")) {
        // Either a plain string or a list of parts. `read_script` handles both
        // and picks the list when both are present. Load runs now receive the
        // collection chain's test scripts as well as the request's own; before
        // this, a collection-level assertion was silently never checked.
        test_script = vayu::http::read_script (config, "tests", "tests");
    }

    metrics_collector = std::make_unique<MetricsCollector> (id, mc_config);
}

RunContext::~RunContext () {
    should_stop = true;
    // Wake the closed-loop controller so it observes should_stop without
    // waiting for its 50ms safety-net timeout before the join below.
    notify_refill ();
    if (worker_thread.joinable ()) {
        worker_thread.join ();
    }
    if (metrics_thread.joinable ()) {
        metrics_thread.join ();
    }
}

void RunManager::register_run (const std::string& run_id, std::shared_ptr<RunContext> context) {
    std::lock_guard<std::mutex> lock (mutex_);
    active_runs_[run_id] = context;
}

std::shared_ptr<RunContext> RunManager::get_run (const std::string& run_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = active_runs_.find (run_id);
    if (it != active_runs_.end ()) {
        return it->second;
    }
    return nullptr;
}

void RunManager::unregister_run (const std::string& run_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    active_runs_.erase (run_id);
}

void RunManager::retain_run (const std::string& run_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = active_runs_.find (run_id);
    if (it == active_runs_.end ()) return;
    it->second->completed_at_ms.store (now_ms ());
    retained_runs_[run_id] = it->second;
    active_runs_.erase (it);
}

std::shared_ptr<RunContext> RunManager::get_run_or_retained (const std::string& run_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto a = active_runs_.find (run_id);
    if (a != active_runs_.end ()) return a->second;
    auto r = retained_runs_.find (run_id);
    if (r != retained_runs_.end ()) return r->second;
    return nullptr;
}

void RunManager::sweep_retained (int64_t ttl_ms) {
    std::lock_guard<std::mutex> lock (mutex_);
    int64_t cutoff = now_ms () - ttl_ms;
    for (auto it = retained_runs_.begin (); it != retained_runs_.end ();) {
        if (it->second->completed_at_ms.load () < cutoff) {
            it = retained_runs_.erase (it);
        } else {
            ++it;
        }
    }
}

size_t RunManager::active_count () const {
    std::lock_guard<std::mutex> lock (mutex_);
    return active_runs_.size ();
}

size_t RunManager::retained_count () const {
    std::lock_guard<std::mutex> lock (mutex_);
    return retained_runs_.size ();
}

void RunManager::start_sweeper (std::function<int64_t ()> ttl_provider) {
    {
        std::lock_guard<std::mutex> lock (sweeper_mtx_);
        if (sweeper_thread_.joinable ()) return; // already running
        sweeper_stop_         = false;
        sweeper_ttl_provider_ = std::move (ttl_provider);
    }
    sweeper_thread_ = std::thread ([this] () {
        std::unique_lock<std::mutex> lock (sweeper_mtx_);
        while (!sweeper_stop_) {
            // Re-read the TTL each tick so a runtime change to liveRetentionMs
            // (Settings → Observability) takes effect without a daemon restart.
            // Sweep at half the TTL so a retained run is evicted within
            // ttl..1.5*ttl of completion; the 500ms cadence floor keeps a tiny
            // or zero TTL (retention disabled) from busy-looping. ttl==0 means
            // "evict immediately", which sweep_retained already handles.
            int64_t ttl = std::max<int64_t> (sweeper_ttl_provider_ (), 0);
            auto interval = std::chrono::milliseconds (std::max<int64_t> (ttl / 2, 500));
            if (sweeper_cv_.wait_for (lock, interval, [this] { return sweeper_stop_; })) {
                break;
            }
            lock.unlock ();
            try {
                sweep_retained (ttl);
            } catch (...) {
                // Defensive: never let an exception escape the sweeper thread.
            }
            lock.lock ();
        }
    });
}

void RunManager::start_sweeper (int64_t ttl_ms) {
    start_sweeper ([ttl_ms] () { return ttl_ms; });
}

void RunManager::stop_sweeper () {
    {
        std::lock_guard<std::mutex> lock (sweeper_mtx_);
        sweeper_stop_ = true;
    }
    sweeper_cv_.notify_all ();
    if (sweeper_thread_.joinable ()) {
        sweeper_thread_.join ();
    }
}

RunManager::~RunManager () {
    stop_sweeper ();
}

std::vector<std::shared_ptr<RunContext>> RunManager::get_all_active_runs () const {
    std::lock_guard<std::mutex> lock (mutex_);
    std::vector<std::shared_ptr<RunContext>> runs;
    for (const auto& [id, context] : active_runs_) {
        runs.push_back (context);
    }
    return runs;
}

void RunManager::start_run (const std::string& run_id,
const nlohmann::json& config,
vayu::db::Database& db,
bool verbose) {
    auto context = std::make_shared<RunContext> (run_id, config,
    static_cast<size_t> (db.get_config_int ("maxStoredErrors",
    static_cast<int> (vayu::core::constants::metrics_collector::DEFAULT_MAX_ERRORS))));
    register_run (run_id, context);

    // Sweep stale retained runs on each new registration so that headless /
    // API-only usage (which never hits /metrics/live) doesn't accumulate them.
    int retention_ms = db.get_config_int ("liveRetentionMs", 60000);
    sweep_retained (retention_ms);

    // IMPORTANT: Set is_running BEFORE spawning threads to avoid race condition
    // where metrics_thread exits immediately because is_running is still false
    context->is_running    = true;
    context->start_time_ms = now_ms ();

    // Spawn metrics collection thread first (will be joined by worker thread)
    context->metrics_thread =
    std::thread ([context, &db] () { collect_metrics (context, &db); });
    // Note: metrics_thread is NOT detached - it will be joined by the worker thread

    // Spawn background thread for execution
    context->worker_thread = std::thread ([context, &db, verbose, this] () {
        execute_load_test (context, &db, verbose, *this);
    });
    context->worker_thread.detach ();
}

void execute_load_test (std::shared_ptr<RunContext> context,
vayu::db::Database* db_ptr,
bool verbose,
RunManager& manager) {
    // Note: is_running and start_time_ms are set in start_run() before threads
    // spawn to avoid race condition with metrics_thread

    auto& db           = *db_ptr;
    const auto& config = context->config;

    try {
        // Update status to running
        db.update_run_status (context->run_id, vayu::RunStatus::Running);

        // Get defaults from config (set via Settings UI)
        int default_max_concurrent = db.get_config_int (
        "eventLoopMaxConcurrent", vayu::core::constants::event_loop::MAX_CONCURRENT);
        int default_max_per_host = db.get_config_int (
        "eventLoopMaxPerHost", vayu::core::constants::event_loop::MAX_PER_HOST);
        int configured_workers = db.get_config_int ("workers", 0); // 0 = auto-detect

        // Per-test config can override defaults
        size_t concurrency =
        static_cast<size_t> (config.value ("concurrency", default_max_concurrent));
        double target_rps = config.value ("rps", 0.0); // 0 = unlimited
        if (target_rps == 0.0) {
            target_rps = config.value ("targetRps", 0.0);
        }
        int timeout_ms = config.value ("timeout", 30000);

        // Configure EventLoop
        vayu::http::EventLoopConfig loop_config;
        loop_config.num_workers = static_cast<size_t> (configured_workers); // Use configured workers (0 = auto-detect)
        loop_config.max_concurrent = std::max (concurrency, size_t (100));
        loop_config.max_per_host   = static_cast<size_t> (default_max_per_host);
        loop_config.target_rps     = target_rps;
        loop_config.burst_size     = target_rps > 0 ? target_rps * 2.0 : 0.0;
        loop_config.dns_cache_timeout = db.get_config_int ("dnsCacheTimeout",
        vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS);
        loop_config.max_response_body_bytes = static_cast<size_t> (std::max (0,
        db.get_config_int ("maxResponseBodyBytes",
        static_cast<int> (vayu::core::constants::event_loop::MAX_RESPONSE_BODY_BYTES))));
        // Only enable curl verbose if explicitly requested in config,
        // independent of server verbose mode
        loop_config.verbose = config.value ("verbose", false);

        std::string workers_str =
        configured_workers == 0 ? "auto" : std::to_string (configured_workers);
        vayu::utils::log_debug ("EventLoop config: workers=" + workers_str +
        ", max_concurrent=" + std::to_string (loop_config.max_concurrent) +
        ", max_per_host=" + std::to_string (loop_config.max_per_host) +
        ", target_rps=" + std::to_string (target_rps) +
        ", timeout=" + std::to_string (timeout_ms) + "ms");

        // Create EventLoop
        context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
        context->event_loop->start ();

        // Build the request once: deserialize + timeout + auth. The event loop
        // attaches request.headers to every transfer, so resolving auth here
        // covers the whole run.
        auto built = vayu::http::build_request (config, db_ptr, timeout_ms);
        if (!built.ok) {
            vayu::utils::log_error (
            built.parse_failed
            ? std::string ("Load test: invalid request format")
            : "Load test auth resolution failed: " + built.error_message);
            db.update_run_status (context->run_id, vayu::RunStatus::Failed);
            context->is_running = false;
            if (context->metrics_thread.joinable ())
                context->metrics_thread.join ();
            manager.retain_run (context->run_id);
            return;
        }
        auto request = std::move (built.request);

        // Execute Load Strategy
        auto test_start = std::chrono::steady_clock::now ();

        try {
            auto strategy = LoadStrategy::create (config);
            strategy->execute (context, db, request);
        } catch (const std::exception& e) {
            vayu::utils::log_error ("Load test failed: " + std::string (e.what ()));
            db.update_run_status (context->run_id, vayu::RunStatus::Failed);
            context->is_running = false;
            if (context->metrics_thread.joinable ()) context->metrics_thread.join ();
            manager.retain_run (context->run_id);
            return;
        }

        // How the run lets go of the event loop depends on why it is ending.
        //
        // A user stop must stop *sending*: draining the queued backlog would
        // keep the target under load after the stop was requested, and waiting
        // on in-flight transfers hands the stop's latency to the upstream.
        // stop(false) discards the backlog and cancels what is in flight.
        //
        // The natural end of the duration still lets genuine in-flight requests
        // settle, but not forever: a request that has outlived its own timeout
        // by the grace period is never going to answer, and waiting on it pins
        // the run in `running` with no way out.
        if (context->should_stop) {
            context->event_loop->stop (false);
        } else {
            const int64_t drain_ms =
            (timeout_ms > 0 ? timeout_ms : vayu::core::constants::server::DEFAULT_TIMEOUT_MS) +
            vayu::core::constants::event_loop::STOP_DRAIN_GRACE_MS;
            context->event_loop->stop (true, std::chrono::milliseconds (drain_ms));
        }

        // Record test end time immediately (before cleanup overhead)
        auto test_end = std::chrono::steady_clock::now ();
        double total_duration_s =
        std::chrono::duration<double> (test_end - test_start).count ();

        // Update end_time in DB immediately to reflect actual test end
        // (not after cleanup/metrics thread join)
        db.update_run_end_time (context->run_id);

        // Stop background metrics collection and wait for thread to finish
        context->is_running = false;

        // Properly join the metrics thread to ensure it's done writing to DB
        if (context->metrics_thread.joinable ()) {
            context->metrics_thread.join ();
        }

        // Calculate cleanup overhead (time from test end to after cleanup)
        auto cleanup_end = std::chrono::steady_clock::now ();
        double setup_overhead_s =
        std::chrono::duration<double> (cleanup_end - test_end).count ();

        size_t completed   = context->total_requests ();
        size_t errors      = context->total_errors ();
        double avg_latency = context->average_latency_ms ();
        double actual_rps =
        total_duration_s > 0 ? static_cast<double> (completed) / total_duration_s : 0.0;
        double error_rate = context->metrics_collector->error_rate ();

        // Calculate percentiles using MetricsCollector (HdrHistogram)
        auto percentiles = context->metrics_collector->calculate_percentiles ();

        // Batch flush all results to database (errors and sampled successes)
        try {
            size_t flushed = context->metrics_collector->flush_to_database (db);
            if (verbose && flushed > 0) {
                vayu::utils::log_info (
                "  Flushed " + std::to_string (flushed) + " results to database");
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Failed to flush results to database: " + std::string (e.what ()));
        }

        // Run deferred script validation if test script is present. Its tallies
        // go into the summary below, so it has to run before the summary write.
        std::optional<ScriptValidationTotals> validation;
        try {
            validation = validate_scripts (context, db, verbose);
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Script validation failed: " + std::string (e.what ()));
        }

        // Store the whole-run summary: everything the report used to rebuild by
        // scanning the run's metric rows, written once, here.
        try {
            RunSummaryInputs inputs;
            inputs.total_requests   = completed;
            inputs.rps              = actual_rps;
            inputs.send_rate        = total_duration_s > 0 ?
            static_cast<double> (context->requests_sent.load ()) / total_duration_s :
            0.0;
            inputs.throughput       = actual_rps;
            inputs.test_duration_s  = total_duration_s;
            inputs.setup_overhead_s = setup_overhead_s;
            inputs.peak_concurrency = context->peak_in_flight.load ();
            inputs.dropped_requests = context->metrics_collector->dropped_requests ();
            inputs.queue_wait_avg_ms = context->metrics_collector->average_queue_wait ();
            inputs.bytes_sent      = context->metrics_collector->total_bytes_sent ();
            inputs.bytes_received  = context->metrics_collector->total_bytes_received ();
            inputs.status_codes    = context->metrics_collector->status_code_distribution ();
            inputs.latency         = percentiles;
            inputs.latency_avg_ms  = avg_latency;
            inputs.tests           = validation;

            db.update_run_summary (
            context->run_id, build_run_summary_payload (inputs).dump ());
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Failed to store run summary: " + std::string (e.what ()));
        }

        // Update run status with retry logic to handle any remaining contention
        vayu::RunStatus final_status =
        context->should_stop ? vayu::RunStatus::Stopped : vayu::RunStatus::Completed;
        db.update_run_status_with_retry (context->run_id, final_status);

        // Terminal status reached - trim old runs per the retention knobs.
        // Best-effort: a prune failure must not fail the completed run.
        try {
            db.prune_runs_configured ();
        } catch (const std::exception& e) {
            vayu::utils::log_warning ("Run pruning failed: " + std::string (e.what ()));
        }

        if (verbose) {
            vayu::utils::log_info (
            "Load test " + context->run_id + " " + vayu::to_string (final_status));
            vayu::utils::log_info ("  Total requests: " + std::to_string (completed));
            vayu::utils::log_info ("  Errors: " + std::to_string (errors) +
            " (" + std::to_string (error_rate) + "%)");
            vayu::utils::log_info ("  Duration: " + std::to_string (total_duration_s) + " s");
            vayu::utils::log_info ("  Target RPS: " +
            (target_rps > 0 ? std::to_string (target_rps) : "unlimited"));
            vayu::utils::log_info ("  Actual RPS: " + std::to_string (actual_rps));
            vayu::utils::log_info ("  Avg latency: " + std::to_string (avg_latency) + " ms");
            vayu::utils::log_info ("  P50/P95/P99: " + std::to_string (percentiles.p50) +
            "/" + std::to_string (percentiles.p95) + "/" +
            std::to_string (percentiles.p99) + " ms");
        }
    } catch (const std::exception& e) {
        // Stop background metrics collection
        context->is_running = false;
        std::this_thread::sleep_for (std::chrono::milliseconds (200));

        vayu::utils::log_error ("Load test error: " + std::string (e.what ()));

        // A crashed run still gets a summary, with whatever the collector holds
        // and a wall-clock duration - without one the report route would take
        // the legacy path and find nothing, reporting an empty run.
        //
        // Written *before* the status flips to Failed, matching the success
        // path: the terminal status is what tells a polling client the report
        // is ready, so a client that fetches on seeing it must not race a
        // summary still being written and get the empty-run answer instead.
        try {
            RunSummaryInputs inputs;
            auto& mc                = *context->metrics_collector;
            inputs.total_requests   = mc.total_requests ();
            const double elapsed_s = context->start_time_ms > 0 ?
            static_cast<double> (now_ms () - context->start_time_ms) / 1000.0 :
            0.0;
            inputs.rps              = elapsed_s > 0 ?
            static_cast<double> (inputs.total_requests) / elapsed_s : 0.0;
            inputs.send_rate        = elapsed_s > 0 ?
            static_cast<double> (context->requests_sent.load ()) / elapsed_s : 0.0;
            inputs.throughput       = inputs.rps;
            inputs.test_duration_s  = elapsed_s;
            inputs.peak_concurrency = context->peak_in_flight.load ();
            inputs.dropped_requests = mc.dropped_requests ();
            inputs.queue_wait_avg_ms = mc.average_queue_wait ();
            inputs.bytes_sent       = mc.total_bytes_sent ();
            inputs.bytes_received   = mc.total_bytes_received ();
            inputs.status_codes     = mc.status_code_distribution ();
            inputs.latency          = mc.calculate_percentiles ();
            inputs.latency_avg_ms   = mc.average_latency ();

            db.update_run_summary (
            context->run_id, build_run_summary_payload (inputs).dump ());
        } catch (const std::exception& ex) {
            vayu::utils::log_error (
            "Failed to store run summary for failed run: " + std::string (ex.what ()));
        }

        try {
            db.update_run_status_with_retry (context->run_id, vayu::RunStatus::Failed);
        } catch (const std::exception& ex) {
            vayu::utils::log_error (
            "Failed to update run status: " + std::string (ex.what ()));
        }

        // Failed is terminal too - prune per the retention knobs, best-effort.
        try {
            db.prune_runs_configured ();
        } catch (const std::exception& ex) {
            vayu::utils::log_warning ("Run pruning failed: " + std::string (ex.what ()));
        }
    }

    context->is_running = false;
    manager.retain_run (context->run_id);
}

std::string build_tick_payload (const nlohmann::json& stats, size_t offset) {
    return "event: metrics\nid: " + std::to_string (offset) + "\ndata: " +
    stats.dump () + "\n\n";
}

nlohmann::json build_metric_tick_payload (const MetricTickSample& sample) {
    nlohmann::json codes = nlohmann::json::object ();
    for (const auto& [code, count] : sample.status_codes) {
        codes[std::to_string (code)] = count;
    }

    nlohmann::json payload;
    payload["timestamp"]           = sample.timestamp;
    payload["elapsed_seconds"]     = sample.elapsed_seconds;
    payload["requests_completed"]  = sample.requests_completed;
    payload["requests_failed"]     = sample.requests_failed;
    payload["current_rps"]         = sample.current_rps;
    payload["current_concurrency"] = sample.current_concurrency;
    payload["send_rate"]           = sample.send_rate;
    payload["throughput"]          = sample.throughput;
    payload["backpressure"]        = sample.backpressure;
    payload["error_rate"]          = sample.error_rate;
    payload["dropped_requests"]    = sample.dropped_requests;
    payload["bytes_sent"]          = sample.bytes_sent;
    payload["bytes_received"]      = sample.bytes_received;
    payload["status_codes"]        = codes;
    payload["latency_p50_ms"]      = sample.latency_p50_ms;
    payload["latency_p95_ms"]      = sample.latency_p95_ms;
    payload["latency_p99_ms"]      = sample.latency_p99_ms;
    return payload;
}

nlohmann::json build_run_summary_payload (const RunSummaryInputs& inputs) {
    nlohmann::json codes = nlohmann::json::object ();
    for (const auto& [code, count] : inputs.status_codes) {
        codes[std::to_string (code)] = count;
    }

    nlohmann::json summary;
    summary["total_requests"]   = inputs.total_requests;
    summary["rps"]              = inputs.rps;
    summary["send_rate"]        = inputs.send_rate;
    summary["throughput"]       = inputs.throughput;
    summary["test_duration"]    = inputs.test_duration_s;
    summary["setup_overhead"]   = inputs.setup_overhead_s;
    summary["peak_concurrency"] = inputs.peak_concurrency;
    summary["dropped_requests"] = inputs.dropped_requests;
    summary["queue_wait_avg"]   = inputs.queue_wait_avg_ms;
    summary["bytes_sent"]       = inputs.bytes_sent;
    summary["bytes_received"]   = inputs.bytes_received;
    summary["status_codes"]     = codes;
    summary["latency"] = { { "min", inputs.latency.min }, { "max", inputs.latency.max },
        { "avg", inputs.latency_avg_ms }, { "p50", inputs.latency.p50 },
        { "p75", inputs.latency.p75 }, { "p90", inputs.latency.p90 },
        { "p95", inputs.latency.p95 }, { "p99", inputs.latency.p99 },
        { "p999", inputs.latency.p999 } };
    // Omitted entirely when validation did not run, so the report keeps
    // distinguishing "no test script" from "a script that passed nothing".
    if (inputs.tests.has_value ()) {
        summary["tests"] = { { "sampled", inputs.tests->sampled },
            { "passed", inputs.tests->passed }, { "failed", inputs.tests->failed } };
    }
    return summary;
}

void collect_metrics (std::shared_ptr<RunContext> context, vayu::db::Database* db_ptr) {
    auto& db          = *db_ptr;
    auto last_update  = std::chrono::steady_clock::now ();
    size_t last_total = 0;

    // Producer-side delta-RPS state (mirrors the SSE handler calculation).
    auto rps_last_time      = std::chrono::steady_clock::now ();
    size_t rps_last_total   = 0;
    double live_current_rps = 0.0;
    bool   rps_first        = true;

    // Live tick cadence (default 100 ms); DB write still gated at 1 Hz.
    // Declared here so it is in scope inside the try block below.
    int tick_interval_ms = 0;

    // Wall clock of the first persisted tick; the origin every stored tick's
    // elapsed_seconds is relative to. 0 until the first DB-gated tick.
    int64_t first_tick_wall_ms = 0;

    // Windowed (rolling) percentiles sampled by emit_live_tick each tick. Captured
    // here so the 1 Hz DB-gated block below can persist the same window it just
    // published - sample_window_percentiles() resets the window, so it must only be
    // called once per tick (inside emit_live_tick) and reused, not re-sampled.
    double win_p50 = 0.0, win_p95 = 0.0, win_p99 = 0.0;

    // Build and append one SSE "metrics" event to the in-memory tick topic.
    // Fields match the SSE handler (metrics.cpp) field-for-field. The wall-clock
    // timestamp is passed in by the caller so that the SSE tick and any
    // persisted enrichment for the same logical tick share one timestamp -
    // re-sampling now_ms() inside drifts them into adjacent ms buckets and the
    // dashboard sees status-codes shift left vs throughput on the same x-axis.
    auto emit_live_tick = [&] (const std::map<int, size_t>* status_snapshot,
        int64_t now_wall_ms) {
        size_t active_count =
        context->event_loop ? context->event_loop->active_count () : 0;
        size_t requests_sent     = context->requests_sent.load ();
        size_t requests_expected = context->requests_expected.load ();
        double elapsed_seconds =
        context->start_time_ms > 0 ?
        static_cast<double> (now_wall_ms - context->start_time_ms) / 1000.0 : 0.0;

        // Sample the rolling window exactly once per tick (it resets on read) and
        // carry the values out for the 1 Hz persistence below.
        auto window = context->metrics_collector->sample_window_percentiles ();
        win_p50 = window.p50;
        win_p95 = window.p95;
        win_p99 = window.p99;

        auto stats = context->metrics_collector->get_current_stats (active_count,
        elapsed_seconds, requests_sent, requests_expected, status_snapshot, &window);

        // Instantaneous RPS: delta-based, updated every ≥100 ms.
        auto now_steady     = std::chrono::steady_clock::now ();
        size_t current_total = stats["totalRequests"].get<size_t> ();
        if (rps_first) {
            rps_last_total = current_total;
            rps_last_time  = now_steady;
            rps_first      = false;
        } else {
            double iv = std::chrono::duration<double> (now_steady - rps_last_time).count ();
            if (iv >= 0.1) {
                live_current_rps =
                static_cast<double> (current_total - rps_last_total) / iv;
                rps_last_total = current_total;
                rps_last_time  = now_steady;
            }
        }
        stats["currentRps"] = live_current_rps;

        // Backpressure: sent but not yet responded (mirrors SSE handler).
        size_t backpressure =
        requests_sent > current_total ? requests_sent - current_total : 0;
        stats["backpressure"]     = backpressure;
        stats["runId"]            = context->run_id;
        stats["timestamp"]        = now_wall_ms;
        stats["requestsSent"]     = requests_sent;
        stats["requestsExpected"] = requests_expected;

        size_t offset = context->published_count.load ();
        context->append_tick (build_tick_payload (stats, offset));
    };

    // Guard the entire body so that any exception (std::bad_alloc, json error,
    // etc.) is caught here rather than escaping the thread function (which would
    // call std::terminate).  `context->closed` is set unconditionally below the
    // try/catch so that attached /metrics/live consumers always terminate cleanly.
    try {
        tick_interval_ms = db_ptr->get_config_int (
        "liveTickIntervalMs", vayu::core::constants::server::STATS_INTERVAL_MS);

        // Size the replay ring from the configured window and this run's tick
        // cadence, so what is retained is the *duration* the user asked for
        // rather than a tick count that means a different span per cadence.
        // Read once here: changing the window mid-run would make the ids the
        // dashboard already holds refer to a differently-sized window.
        context->set_max_live_ticks (live_ring_size (
        db_ptr->get_config_int ("liveReplayWindowMs",
        vayu::core::constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS),
        tick_interval_ms,
        static_cast<size_t> (db_ptr->get_config_int ("liveMaxRetainedTicks",
        static_cast<int> (vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS)))));

        // Tick 0: emit immediately so consumers see data before the first sleep.
        emit_live_tick (nullptr, now_ms ());

        // Loop on is_running alone. should_stop is only the *request* to stop:
        // the worker acts on it, then blocks in event_loop->stop (cancelling on
        // a user stop, draining to a deadline at the natural end), and clears
        // is_running afterwards. Exiting on should_stop emitted the "final
        // settled tick" and set closed while hundreds of requests were still
        // settling, so the live view froze at the moment of the stop click
        // while the stored report - written after the worker returned -
        // counted everything that landed in between.
        while (context->is_running) {
            std::this_thread::sleep_for (std::chrono::milliseconds (tick_interval_ms));

            // Single wall-clock sample per tick - shared by the SSE payload
            // timestamp, the run-elapsed calc, and (on DB-gated ticks) every
            // persisted metric row below. See #27.
            int64_t tick_wall_ms = now_ms ();

            // Snapshot the status-code distribution once per tick and share it
            // with both the SSE builder and (on DB-gated ticks) the persisted
            // enrichment builder - avoids scanning/copying the map twice.
            auto status_snapshot = context->metrics_collector->status_code_distribution ();

            // Emit a live tick every iteration regardless of the 1 Hz DB gate.
            emit_live_tick (&status_snapshot, tick_wall_ms);

            auto now = std::chrono::steady_clock::now ();
            auto elapsed = std::chrono::duration<double> (now - last_update).count ();

            if (elapsed >= 1.0) // Update every second
            {
                size_t current_total  = context->total_requests ();
                size_t current_errors = context->total_errors ();
                size_t delta          = current_total - last_total;

                double current_rps = elapsed > 0 ? static_cast<double> (delta) / elapsed : 0.0;
                double error_rate = current_total > 0 ?
                (static_cast<double> (current_errors) * 100.0 / static_cast<double> (current_total)) :
                0.0;

                // Calculate send rate (requests dispatched per second) and throughput (responses per second)
                size_t requests_sent = context->requests_sent.load ();
                double run_elapsed_s =
                (static_cast<double> (tick_wall_ms - context->start_time_ms)) / 1000.0;
                double send_rate  = run_elapsed_s > 0 ?
                static_cast<double> (requests_sent) / run_elapsed_s :
                0.0;
                double throughput = run_elapsed_s > 0 ?
                static_cast<double> (current_total) / run_elapsed_s :
                0.0;

                // Calculate backpressure (true in-flight: requests sent but not yet responded)
                size_t backpressure = context->in_flight ();

                // Sample the in-flight high-water mark. The closed-loop controller
                // also updates this at submit granularity; open-loop modes
                // (constant_rps) rely solely on this 1 Hz sample. CAS-max so the two
                // writers don't clobber each other.
                {
                    size_t pk = context->peak_in_flight.load (std::memory_order_relaxed);
                    while (backpressure > pk &&
                    !context->peak_in_flight.compare_exchange_weak (pk, backpressure,
                    std::memory_order_relaxed)) {
                        // pk reloaded on failure
                    }
                }

                vayu::utils::log_debug ("Metrics: rps=" + std::to_string (current_rps) +
                ", send_rate=" + std::to_string (send_rate) +
                ", throughput=" + std::to_string (throughput) +
                ", backpressure=" + std::to_string (backpressure) +
                ", error_rate=" + std::to_string (error_rate) + "%" +
                ", active=" + std::to_string (context->event_loop->active_count ()) +
                ", sent=" + std::to_string (requests_sent));

                // Persist the tick: one wide row, built here rather than
                // reassembled from ~18 EAV rows by every reader.
                try {
                    // elapsed_seconds is measured from the *first persisted*
                    // tick, not from the run's start: the 1 Hz gate means the
                    // first stored tick lands ~1s in, and a series that starts
                    // at 0 is what the charts have always drawn.
                    if (first_tick_wall_ms == 0) {
                        first_tick_wall_ms = tick_wall_ms;
                    }

                    auto& mc = *context->metrics_collector;
                    MetricTickSample sample;
                    sample.timestamp = tick_wall_ms;
                    sample.elapsed_seconds =
                    static_cast<double> (tick_wall_ms - first_tick_wall_ms) / 1000.0;
                    sample.requests_completed = current_total;
                    sample.requests_failed    = current_errors;
                    sample.current_rps        = current_rps;
                    sample.current_concurrency = context->event_loop->active_count ();
                    sample.send_rate           = send_rate;
                    sample.throughput          = throughput;
                    sample.backpressure        = backpressure;
                    sample.error_rate          = error_rate;
                    sample.dropped_requests    = mc.dropped_requests ();
                    sample.bytes_sent          = mc.total_bytes_sent ();
                    sample.bytes_received      = mc.total_bytes_received ();
                    // Reuse the snapshot already taken for the live tick above.
                    sample.status_codes = status_snapshot;
                    // Windowed (rolling) percentiles from the interval recorder -
                    // these power the history percentile chart, the
                    // response-time-vs-concurrency scatter, and the capacity
                    // breakpoint / saturation derivations. Reuses the window
                    // sampled by emit_live_tick this tick (do not re-sample).
                    sample.latency_p50_ms = win_p50;
                    sample.latency_p95_ms = win_p95;
                    sample.latency_p99_ms = win_p99;

                    db.add_metric_tick ({ 0, context->run_id, tick_wall_ms,
                    build_metric_tick_payload (sample).dump () });
                } catch (const std::exception& e) {
                    // Continue on error
                }

                last_update = now;
                last_total  = current_total;
            }
        }

        // Final settled tick before signalling closed - consumers use this ordering
        // as the termination contract (last data before closed==true).
        emit_live_tick (nullptr, now_ms ());
    } catch (const std::exception& e) {
        vayu::utils::log_error ("collect_metrics: " + std::string (e.what ()));
    } catch (...) {
        vayu::utils::log_error ("collect_metrics: unknown exception");
    }

    // Unconditional: always signal consumers so they terminate cleanly,
    // even if the producer threw.
    context->closed.store (true, std::memory_order_release);
}

} // namespace vayu::core
