#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <curl/curl.h>

#include <chrono>
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
    std::chrono::steady_clock::time_point submitted_at{};
    Request request;
    Response response;
    std::string response_body;
    RequestCallback callback;
    ProgressCallback progress;
    std::promise<Result<Response>> promise;
    bool has_promise = false;
    /// Largest response body this transfer may buffer, 0 = unbounded.
    /// Set from EventLoopConfig when the handle is configured.
    size_t max_response_bytes = 0;
    /// Set by write_callback when it refused to buffer more, so the completion
    /// can name the cap instead of reporting curl's generic write failure.
    bool body_limit_exceeded           = false;
    char error_buffer[CURL_ERROR_SIZE] = { 0 };
    struct curl_slist* headers_list    = nullptr;
    struct curl_slist* resolve_list    = nullptr; // DNS pre-resolution list
    /// Multipart body attached to the handle, freed with the rest of this
    /// transfer's curl state. Only a `form-data` body has one.
    curl_mime* mime = nullptr;

    ~TransferData ();
};

} // namespace detail
} // namespace vayu::http
