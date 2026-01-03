#pragma once

#include <curl/curl.h>

#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"

namespace vayu::http::detail {

// Forward declaration
struct TransferData;

/**
 * @brief Convert CURL error code to vayu Error
 */
Error curl_to_error(CURLcode code, const char* error_buffer);

/**
 * @brief Get HTTP status text from status code
 */
const char* status_text(int code);

/**
 * @brief Setup a CURL easy handle for a request
 */
CURL* setup_easy_handle(TransferData* data, const EventLoopConfig& config);

/**
 * @brief Extract response from completed CURL transfer
 */
Result<Response> extract_response(CURL* curl, TransferData* data, CURLcode result);

}  // namespace vayu::http::detail
