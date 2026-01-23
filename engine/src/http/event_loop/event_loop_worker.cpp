/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/event_loop_worker.hpp"

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#endif

#include <chrono>
#include <regex>

#include "vayu/core/constants.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

// ============================================================================
// DnsCache Implementation
// ============================================================================

// Static member definition
DnsCache EventLoopWorker::dns_cache_;

std::string DnsCache::resolve (const std::string& hostname) {
    // Check cache first (read lock)
    {
        std::shared_lock<std::shared_mutex> lock (mutex_);
        auto it = cache_.find (hostname);
        if (it != cache_.end ()) {
            return it->second;
        }
    }

    // Not cached - resolve (no lock during DNS lookup)
    // Use AF_UNSPEC to allow both IPv4 and IPv6 - this matches curl's default behavior
    // and is critical for localhost which often resolves to ::1 (IPv6) on modern systems
    struct addrinfo hints = {};
    hints.ai_family       = AF_UNSPEC; // Allow both IPv4 and IPv6
    hints.ai_socktype     = SOCK_STREAM;

    struct addrinfo* result = nullptr;
    int status = getaddrinfo (hostname.c_str (), nullptr, &hints, &result);

    std::string ip;
    if (status == 0 && result) {
        // Iterate through results, preferring IPv6 for localhost (matches curl
        // behavior) For other hosts, take the first result
        struct addrinfo* best = result;

        // For localhost, prefer IPv6 if available (curl tries IPv6 first)
        if (hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1") {
            for (struct addrinfo* rp = result; rp != nullptr; rp = rp->ai_next) {
                if (rp->ai_family == AF_INET6) {
                    best = rp;
                    break;
                }
            }
        }

        if (best->ai_family == AF_INET6) {
            char ip_str[INET6_ADDRSTRLEN];
            struct sockaddr_in6* addr6 =
            reinterpret_cast<struct sockaddr_in6*> (best->ai_addr);
            inet_ntop (AF_INET6, &(addr6->sin6_addr), ip_str, INET6_ADDRSTRLEN);
            ip = ip_str;
        } else if (best->ai_family == AF_INET) {
            char ip_str[INET_ADDRSTRLEN];
            struct sockaddr_in* addr =
            reinterpret_cast<struct sockaddr_in*> (best->ai_addr);
            inet_ntop (AF_INET, &(addr->sin_addr), ip_str, INET_ADDRSTRLEN);
            ip = ip_str;
        }
        freeaddrinfo (result);
    }

    // Cache the result (write lock)
    if (!ip.empty ()) {
        std::unique_lock<std::shared_mutex> lock (mutex_);
        cache_[hostname] = ip;
    }

    return ip;
}

std::string DnsCache::get (const std::string& hostname) const {
    std::shared_lock<std::shared_mutex> lock (mutex_);
    auto it = cache_.find (hostname);
    return (it != cache_.end ()) ? it->second : "";
}

struct curl_slist* DnsCache::get_resolve_list (const std::string& hostname, int port) {
    std::string ip = resolve (hostname);
    if (ip.empty ()) {
        return nullptr;
    }

    // Format: "hostname:port:address"
    std::string entry = hostname + ":" + std::to_string (port) + ":" + ip;
    return curl_slist_append (nullptr, entry.c_str ());
}

void DnsCache::clear () {
    std::unique_lock<std::shared_mutex> lock (mutex_);
    cache_.clear ();
}

// ============================================================================
// CurlHandlePool Implementation
// ============================================================================

CurlHandlePool::CurlHandlePool (size_t initial_size) {
    // Pre-create handles to avoid allocation during high-load
    for (size_t i = 0; i < initial_size; ++i) {
        CURL* handle = curl_easy_init ();
        if (handle) {
            pool_.push (handle);
            total_created_++;
        }
    }
}

CurlHandlePool::~CurlHandlePool () {
    // No lock needed - destructor runs after worker thread stops
    while (!pool_.empty ()) {
        CURL* handle = pool_.front ();
        pool_.pop ();
        curl_easy_cleanup (handle);
    }
}

CURL* CurlHandlePool::acquire () {
    // No lock needed - single-threaded access
    if (!pool_.empty ()) {
        CURL* handle = pool_.front ();
        pool_.pop ();
        curl_easy_reset (handle); // Reset is ~100x faster than init
        total_reused_++;
        return handle;
    }

    // Pool empty - create new handle
    CURL* handle = curl_easy_init ();
    if (handle) {
        total_created_++;
    }
    return handle;
}

void CurlHandlePool::release (CURL* handle) {
    if (!handle)
        return;
    // No lock needed - single-threaded access
    pool_.push (handle);
}

// ============================================================================
// EventLoopWorker Implementation
// ============================================================================

EventLoopWorker::EventLoopWorker (const EventLoopConfig& cfg)
: pending_queue (core::constants::queue::CAPACITY), // 64K capacity ring buffer
  config (cfg), rate_limiter (RateLimiterConfig{ cfg.target_rps, cfg.burst_size }),
  handle_pool_ (config.max_concurrent) { // Pre-allocate handles
    multi_handle = curl_multi_init ();
    if (!multi_handle) {
        throw std::runtime_error ("Failed to initialize curl_multi for worker");
    }

    // Set multi handle options for high-performance
    curl_multi_setopt (multi_handle, CURLMOPT_MAXCONNECTS,
    static_cast<long> (config.max_concurrent));
    curl_multi_setopt (multi_handle, CURLMOPT_MAX_HOST_CONNECTIONS,
    static_cast<long> (config.max_per_host));

    // Enable HTTP/2 multiplexing (many requests over single connection)
    // This is critical for high-RPS as it reduces connection establishment overhead
    curl_multi_setopt (multi_handle, CURLMOPT_PIPELINING, CURLPIPE_MULTIPLEX);

    // Set max total connections (connection pool size)
    // Higher value = more reusable connections available
    curl_multi_setopt (multi_handle, CURLMOPT_MAX_TOTAL_CONNECTIONS,
    static_cast<long> (config.max_concurrent * 2U));
}

EventLoopWorker::~EventLoopWorker () {
    if (multi_handle) {
        curl_multi_cleanup (multi_handle);
    }
}

void EventLoopWorker::start () {
    if (running.exchange (true)) {
        return;
    }
    stop_requested = false;
    thread         = std::thread (&EventLoopWorker::run_loop, this);
}

void EventLoopWorker::stop (bool wait_for_pending) {
    if (!running) {
        return;
    }

    stop_requested = true;
    queue_has_items.store (true,
    std::memory_order_release); // Wake up worker if spinning on empty queue
    queue_has_items.notify_one ();

    if (!wait_for_pending) {
        // Drain SPSC queue
        std::unique_ptr<TransferData> data;
        while (pending_queue.pop (data)) {
            Error error;
            error.code    = ErrorCode::InternalError;
            error.message = "Request cancelled";

            if (data->callback) {
                data->callback (data->request_id, error);
            }
            if (data->has_promise) {
                data->promise.set_value (error);
            }
        }
    }

    if (thread.joinable ()) {
        thread.join ();
    }

    running = false;
}

void EventLoopWorker::run_loop () {
    // Adaptive spinning parameters
    constexpr int SPIN_COUNT = core::constants::queue::SPIN_COUNT;

    // Core loop optimized for latency and throughput
    while (!stop_requested || !pending_queue.empty () || !active_transfers.empty ()) {
        bool did_work = false;

        // 1. Process pending queue (Lock-free Consumer)
        // We avoid blocking acquisition of rate limiter tokens to keep IO loop moving

        // Use atomic load for active count check (Lock-free hot path)
        // The check is "loose" (data race only leads to trying to add and
        // finding map full, which is fine)
        size_t local_active = current_active_count.load (std::memory_order_relaxed);

        std::unique_ptr<TransferData> data;

        // Fetch Phase: Get up to max_concurrent items, BUT only if tokens available.
        // We prioritize DRIVING IO over accepting new work if rate limited.
        while (local_active < config.max_concurrent) {
            // Check rate limiter WITHOUT blocking (single-threaded access, no lock needed)
            if (!rate_limiter.try_acquire_unlocked ()) {
                // Rate limit reached. Stop fetching new work.
                // Go drive the IO machinery for existing requests.
                break;
            }

            // Have token, try get data
            if (!pending_queue.pop (data)) {
                // Queue empty, but we acquired a token.
                // It's a small inefficiency (wasted token) but simpler code path.
                // Given 60k RPS, a few wasted tokens are negligible noise.
                break;
            }

            did_work = true;

            // Acquire handle from pool (lock-free or specialized pool)
            CURL* easy = handle_pool_.acquire ();
            // Note: setup_easy_handle might take time, good to do it outside locks
            easy = setup_easy_handle (easy, data.get (), config, &dns_cache_);

            if (easy) {
                // Add to multi handle - this is fast
                curl_multi_add_handle (multi_handle, easy);

                // Track active transfer
                {
                    // No lock needed - private resource
                    active_transfers[easy] = std::move (data);
                    // Update atomic size
                    current_active_count.store (
                    active_transfers.size (), std::memory_order_relaxed);
                    local_active++; // Local cache update for loop condition
                }
            } else {
                // Handle creation failure
                Error error;
                error.code    = ErrorCode::InternalError;
                error.message = "Failed to create curl handle";
                if (data->callback)
                    data->callback (data->request_id, error);
                if (data->has_promise)
                    data->promise.set_value (error);
            }
        }

        // 2. Drive CURL state machine
        int still_running = 0;
        CURLMcode mc      = curl_multi_perform (multi_handle, &still_running);
        if (mc == CURLM_OK) {
            // curl_multi_perform is non-blocking, but might do some work
        }

        // 3. Process completions
        // Check often to free up slots
        int msgs_left = 0;
        CURLMsg* msg  = nullptr;
        while ((msg = curl_multi_info_read (multi_handle, &msgs_left))) {
            did_work = true;

            if (msg->msg == CURLMSG_DONE) {
                CURL* easy      = msg->easy_handle;
                CURLcode result = msg->data.result;

                std::unique_ptr<TransferData> data;
                {
                    // No lock needed - private resource
                    auto it = active_transfers.find (easy);
                    if (it != active_transfers.end ()) {
                        data = std::move (it->second);
                        active_transfers.erase (it);
                        // Update atomic size
                        current_active_count.store (
                        active_transfers.size (), std::memory_order_relaxed);
                    }
                }

                if (data) {
                    auto response_result = extract_response (easy, data.get (), result);
                    if (data->callback)
                        data->callback (data->request_id, response_result);
                    if (data->has_promise)
                        data->promise.set_value (std::move (response_result));
                    local_processed.fetch_add (1, std::memory_order_relaxed);
                }

                curl_multi_remove_handle (multi_handle, easy);
                handle_pool_.release (easy);
            }
        }

        // 4. Wait Strategy
        if (!did_work) {
            if (still_running > 0) {
                // Wait for IO activity, but allow interruption via curl_multi_wakeup
                // Use a short timeout to keep checking the queue even if no IO events
                // 1ms is generally fine IF we use wakeup
                curl_multi_poll (multi_handle, nullptr, 0, 1, nullptr);
            } else if (!stop_requested) {
                // No active transfers, and no pending items recently.
                // This is the idle storage.
                // Use atomic wait instead of Condition Variable for lower
                // latency wakeup We wait on queue_has_items flag

                // Adaptive spinning before sleeping
                for (int i = 0; i < SPIN_COUNT; ++i) {
                    if (pending_queue.read_available () > 0)
                        break;
                    // Busy-wait / pause to avoid context switch
                    // std::this_thread::yield(); // REMOVED: Yield causes too much latency
                }

                if (pending_queue.read_available () == 0) {
                    // Check again before sleep
                    queue_has_items.wait (false, std::memory_order_acquire);
                }
                // Reset flag consumption is partly implicit by checking queue
                // size But we can reset it if queue is empty to allow next wait
                if (pending_queue.read_available () == 0) {
                    queue_has_items.store (false, std::memory_order_release);
                }
            }
        }
    }
}

void EventLoopWorker::submit (std::unique_ptr<TransferData> data) {
    // SPSC Queue is safe for single producer.
    while (!pending_queue.push (data)) {
        // Queue full.
        // Spin/Yield. This is backpressure to the producer.
        std::this_thread::yield ();
    }

    // Signal the worker
    bool was_empty = !queue_has_items.exchange (true, std::memory_order_release);
    // Always wake up curl_multi_poll, even if queue wasn't empty
    // (because worker might be sleeping in poll despite having items if it just processed a batch)
    curl_multi_wakeup (multi_handle);

    if (was_empty) {
        queue_has_items.notify_one ();
    }
}

size_t EventLoopWorker::active_count () const {
    // Use atomic count for lock-free read
    return current_active_count.load (std::memory_order_relaxed);
}

size_t EventLoopWorker::pending_count () const {
    // SPSC size is thread-safe for approximation
    return pending_queue.read_available ();
}

} // namespace vayu::http::detail
