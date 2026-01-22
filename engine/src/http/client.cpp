/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/client.cpp
 * @brief HTTP client implementation using libcurl
 */

#ifdef _WIN32
#include <windows.h>
#include <winsock2.h>
// Windows headers define DELETE macro which conflicts with HttpMethod::DELETE
#ifdef DELETE
#undef DELETE
#endif
#endif

#include "vayu/http/client.hpp"

#include <curl/curl.h>

#include <cstring>
#include <stdexcept>

#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace vayu::http {

// ============================================================================
// Helper Functions
// ============================================================================

namespace {
int debug_callback(CURL* handle, curl_infotype type, char* data, size_t size, void* userptr) {
    (void) handle;
    (void) userptr;

    std::string text(data, size);
    // Remove trailing newlines
    while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) {
        text.pop_back();
    }

    switch (type) {
        case CURLINFO_TEXT:
            vayu::utils::log_debug("* " + text);
            break;
        case CURLINFO_HEADER_OUT:
            vayu::utils::log_debug("> " + text);
            break;
        case CURLINFO_HEADER_IN:
            vayu::utils::log_debug("< " + text);
            break;
        default:
            break;
    }
    return 0;
}

/**
 * @brief Callback for writing response body
 */
size_t write_callback(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* response_body = static_cast<std::string*>(userdata);
    size_t total_size = size * nmemb;
    response_body->append(ptr, total_size);
    return total_size;
}

/**
 * @brief Callback for writing response headers
 */
size_t header_callback(char* buffer, size_t size, size_t nitems, void* userdata) {
    auto* headers = static_cast<Headers*>(userdata);
    size_t total_size = size * nitems;

    std::string line(buffer, total_size);

    // Remove trailing \r\n
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
        line.pop_back();
    }

    // Skip empty lines and status line
    if (line.empty() || line.starts_with("HTTP/")) {
        return total_size;
    }

    // Parse header: "Key: Value"
    auto colon_pos = line.find(':');
    if (colon_pos != std::string::npos) {
        std::string key = line.substr(0, colon_pos);
        std::string value = line.substr(colon_pos + 1);

        // Trim leading whitespace from value
        while (!value.empty() && value.front() == ' ') {
            value.erase(0, 1);
        }

        // Convert key to lowercase for consistency
        for (auto& c : key) {
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        }

        (*headers)[key] = value;
    }

    return total_size;
}

/**
 * @brief Convert curl error code to our ErrorCode
 */
Error curl_to_error(CURLcode code, const char* error_buffer) {
    Error error;
    error.message = error_buffer[0] ? error_buffer : curl_easy_strerror(code);

    switch (code) {
        case CURLE_OK:
            error.code = ErrorCode::None;
            break;
        case CURLE_OPERATION_TIMEDOUT:
            error.code = ErrorCode::Timeout;
            break;
        case CURLE_COULDNT_CONNECT:
        case CURLE_COULDNT_RESOLVE_HOST:
        case CURLE_COULDNT_RESOLVE_PROXY:
            error.code = ErrorCode::ConnectionFailed;
            break;
        case CURLE_SSL_CONNECT_ERROR:
        case CURLE_SSL_CERTPROBLEM:
        case CURLE_SSL_CIPHER:
        case CURLE_PEER_FAILED_VERIFICATION:
            error.code = ErrorCode::SslError;
            break;
        case CURLE_URL_MALFORMAT:
            error.code = ErrorCode::InvalidUrl;
            break;
        default:
            error.code = ErrorCode::InternalError;
            break;
    }

    return error;
}

/**
 * @brief Get HTTP status text from code
 */
const char* status_text(int code) {
    switch (code) {
        case 200:
            return "OK";
        case 201:
            return "Created";
        case 204:
            return "No Content";
        case 301:
            return "Moved Permanently";
        case 302:
            return "Found";
        case 304:
            return "Not Modified";
        case 400:
            return "Bad Request";
        case 401:
            return "Unauthorized";
        case 403:
            return "Forbidden";
        case 404:
            return "Not Found";
        case 405:
            return "Method Not Allowed";
        case 408:
            return "Request Timeout";
        case 429:
            return "Too Many Requests";
        case 500:
            return "Internal Server Error";
        case 502:
            return "Bad Gateway";
        case 503:
            return "Service Unavailable";
        case 504:
            return "Gateway Timeout";
        default:
            return "Unknown";
    }
}

}  // namespace

// ============================================================================
// Client Implementation
// ============================================================================

struct Client::Impl {
    CURL* curl = nullptr;
    ClientConfig config;
    char error_buffer[CURL_ERROR_SIZE] = {0};

    explicit Impl(ClientConfig cfg) : config(std::move(cfg)) {
        curl = curl_easy_init();
        if (!curl) {
            throw std::runtime_error("Failed to initialize curl");
        }
    }

    ~Impl() {
        if (curl) {
            curl_easy_cleanup(curl);
        }
    }

    void reset() {
        curl_easy_reset(curl);
        std::memset(error_buffer, 0, sizeof(error_buffer));
    }
};

Client::Client(ClientConfig config) : impl_(std::make_unique<Impl>(std::move(config))) {}

Client::~Client() = default;

Client::Client(Client&&) noexcept = default;
Client& Client::operator=(Client&&) noexcept = default;

Result<Response> Client::send(const Request& request) {
    impl_->reset();
    CURL* curl = impl_->curl;

    // Response data
    Response response;
    std::string response_body;

    // Store request headers for response
    response.request_headers = request.headers;

    // Set error buffer
    curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, impl_->error_buffer);

    // Set URL
    curl_easy_setopt(curl, CURLOPT_URL, request.url.c_str());

    // Set method
    switch (request.method) {
        case HttpMethod::GET:
            curl_easy_setopt(curl, CURLOPT_HTTPGET, 1L);
            break;
        case HttpMethod::POST:
            curl_easy_setopt(curl, CURLOPT_POST, 1L);
            break;
        case HttpMethod::PUT:
            curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
            break;
        case HttpMethod::DELETE:
            curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
            break;
        case HttpMethod::PATCH:
            curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PATCH");
            break;
        case HttpMethod::HEAD:
            curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);
            break;
        case HttpMethod::OPTIONS:
            curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "OPTIONS");
            break;
    }

    // Set request body
    if (request.body.mode != BodyMode::None && !request.body.content.empty()) {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request.body.content.c_str());
        curl_easy_setopt(
            curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(request.body.content.size()));
    }

    // Set headers
    struct curl_slist* headers_list = nullptr;
    for (const auto& [key, value] : request.headers) {
        std::string header = key + ": " + value;
        headers_list = curl_slist_append(headers_list, header.c_str());
    }

    // Add User-Agent if not set
    bool has_user_agent =
        request.headers.contains("User-Agent") || request.headers.contains("user-agent");
    if (!has_user_agent) {
        std::string ua = "User-Agent: " + impl_->config.user_agent;
        headers_list = curl_slist_append(headers_list, ua.c_str());
        response.request_headers["User-Agent"] = impl_->config.user_agent;
    }

    if (headers_list) {
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers_list);
    }

    // Build raw request string (proper HTTP/1.1 format)
    std::stringstream raw_req;

    // Parse URL to extract host and path
    std::string host;
    std::string path = "/";
    std::string url = request.url;

    // Remove protocol prefix
    size_t proto_end = url.find("://");
    if (proto_end != std::string::npos) {
        url = url.substr(proto_end + 3);
    }

    // Split host and path
    size_t path_start = url.find('/');
    if (path_start != std::string::npos) {
        host = url.substr(0, path_start);
        path = url.substr(path_start);
    } else {
        host = url;
        // Check for query string without path
        size_t query_start = host.find('?');
        if (query_start != std::string::npos) {
            path = "/" + host.substr(query_start);
            host = host.substr(0, query_start);
        }
    }

    // Request line: METHOD /path HTTP/1.1
    raw_req << to_string(request.method) << " " << path << " HTTP/1.1\r\n";

    // Host header (required for HTTP/1.1)
    raw_req << "Host: " << host << "\r\n";

    // Add all request headers
    for (const auto& [key, value] : response.request_headers) {
        // Skip if it's a Host header (we already added it)
        if (key == "Host" || key == "host") continue;
        raw_req << key << ": " << value << "\r\n";
    }

    // Add Content-Length for body
    if (!request.body.content.empty()) {
        raw_req << "Content-Length: " << request.body.content.size() << "\r\n";
    }

    // End of headers
    raw_req << "\r\n";

    // Body
    if (!request.body.content.empty()) {
        raw_req << request.body.content;
    }
    response.raw_request = raw_req.str();

    // Set callbacks
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_body);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &response.headers);

    // Set timeout
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(request.timeout_ms));

    // Set redirect options
    if (request.follow_redirects) {
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt(curl, CURLOPT_MAXREDIRS, static_cast<long>(request.max_redirects));
    }

    // SSL verification
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, request.verify_ssl ? 1L : 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, request.verify_ssl ? 2L : 0L);

    // Verbose output for debugging
    if (impl_->config.verbose) {
        curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L);
        curl_easy_setopt(curl, CURLOPT_DEBUGFUNCTION, debug_callback);
    }

    // Proxy
    if (!impl_->config.proxy_url.empty()) {
        curl_easy_setopt(curl, CURLOPT_PROXY, impl_->config.proxy_url.c_str());
    }

    // Perform the request
    CURLcode res = curl_easy_perform(curl);

    // Cleanup headers
    if (headers_list) {
        curl_slist_free_all(headers_list);
    }

    // Get timing info (try to get even on errors, as curl may have partial timing)
    double total_time = 0, namelookup_time = 0, connect_time = 0;
    double appconnect_time = 0, starttransfer_time = 0;

    curl_easy_getinfo(curl, CURLINFO_TOTAL_TIME, &total_time);
    curl_easy_getinfo(curl, CURLINFO_NAMELOOKUP_TIME, &namelookup_time);
    curl_easy_getinfo(curl, CURLINFO_CONNECT_TIME, &connect_time);
    curl_easy_getinfo(curl, CURLINFO_APPCONNECT_TIME, &appconnect_time);
    curl_easy_getinfo(curl, CURLINFO_STARTTRANSFER_TIME, &starttransfer_time);

    response.timing.total_ms = total_time * 1000.0;
    response.timing.dns_ms = namelookup_time * 1000.0;
    response.timing.connect_ms = (connect_time - namelookup_time) * 1000.0;
    response.timing.tls_ms = (appconnect_time - connect_time) * 1000.0;
    response.timing.first_byte_ms = (starttransfer_time - appconnect_time) * 1000.0;
    response.timing.download_ms = (total_time - starttransfer_time) * 1000.0;

    // Check for errors
    if (res != CURLE_OK) {
        // Convert curl error to ErrorCode and message
        Error error = curl_to_error(res, impl_->error_buffer);
        
        // Return Response object with error details (Postman-compatible approach)
        response.status_code = 0;  // 0 indicates client-side error (no server response)
        response.status_text = "Error";
        response.error_code = error.code;
        response.error_message = error.message;
        // raw_request is already populated above
        // headers and body remain empty (no server response)
        // timing info is already set above
        
        return response;
    }

    // Get response info for successful requests
    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    response.status_code = static_cast<int>(http_code);
    response.status_text = status_text(response.status_code);
    response.error_code = ErrorCode::None;  // Explicitly set to None for successful requests

    // Set body
    response.body = std::move(response_body);
    response.body_size = response.body.size();

    return response;
}

Result<Response> Client::get(const std::string& url, const Headers& headers) {
    Request request;
    request.method = HttpMethod::GET;
    request.url = url;
    request.headers = headers;
    return send(request);
}

Result<Response> Client::post(const std::string& url,
                              const std::string& body,
                              const Headers& headers) {
    Request request;
    request.method = HttpMethod::POST;
    request.url = url;
    request.body.mode = BodyMode::Text;
    request.body.content = body;
    request.headers = headers;
    return send(request);
}

std::string Client::last_error() const {
    return impl_->error_buffer;
}

// ============================================================================
// Global Functions
// ============================================================================

void global_init() {
    curl_global_init(CURL_GLOBAL_ALL);
}

void global_cleanup() {
    curl_global_cleanup();
}

}  // namespace vayu::http
