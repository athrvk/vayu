#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstddef>
#include <cstdint>
#include <string>

#include "vayu/version.hpp"

namespace vayu::core::constants {
/**
 * @brief Default configuration values
 */
namespace defaults {
/// Default URL for the daemon process
constexpr const char* DAEMON_URL = "http://127.0.0.1:9876";
/// Default port for the daemon server
constexpr int PORT = 9876;
/// Default verbosity level
constexpr bool VERBOSE = false;
/// Default User-Agent header string
constexpr const char* DEFAULT_USER_AGENT = "Vayu/" VAYU_VERSION_STRING;
} // namespace defaults

/**
 * @brief CLI argument constants
 */
namespace cli {
/// Short flag for port argument
constexpr const char* ARG_PORT_SHORT = "-p";
/// Long flag for port argument
constexpr const char* ARG_PORT_LONG = "--port";
} // namespace cli

/**
 * @brief Logging configuration
 */
namespace logging {
/// Directory where logs are stored
constexpr const char* DIR = "engine/logs";
/// Prefix for log filenames
constexpr const char* FILE_PREFIX = "/vayu_";
/// Timestamp format for log filenames
constexpr const char* TIME_FORMAT = "%Y%m%d_%H%M%S";
} // namespace logging

/**
 * @brief HTTP protocol constants
 */
namespace http {
/// End-of-line characters for HTTP headers
constexpr const char* EOL_CHARS = "\r\n";
/// Multiplier for burst size relative to target RPS
constexpr double BURST_MULTIPLIER = 2.0;
/// Cost of a single token in the rate limiter
constexpr double TOKEN_COST = 1.0;
} // namespace http

/**
 * @brief Event loop configuration
 */
namespace event_loop {
/// Maximum concurrent requests per worker
constexpr size_t MAX_CONCURRENT = 1000;
/// Maximum concurrent connections per host (per worker).
constexpr size_t MAX_PER_HOST = 200;
/// Timeout for a worker's curl_multi_poll in milliseconds. Deliberately short:
/// it only bounds how long a worker with active transfers blocks waiting for
/// IO, and submit() interrupts the poll via curl_multi_wakeup anyway.
constexpr int POLL_TIMEOUT_MS = 1;
/// DNS cache timeout in seconds (avoids DNS resolver saturation).
/// Governs both curl's own cache and the pre-resolution pin cache.
/// 0 disables caching; a negative value never expires.
constexpr long DNS_CACHE_TIMEOUT_SECONDS = 300;
/// How long a failed lookup is remembered, so an unresolvable host does not
/// re-block the worker thread on getaddrinfo for every request. Deliberately
/// short: a host that has just come up should be picked up quickly.
constexpr long DNS_NEGATIVE_CACHE_SECONDS = 5;
/// Largest response body a single load-run transfer may buffer in memory.
/// A transfer past this fails with CURLE_WRITE_ERROR rather than growing as
/// concurrency x body-size until the daemon is OOM-killed. 0 = unbounded.
constexpr size_t MAX_RESPONSE_BODY_BYTES = 32UL * 1024 * 1024;
/// TCP keep-alive idle time in seconds
constexpr long TCP_KEEPALIVE_IDLE_SECONDS = 60;
/// TCP keep-alive probe interval in seconds
constexpr long TCP_KEEPALIVE_INTERVAL_SECONDS = 30;
/// Grace added to the per-request timeout when a run drains its in-flight
/// transfers at the natural end of its duration. A transfer that outlives its
/// own timeout by this much is not going to complete, so it is cancelled
/// rather than allowed to hold the run in `running` indefinitely.
constexpr int64_t STOP_DRAIN_GRACE_MS = 2000;
} // namespace event_loop

/**
 * @brief Accepted ranges for a POST /runs load-test config.
 *
 * These are crash guards, not policy: every client caps itself far lower
 * (the load dialog offers concurrency <= 1000, the MCP tool has a
 * user-settable cap). They exist because each field is read with
 * `config.value(...)` and cast to `size_t`, so a negative becomes ~1.8e19 and
 * an out-of-range value reaches an eager allocation or a modulo before
 * anything else can reject it.
 */
namespace run_config {
/// Upper bound on a run's `concurrency`. `EventLoopConfig::max_concurrent` is
/// an *eager* per-worker curl-handle pre-allocation, so an unbounded value
/// allocates until malloc fails. Ten times the per-worker ceiling leaves every
/// realistic run untouched while keeping the pre-allocation finite.
constexpr int64_t MAX_CONCURRENCY = 10 * static_cast<int64_t> (event_loop::MAX_CONCURRENT);
/// Upper bound on `maxInFlight`, the open-loop backpressure ceiling. It is
/// deliberately **not** `MAX_CONCURRENCY`: that bounds an eager curl-handle
/// pre-allocation, while this bounds a counter of outstanding requests that
/// allocates nothing up front. Reusing the connection guard here refused
/// configurations the engine already runs implicitly - the default ceiling is
/// `max(targetRps * 10, 1000)` (`load_strategy.cpp`), which reaches 500,000 at
/// the load dialog's 50k RPS maximum. A million covers the default formula
/// across the whole advertised RPS range and still keeps a negative value -
/// ~1.8e19 once cast to `size_t` - from removing the backpressure entirely.
constexpr int64_t MAX_IN_FLIGHT = 1000000;
/// Upper bound on `max_response_samples` (each retained sample holds a full
/// response body, and the vector is reserved up front).
constexpr int64_t MAX_RESPONSE_SAMPLES = 1000000;
/// Upper bound on `max_success_results` / `max_slow_results`. Each retained
/// record holds a serialised timing breakdown (~200 bytes), and both vectors
/// are reserved up front, so an unbounded value is an eager allocation.
constexpr int64_t MAX_RETAINED_RESULTS = 1000000;
/// Upper bound on `slow_threshold_ms` (a day - past that no completion is an
/// outlier because no completion survives).
constexpr int64_t MAX_SLOW_THRESHOLD_MS = 86400000;
/// Upper bound on `max_sample_body_bytes`. A captured body is copied on the
/// completion callback, so an unbounded per-body cap turns one huge response
/// into a hot-path memcpy the whole worker waits on.
constexpr int64_t MAX_SAMPLE_BODY_BYTES = 104857600; // 100MB
/// Upper bound on `max_sample_bytes` (the whole-run capture budget). Every
/// byte under it is held in memory until the run flushes.
constexpr int64_t MAX_SAMPLE_BYTES = 1073741824; // 1GB
/// Upper bound on `max_exemplar_results`. Each retained exemplar holds a
/// captured exchange, bounded in turn by the two budgets above.
constexpr int64_t MAX_EXEMPLAR_RESULTS = 100000;
/// Upper bound on a capacity run's `sloMs`. Mirrors the app's own clamp on the
/// client-side SLO setting (`app/src/constants/client-settings.ts`), so a
/// budget the dialog can express is one the engine accepts.
constexpr int64_t MAX_SLO_MS = 60000;
} // namespace run_config

/**
 * @brief Defaults for the capacity-discovery search.
 *
 * Only the first three are settable per run (`sloMs`, `stepDuration`, and the
 * `startConcurrency`/`concurrency` bounds the other modes already own). The
 * rest are the controller's policy: they live here rather than as run-config
 * keys because a user asking "what can my service take" is not also choosing a
 * step-growth factor, and a knob nobody sets is a knob nobody maintains.
 */
namespace capacity {
/// Default latency budget the search looks for the edge of, in ms. Matches the
/// app's `DEFAULT_SLO_THRESHOLD_MS` so the dialog's prefill is the same number.
constexpr int64_t SLO_MS = 200;
/// How long each level is held before its window is judged. Long enough for the
/// windowed percentiles to settle at the stock 100ms tick cadence, short enough
/// that a search over tens of levels finishes inside a normal run duration.
constexpr int64_t STEP_DURATION_MS = 5000;
/// Deadline for the whole search when the run config names no `duration`.
///
/// Deliberately **not** the 60s every other mode falls back to: at the default
/// step this mode walks a level every 5s, so a minute is a dozen levels and a
/// search that almost always ends `deadline` rather than finding anything. It
/// is a named constant rather than a literal because the MCP duration cap has
/// to know it - a guard assuming one default for every mode let a capacity run
/// past a cap it was under - and `safety.test.ts` reads this line to stay in
/// step.
constexpr int64_t DEADLINE_MS = 300000;
/// Ticks discarded at the start of each level: the in-flight count is still
/// climbing to the new target, so those windows measure the transition rather
/// than the level. At the stock cadence this is the first 300ms of every step.
constexpr size_t SETTLE_TICKS = 3;
/// Concurrency cap when the run config names none.
constexpr int64_t MAX_CONCURRENCY = 100;
/// Fractional growth per healthy step (+25%), floored at +1 concurrency.
constexpr double STEP_GROWTH = 0.25;
/// Below this percentage of throughput gained across the last two step-ups, the
/// service is saturated even though it is still inside its latency budget.
constexpr double PLATEAU_GAIN_PCT = 5.0;
/// Consecutive breaching windows before the search stops. Two, not one, so a
/// single noisy window re-measures instead of ending the run.
constexpr size_t SLO_BREACH_WINDOWS = 2;
} // namespace capacity

/**
 * @brief Server configuration
 */
namespace server {
/// Default request timeout in milliseconds
constexpr int DEFAULT_TIMEOUT_MS = 30000;
/// Interval for collecting statistics in milliseconds
constexpr int STATS_INTERVAL_MS = 100;
/// Default span of live SSE history retained in memory per run, in
/// milliseconds (config key `liveReplayWindowMs`). The buffer is a ring: older
/// ticks are evicted, so a run's memory does not grow with its duration. A
/// consumer that resumes from further back is served from the oldest retained
/// tick (SSE clients tolerate a gap on resume).
///
/// The bound is a *duration*, not a tick count, because the tick cadence is
/// itself user-configurable (`liveTickIntervalMs`, 10-1000ms): a fixed count
/// would mean a 30-second window at one end of that range and a 50-minute one
/// at the other. 5 minutes matches the app's default live-chart window, so a
/// dashboard attaching mid-run replays what it is going to show.
constexpr int DEFAULT_LIVE_REPLAY_WINDOW_MS = 300000;
/// Default ceiling on retained live ticks per run (config key
/// `liveMaxRetainedTicks`) - the backstop that keeps a fast cadence from
/// turning a long window into unbounded memory. It is a *memory* bound, not a
/// rendering one: the dashboard's charts bucket ticks before plotting (0.5s by
/// default) and uPlot draws to canvas, so a full window reaches the screen as a
/// few thousand points however many ticks back it.
///
/// Raising it is close to free at stock settings, because the window - not this
/// ceiling - is what sizes the ring: a 5-minute window at a 100ms cadence holds
/// 3000 ticks whatever this is set to. It only binds when window / cadence
/// exceeds it. 50000 is chosen so the longest configurable window (1 hour) is
/// honoured in full at the default cadence, with headroom.
///
/// The renderer keeps the same value (its DEFAULT_MAX_RETAINED_TICKS in
/// app/src/constants/live-window.ts) and reads this key too, so neither side
/// promises a window the other cannot hold.
constexpr size_t DEFAULT_MAX_LIVE_TICKS = 50000;
/// How long `RunManager::shutdown` waits for signalled runs to reach a terminal
/// status before it logs that they have not. The *wait* is bounded; the join
/// that follows it is not, because abandoning a still-running worker is exactly
/// the use-after-free the drain exists to prevent. Matches the 5s the daemon
/// waited before the drain was ordered.
constexpr int64_t RUN_SHUTDOWN_GRACE_MS = 5000;
/// How far ahead of an OAuth 2.0 token's expiry a run refreshes it (config key
/// `oauth2RefreshLeadMs`). Comfortably wider than the 45s skew
/// `oauth::is_expired` already applies, so the new credential is published
/// while the old one is still being accepted and no request falls in the gap.
constexpr int64_t OAUTH2_REFRESH_LEAD_MS = 60000;
/// Floor on the wait between two mid-run refreshes. A token whose whole
/// lifetime is shorter than the lead is always inside its refresh window, so
/// without a floor the watchdog would re-acquire in a tight loop and hammer the
/// token endpoint on the run's behalf.
constexpr int64_t OAUTH2_REFRESH_MIN_INTERVAL_MS = 1000;
/// First wait after a failed mid-run refresh, doubled per consecutive failure
/// up to OAUTH2_REFRESH_RETRY_MAX_MS. The run keeps sending the credential it
/// has - a failed refresh is reported, never fatal - so retrying is about
/// recovering from a token endpoint that blipped, not about the run's fate.
constexpr int64_t OAUTH2_REFRESH_RETRY_MS = 5000;
/// Ceiling on that backoff, so a token endpoint that is down for an hour costs
/// the run a bounded number of attempts rather than one every five seconds.
constexpr int64_t OAUTH2_REFRESH_RETRY_MAX_MS = 60000;
/// How often the refresh watchdog wakes while waiting, to notice that the run
/// has ended. The worker joins the thread on its way out, so this is what
/// bounds how long a finished run waits for it: without the slice, a watchdog
/// asleep until the next expiry would hold the run open for the rest of the
/// token's life. Lower costs a few more wakeups per second on one thread.
constexpr int64_t OAUTH2_REFRESH_POLL_INTERVAL_MS = 100;
} // namespace server

/**
 * @brief The server-vitals monitor a run may scrape alongside its own metrics.
 *
 * The three a user reaches for are config-backed (`monitorIntervalMs`,
 * `monitorMaxSeries`, `monitorScrapeTimeoutMs`) and these are their seeds. The
 * rest are rails rather than preferences: the interval bounds exist to stop a
 * cadence that measures the scraper instead of the target, and the backoff
 * threshold is how politely the loop gives up on a dead endpoint - the same
 * reason `threshold_eval`'s budget ranges are constants.
 */
namespace monitor {
/// Floor on `monitor.intervalMs`. Below this the scrape's own latency is a
/// large share of the interval, so the series measures the scraper.
constexpr int MIN_INTERVAL_MS = 250;
/// Ceiling on it. A run shorter than one interval would record nothing.
constexpr int MAX_INTERVAL_MS = 60000;
/// Cadence for a block that names no `intervalMs` (config `monitorIntervalMs`).
constexpr int DEFAULT_INTERVAL_MS = 1000;
/// How many metrics one run may chart (config `monitorMaxSeries`). Each is a
/// line on one overlay and a name matched against every exposition line.
constexpr size_t MAX_SERIES = 8;
/// Consecutive failed scrapes before the loop logs once and backs off. Below
/// this a scrape failure is a gap in the series and nothing else.
constexpr int FAILURES_BEFORE_BACKOFF = 5;
/// `monitorScrapeTimeoutMs` seed. Zero is the sentinel for "derive from the
/// interval", which is what keeps the timeout tracking a cadence the user
/// changes later; see `resolve_scrape_timeout_ms`.
constexpr int DEFAULT_SCRAPE_TIMEOUT_MS = 0;
/// Floor the derivation never goes below, for an interval small enough that
/// three quarters of it would time out before a loopback endpoint could answer.
constexpr int MIN_DERIVED_SCRAPE_TIMEOUT_MS = 100;
} // namespace monitor

/**
 * @brief Script engine configuration
 */
namespace script_engine {
/// Memory limit for the script engine in bytes (64MB)
constexpr size_t MEMORY_LIMIT = 64 * 1024 * 1024;
/// Script execution timeout in milliseconds
constexpr uint64_t TIMEOUT_MS = 5000;
/// Stack size for the script engine in bytes (256KB)
constexpr size_t STACK_SIZE = 256 * 1024;
/// Whether to enable console output from scripts
constexpr bool ENABLE_CONSOLE = true;
/**
 * @brief How many requests one script execution may issue via
 *        `pm.sendRequest`.
 *
 * A cap rather than a knob because the failure it bounds is not the single
 * script a user is watching: a load run's `tests` script runs once per
 * *sampled* response, serially, on the run's worker thread, so an uncapped
 * loop turns post-run validation into minutes of apparent hang. Ten is well
 * above the token-fetch case the feature exists for and far below the point
 * where a sampled run stops looking finished.
 */
constexpr int SEND_REQUEST_LIMIT = 10;
} // namespace script_engine

/**
 * @brief JSON processing configuration
 */
namespace json {
/// Default indentation level for JSON serialization
constexpr int DEFAULT_INDENT = 2;
/// Maximum size for JSON field parsing to prevent OOM (10MB)
constexpr size_t MAX_FIELD_SIZE = 10 * 1024 * 1024;
/// Maximum request/response body bytes stored per design-run trace (5MB).
/// Larger bodies are truncated in results.trace_data with bodyTruncated set.
constexpr size_t MAX_TRACE_BODY_BYTES = 5 * 1024 * 1024;
} // namespace json

/**
 * @brief Collection-runner (scenario) bounds.
 */
namespace scenario {
/// Largest plan one scenario run may resolve to (config key `maxScenarioSteps`).
/// The whole plan is composed up front and held in memory for the run's life,
/// and load-mode scenarios allocate one latency histogram per step, so plan
/// size is a memory bound in both modes rather than a policy preference.
constexpr size_t MAX_STEPS = 200;
/// Largest inline `data` array one scenario run may carry (config key
/// `maxScenarioDataRows`). The rows arrive on the run payload because the app
/// owns file parsing and the script sandbox has no filesystem access; this is
/// what bounds the payload that decision costs.
constexpr size_t MAX_DATA_ROWS = 1000;
/// Largest serialized size of that inline `data` array (config key
/// `maxScenarioDataBytes`). The row bound alone does not bound the payload -
/// one row with a megabyte in a cell is within it - and the transport's own
/// ceiling is cpp-httplib's 100MB body cap, which would surface as a reset
/// connection rather than as a message naming what was wrong. This is the
/// engine-authored bound that answers first.
constexpr size_t MAX_DATA_BYTES = 16 * 1024 * 1024;
/// Largest number of per-step `results` rows one scenario run stores (config
/// key `maxScenarioStoredSteps`; 0 = unlimited). `Database::get_results` loads
/// every row of a run with no limit and the report parses each `trace_data`,
/// which the dashboard polls - so an unbounded 200-step by 500-iteration run
/// would make the report path quadratic. Steps that did not pass are kept
/// first and what was thinned is disclosed in the run summary.
constexpr size_t MAX_STORED_STEPS = 5000;
/// How many step executions one iteration may perform, derived from the plan
/// when the config key `maxStepsPerIteration` is left at its default of 0:
/// `STEPS_PER_ITERATION_MULTIPLIER x plan steps`, never below
/// `MIN_STEPS_PER_ITERATION`. `pm.execution.setNextRequest` makes an infinite
/// loop a two-line script, so an iteration needs a ceiling; the ceiling is a
/// multiple of the sequence's own length because a plan of 3 steps and a plan
/// of 200 do not want the same one, and the floor keeps a short plan's
/// legitimate retry loops working.
constexpr size_t STEPS_PER_ITERATION_MULTIPLIER = 10;
constexpr size_t MIN_STEPS_PER_ITERATION        = 100;
} // namespace scenario

/**
 * @brief Metrics collector configuration for high-RPS load testing
 */
namespace metrics_collector {
/// Default expected requests for pre-allocation
constexpr size_t DEFAULT_EXPECTED_REQUESTS = 100000;
/// Default maximum error records to store (config key `maxStoredErrors`;
/// 0 = unlimited) (prevents OOM at high error rates). A fully-failing target
/// produces errors at close to the completion rate, each carrying a message and
/// a trace blob, so an unlimited store is a straight path to an OOM kill
/// mid-run. Errors past the cap are still counted (see
/// MetricsCollector::errors_dropped) and still reach the status-code
/// distribution - only their individual records are dropped, which truncates
/// the final report's per-type error breakdown. Raise the key to keep that
/// breakdown complete on a run with more errors than this.
constexpr size_t DEFAULT_MAX_ERRORS = 10000;
/// Maximum sampled success results to store (config key `max_success_results`;
/// 0 = unlimited). Retained as a reservoir: past the cap a later completion
/// displaces a uniformly chosen incumbent rather than being dropped, so the
/// stored set describes the whole run instead of its first
/// `max_success_results * success_sample_rate` requests.
constexpr size_t DEFAULT_MAX_SUCCESS_RESULTS = 1000;
/// Maximum slow-request records to store (config key `max_slow_results`;
/// 0 = unlimited). A separate budget from the sampled successes: a completion
/// past `slow_threshold_ms` is stored because the user asked for outliers, so
/// it must not consume a 1-in-N slot - and under saturation most completions
/// cross the threshold, so it needs a ceiling of its own.
constexpr size_t DEFAULT_MAX_SLOW_RESULTS = 1000;
/// Default latency (ms) past which a completion is captured as an outlier
/// (config key `slow_threshold_ms`). 0 disables slow-request capture.
constexpr int DEFAULT_SLOW_THRESHOLD_MS = 1000;
/// Default sample rate for success traces (1 in N)
constexpr size_t DEFAULT_SUCCESS_SAMPLE_RATE = 100;
/// Whether to store success trace data by default
constexpr bool DEFAULT_STORE_SUCCESS_TRACES = false;
/// Maximum response samples to store for deferred script validation
constexpr size_t DEFAULT_MAX_RESPONSE_SAMPLES = 1000;
/// Sample rate for response storage (1 = all, 100 = 1%, etc.)
constexpr size_t DEFAULT_RESPONSE_SAMPLE_RATE = 100;
/// Upper bound on the collector's *pre-allocation* - not on what a run may go
/// on to store, since both vectors still grow past it.
///
/// Both derived reserves scale with `expected_requests`, which RunContext
/// computes as duration x RPS x 1.2 with no ceiling of its own. At 1M RPS for
/// a day that is ~1.04e11, and the errors reserve (expected / 20, taken
/// whenever `max_errors` is 0 - the default, and nothing overrides it) asks
/// for ~5.2e9 ResultRecords, on the order of 450 GB. That allocation throws
/// out of the collector's constructor, which runs inside RunContext's, which
/// the route calls *after* writing the run row - so the caller gets an opaque
/// 500 and the row is stranded `pending` forever. A reserve is only an
/// optimisation, so capping it costs a few reallocations on a run that large
/// and nothing at all otherwise. 1M records is ~90 MB, still generous.
constexpr size_t MAX_RESERVE_RECORDS = 1000000;
/// Whether a load run captures response headers/bodies for its retained
/// samples by default (config key `capture_response_bodies`). On by default is
/// only defensible because capture is failure-and-outlier-shaped rather than
/// uniform: a healthy run captures roughly `EXEMPLARS_PER_STATUS` bodies per
/// distinct status code and nothing else, so the common case costs kilobytes.
constexpr bool DEFAULT_CAPTURE_RESPONSE_BODIES = true;
/// Largest single captured response body kept, in bytes (config key
/// `maxSampleBodyBytes`). Deliberately far below design mode's
/// `maxTraceBodyBytes` (5 MiB): a design run stores one exchange the user asked
/// for, a load run stores tens of them nobody asked for individually.
constexpr size_t DEFAULT_MAX_SAMPLE_BODY_BYTES = 32768;
/// Whole-run budget for captured body bytes (config key `maxSampleBytes`).
/// Once spent, samples keep being recorded with their headers and metadata and
/// only the bodies are dropped - counted by
/// MetricsCollector::sample_bodies_dropped so the UI can say the set is
/// incomplete rather than showing a silently biased subset.
constexpr size_t DEFAULT_MAX_SAMPLE_BYTES = 2 * 1024 * 1024;
/// How many exemplars of each distinct status code a run guarantees to retain.
/// Small on purpose: exemplars answer "what does a 503 from this target look
/// like", which the first few answer as well as the first few hundred.
constexpr size_t EXEMPLARS_PER_STATUS = 3;
/// Ceiling on the exemplar store (config key `max_exemplar_results`; 0 =
/// unlimited). The per-status gate already bounds a normal run to
/// `EXEMPLARS_PER_STATUS x distinct status codes`, which is single digits;
/// this is the guard for a target that answers with hundreds of distinct
/// codes. Exemplars past it are dropped and counted, never displaced - an
/// exemplar's whole value is that it was retained, so a reservoir would defeat
/// the bucket.
constexpr size_t DEFAULT_MAX_EXEMPLAR_RESULTS = 64;
/// HdrHistogram significant figures (3 = ~0.1% precision)
constexpr int HISTOGRAM_SIGNIFICANT_FIGURES = 3;
/// HdrHistogram max trackable latency in microseconds (1 hour)
constexpr int64_t HISTOGRAM_MAX_LATENCY_US = 3600LL * 1000LL * 1000LL;
/// Whether a load run feeds the five per-phase histograms (config key
/// `phaseHistograms`). On by default: the phase values are computed for every
/// completion anyway, and without this bank they survive only for the ~1% of
/// completions a trace is retained for - so "was it the server or the
/// connection path" is answered off a biased sample. The escape hatch exists
/// because the feed is five atomic histogram records on the completion path;
/// see docs/engine/benchmarks.md for the measured cost.
constexpr bool DEFAULT_PHASE_HISTOGRAMS = true;

/// Whether a streaming load run feeds the per-completion event histogram
/// (run config `stream_metrics`, issue #576). On by default: it is one atomic
/// histogram record per completion, paid only by runs that stream, and it is
/// the whole point of running a stream under load - events/sec is the number
/// such a run exists to produce.
constexpr bool DEFAULT_STREAM_METRICS = true;

/// Ceiling on the event histogram's value range - events delivered by one
/// stream. Above `sse::STREAM_EVENTS_CEILING`, which is what a per-request cap
/// can be set to, so the histogram can hold any completion the caps allow.
constexpr int64_t HISTOGRAM_MAX_EVENTS = 10000000;
} // namespace metrics_collector

/**
 * @brief SSE request configuration (issue #573)
 *
 * The seeds and bounds of the six `sse*` settings. Every one of them exists
 * because a stream is unbounded by nature: it has no content length, no promise
 * to end, and no ceiling on how much it will send. These are where each of
 * those turns into a number the engine can hold a stream to.
 */
namespace sse {
/// Events retained in memory per run for replay and tail, seeding
/// `sseMaxRetainedEvents`. An LLM completion is a few hundred tokens, so the
/// stock ring holds a whole one and then some.
constexpr std::size_t MAX_RETAINED_EVENTS     = 2000;
constexpr std::size_t MIN_RETAINED_EVENTS     = 10;
constexpr std::size_t RETAINED_EVENTS_CEILING = 200000;

/// Bytes of one event's `data` kept, seeding `sseMaxEventBytes`. Also the cap
/// on any single unterminated line, which is what bounds the parser itself.
constexpr std::size_t MAX_EVENT_BYTES     = 64 * 1024;
constexpr std::size_t MIN_EVENT_BYTES     = 256;
constexpr std::size_t EVENT_BYTES_CEILING = 8UL * 1024 * 1024;

/// Events written into a completed run's trace, seeding `sseMaxStoredEvents`.
/// Smaller than the ring: the ring is a live window that dies with the run,
/// this is on disk for as long as the run is retained.
constexpr std::size_t MAX_STORED_EVENTS     = 500;
constexpr std::size_t STORED_EVENTS_CEILING = 100000;

/// Default per-request caps, seeding `sseMaxStreamDurationMs` and
/// `sseMaxStreamEvents`. Ten minutes is longer than any single model response
/// and far shorter than a leaked worker thread.
constexpr int64_t MAX_STREAM_DURATION_MS     = 600000;
constexpr int64_t MIN_STREAM_DURATION_MS     = 1000;
constexpr int64_t STREAM_DURATION_MS_CEILING = 86400000;

constexpr int64_t MAX_STREAM_EVENTS     = 100000;
constexpr int64_t MIN_STREAM_EVENTS     = 1;
constexpr int64_t STREAM_EVENTS_CEILING = 10000000;

/// Grace between a load stream's duration cap and the whole-transfer timeout
/// that backstops it (issue #576). The cap is enforced from the progress
/// callback, which libcurl runs at least once a second, so the backstop has to
/// sit far enough past the cap that ordinary callback latency never beats it -
/// otherwise a stream that ended exactly as asked is reported as a timeout.
/// Reaching the backstop at all means the callback never ran, which is a real
/// failure and is reported as one.
constexpr int64_t LOAD_STREAM_TIMEOUT_GRACE_MS = 5000;

/// How long a stream may deliver nothing before it is ended as idle, seeding
/// `sseIdleTimeoutMs`. Enforced through `CURLOPT_LOW_SPEED_TIME`, whose
/// resolution is whole seconds, so a value is rounded up to the next second and
/// the floor is one second.
constexpr int64_t IDLE_TIMEOUT_MS         = 60000;
constexpr int64_t MIN_IDLE_TIMEOUT_MS     = 1000;
constexpr int64_t IDLE_TIMEOUT_MS_CEILING = 3600000;

/// How many keep-alive intervals a relay may go without a successful write
/// before its claim is considered dead and a reconnect may take it over - the
/// #506 rule, with the same two-interval window the inbox uses.
constexpr int RELAY_KEEPALIVE_MS          = 15000;
constexpr int RELAY_POLL_INTERVAL_MS      = 50;
constexpr int RELAY_CLAIM_STALE_INTERVALS = 2;
} // namespace sse

/**
 * @brief Webhook inbox configuration (issue #480)
 *
 * Rails rather than preferences: every one of these bounds what a *remote*
 * caller can make the engine hold or wait for, so none is user-settable. The
 * canned response a user actually tunes (status, headers, body, delay) is
 * per-inbox request state, not a constant.
 */
namespace inbox {
/// Stored bytes per capture, seeding the `inboxMaxBodyBytes` setting. A larger
/// body is truncated with the flag set.
constexpr int64_t MAX_BODY_BYTES = 64 * 1024;
/// Bounds on that setting. The floor keeps a capture from being all flag and no
/// payload; the ceiling is the transport limit below, past which nothing is
/// read at all.
constexpr int64_t MIN_BODY_BYTES = 256;

/// Captures retained per inbox, seeding the `inboxMaxCaptures` setting; the
/// oldest are deleted as new ones arrive.
constexpr int64_t MAX_CAPTURES = 500;
/// Bounds on that setting. The ceiling is what one `GET /inbox/:id/requests`
/// page may ask for, so it also bounds how much a single read materialises.
constexpr int64_t MIN_CAPTURES     = 1;
constexpr int64_t CAPTURES_CEILING = 10000;

/// Poll cadence of `GET /inbox/:id/live` against the capture table, seeding the
/// `inboxLivePollIntervalMs` setting.
constexpr int LIVE_POLL_INTERVAL_MS = 250;
/// Bounds on that setting: below the floor the wakeups outweigh the latency
/// they save, above the ceiling a webhook visibly lags its arrival.
constexpr int MIN_LIVE_POLL_INTERVAL_MS = 25;
constexpr int MAX_LIVE_POLL_INTERVAL_MS = 5000;

/// How many poll intervals a live stream may go without a successful write
/// before its claim is considered dead and a reconnect may take it over. A
/// healthy stream writes at least a keep-alive every interval, so two elapsed
/// intervals means it is not writing - see InboxManager::try_claim_live.
constexpr int LIVE_CLAIM_STALE_INTERVALS = 2;
/// Floor under that window, so a 25ms cadence does not make ordinary scheduler
/// jitter look like a dead holder.
constexpr int MIN_LIVE_CLAIM_STALE_MS = 100;

/// Transport limit on one inbound request. Past this the listener answers 413
/// and records nothing - a payload this size is not a webhook. A rail rather
/// than a setting: it bounds what an unauthenticated *remote* caller can make
/// the engine buffer, which is not the local user's preference to spend.
constexpr size_t MAX_PAYLOAD_BYTES = 8UL * 1024 * 1024;
/// Upper bound on the canned response's artificial delay. It occupies a
/// listener thread for its whole duration - and the teardown join waits for it
/// - so it is bounded well below any client timeout. A rail for the same
/// reason: it is how long a stop can be made to take, not a preference.
constexpr int MAX_RESPONSE_DELAY_MS = 30000;
/// Page size of `GET /inbox/:id/requests` when the caller names none. Not a
/// setting: the app always sends an explicit `limit`, so an engine-side default
/// would have no reader on the path the app takes.
constexpr int64_t DEFAULT_PAGE_LIMIT = 50;
} // namespace inbox

/**
 * @brief Script validation configuration
 */
namespace script_validation {
/// Maximum failure messages to store in validation results
constexpr size_t MAX_FAILURE_MESSAGES = 10;
} // namespace script_validation

/**
 * @brief Queue and Event Loop configuration
 */
namespace queue {
/// Default capacity for the SPSC queue (must be power of 2)
constexpr size_t CAPACITY = 65536;
/// Number of spins before sleeping in the worker loop
constexpr int SPIN_COUNT = 2000;
} // namespace queue

/**
 * @brief Local OAuth 2.0 mock issuer bounds
 *
 * Rails rather than preferences: every one of these bounds a resource the
 * *caller* does not pay for - listener threads, and two maps a long-lived
 * daemon would otherwise grow one entry per authorize call that never came
 * back for its code. The issuer's actual behaviour (expiry, claims, failure
 * mode, cadence of nothing) is per-issuer request payload, not config.
 */
namespace mock_issuer {
/// Concurrently running issuers. Each owns a listener thread plus cpp-httplib's
/// own accept loop, so this is a thread budget more than anything else.
constexpr size_t MAX_ISSUERS = 8;
/// Clients one issuer may be configured with.
constexpr size_t MAX_CLIENTS = 32;
/// Authorization codes held awaiting their exchange (oldest evicted first).
constexpr size_t MAX_PENDING_CODES = 256;
/// Live refresh tokens held per issuer (oldest evicted first). Rotation spends
/// one and mints one, so this only binds when many are issued and never used.
constexpr size_t MAX_REFRESH_TOKENS = 256;
/// How long an authorization code stays exchangeable. RFC 6749 §4.1.2 asks for
/// a short lifetime; this matches the interactive attempt TTL in
/// oauth_authorize.cpp so the two halves of one flow expire together.
constexpr int64_t CODE_TTL_MS = 5 * 60 * 1000;
/// Ceiling on the `slow` failure mode's delay. Past a minute the caller is
/// testing its own timeout, and the sleep holds a cpp-httplib pool thread.
constexpr int64_t MAX_SLOW_MS = 60000;
/// Ceiling on a minted token's lifetime (31 days).
constexpr int64_t MAX_EXPIRES_IN_SECONDS = 31LL * 86400LL;
} // namespace mock_issuer

/**
 * @brief Saved example-response bounds (issue #481)
 *
 * A rail, not a preference: an example is stored verbatim in a TEXT column that
 * `GET /requests/:id/examples` returns in full, so the cap bounds what one
 * import - or one caller - can make every later read of that request pay for.
 * Generous enough for the recorded JSON payloads examples exist to hold, and
 * well under the point at which a list response stops being displayable.
 */
namespace request_example {
/// Body bytes per stored example. A larger body is a 400, never a silent
/// truncation: an example whose body is not what the caller sent would be
/// served as if it were (phase 2), and a half-body is worse than a refusal.
constexpr size_t MAX_BODY_BYTES = 1024 * 1024;
/// Examples one request may hold. Bounds the list read and the per-request
/// slice of a bulk import.
constexpr size_t MAX_PER_REQUEST = 100;

/**
 * Who wrote the row (issue #588, consumed by the spec sync of #627).
 *
 * Two values and no more: `import` is every row an importer or a spec sync
 * produced, `user` is one a person saved from a live response. Sync may replace
 * the first kind wholesale and must never touch the second, so this is a stored
 * discriminator rather than something a later read could infer - nothing else
 * about the row says where it came from.
 *
 * `import` is the default because it is honest for every row that existed
 * before the column did: until the app could save one, import was the only
 * writer.
 */
constexpr const char* ORIGIN_IMPORT = "import";
constexpr const char* ORIGIN_USER   = "user";
} // namespace request_example

/**
 * @brief OpenAPI document bounds (issue #637).
 */
namespace spec_document {
/// Bytes one stored OpenAPI document may hold (config key
/// `maxSpecDocumentBytes`). Aligned with `json::MAX_FIELD_SIZE`, because every
/// later phase parses the stored text back as JSON and that is the ceiling the
/// parse path already carries. Engine-authored so an oversized document is
/// refused with a message naming the count and the cap, the way `MAX_DATA_BYTES`
/// is - cpp-httplib's own body cap would drop the connection instead.
constexpr size_t MAX_BYTES = 10 * 1024 * 1024;

/// Operation rows one stored `spec_documents.operations` index may declare, and
/// the same number of rows a coverage block reports (issue #629).
///
/// A cap on both halves rather than only the report's, because the index is
/// what a run holds in memory for its whole life: an enormous document must not
/// be able to make every scenario run of it carry a proportional allocation.
/// Both places that enforce it *name* what they dropped - the write refuses with
/// the count, the report carries `operationsTruncated` - because a silently
/// shortened coverage block reads as a contract that is smaller than it is.
constexpr size_t MAX_OPERATIONS = 2000;

/// Status codes one coverage row may list under `statusesSeen`/`undeclaredSeen`.
/// A misconfigured target can answer one operation with hundreds of distinct
/// codes; the row stays readable and says how many it dropped.
constexpr size_t MAX_STATUSES_PER_OPERATION = 50;
} // namespace spec_document

/**
 * @brief Local mock server bounds (issue #481 phase 2)
 *
 * Rails rather than preferences, the same split the inbox and the issuer draw:
 * every value here bounds a resource the *caller* of the mock does not pay for
 * - listener threads, and the route table one collection can make the engine
 * hold. What a user actually tunes per mock (latency, error rate) is request
 * payload, not config.
 */
namespace mock_server {
/// Concurrently running mocks. Each owns a listener thread plus cpp-httplib's
/// own accept loop, so this is a thread budget - the same one the issuer's
/// MAX_ISSUERS is.
constexpr size_t MAX_SERVERS = 8;
/// Routes one mock may hold. A collection tree is walked whole at start, so
/// this bounds what a single `POST /mock/start` materialises; past it the start
/// is refused rather than the tail silently dropped.
constexpr size_t MAX_ROUTES = 2000;
/// Ceiling on the injected per-response delay. It holds a cpp-httplib pool
/// thread for its whole duration - and the teardown join waits for it - so it
/// is bounded well below any client timeout, exactly as the inbox's canned
/// delay is.
constexpr int MAX_LATENCY_MS = 30000;
} // namespace mock_server

/**
 * @brief Database optimization configuration
 */
namespace database {
/// SQLite cache size in bytes (67108864 = 64MB, converted to negative KB for SQLite PRAGMA)
constexpr int CACHE_SIZE_BYTES = 67108864;
/// SQLite temp store mode (0=default, 1=file, 2=memory)
constexpr int TEMP_STORE = 2;
/// SQLite memory-mapped I/O size in bytes (256MB)
constexpr size_t MMAP_SIZE_BYTES = 268435456;
/// WAL autocheckpoint frequency in pages
constexpr int WAL_AUTOCHECKPOINT = 1000;
/// SQLite busy timeout in milliseconds (10 seconds)
constexpr int BUSY_TIMEOUT_MS = 10000;
/// SQLite synchronous mode (0=OFF, 1=NORMAL, 2=FULL) - 0 is safe with WAL
constexpr int SYNCHRONOUS = 0;
/// Run retention: keep at most N most-recent runs (0 = unlimited).
constexpr int MAX_RUNS_RETAINED = 200;
/// Run retention: delete runs older than N days (0 = unlimited).
constexpr int RUN_RETENTION_DAYS = 30;
} // namespace database
} // namespace vayu::core::constants

/**
 * @brief Metrics constants
 */
namespace vayu::core::metrics {
/// Multiplier for converting ratios to percentages
constexpr double PERCENTAGE_MULTIPLIER = 100.0;
} // namespace vayu::core::metrics
