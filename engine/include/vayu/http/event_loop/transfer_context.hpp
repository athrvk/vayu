#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <curl/curl.h>

#include <functional>
#include <future>
#include <string>

#include "vayu/types.hpp"

namespace vayu::http {

// Forward declarations from event_loop.hpp
using RequestCallback = std::function<void (size_t request_id, Result<Response>)>;
using ProgressCallback =
std::function<void (size_t request_id, size_t downloaded, size_t total)>;

namespace detail {

/**
 * @brief Data associated with each HTTP transfer
 *
 * This struct holds all state needed to track a single HTTP request
 * through its lifecycle in the event loop.
 */
struct TransferData {
    size_t request_id = 0;
    Request request;
    Response response;
    std::string response_body;
    RequestCallback callback;
    ProgressCallback progress;
    std::promise<Result<Response>> promise;
    bool has_promise                   = false;
    char error_buffer[CURL_ERROR_SIZE] = { 0 };
    struct curl_slist* headers_list    = nullptr;
    struct curl_slist* resolve_list    = nullptr; // DNS pre-resolution list

    ~TransferData ();
};

} // namespace detail
} // namespace vayu::http
