#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <curl/curl.h>

#include <cstddef>

namespace vayu::http::detail {

/**
 * @brief CURL debug callback for verbose output
 */
int debug_callback(CURL* handle, curl_infotype type, char* data, size_t size, void* userptr);

/**
 * @brief CURL callback for writing response body
 */
size_t write_callback(char* ptr, size_t size, size_t nmemb, void* userdata);

/**
 * @brief CURL callback for writing response headers
 */
size_t header_callback(char* buffer, size_t size, size_t nitems, void* userdata);

/**
 * @brief CURL progress callback wrapper
 */
int progress_callback(
    void* clientp, curl_off_t dltotal, curl_off_t dlnow, curl_off_t ultotal, curl_off_t ulnow);

}  // namespace vayu::http::detail
