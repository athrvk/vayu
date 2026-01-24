#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file types.hpp
 * @brief Common types used throughout Vayu Engine
 */

#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace vayu {

// ============================================================================
// Time Types
// ============================================================================

using Clock     = std::chrono::steady_clock;
using TimePoint = Clock::time_point;
using Duration  = std::chrono::milliseconds;

// ============================================================================
// HTTP Types
// ============================================================================

#ifdef WIN32
// Un-define Windows macros that conflict with Vayu types
#ifdef DELETE
#undef DELETE
#endif
#ifdef ERROR
#undef ERROR
#endif
#endif

enum class HttpMethod { GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS };

/**
 * @brief Convert HttpMethod enum to string
 */
inline const char* to_string (HttpMethod method) {
    switch (method) {
    case HttpMethod::GET: return "GET";
    case HttpMethod::POST: return "POST";
    case HttpMethod::PUT: return "PUT";
    case HttpMethod::DELETE: return "DELETE";
    case HttpMethod::PATCH: return "PATCH";
    case HttpMethod::HEAD: return "HEAD";
    case HttpMethod::OPTIONS: return "OPTIONS";
    }
    return "UNKNOWN";
}

/**
 * @brief Parse string to HttpMethod
 */
inline std::optional<HttpMethod> parse_method (const std::string& str) {
    if (str == "GET")
        return HttpMethod::GET;
    if (str == "POST")
        return HttpMethod::POST;
    if (str == "PUT")
        return HttpMethod::PUT;
    if (str == "DELETE")
        return HttpMethod::DELETE;
    if (str == "PATCH")
        return HttpMethod::PATCH;
    if (str == "HEAD")
        return HttpMethod::HEAD;
    if (str == "OPTIONS")
        return HttpMethod::OPTIONS;
    return std::nullopt;
}

/**
 * @brief HTTP Headers (case-insensitive keys recommended)
 */
using Headers = std::map<std::string, std::string>;

/**
 * @brief Request body content types
 */
enum class BodyMode { None, Json, Text, Form, FormData, Binary, GraphQL };

/**
 * @brief Request body
 */
struct Body {
    BodyMode mode = BodyMode::None;
    std::string content;
};

/**
 * @brief HTTP Request definition
 */
struct Request {
    HttpMethod method = HttpMethod::GET;
    std::string url;
    Headers headers;
    Body body;

    // Options
    int timeout_ms        = 30000;
    bool follow_redirects = true;
    int max_redirects     = 10;
    bool verify_ssl       = true;
};

/**
 * @brief Timing breakdown for a request
 */
struct Timing {
    double total_ms      = 0.0;
    double dns_ms        = 0.0;
    double connect_ms    = 0.0;
    double tls_ms        = 0.0;
    double first_byte_ms = 0.0;
    double download_ms   = 0.0;
};

// ============================================================================
// Error Types (defined early so Response can use ErrorCode)
// ============================================================================

enum class ErrorCode {
    None,
    Timeout,
    ConnectionFailed,
    DnsError,
    SslError,
    InvalidUrl,
    InvalidMethod,
    ScriptError,
    InternalError
};

/**
 * @brief Convert ErrorCode to string
 */
inline const char* to_string (ErrorCode code) {
    switch (code) {
    case ErrorCode::None: return "NONE";
    case ErrorCode::Timeout: return "TIMEOUT";
    case ErrorCode::ConnectionFailed: return "CONNECTION_FAILED";
    case ErrorCode::DnsError: return "DNS_ERROR";
    case ErrorCode::SslError: return "SSL_ERROR";
    case ErrorCode::InvalidUrl: return "INVALID_URL";
    case ErrorCode::InvalidMethod: return "INVALID_METHOD";
    case ErrorCode::ScriptError: return "SCRIPT_ERROR";
    case ErrorCode::InternalError: return "INTERNAL_ERROR";
    }
    return "UNKNOWN";
}

/**
 * @brief HTTP Response
 */
struct Response {
    int status_code = 0;
    std::string status_text;
    Headers headers;
    Headers request_headers; // Headers that were sent in the request
    std::string raw_request; // Complete raw HTTP request
    std::string body;
    size_t body_size = 0;
    Timing timing;

    // Error information (for client-side failures like invalid URL, connection errors)
    // When set, indicates the request failed before receiving a server response
    ErrorCode error_code = ErrorCode::None;
    std::string error_message;

    // Convenience methods
    [[nodiscard]] bool is_success () const {
        return status_code >= 200 && status_code < 300 && error_code == ErrorCode::None;
    }

    [[nodiscard]] bool is_redirect () const {
        return status_code >= 300 && status_code < 400 && error_code == ErrorCode::None;
    }

    [[nodiscard]] bool is_client_error () const {
        return status_code >= 400 && status_code < 500 && error_code == ErrorCode::None;
    }

    [[nodiscard]] bool is_server_error () const {
        return status_code >= 500 && status_code < 600 && error_code == ErrorCode::None;
    }

    [[nodiscard]] bool has_error () const {
        return error_code != ErrorCode::None;
    }
};

// ============================================================================
// Error Information
// ============================================================================

/**
 * @brief Error information
 */
struct Error {
    ErrorCode code = ErrorCode::None;
    std::string message;

    [[nodiscard]] bool has_error () const {
        return code != ErrorCode::None;
    }

    [[nodiscard]] explicit operator bool () const {
        return has_error ();
    }
};

// ============================================================================
// Result Type
// ============================================================================

/**
 * @brief Result type that holds either a value or an error
 */
template <typename T> class Result {
    public:
    Result (T value) : data_ (std::move (value)) {
    }
    Result (Error error) : data_ (std::move (error)) {
    }

    [[nodiscard]] bool is_ok () const {
        return std::holds_alternative<T> (data_);
    }

    [[nodiscard]] bool is_error () const {
        return std::holds_alternative<Error> (data_);
    }

    [[nodiscard]] const T& value () const& {
        return std::get<T> (data_);
    }

    [[nodiscard]] T&& value () && {
        return std::get<T> (std::move (data_));
    }

    [[nodiscard]] const Error& error () const& {
        return std::get<Error> (data_);
    }

    private:
    std::variant<T, Error> data_;
};

// ============================================================================
// SSE Types
// ============================================================================

/**
 * @brief A single Server-Sent Event
 */
struct SseEvent {
    /// Event type (defaults to "message" if not specified)
    std::string type = "message";

    /// Event data (may contain multiple lines joined by newlines)
    std::string data;

    /// Optional event ID for reconnection
    std::optional<std::string> id;

    /// Server-suggested retry interval in milliseconds
    std::optional<int> retry_ms;
};

/**
 * @brief EventSource connection state
 */
enum class EventSourceState {
    Connecting, ///< Connection is being established
    Open,       ///< Connection is open and receiving events
    Closed      ///< Connection is closed
};

/**
 * @brief Convert state to string
 */
inline const char* to_string (EventSourceState state) {
    switch (state) {
    case EventSourceState::Connecting: return "CONNECTING";
    case EventSourceState::Open: return "OPEN";
    case EventSourceState::Closed: return "CLOSED";
    }
    return "UNKNOWN";
}

// ============================================================================
// Event Loop Types
// ============================================================================

/**
 * @brief Batch execution result
 */
struct BatchResult {
    std::vector<Result<Response>> responses;
    size_t successful    = 0;
    size_t failed        = 0;
    double total_time_ms = 0.0;
};

/**
 * @brief Event loop statistics
 */
struct EventLoopStats {
    size_t total_requests     = 0;
    size_t active_requests    = 0;
    size_t pending_requests   = 0;
    size_t completed_requests = 0;
};

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * Summary metrics for a stopped or completed run.
 */
struct RunSummary {
    size_t total_requests;
    size_t errors;
    double error_rate;
    double avg_latency_ms;
};

/**
 * Detailed report containing comprehensive statistics for a run.
 */
struct DetailedReport {
    // Summary
    size_t total_requests;
    size_t successful_requests;
    size_t failed_requests;
    double error_rate;
    double total_duration_s;
    double avg_rps;

    // Latency Statistics (ms)
    double latency_min;
    double latency_max;
    double latency_avg;
    double latency_p50;
    double latency_p75; // Phase 1: Additional percentile
    double latency_p90;
    double latency_p95;
    double latency_p99;
    double latency_p999; // Phase 1: Additional percentile

    // Distribution
    std::map<int, size_t> status_codes;

    // Error Details
    size_t errors_with_details; // Count of errors with trace data
    std::map<std::string, size_t> error_types; // e.g., {"timeout": 3, "connection_failed": 2}

    // Phase 1: Error categorization by status code
    std::map<int, size_t> errors_by_status_code;

    // Timing Breakdown (averages in ms) - only if timing data captured
    bool has_timing_data;
    double avg_dns_ms;
    double avg_connect_ms;
    double avg_tls_ms;
    double avg_first_byte_ms;
    double avg_download_ms;

    // Slow Requests
    size_t slow_requests_count;
    size_t slow_threshold_ms; // The threshold used (0 if not set)

    // Phase 1: Rate Control Metrics
    double target_rps;      // Configured target RPS (0 if unlimited)
    double actual_rps;      // Actual RPS achieved
    double rps_achievement; // Percentage of target achieved

    // Rate Metrics (Open Model)
    double send_rate;  // Avg rate at which requests were dispatched (req/s)
    double throughput; // Avg rate at which responses were received (req/s)

    // Phase 2: Timing context
    double setup_overhead_s; // Time from run creation to test start (seconds)
};

// ============================================================================
// Script Types
// ============================================================================

/**
 * @brief Test assertion result
 */
struct TestResult {
    std::string name;
    bool passed = false;
    std::string error_message;
};

/**
 * @brief Script execution result
 */
struct ScriptResult {
    bool success = true;
    std::vector<TestResult> tests;
    std::vector<std::string> console_output;
    std::string error_message;
};

// ============================================================================
// Environment Types
// ============================================================================

/**
 * @brief Variable value with metadata
 */
struct Variable {
    std::string value;
    bool secret  = false;
    bool enabled = true;
};

/**
 * @brief Environment (collection of variables)
 */
using Environment = std::map<std::string, Variable>;

// ============================================================================
// Database Enums
// ============================================================================

enum class RunType { Design, Load };

inline const char* to_string (RunType type) {
    switch (type) {
    case RunType::Design: return "design";
    case RunType::Load: return "load";
    }
    return "unknown";
}

inline std::optional<RunType> parse_run_type (const std::string& str) {
    if (str == "design")
        return RunType::Design;
    if (str == "load")
        return RunType::Load;
    return std::nullopt;
}

enum class LoadTestType { Constant, RampUp, Iterations };

inline const char* to_string (LoadTestType type) {
    switch (type) {
    case LoadTestType::Constant: return "constant";
    case LoadTestType::RampUp: return "ramp_up";
    case LoadTestType::Iterations: return "iterations";
    }
    return "unknown";
}

inline std::optional<LoadTestType> parse_load_test_type (const std::string& str) {
    if (str == "constant" || str == "duration")
        return LoadTestType::Constant;
    if (str == "ramp_up")
        return LoadTestType::RampUp;
    if (str == "iterations")
        return LoadTestType::Iterations;
    return std::nullopt;
}

enum class RunStatus { Pending, Running, Completed, Failed, Stopped };

inline const char* to_string (RunStatus status) {
    switch (status) {
    case RunStatus::Pending: return "pending";
    case RunStatus::Running: return "running";
    case RunStatus::Completed: return "completed";
    case RunStatus::Failed: return "failed";
    case RunStatus::Stopped: return "stopped";
    }
    return "unknown";
}

inline std::optional<RunStatus> parse_run_status (const std::string& str) {
    if (str == "pending")
        return RunStatus::Pending;
    if (str == "running")
        return RunStatus::Running;
    if (str == "completed")
        return RunStatus::Completed;
    if (str == "failed")
        return RunStatus::Failed;
    if (str == "stopped")
        return RunStatus::Stopped;
    return std::nullopt;
}

enum class MetricName {
    Rps,
    LatencyAvg,
    LatencyP50,
    LatencyP75,
    LatencyP90,
    LatencyP95,
    LatencyP99,
    LatencyP999,
    ErrorRate,
    TotalRequests,
    Completed,
    ConnectionsActive,
    RequestsSent,
    RequestsExpected,
    // Rate metrics (Open Model)
    SendRate,     // Rate at which requests are dispatched to the server
    Throughput,   // Rate at which responses are received from the server
    Backpressure, // Queue depth: requests sent but not yet responded
    // Script validation metrics
    TestsValidating,
    TestsPassed,
    TestsFailed,
    TestsSampled,
    // Status code distribution
    StatusCodes,
    // Duration metrics
    TestDuration, // Actual test execution time in seconds
    SetupOverhead // Time spent on setup/teardown in seconds
};

inline const char* to_string (MetricName name) {
    switch (name) {
    case MetricName::Rps: return "rps";
    case MetricName::LatencyAvg: return "latency_avg";
    case MetricName::LatencyP50: return "latency_p50";
    case MetricName::LatencyP75: return "latency_p75";
    case MetricName::LatencyP90: return "latency_p90";
    case MetricName::LatencyP95: return "latency_p95";
    case MetricName::LatencyP99: return "latency_p99";
    case MetricName::LatencyP999: return "latency_p999";
    case MetricName::ErrorRate: return "error_rate";
    case MetricName::TotalRequests: return "total_requests";
    case MetricName::Completed: return "completed";
    case MetricName::ConnectionsActive: return "connections_active";
    case MetricName::RequestsSent: return "requests_sent";
    case MetricName::RequestsExpected: return "requests_expected";
    case MetricName::SendRate: return "send_rate";
    case MetricName::Throughput: return "throughput";
    case MetricName::Backpressure: return "backpressure";
    case MetricName::TestsValidating: return "tests_validating";
    case MetricName::TestsPassed: return "tests_passed";
    case MetricName::TestsFailed: return "tests_failed";
    case MetricName::TestsSampled: return "tests_sampled";
    case MetricName::StatusCodes: return "status_codes";
    case MetricName::TestDuration: return "test_duration";
    case MetricName::SetupOverhead: return "setup_overhead";
    }
    return "unknown";
}

inline std::optional<MetricName> parse_metric_name (const std::string& str) {
    if (str == "rps")
        return MetricName::Rps;
    if (str == "latency_avg")
        return MetricName::LatencyAvg;
    if (str == "latency_p50")
        return MetricName::LatencyP50;
    if (str == "latency_p75")
        return MetricName::LatencyP75;
    if (str == "latency_p90")
        return MetricName::LatencyP90;
    if (str == "latency_p95")
        return MetricName::LatencyP95;
    if (str == "latency_p99")
        return MetricName::LatencyP99;
    if (str == "latency_p999")
        return MetricName::LatencyP999;
    if (str == "error_rate")
        return MetricName::ErrorRate;
    if (str == "total_requests")
        return MetricName::TotalRequests;
    if (str == "completed")
        return MetricName::Completed;
    if (str == "connections_active")
        return MetricName::ConnectionsActive;
    if (str == "requests_sent")
        return MetricName::RequestsSent;
    if (str == "requests_expected")
        return MetricName::RequestsExpected;
    if (str == "send_rate")
        return MetricName::SendRate;
    if (str == "throughput")
        return MetricName::Throughput;
    if (str == "backpressure")
        return MetricName::Backpressure;
    if (str == "tests_validating")
        return MetricName::TestsValidating;
    if (str == "tests_passed")
        return MetricName::TestsPassed;
    if (str == "tests_failed")
        return MetricName::TestsFailed;
    if (str == "tests_sampled")
        return MetricName::TestsSampled;
    if (str == "status_codes")
        return MetricName::StatusCodes;
    if (str == "test_duration")
        return MetricName::TestDuration;
    if (str == "setup_overhead")
        return MetricName::SetupOverhead;
    return std::nullopt;
}

// ============================================================================
// Database Types
// ============================================================================

namespace db {
struct Collection {
    std::string id;
    std::optional<std::string> parent_id;
    std::string name;
    std::string variables; // JSON - Collection-scoped variables
    int order;
    int64_t created_at;
    int64_t updated_at;
};

struct Request {
    std::string id;
    std::string collection_id;
    std::string name;
    HttpMethod method;
    std::string url;
    std::string params;  // JSON - Query parameters
    std::string headers; // JSON
    std::string body;    // JSON/Text
    std::string body_type; // "json", "text", "form-data", "x-www-form-urlencoded", "none"
    std::string auth;                // JSON
    std::string pre_request_script;  // JS Code
    std::string post_request_script; // JS Code (Tests)
    int64_t created_at;
    int64_t updated_at;
};

struct Environment {
    std::string id;
    std::string name;
    std::string variables; // JSON
    bool is_active = false;
    int64_t created_at;
    int64_t updated_at;
};

struct Run {
    std::string id;
    std::optional<std::string> request_id; // Linked request (if design mode)
    std::optional<std::string> environment_id; // Environment used
    RunType type;                              // "design" or "load"
    RunStatus status;            // "pending", "running", "completed", "failed"
    std::string config_snapshot; // JSON string (Full copy of request/env)
    int64_t start_time;
    int64_t end_time;
};

struct Metric {
    int id;
    std::string run_id;
    int64_t timestamp;
    MetricName name; // "rps", "latency", "error_rate"
    double value;
    std::string labels; // JSON string
};

struct Result {
    int id;
    std::string run_id;
    int64_t timestamp;
    int status_code;
    double latency_ms;
    std::string error;
    std::string trace_data; // JSON (Headers/Body - only for Design Mode or Errors)
};

/**
 * @brief Configuration entry with metadata for UI display
 */
struct ConfigEntry {
    std::string key;   // Unique identifier (e.g., "defaultTimeout")
    std::string value; // Current value as string (will be parsed based on type)
    std::string type;  // "integer", "string", "boolean", "number"
    std::string label; // Display label (e.g., "Default Request Timeout")
    std::string description; // Help text for UI
    std::string category; // Grouping (e.g., "server", "scripting", "performance")
    std::string default_value;            // Default value as string
    std::optional<std::string> min_value; // Optional minimum (for numbers)
    std::optional<std::string> max_value; // Optional maximum (for numbers)
    int64_t updated_at;                   // Last update timestamp
};

/**
 * @brief Global variables - singleton storage for app-wide variables
 */
struct Globals {
    std::string id;        // Always "globals" - singleton
    std::string variables; // JSON - Global variables
    int64_t updated_at;
};
} // namespace db

} // namespace vayu
