/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/curl_callbacks.hpp"

#include <string>

#include "vayu/http/event_loop/transfer_context.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::detail {

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

size_t write_callback(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* data = static_cast<TransferData*>(userdata);
    size_t total_size = size * nmemb;
    data->response_body.append(ptr, total_size);
    return total_size;
}

size_t header_callback(char* buffer, size_t size, size_t nitems, void* userdata) {
    auto* data = static_cast<TransferData*>(userdata);
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

        data->response.headers[key] = value;
    }

    return total_size;
}

int progress_callback(void* clientp,
                      curl_off_t dltotal,
                      curl_off_t dlnow,
                      curl_off_t /*ultotal*/,
                      curl_off_t /*ulnow*/) {
    auto* data = static_cast<TransferData*>(clientp);
    if (data->progress) {
        data->progress(data->request_id, static_cast<size_t>(dlnow), static_cast<size_t>(dltotal));
    }
    return 0;
}

}  // namespace vayu::http::detail
