#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

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
/// Maximum total connections allowed
constexpr size_t MAX_CONNECTIONS = 10000;
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
 * @brief Server-Sent Events (SSE) configuration
 */
namespace sse {
/// Maximum retry interval for SSE reconnection in milliseconds
constexpr int MAX_RETRY_MS = 30000;
/// Connection timeout for SSE in milliseconds
constexpr int CONNECT_TIMEOUT_MS = 30000;
/// Whether to send Last-Event-ID header on reconnect
constexpr bool SEND_LAST_EVENT_ID = true;
} // namespace sse

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
} // namespace metrics_collector

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
