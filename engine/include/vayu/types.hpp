#pragma once

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

namespace vayu
{

    // ============================================================================
    // Time Types
    // ============================================================================

    using Clock = std::chrono::steady_clock;
    using TimePoint = Clock::time_point;
    using Duration = std::chrono::milliseconds;

    // ============================================================================
    // HTTP Types
    // ============================================================================

    enum class HttpMethod
    {
        GET,
        POST,
        PUT,
        DELETE,
        PATCH,
        HEAD,
        OPTIONS
    };

    /**
     * @brief Convert HttpMethod enum to string
     */
    inline const char *to_string(HttpMethod method)
    {
        switch (method)
        {
        case HttpMethod::GET:
            return "GET";
        case HttpMethod::POST:
            return "POST";
        case HttpMethod::PUT:
            return "PUT";
        case HttpMethod::DELETE:
            return "DELETE";
        case HttpMethod::PATCH:
            return "PATCH";
        case HttpMethod::HEAD:
            return "HEAD";
        case HttpMethod::OPTIONS:
            return "OPTIONS";
        }
        return "UNKNOWN";
    }

    /**
     * @brief Parse string to HttpMethod
     */
    inline std::optional<HttpMethod> parse_method(const std::string &str)
    {
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
    enum class BodyMode
    {
        None,
        Json,
        Text,
        Form,
        FormData,
        Binary,
        GraphQL
    };

    /**
     * @brief Request body
     */
    struct Body
    {
        BodyMode mode = BodyMode::None;
        std::string content;
    };

    /**
     * @brief HTTP Request definition
     */
    struct Request
    {
        HttpMethod method = HttpMethod::GET;
        std::string url;
        Headers headers;
        Body body;

        // Options
        int timeout_ms = 30000;
        bool follow_redirects = true;
        int max_redirects = 10;
        bool verify_ssl = true;
    };

    /**
     * @brief Timing breakdown for a request
     */
    struct Timing
    {
        double total_ms = 0.0;
        double dns_ms = 0.0;
        double connect_ms = 0.0;
        double tls_ms = 0.0;
        double first_byte_ms = 0.0;
        double download_ms = 0.0;
    };

    /**
     * @brief HTTP Response
     */
    struct Response
    {
        int status_code = 0;
        std::string status_text;
        Headers headers;
        std::string body;
        size_t body_size = 0;
        Timing timing;

        // Convenience methods
        [[nodiscard]] bool is_success() const
        {
            return status_code >= 200 && status_code < 300;
        }

        [[nodiscard]] bool is_redirect() const
        {
            return status_code >= 300 && status_code < 400;
        }

        [[nodiscard]] bool is_client_error() const
        {
            return status_code >= 400 && status_code < 500;
        }

        [[nodiscard]] bool is_server_error() const
        {
            return status_code >= 500 && status_code < 600;
        }
    };

    // ============================================================================
    // Error Types
    // ============================================================================

    enum class ErrorCode
    {
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
    inline const char *to_string(ErrorCode code)
    {
        switch (code)
        {
        case ErrorCode::None:
            return "NONE";
        case ErrorCode::Timeout:
            return "TIMEOUT";
        case ErrorCode::ConnectionFailed:
            return "CONNECTION_FAILED";
        case ErrorCode::DnsError:
            return "DNS_ERROR";
        case ErrorCode::SslError:
            return "SSL_ERROR";
        case ErrorCode::InvalidUrl:
            return "INVALID_URL";
        case ErrorCode::InvalidMethod:
            return "INVALID_METHOD";
        case ErrorCode::ScriptError:
            return "SCRIPT_ERROR";
        case ErrorCode::InternalError:
            return "INTERNAL_ERROR";
        }
        return "UNKNOWN";
    }

    /**
     * @brief Error information
     */
    struct Error
    {
        ErrorCode code = ErrorCode::None;
        std::string message;

        [[nodiscard]] bool has_error() const
        {
            return code != ErrorCode::None;
        }

        [[nodiscard]] explicit operator bool() const
        {
            return has_error();
        }
    };

    // ============================================================================
    // Result Type
    // ============================================================================

    /**
     * @brief Result type that holds either a value or an error
     */
    template <typename T>
    class Result
    {
    public:
        Result(T value) : data_(std::move(value)) {}
        Result(Error error) : data_(std::move(error)) {}

        [[nodiscard]] bool is_ok() const
        {
            return std::holds_alternative<T>(data_);
        }

        [[nodiscard]] bool is_error() const
        {
            return std::holds_alternative<Error>(data_);
        }

        [[nodiscard]] const T &value() const &
        {
            return std::get<T>(data_);
        }

        [[nodiscard]] T &&value() &&
        {
            return std::get<T>(std::move(data_));
        }

        [[nodiscard]] const Error &error() const &
        {
            return std::get<Error>(data_);
        }

    private:
        std::variant<T, Error> data_;
    };

    // ============================================================================
    // Script Types
    // ============================================================================

    /**
     * @brief Test assertion result
     */
    struct TestResult
    {
        std::string name;
        bool passed = false;
        std::string error_message;
    };

    /**
     * @brief Script execution result
     */
    struct ScriptResult
    {
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
    struct Variable
    {
        std::string value;
        bool secret = false;
        bool enabled = true;
    };

    /**
     * @brief Environment (collection of variables)
     */
    using Environment = std::map<std::string, Variable>;

} // namespace vayu
