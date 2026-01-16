#pragma once

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
}  // namespace defaults

/**
 * @brief CLI argument constants
 */
namespace cli {
/// Short flag for port argument
constexpr const char* ARG_PORT_SHORT = "-p";
/// Long flag for port argument
constexpr const char* ARG_PORT_LONG = "--port";
}  // namespace cli

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
}  // namespace logging

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
}  // namespace http

/**
 * @brief Event loop configuration
 */
namespace event_loop {
/// Maximum concurrent requests per worker
constexpr size_t MAX_CONCURRENT = 1000;
/// Maximum concurrent connections per host
constexpr size_t MAX_PER_HOST = 100;
/// Timeout for event loop polling in milliseconds
constexpr int POLL_TIMEOUT_MS = 10;
/// DNS cache timeout in seconds (avoids DNS resolver saturation)
constexpr long DNS_CACHE_TIMEOUT_SECONDS = 300;
/// TCP keep-alive idle time in seconds
constexpr long TCP_KEEPALIVE_IDLE_SECONDS = 60;
/// TCP keep-alive probe interval in seconds
constexpr long TCP_KEEPALIVE_INTERVAL_SECONDS = 30;
}  // namespace event_loop

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
/// Size of the context pool for request handling
constexpr size_t CONTEXT_POOL_SIZE = 64;
}  // namespace server

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
}  // namespace sse

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
}  // namespace script_engine

/**
 * @brief JSON processing configuration
 */
namespace json {
/// Default indentation level for JSON serialization
constexpr int DEFAULT_INDENT = 2;
/// Maximum size for JSON field parsing to prevent OOM (10MB)
constexpr size_t MAX_FIELD_SIZE = 10 * 1024 * 1024;
}  // namespace json

/**
 * @brief Metrics collector configuration for high-RPS load testing
 */
namespace metrics_collector {
/// Default expected requests for pre-allocation
constexpr size_t DEFAULT_EXPECTED_REQUESTS = 100000;
/// Maximum errors to store (0 = unlimited) (prevents OOM at high error rates)
constexpr size_t DEFAULT_MAX_ERRORS = 0;
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
}  // namespace metrics_collector

/**
 * @brief Script validation configuration
 */
namespace script_validation {
/// Maximum failure messages to store in validation results
constexpr size_t MAX_FAILURE_MESSAGES = 10;
}  // namespace script_validation

/**
 * @brief Queue and Event Loop configuration
 */
namespace queue {
/// Default capacity for the SPSC queue (must be power of 2)
constexpr size_t CAPACITY = 65536;
/// Number of spins before sleeping in the worker loop
constexpr int SPIN_COUNT = 2000;
}  // namespace queue

/**
 * @brief Database streaming configuration
 */
namespace db_streaming {
/// Batch size for streaming requests to prevent OOM
constexpr size_t REQUEST_BATCH_SIZE = 5;
}  // namespace db_streaming

/**
 * @brief Database optimization configuration
 */
namespace database {
/// SQLite cache size in KB (negative value means KB, -64000 = 64MB)
constexpr int CACHE_SIZE_KB = -64000;
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
}  // namespace database
}  // namespace vayu::core::constants

/**
 * @brief Metrics constants
 */
namespace vayu::core::metrics {
/// Multiplier for converting ratios to percentages
constexpr double PERCENTAGE_MULTIPLIER = 100.0;
}  // namespace vayu::core::metrics
