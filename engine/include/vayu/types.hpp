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

#include <algorithm>
#include <cctype>
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
 * @brief Case-insensitive ordering for HTTP header names.
 *
 * HTTP header field names are case-insensitive (RFC 9110 §5.1), so the Headers
 * map treats `Authorization` and `authorization` as the same key. This removes
 * a whole class of duplicate-header / missed-lookup bugs.
 */
struct CaseInsensitiveLess {
    bool operator() (const std::string& a, const std::string& b) const {
        return std::lexicographical_compare (
        a.begin (), a.end (), b.begin (), b.end (),
        [] (unsigned char c1, unsigned char c2) {
            return std::tolower (c1) < std::tolower (c2);
        });
    }

    /// Header-name equality, for the callers that compare a name outside the
    /// map - the same rule the map's ordering already applies, rather than a
    /// private lower-casing copy at each call site.
    static bool equal (const std::string& a, const std::string& b) {
        const CaseInsensitiveLess less;
        return !less (a, b) && !less (b, a);
    }
};

/**
 * @brief HTTP Headers (case-insensitive keys)
 */
using Headers = std::map<std::string, std::string, CaseInsensitiveLess>;

/**
 * @brief Request body content types
 *
 * `Form` is `x-www-form-urlencoded` and `FormData` is `multipart/form-data`.
 * Both carry their content as `Body::fields`, never as `Body::content` - see
 * `vayu/http/form_body.hpp` for the wire encoding of each.
 */
enum class BodyMode { None, Json, Text, Form, FormData, Binary, GraphQL };

/**
 * @brief What a `form-data` part carries: typed text, or a file from disk.
 *
 * `x-www-form-urlencoded` has no file form - its wire encoding is a string of
 * pairs - so a `File` part is only ever valid under `BodyMode::FormData`, and
 * `parse_form_fields` refuses it anywhere else.
 */
enum class FormFieldType { Text, File };

/**
 * @brief One entry of a form body.
 *
 * Mirrors the renderer's `KeyValueEntry`: a disabled row is stored and
 * round-tripped, and dropped only when the body is put on the wire.
 *
 * A **file part** (`type == FormFieldType::File`) names a path in `src` rather
 * than carrying bytes in `value`: libcurl reads the file at transfer time, so
 * nothing here holds the contents. `file_name` and `content_type` override what
 * the part declares about itself; empty means "let libcurl derive it" (the
 * basename, and `application/octet-stream`). A file part whose `src` is empty
 * or unreadable is refused before the transfer starts - see
 * `vayu::http::unsendable_file_part`.
 */
struct FormField {
    FormField () = default;
    /// A text part, which is what three positional values have always meant.
    /// Written out rather than left to aggregate initialization so that adding
    /// the file members below does not turn every `{key, value, enabled}` in
    /// the tree into a `-Wmissing-field-initializers` warning.
    FormField (std::string field_key, std::string field_value, bool is_enabled = true)
    : key (std::move (field_key)), value (std::move (field_value)),
      enabled (is_enabled) {
    }

    std::string key;
    std::string value;
    bool enabled       = true;
    FormFieldType type = FormFieldType::Text;
    std::string src;          // file parts only - a path on this machine
    std::string file_name;    // declared filename; empty = basename of `src`
    std::string content_type; // per-part Content-Type; empty = libcurl's guess
};

/**
 * @brief Request body
 *
 * Exactly one of `content` and `fields` carries the body: the two form modes
 * use `fields`, every other content-bearing mode uses `content`.
 */
struct Body {
    BodyMode mode = BodyMode::None;
    std::string content;
    std::vector<FormField> fields;
};

/**
 * @brief Transport HTTP version for a request, stored as TEXT in the DB.
 *
 * `all_http_versions()` is the single enumeration of this domain - request
 * validation and the seeded config `options` list both derive their allowed
 * values from it rather than writing a literal list, so the two cannot drift.
 */
enum class HttpVersion { Auto, Http1_1, Http2 };

inline std::string to_string (HttpVersion version) {
    switch (version) {
    case HttpVersion::Auto: return "auto";
    case HttpVersion::Http1_1: return "http1.1";
    case HttpVersion::Http2: return "http2";
    }
    return "unknown";
}

inline std::string http_version_label (HttpVersion version) {
    switch (version) {
    case HttpVersion::Auto: return "Auto";
    case HttpVersion::Http1_1: return "HTTP/1.x";
    case HttpVersion::Http2: return "HTTP/2";
    }
    return "Unknown";
}

inline std::optional<HttpVersion> http_version_from_string (const std::string& str) {
    if (str == "auto")
        return HttpVersion::Auto;
    if (str == "http1.1")
        return HttpVersion::Http1_1;
    if (str == "http2")
        return HttpVersion::Http2;
    return std::nullopt;
}

inline const std::vector<HttpVersion>& all_http_versions () {
    static const std::vector<HttpVersion> versions = { HttpVersion::Auto,
        HttpVersion::Http1_1, HttpVersion::Http2 };
    return versions;
}

constexpr HttpVersion DEFAULT_HTTP_VERSION = HttpVersion::Auto;

/**
 * @brief HTTP Request definition
 */
struct Request {
    HttpMethod method = HttpMethod::GET;
    std::string url;
    Headers headers;
    Body body;

    // Options
    int timeout_ms           = 30000;
    bool follow_redirects    = true;
    int max_redirects        = 10;
    bool verify_ssl          = true;
    HttpVersion http_version = DEFAULT_HTTP_VERSION;

    /**
     * @brief Give this transfer its own cookie engine, seeded with
     *        `cookie_lines` and read back into `Response::cookie_lines`.
     *
     * The event loop's handles come from a pool and are reused, so a cookie
     * engine left enabled on one would carry a session from whichever transfer
     * ran before it. Setting this flushes the handle first (`CURLOPT_COOKIELIST
     * "ALL"`) and seeds only what the caller supplied, which is what makes a
     * per-virtual-user session on a shared pool possible at all.
     *
     * Off for every single-request load run: `false` here is the difference
     * between two `curl_easy_setopt` calls per transfer and none.
     */
    bool track_cookies = false;

    /**
     * @brief libcurl's own Netscape lines to seed this transfer with.
     *
     * Same representation the jar stores (`http/cookie_jar.hpp`) and for the
     * same reason: libcurl owns the cookie semantics - domain and path
     * matching, `Secure`, expiry, replacement - and a hand-rolled copy of that
     * does not receive its fixes. Read only when `track_cookies` is set.
     */
    std::vector<std::string> cookie_lines;
};

/**
 * @brief Timing breakdown for a request
 */
struct Timing {
    double total_ms      = 0.0;  // perceived latency: submit → completion (after Plan 1)
    double wire_ms       = 0.0;  // pure CURLINFO_TOTAL_TIME (DNS + TCP + TLS + send + recv)
    double queue_wait_ms = 0.0;  // total_ms − wire_ms (generator-side overhead, clamped >= 0)
    double dns_ms        = 0.0;
    double connect_ms    = 0.0;
    double tls_ms        = 0.0;
    double first_byte_ms = 0.0;
    double download_ms   = 0.0;
    size_t bytes_down    = 0; // CURLINFO_SIZE_DOWNLOAD_T + response header bytes (wire)
    size_t bytes_up      = 0; // CURLINFO_SIZE_UPLOAD_T + request header bytes (wire)
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
    AuthRequired,
    AuthFailed,
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
    case ErrorCode::AuthRequired: return "AUTH_REQUIRED";
    case ErrorCode::AuthFailed: return "AUTH_FAILED";
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

    /**
     * @brief The protocol actually negotiated for this transfer, e.g.
     * "HTTP/1.1" or "HTTP/2" - read from CURLINFO_HTTP_VERSION after the
     * transfer completes.
     *
     * This is an *outcome*, not the request. It is deliberately a different
     * type and a different value space from the two other things also
     * called "http_version" in this codebase:
     *   - `Request::http_version` (HttpVersion enum) is what was asked for -
     *     Auto/Http1_1/Http2 - before the transfer ran.
     *   - `db::Request::http_version` (string) is that same request-side
     *     enum, persisted to disk.
     * Conflating either of those with this field would show a user a
     * protocol they asked for but were not actually granted.
     *
     * Empty when nothing was negotiated (e.g. the connection never reached a
     * server) - deliberately not defaulted to "HTTP/1.1", since that would be
     * a guess presented as a fact.
     */
    std::string http_version;

    /**
     * @brief True when the request explicitly asked for HTTP/2 and the
     * connection negotiated something older.
     *
     * Not derivable from `http_version` alone - that is the outcome, and the
     * outcome only becomes a complaint next to what was asked for, which the
     * Response does not otherwise carry. Computed once per transfer by
     * `vayu::http::http_version_downgraded` (curl_version_map.hpp) so both
     * drivers agree; see that function for why a silent downgrade needed
     * naming at all.
     */
    bool http_version_downgraded = false;

    /**
     * @brief The whole cookie jar the finishing handle held, when the request
     *        asked for one (`Request::track_cookies`); empty otherwise.
     *
     * The *whole* jar, not the `Set-Cookie`s of this exchange - what was seeded
     * plus whatever the response changed - which is why the caller replaces its
     * copy with this rather than merging: merging would resurrect a cookie the
     * server deleted by expiring it. Same reasoning, and the same
     * representation, as `CookieJar::store`.
     */
    std::vector<std::string> cookie_lines;

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
 * @brief Which `console.*` method a script line came from.
 *
 * QuickJS binds all four methods to one C function, so the level has to be
 * captured at the call - it is not recoverable from the text afterwards. It was
 * dropped entirely until now, which is why every line reached the app's Console
 * tab looking the same whether the script called `log` or `error`.
 */
enum class ConsoleLevel { Log, Info, Warn, Error };

/** Wire spelling of a level. The app matches on these exact strings. */
[[nodiscard]] constexpr const char* to_string (ConsoleLevel level) noexcept {
    switch (level) {
    case ConsoleLevel::Info: return "info";
    case ConsoleLevel::Warn: return "warn";
    case ConsoleLevel::Error: return "error";
    case ConsoleLevel::Log: break;
    }
    return "log";
}

/**
 * @brief One `console.*` line from a script.
 *
 * No `source` field: a `ScriptEngine` run does not know whether it is the
 * pre-request or the post-request script. Whoever merges the two knows, and
 * fills it in on the wire (`execution.cpp`).
 */
struct ConsoleEntry {
    ConsoleLevel level = ConsoleLevel::Log;
    std::string message;
};

/**
 * @brief What a script asked the sequence around it to do next (issue #355).
 *
 * `pm.execution.setNextRequest` / `skipRequest` **record** an intent here and
 * reach into nothing. `ScriptResult` is already the channel a script speaks to
 * its caller through, and the caller - the scenario runner - is the only thing
 * that knows what a sequence is; a binding that reached into the runner would
 * also have to exist for callers that have no sequence at all.
 *
 * Last call wins within one script, which is Postman's behaviour.
 *
 * A `Kind` other than `None` is only ever produced inside a scenario run: both
 * bindings throw where `ScriptContext::in_scenario` is false, so a `POST
 * /execute` send and a load run's deferred `tests` script can never hand their
 * caller an instruction it would silently drop.
 */
struct ScriptControl {
    enum class Kind {
        None,        ///< The script asked for nothing; run the next step.
        Next,        ///< `setNextRequest(name)` - jump to `target`.
        Skip,        ///< `skipRequest()` - do not send this step.
        EndIteration ///< `setNextRequest(null)` - end this iteration.
    };
    Kind kind = Kind::None;
    /// The step name to jump to; set for `Kind::Next` and empty otherwise.
    std::string target;
};

/**
 * @brief Script execution result
 */
struct ScriptResult {
    bool success = true;
    std::vector<TestResult> tests;
    std::vector<ConsoleEntry> console_output;
    std::string error_message;
    /// Flow control the script asked for - read by the scenario runner, and
    /// `Kind::None` for every other caller (see ScriptControl).
    ScriptControl control;
};

// ============================================================================
// Environment Types
// ============================================================================

/**
 * @brief Variable value with metadata.
 *
 * `value` is always stored as a string on disk. `type` is a UI/script hint
 * (per data-model PRD §5.2) declaring the conversion applied when scripts
 * read this variable via pm.*.get(...). One of:
 *   "string" (default), "number", "boolean", "json".
 *
 * `created_at` (ms epoch) is the app's row-ordering key - the variables editor
 * lists a scope oldest-first. The engine does not display it, but it must
 * round-trip through every read/write of a stored variables blob, or the app's
 * ordering is destroyed (issue #135). `std::nullopt` means "unknown", which the
 * app sorts as older than everything; the engine never invents a value for an
 * existing variable, only for one a script creates.
 *
 * Every field here is serialized by `vayu::json::serialize_variables`; adding
 * one without adding it there silently drops it on the next design run.
 */
struct Variable {
    std::string value;
    bool secret  = false;
    bool enabled = true;
    std::string type = "string";
    std::optional<int64_t> created_at;

    bool operator== (const Variable&) const = default;
};

/**
 * @brief Environment (collection of variables)
 */
using Environment = std::map<std::string, Variable>;

// ============================================================================
// Database Enums
// ============================================================================

/**
 * @brief What kind of work a `runs` row records.
 *
 * `Scenario` is not a flavour of `Design`: a design run has exactly one
 * `results` row and `GET /runs/:runId` serves it as `result` on that assumption
 * (`attach_design_result`, `utils/json.cpp`), while a scenario run writes one
 * row per step execution. Overloading `design` would break that reader.
 */
enum class RunType { Design, Load, Scenario };

inline const char* to_string (RunType type) {
    switch (type) {
    case RunType::Design: return "design";
    case RunType::Load: return "load";
    case RunType::Scenario: return "scenario";
    }
    return "unknown";
}

inline std::optional<RunType> parse_run_type (const std::string& str) {
    if (str == "design")
        return RunType::Design;
    if (str == "load")
        return RunType::Load;
    if (str == "scenario")
        return RunType::Scenario;
    return std::nullopt;
}

enum class LoadTestType { ConstantRps, ConstantConcurrency, RampUp, Iterations };

inline const char* to_string (LoadTestType type) {
    switch (type) {
    case LoadTestType::ConstantRps: return "constant_rps";
    case LoadTestType::ConstantConcurrency: return "constant_concurrency";
    case LoadTestType::RampUp: return "ramp_up";
    case LoadTestType::Iterations: return "iterations";
    }
    return "unknown";
}

inline std::optional<LoadTestType> parse_load_test_type (const std::string& str) {
    if (str == "constant_rps")
        return LoadTestType::ConstantRps;
    if (str == "constant_concurrency")
        return LoadTestType::ConstantConcurrency;
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

// ============================================================================
// Database Types
// ============================================================================

namespace db {
struct Collection {
    std::string id;
    std::optional<std::string> parent_id;
    std::string name;
    std::string description;  // TEXT NOT NULL DEFAULT ''
    std::string variables;    // JSON - Collection-scoped variables
    std::string auth;         // JSON - Auth config (mode + fields), never 'inherit'
    std::string pre_request_script;  // JS - runs before every request in this collection
    std::string post_request_script; // JS - runs after every request in this collection
    int order;
    int64_t created_at;
    int64_t updated_at;
};

struct Request {
    std::string id;
    std::string collection_id;
    std::string name;
    std::string description; // TEXT NOT NULL DEFAULT ''
    HttpMethod method;
    std::string url;
    std::string params;    // JSON array of KeyValueEntry: [{key,value,enabled,description?}]
    std::string headers;   // JSON array of KeyValueEntry
    std::string body;      // JSON discriminated union: {mode,content?} | {mode,fields?}
    std::string body_type; // Denormalized: equals body.mode for queryability
    std::string auth;      // JSON - RequestAuth (mode + fields, may be 'inherit')
    std::string pre_request_script;  // JS Code
    std::string post_request_script; // JS Code (Tests)
    int order;             // INTEGER NOT NULL DEFAULT 0 - position within collection
    // Execution options. Mirror the fields of the executable vayu::Request so a
    // saved request keeps the redirect policy the user chose. The in-struct
    // defaults match the column defaults, so a default-constructed row and a row
    // written before these columns existed agree.
    bool follow_redirects    = true;   // INTEGER NOT NULL DEFAULT 1
    int max_redirects        = 10;     // INTEGER NOT NULL DEFAULT 10
    std::string http_version = "auto"; // TEXT NOT NULL DEFAULT 'auto'
    int64_t created_at;
    int64_t updated_at;
};

struct Environment {
    std::string id;
    std::string name;
    std::string description; // TEXT NOT NULL DEFAULT ''
    std::string variables;   // JSON
    // The environment a client resolves against by default, and the one it
    // restores on the next launch. At most one row carries it: every write path
    // goes through Database::deactivate_other_environments_locked, so
    // activating one environment deactivates the previous one in the same
    // transaction. Selecting it is still a client action - the engine never
    // *applies* an active environment to a request, which must name its own
    // environmentId - but the choice is stored here rather than in client-local
    // state, so it survives a reinstall and is shared by every client on the
    // same database. See docs/engine/db-schema.md.
    bool is_active = false;
    int64_t created_at;
    int64_t updated_at;
};

struct Run {
    std::string id;
    std::optional<std::string> request_id; // Linked request (if design mode)
    std::optional<std::string> environment_id; // Environment used
    RunType type;                              // "design", "load" or "scenario"
    RunStatus status;            // "pending", "running", "completed", "failed"
    std::string config_snapshot; // JSON string (Full copy of request/env)
    int64_t start_time;
    // 0 means "no end recorded"; readers guard on `> 0` (the report route
    // substitutes now_ms(), the app's dashboard falls back to its own clock).
    // Defaulted rather than left bare so an insert site that forgets to stamp
    // it cannot store an indeterminate value - a run orphaned by a daemon
    // crash is marked Failed with `end_time` as recorded, so garbage here
    // would survive into the report. Both route inserts seed it to start_time
    // via seed_run_times (execution.cpp).
    int64_t end_time = 0;
    // Whole-run results, written once when the run reaches a terminal status.
    // JSON object; `""` means "not written", which now means only one thing -
    // the engine died before the run reached a terminal status - so the report
    // route reports from the sampled `results` alone. NOT NULL with a `""`
    // default so sync_schema can ALTER TABLE ADD COLUMN it onto an existing
    // runs table (same pattern as requests.follow_redirects).
    std::string summary; // TEXT NOT NULL DEFAULT ''
};

/**
 * @brief One wide row per persisted metrics tick - the whole tick object as
 * stored JSON, replacing the ~18 EAV `metrics` rows a tick used to cost.
 *
 * `payload` is exactly the snake_case per-tick object `GET /runs/:id/metrics`
 * returns (the app's `LoadTestMetrics` shape), built once at write time instead
 * of reassembled per request. Rows map 1:1 to `data[]` entries, which is what
 * makes that endpoint's pagination tick-aligned.
 */
struct MetricTick {
    int id;
    std::string run_id;
    int64_t timestamp;  // Unix ms - the tick's single wall-clock sample
    std::string payload; // JSON object (see build_metric_tick_payload)
};

struct Result {
    int id;
    std::string run_id;
    int64_t timestamp;
    int status_code;
    std::string status_text; // Wire reason phrase, or canonical IANA text
    double latency_ms;
    std::string error;
    // JSON. Design mode stores the whole exchange here (request + response,
    // nested). A load run stores only the timing breakdown - never a body -
    // because `calculate_detailed_report` parses every row of this column on
    // every report fetch, and the dashboard polls that. Load-run bodies live in
    // `result_bodies`/`body_blobs` instead, read only by GET /runs/:id/samples.
    std::string trace_data;
};

/**
 * @brief One captured response body, content-addressed and shared within a run.
 *
 * Load-test responses are overwhelmingly identical, so the sample rows below
 * point at these rather than each carrying its own copy: 1000 samples of one
 * 2 KiB body store 2 KiB. Scoped per run (`run_id` + `hash` is unique) so
 * deleting a run deletes its blobs without any cross-run refcount to maintain.
 */
struct BodyBlob {
    int id;
    std::string run_id;
    std::string hash;    // lowercase hex SHA-256 of `content` (vayu::core::body_digest)
    std::string content; // the stored bytes, already truncated to the per-body cap
};

/**
 * @brief The captured exchange for one sampled load-run result.
 *
 * Keyed by the `results` row it belongs to, one-to-one. Its own table so the
 * report path - which loads every `results` row for a run and JSON-parses each
 * `trace_data` - never reads a body it does not use.
 */
struct ResultBody {
    int result_id; // PK, and the `results.id` this exchange belongs to
    std::string run_id;
    std::string headers;   // JSON object of response headers
    // 0 when no body was stored: the response had none, it was binary, or the
    // run's capture budget was spent. `body_bytes` and the flags say which.
    int blob_id;
    int64_t body_bytes;    // size of the body as received, before truncation
    bool truncated;        // stored bytes are a prefix of `body_bytes`
    bool is_binary;        // stored as a descriptor; `blob_id` is 0
    std::string content_type;
};

/**
 * @brief A captured exchange on its way to `result_bodies`, still unattached.
 *
 * `results.id` is assigned by the insert, so the pairing between a result and
 * its exchange has to travel as the result's index within the batch. Both are
 * written in one transaction (Database::add_results_batch), so a run never
 * persists a body row pointing at a result that did not land.
 */
struct PendingResultBody {
    size_t result_index = 0;
    std::string headers;   // JSON object
    std::string body;      // stored bytes; "" when binary, absent or dropped
    std::string body_hash; // digest of `body`; "" when nothing is stored
    int64_t body_bytes = 0;
    bool truncated     = false;
    bool binary        = false;
    std::string content_type;
};

/**
 * @brief Configuration entry with metadata for UI display
 */
struct ConfigEntry {
    std::string key;   // Unique identifier (e.g., "defaultTimeout")
    std::string value; // Current value as string (will be parsed based on type)
    std::string type;  // "integer", "string", "boolean", "number", "enum"
    std::string label; // Display label (e.g., "Default Request Timeout")
    std::string description; // Help text for UI
    std::string category; // Grouping (e.g., "server", "scripting", "performance")
    std::string default_value;            // Default value as string
    std::optional<std::string> min_value; // Optional minimum (for numbers)
    std::optional<std::string> max_value; // Optional maximum (for numbers)
    std::optional<std::string> options; // JSON array of {value,label}, enum types only
    int64_t updated_at;                 // Last update timestamp
};

/**
 * @brief Global variables - singleton storage for app-wide variables
 */
struct Globals {
    std::string id;        // Always "globals" - singleton
    std::string variables; // JSON - Global variables
    int64_t updated_at;
};

/**
 * @brief Cached OAuth 2.0 token, keyed by config identity.
 *
 * cache_key derivation lives in vayu::http::oauth::cache_key and must stay
 * byte-identical with the app's computeOAuth2CacheKey.
 */
struct OAuthToken {
    std::string cache_key;     // PK
    std::string access_token;
    std::string token_type;    // "Bearer" when the provider omits it
    std::string refresh_token; // "" = none
    std::string scope;
    int64_t expires_in;   // seconds; 0 = non-expiring
    int64_t created_at;   // ms epoch
    std::string raw_response; // provider JSON (truncated); debugging only, never logged
};
} // namespace db

} // namespace vayu
