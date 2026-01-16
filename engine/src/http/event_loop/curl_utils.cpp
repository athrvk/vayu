#include "vayu/http/event_loop/curl_utils.hpp"

#include <curl/curl.h>

#include <regex>

#include "vayu/core/config_manager.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/event_loop/curl_callbacks.hpp"
#include "vayu/http/event_loop/event_loop_worker.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

std::string extract_hostname(const std::string& url) {
    // Simple regex to extract hostname from URL
    // Matches: protocol://hostname:port/path or protocol://hostname/path
    static const std::regex url_regex(R"(^(?:https?://)?([^:/\s]+))", std::regex::optimize);
    std::smatch match;
    if (std::regex_search(url, match, url_regex) && match.size() > 1) {
        return match[1].str();
    }
    return "";
}

int extract_port(const std::string& url) {
    // Check for explicit port
    static const std::regex port_regex(R"(^(?:https?://)?[^:/\s]+:(\d+))", std::regex::optimize);
    std::smatch match;
    if (std::regex_search(url, match, port_regex) && match.size() > 1) {
        return std::stoi(match[1].str());
    }
    // Default ports
    if (url.find("https://") == 0) return 443;
    if (url.find("http://") == 0) return 80;
    return 443;  // Default to HTTPS
}

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

CURL* setup_easy_handle(CURL* curl,
                        TransferData* data,
                        const EventLoopConfig& config,
                        DnsCache* dns_cache) {
    // Use provided handle or create new one
    if (!curl) {
        curl = curl_easy_init();
        if (!curl) {
            return nullptr;
        }
    }

    const Request& request = data->request;

    // Set error buffer
    curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, data->error_buffer);

    // Set URL
    curl_easy_setopt(curl, CURLOPT_URL, request.url.c_str());

    // DNS Pre-resolution: Use cached DNS to bypass system resolver
    // This is critical for high-RPS loads (prevents DNS saturation)
    if (dns_cache) {
        std::string hostname = extract_hostname(request.url);
        int port = extract_port(request.url);
        if (!hostname.empty()) {
            struct curl_slist* resolve_list = dns_cache->get_resolve_list(hostname, port);
            if (resolve_list) {
                curl_easy_setopt(curl, CURLOPT_RESOLVE, resolve_list);
                data->resolve_list = resolve_list;  // Store for cleanup
            }
        }
    }

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
    for (const auto& [key, value] : request.headers) {
        std::string header = key + ": " + value;
        data->headers_list = curl_slist_append(data->headers_list, header.c_str());
    }

    // Add User-Agent if not set
    bool has_user_agent =
        request.headers.contains("User-Agent") || request.headers.contains("user-agent");
    if (!has_user_agent) {
        std::string ua = "User-Agent: " + config.user_agent;
        data->headers_list = curl_slist_append(data->headers_list, ua.c_str());
    }

    if (data->headers_list) {
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, data->headers_list);
    }

    // Set callbacks
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, data);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, data);

    // Progress callback
    if (data->progress) {
        curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, progress_callback);
        curl_easy_setopt(curl, CURLOPT_XFERINFODATA, data);
        curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    }

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

    // =========================================================================
    // HIGH-PERFORMANCE OPTIMIZATIONS (Phase 1 - Target: 60k RPS)
    // Reads from ConfigManager for runtime configurability
    // =========================================================================

    auto& cfg = vayu::core::ConfigManager::instance();

    // DNS Caching: Cache DNS lookups to avoid resolver saturation
    // This is critical - DNS was causing 84% of errors at 10k RPS
    // Setting to 0 disables caching (resolves every request)
    long dns_cache_timeout = cfg.get_int(
        "dnsCacheTimeout", 
        vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS);
    curl_easy_setopt(curl, CURLOPT_DNS_CACHE_TIMEOUT, dns_cache_timeout);

    // TCP Keep-Alive: Reuse connections and detect dead sockets faster
    // Setting idle time to 0 disables keep-alive entirely
    long keepalive_idle = cfg.get_int(
        "tcpKeepAliveIdle",
        vayu::core::constants::event_loop::TCP_KEEPALIVE_IDLE_SECONDS);
    long keepalive_interval = cfg.get_int(
        "tcpKeepAliveInterval",
        vayu::core::constants::event_loop::TCP_KEEPALIVE_INTERVAL_SECONDS);
    
    if (keepalive_idle > 0) {
        curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);
        curl_easy_setopt(curl, CURLOPT_TCP_KEEPIDLE, keepalive_idle);
        curl_easy_setopt(curl, CURLOPT_TCP_KEEPINTVL, keepalive_interval);
    } else {
        // Disable TCP keep-alive when idle time is 0
        curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 0L);
    }

    // HTTP/2: Enable multiplexing (many requests over single connection)
    // This dramatically reduces connection establishment overhead
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2TLS);

    // Connection reuse: Don't close connection after request
    curl_easy_setopt(curl, CURLOPT_FORBID_REUSE, 0L);

    // TCP_NODELAY: Disable Nagle's algorithm for lower latency
    curl_easy_setopt(curl, CURLOPT_TCP_NODELAY, 1L);

    // =========================================================================

    // Verbose output for debugging
    if (config.verbose) {
        curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L);
        curl_easy_setopt(curl, CURLOPT_DEBUGFUNCTION, debug_callback);
    }

    // Proxy
    if (!config.proxy_url.empty()) {
        curl_easy_setopt(curl, CURLOPT_PROXY, config.proxy_url.c_str());
    }

    // Store private data pointer
    curl_easy_setopt(curl, CURLOPT_PRIVATE, data);

    return curl;
}

Result<Response> extract_response(CURL* curl, TransferData* data, CURLcode result) {
    if (result != CURLE_OK) {
        return curl_to_error(result, data->error_buffer);
    }

    Response& response = data->response;

    // Get response info
    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    response.status_code = static_cast<int>(http_code);
    response.status_text = status_text(response.status_code);

    // Get timing info
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

    // Set body
    response.body = std::move(data->response_body);
    response.body_size = response.body.size();

    return response;
}

}  // namespace vayu::http::detail
