#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <curl/curl.h>

#include <string>

#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"

namespace vayu::http::detail {

// Forward declaration
struct TransferData;
class DnsCache;

/**
 * @brief Convert CURL error code to vayu Error
 */
Error curl_to_error(CURLcode code, const char* error_buffer);

/**
 * @brief Get HTTP status text from status code
 */
const char* status_text(int code);

/**
 * @brief Extract hostname from URL
 */
std::string extract_hostname(const std::string& url);

/**
 * @brief Extract port from URL (defaults to 443 for https, 80 for http)
 */
int extract_port(const std::string& url);

/**
 * @brief Setup a CURL easy handle for a request
 * @param curl Pre-allocated curl handle (from pool) or nullptr to create new
 * @param data Transfer data containing request info
 * @param config Event loop configuration
 * @param dns_cache Optional DNS cache for pre-resolved hostnames
 * @return Configured curl handle, or nullptr on failure
 */
CURL* setup_easy_handle(CURL* curl,
                        TransferData* data,
                        const EventLoopConfig& config,
                        DnsCache* dns_cache = nullptr);

/**
 * @brief Extract response from completed CURL transfer
 */
Result<Response> extract_response(CURL* curl, TransferData* data, CURLcode result);

}  // namespace vayu::http::detail
