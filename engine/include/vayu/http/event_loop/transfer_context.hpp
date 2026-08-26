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
#include <optional>
#include <string>

#include "vayu/http/sse_frame_counter.hpp"
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
    bool body_limit_exceeded = false;

    /// The caps this transfer streams under, copied from the request when the
    /// handle is configured; absent for every non-streaming transfer, which is
    /// what keeps the counter and both cap checks off the ordinary hot path.
    std::optional<StreamBounds> stream_bounds;
    /// Events delivered so far. Fed by write_callback, finished and read once
    /// at completion.
    SseFrameCounter stream_counter;
    /// When the duration cap expires. Computed at configure time from
    /// `stream_bounds->max_duration_ms`, so the clock is read once per transfer
    /// rather than once per callback.
    std::chrono::steady_clock::time_point stream_deadline{};
    /// Set by whichever cap ended the transfer, so the completion can report a
    /// **success** where curl reports an aborted write. Distinct from
    /// `body_limit_exceeded`, which stays an error: the byte cap is a refusal
    /// to buffer, the stream caps are the stream's intended end.
    bool stream_cap_reached = false;

    char error_buffer[CURL_ERROR_SIZE] = { 0 };
    struct curl_slist* headers_list    = nullptr;
    struct curl_slist* resolve_list    = nullptr; // DNS pre-resolution list
    /// Multipart body attached to the handle, freed with the rest of this
    /// transfer's curl state. Only a `form-data` body has one.
    curl_mime* mime = nullptr;

    TransferData () = default;
    ~TransferData ();
    TransferData (const TransferData&)            = delete;
    TransferData& operator= (const TransferData&) = delete;
    TransferData (TransferData&&)                 = delete;
    TransferData& operator= (TransferData&&)      = delete;
};

} // namespace detail
} // namespace vayu::http
