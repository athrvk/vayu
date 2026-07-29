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
/// Timeout for event loop polling in milliseconds
constexpr int POLL_TIMEOUT_MS = 10;
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
/// Upper bound on `max_response_samples` (each retained sample holds a full
/// response body, and the vector is reserved up front).
constexpr int64_t MAX_RESPONSE_SAMPLES = 1000000;
} // namespace run_config

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
/// Size of the context pool for request handling
constexpr size_t CONTEXT_POOL_SIZE = 64;
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
/// Maximum success results to store (0 = unlimited)
constexpr size_t DEFAULT_MAX_SUCCESS_RESULTS = 1000;
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
