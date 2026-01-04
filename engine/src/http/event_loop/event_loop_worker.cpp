#include "vayu/http/event_loop/event_loop_worker.hpp"

#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>

#include <chrono>
#include <regex>

#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

// ============================================================================
// DnsCache Implementation
// ============================================================================

// Static member definition
DnsCache EventLoopWorker::dns_cache_;

std::string DnsCache::resolve(const std::string& hostname) {
    // Check cache first (read lock)
    {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        auto it = cache_.find(hostname);
        if (it != cache_.end()) {
            return it->second;
        }
    }

    // Not cached - resolve (no lock during DNS lookup)
    struct addrinfo hints = {};
    hints.ai_family = AF_INET;  // IPv4
    hints.ai_socktype = SOCK_STREAM;

    struct addrinfo* result = nullptr;
    int status = getaddrinfo(hostname.c_str(), nullptr, &hints, &result);

    std::string ip;
    if (status == 0 && result) {
        char ip_str[INET_ADDRSTRLEN];
        struct sockaddr_in* addr = reinterpret_cast<struct sockaddr_in*>(result->ai_addr);
        inet_ntop(AF_INET, &(addr->sin_addr), ip_str, INET_ADDRSTRLEN);
        ip = ip_str;
        freeaddrinfo(result);
    }

    // Cache the result (write lock)
    if (!ip.empty()) {
        std::unique_lock<std::shared_mutex> lock(mutex_);
        cache_[hostname] = ip;
    }

    return ip;
}

std::string DnsCache::get(const std::string& hostname) const {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = cache_.find(hostname);
    return (it != cache_.end()) ? it->second : "";
}

struct curl_slist* DnsCache::get_resolve_list(const std::string& hostname, int port) {
    std::string ip = resolve(hostname);
    if (ip.empty()) {
        return nullptr;
    }

    // Format: "hostname:port:address"
    std::string entry = hostname + ":" + std::to_string(port) + ":" + ip;
    return curl_slist_append(nullptr, entry.c_str());
}

void DnsCache::clear() {
    std::unique_lock<std::shared_mutex> lock(mutex_);
    cache_.clear();
}

// ============================================================================
// CurlHandlePool Implementation
// ============================================================================

CurlHandlePool::CurlHandlePool(size_t initial_size) {
    // Pre-create handles to avoid allocation during high-load
    for (size_t i = 0; i < initial_size; ++i) {
        CURL* handle = curl_easy_init();
        if (handle) {
            pool_.push(handle);
            total_created_.fetch_add(1, std::memory_order_relaxed);
        }
    }
}

CurlHandlePool::~CurlHandlePool() {
    std::lock_guard<std::mutex> lock(mutex_);
    while (!pool_.empty()) {
        CURL* handle = pool_.front();
        pool_.pop();
        curl_easy_cleanup(handle);
    }
}

CURL* CurlHandlePool::acquire() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!pool_.empty()) {
            CURL* handle = pool_.front();
            pool_.pop();
            curl_easy_reset(handle);  // Reset is ~100x faster than init
            total_reused_.fetch_add(1, std::memory_order_relaxed);
            return handle;
        }
    }

    // Pool empty - create new handle
    CURL* handle = curl_easy_init();
    if (handle) {
        total_created_.fetch_add(1, std::memory_order_relaxed);
    }
    return handle;
}

void CurlHandlePool::release(CURL* handle) {
    if (!handle) return;

    std::lock_guard<std::mutex> lock(mutex_);
    pool_.push(handle);
}

size_t CurlHandlePool::pool_size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return pool_.size();
}

// ============================================================================
// EventLoopWorker Implementation
// ============================================================================

EventLoopWorker::EventLoopWorker(const EventLoopConfig& cfg)
    : config(cfg),
      rate_limiter(RateLimiterConfig{cfg.target_rps, cfg.burst_size}),
      handle_pool_(config.max_concurrent) {  // Pre-allocate handles
    multi_handle = curl_multi_init();
    if (!multi_handle) {
        throw std::runtime_error("Failed to initialize curl_multi for worker");
    }

    // Set multi handle options for high-performance
    curl_multi_setopt(multi_handle, CURLMOPT_MAXCONNECTS, static_cast<long>(config.max_concurrent));
    curl_multi_setopt(
        multi_handle, CURLMOPT_MAX_HOST_CONNECTIONS, static_cast<long>(config.max_per_host));

    // Enable HTTP/2 multiplexing (many requests over single connection)
    // This is critical for high-RPS as it reduces connection establishment overhead
    curl_multi_setopt(multi_handle, CURLMOPT_PIPELINING, CURLPIPE_MULTIPLEX);

    // Set max total connections (connection pool size)
    // Higher value = more reusable connections available
    curl_multi_setopt(multi_handle,
                      CURLMOPT_MAX_TOTAL_CONNECTIONS,
                      static_cast<long>(config.max_concurrent * 2U));
}

EventLoopWorker::~EventLoopWorker() {
    if (multi_handle) {
        curl_multi_cleanup(multi_handle);
    }
}

void EventLoopWorker::start() {
    if (running.exchange(true)) {
        return;
    }
    stop_requested = false;
    thread = std::thread(&EventLoopWorker::run_loop, this);
}

void EventLoopWorker::stop(bool wait_for_pending) {
    if (!running) {
        return;
    }

    stop_requested = true;

    if (!wait_for_pending) {
        std::lock_guard<std::mutex> lock(queue_mutex);
        while (!pending_queue.empty()) {
            auto data = std::move(pending_queue.front());
            pending_queue.pop();

            Error error;
            error.code = ErrorCode::InternalError;
            error.message = "Request cancelled";

            if (data->callback) {
                data->callback(data->request_id, error);
            }
            if (data->has_promise) {
                data->promise.set_value(error);
            }
        }
    }

    queue_cv.notify_all();

    if (thread.joinable()) {
        thread.join();
    }

    running = false;
}

void EventLoopWorker::run_loop() {
    while (!stop_requested || !pending_queue.empty() || !active_transfers.empty()) {
        // Move pending requests to active (with rate limiting)
        std::unique_ptr<TransferData> data;
        {
            std::lock_guard<std::mutex> lock(queue_mutex);

            // Check concurrency limit safely
            size_t active_count = 0;
            {
                std::lock_guard<std::mutex> active_lock(active_mutex);
                active_count = active_transfers.size();
            }

            if (!pending_queue.empty() && active_count < config.max_concurrent) {
                // Try to acquire token without blocking
                if (rate_limiter.try_acquire()) {
                    data = std::move(pending_queue.front());
                    pending_queue.pop();
                }
            }
        }

        // Apply rate limiting outside the lock
        if (data) {
            // Acquire handle from pool (much faster than curl_easy_init)
            CURL* easy = handle_pool_.acquire();
            easy = setup_easy_handle(easy, data.get(), config, &dns_cache_);
            if (easy) {
                curl_multi_add_handle(multi_handle, easy);
                std::lock_guard<std::mutex> active_lock(active_mutex);
                active_transfers[easy] = std::move(data);
            } else {
                Error error;
                error.code = ErrorCode::InternalError;
                error.message = "Failed to create curl handle";

                if (data->callback) {
                    data->callback(data->request_id, error);
                }
                if (data->has_promise) {
                    data->promise.set_value(error);
                }
            }
        }

        // Perform transfers
        int still_running = 0;
        curl_multi_perform(multi_handle, &still_running);

        // Check for completed transfers
        int msgs_left = 0;
        CURLMsg* msg = nullptr;
        while ((msg = curl_multi_info_read(multi_handle, &msgs_left))) {
            if (msg->msg == CURLMSG_DONE) {
                CURL* easy = msg->easy_handle;
                CURLcode result = msg->data.result;

                std::unique_ptr<TransferData> data;
                {
                    std::lock_guard<std::mutex> lock(active_mutex);
                    auto it = active_transfers.find(easy);
                    if (it != active_transfers.end()) {
                        data = std::move(it->second);
                        active_transfers.erase(it);
                    }
                }

                if (data) {
                    auto response_result = extract_response(easy, data.get(), result);

                    if (data->callback) {
                        data->callback(data->request_id, response_result);
                    }
                    if (data->has_promise) {
                        data->promise.set_value(std::move(response_result));
                    }

                    local_processed.fetch_add(1, std::memory_order_relaxed);
                }

                curl_multi_remove_handle(multi_handle, easy);
                // Return handle to pool instead of destroying it (100x faster)
                handle_pool_.release(easy);
            }
        }

        // Wait for activity or timeout
        if (still_running > 0) {
            curl_multi_poll(multi_handle, nullptr, 0, config.poll_timeout_ms, nullptr);
        } else if (!stop_requested) {
            // Wait for new requests
            std::unique_lock<std::mutex> lock(queue_mutex);
            queue_cv.wait_for(lock, std::chrono::milliseconds(config.poll_timeout_ms), [this] {
                return stop_requested || !pending_queue.empty();
            });
        }
    }
}

void EventLoopWorker::submit(std::unique_ptr<TransferData> data) {
    {
        std::lock_guard<std::mutex> lock(queue_mutex);
        pending_queue.push(std::move(data));
    }
    queue_cv.notify_one();
}

size_t EventLoopWorker::active_count() const {
    std::lock_guard<std::mutex> lock(const_cast<std::mutex&>(active_mutex));
    return active_transfers.size();
}

size_t EventLoopWorker::pending_count() const {
    std::lock_guard<std::mutex> lock(const_cast<std::mutex&>(queue_mutex));
    return pending_queue.size();
}

}  // namespace vayu::http::detail
