#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/event_loop.hpp
 * @brief Async HTTP event loop using curl_multi for concurrent requests
 */

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <thread>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

// Forward declarations for Pimpl idiom
namespace detail {
class EventLoopImpl;
} // namespace detail

/**
 * @brief Callback invoked when a request completes
 */
using RequestCallback = std::function<void (size_t request_id, Result<Response>)>;

/**
 * @brief Progress callback for tracking request progress
 */
using ProgressCallback =
std::function<void (size_t request_id, size_t downloaded, size_t total)>;

using BatchResult    = vayu::BatchResult;
using EventLoopStats = vayu::EventLoopStats;

/**
 * @brief Event loop configuration
 */
struct EventLoopConfig {
    /// Number of worker event loops (0 = auto-detect CPU cores)
    size_t num_workers = 0;

    /// Maximum number of concurrent connections per worker (default: 1000)
    size_t max_concurrent = vayu::core::constants::event_loop::MAX_CONCURRENT;

    /// Maximum connections per host (default: 100)
    size_t max_per_host = vayu::core::constants::event_loop::MAX_PER_HOST;

    /// Default user agent string
    std::string user_agent = vayu::core::constants::defaults::DEFAULT_USER_AGENT;

    /// Enable verbose curl output for debugging
    bool verbose = vayu::core::constants::defaults::VERBOSE;

    /// Proxy URL (optional)
    std::string proxy_url;

    /// DNS cache timeout in seconds (0 = no caching, negative = never expires).
    /// Governs curl's own resolver cache and the pre-resolution pin cache.
    long dns_cache_timeout = vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS;

    /// Largest response body one transfer may buffer (0 = unbounded).
    /// Exceeding it fails that transfer instead of allocating without bound.
    size_t max_response_body_bytes = vayu::core::constants::event_loop::MAX_RESPONSE_BODY_BYTES;

    /// Target requests per second (0 = unlimited, no rate limiting)
    double target_rps = 0.0;

    /// Maximum burst size for rate limiting (defaults to 2x target_rps)
    double burst_size = 0.0;
};

/**
 * @brief Request handle for tracking/cancellation
 */
struct RequestHandle {
    size_t id;
    std::future<Result<Response>> future;
};

/**
 * @brief High-performance async HTTP event loop
 *
 * Uses curl_multi to handle many concurrent HTTP requests efficiently.
 * Supports callbacks, futures, and batch execution patterns.
 *
 * Example usage:
 * @code
 * EventLoop loop;
 * loop.start();
 *
 * // Submit with callback
 * loop.submit(request, [](size_t id, Result<Response> result) {
 *     if (result.is_ok()) {
 *         std::cout << "Request " << id << " completed\n";
 *     }
 * });
 *
 * // Or use futures
 * auto handle = loop.submit(request);
 * auto result = handle.future.get();
 *
 * // Or batch execute
 * auto batch = loop.execute_batch(requests);
 *
 * loop.stop();
 * @endcode
 */
class EventLoop {
    public:
    /**
     * @brief Construct a new Event Loop
     */
    explicit EventLoop (EventLoopConfig config = {});

    /**
     * @brief Destructor - stops the event loop if running
     */
    ~EventLoop ();

    // Non-copyable
    EventLoop (const EventLoop&)            = delete;
    EventLoop& operator= (const EventLoop&) = delete;

    // Movable (only when stopped)
    EventLoop (EventLoop&&) noexcept;
    EventLoop& operator= (EventLoop&&) noexcept;

    /**
     * @brief Start the event loop thread
     *
     * Must be called before submitting requests.
     */
    void start ();

    /**
     * @brief Stop the event loop
     *
     * @param wait_for_pending If true, queued requests are still sent and
     *        in-flight ones are awaited. If false, both are cancelled: the
     *        queued backlog is discarded without being sent, and every
     *        in-flight transfer is removed from curl and completed with an
     *        `ErrorCode::InternalError` "Request cancelled" result, so a stop
     *        cannot be held hostage by an upstream that never answers.
     * @param drain_timeout Upper bound on the wait when `wait_for_pending` is
     *        true; whatever is still in flight when it expires is cancelled the
     *        same way. Zero (the default) means wait indefinitely, which is
     * only safe when every transfer carries a timeout of its own. Ignored when
     *        `wait_for_pending` is false - that path cancels immediately.
     */
    void stop (bool wait_for_pending = true,
    std::chrono::milliseconds drain_timeout = std::chrono::milliseconds::zero ());

    /**
     * @brief Check if the event loop is running
     */
    [[nodiscard]] bool is_running () const;

    /**
     * @brief Submit a request with a callback
     *
     * @param request The HTTP request to send
     * @param callback Optional callback invoked when request completes
     * @param progress Optional progress callback
     * @return Request ID for tracking
     */
    size_t submit (const Request& request,
    RequestCallback callback  = nullptr,
    ProgressCallback progress = nullptr);

    /**
     * @brief Submit a request and get a future
     *
     * @param request The HTTP request to send
     * @return RequestHandle with ID and future for the result
     */
    [[nodiscard]] RequestHandle submit_async (const Request& request);

    /**
     * @brief Cancel a pending request
     *
     * @param request_id The ID returned from submit()
     * @return true if the request was cancelled, false if already completed
     */
    bool cancel (size_t request_id);

    /**
     * @brief Execute a batch of requests and wait for all to complete
     *
     * This is the simplest way to run multiple requests concurrently.
     *
     * @param requests Vector of requests to execute
     * @return BatchResult with all responses and statistics
     */
    [[nodiscard]] BatchResult execute_batch (const std::vector<Request>& requests);

    /**
     * @brief Get number of active (in-flight) requests
     */
    [[nodiscard]] size_t active_count () const;

    /**
     * @brief Get number of pending (queued) requests
     */
    [[nodiscard]] size_t pending_count () const;

    /**
     * @brief Get total requests processed since start
     */
    [[nodiscard]] size_t total_processed () const;

    /**
     * @brief Get comprehensive statistics about the event loop
     */
    [[nodiscard]] EventLoopStats stats () const;

    private:
    std::unique_ptr<detail::EventLoopImpl> impl_;
};

// vayu::http::ThreadPool lives in "vayu/http/thread_pool.hpp" - it used to be
// declared here as well, a second class of the same name in the same namespace
// whose only definition was thread_pool.cpp's. That is an ODR violation that
// linked purely because both had a single unique_ptr member; do not re-add it.

} // namespace vayu::http
