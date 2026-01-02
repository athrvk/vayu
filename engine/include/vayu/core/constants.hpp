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
}  // namespace json
}  // namespace vayu::core::constants

/**
 * @brief Metrics constants
 */
namespace vayu::core::metrics {
/// Multiplier for converting ratios to percentages
constexpr double PERCENTAGE_MULTIPLIER = 100.0;
}  // namespace vayu::core::metrics
