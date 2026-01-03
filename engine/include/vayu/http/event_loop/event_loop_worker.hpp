#pragma once

#include <curl/curl.h>

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <queue>
#include <shared_mutex>
#include <string>
#include <thread>
#include <unordered_map>

#include "vayu/http/event_loop.hpp"
#include "vayu/http/rate_limiter.hpp"

namespace vayu::http::detail {

// Forward declaration
struct TransferData;

/**
 * @brief Thread-safe DNS cache for pre-resolved hostnames
 *
 * Resolves hostnames once and caches the IP addresses to avoid
 * overwhelming the system DNS resolver under high load.
 */
class DnsCache {
public:
    /// Pre-resolve a hostname and cache the result
    /// Returns the resolved IP or empty string on failure
    std::string resolve(const std::string& hostname);

    /// Get cached IP for hostname (empty if not cached)
    std::string get(const std::string& hostname) const;

    /// Get curl-compatible resolve entry: "hostname:port:ip"
    /// Returns nullptr if not cached
    struct curl_slist* get_resolve_list(const std::string& hostname, int port);

    /// Clear the cache
    void clear();

private:
    mutable std::shared_mutex mutex_;
    std::unordered_map<std::string, std::string> cache_;
};

/**
 * @brief High-performance CURL handle pool
 *
 * Reuses curl_easy handles instead of creating new ones for each request.
 * curl_easy_init() takes ~100µs, curl_easy_reset() takes ~1µs.
 * At 60k RPS, this saves ~6 seconds per second of CPU time.
 */
class CurlHandlePool {
public:
    explicit CurlHandlePool(size_t initial_size = 100);
    ~CurlHandlePool();

    // Prevent copying
    CurlHandlePool(const CurlHandlePool&) = delete;
    CurlHandlePool& operator=(const CurlHandlePool&) = delete;

    /// Acquire a handle from the pool (or create new if empty)
    /// The handle is reset and ready for configuration
    CURL* acquire();

    /// Return a handle to the pool for reuse
    void release(CURL* handle);

    /// Get pool statistics
    size_t pool_size() const;
    size_t total_created() const {
        return total_created_.load();
    }
    size_t total_reused() const {
        return total_reused_.load();
    }

private:
    mutable std::mutex mutex_;
    std::queue<CURL*> pool_;
    std::atomic<size_t> total_created_{0};
    std::atomic<size_t> total_reused_{0};
};

/**
 * @brief Single worker thread running its own curl_multi event loop
 *
 * Each worker maintains:
 * - Its own curl_multi handle for concurrent transfers
 * - A pending queue for incoming requests
 * - Active transfers map for in-flight requests
 * - Rate limiter for controlling throughput
 */
class EventLoopWorker {
public:
    explicit EventLoopWorker(const EventLoopConfig& cfg);
    ~EventLoopWorker();

    // Prevent copying
    EventLoopWorker(const EventLoopWorker&) = delete;
    EventLoopWorker& operator=(const EventLoopWorker&) = delete;

    void start();
    void stop(bool wait_for_pending);
    void submit(std::unique_ptr<TransferData> data);

    size_t active_count() const;
    size_t pending_count() const;

    // Thread-local stats (lock-free)
    std::atomic<size_t> local_processed{0};

private:
    // Allow EventLoopImpl to access private members for cancellation and cleanup
    friend class EventLoopImpl;

    void run_loop();

    CURLM* multi_handle = nullptr;
    std::thread thread;
    std::atomic<bool> running{false};
    std::atomic<bool> stop_requested{false};

    std::mutex queue_mutex;
    std::condition_variable queue_cv;
    std::queue<std::unique_ptr<TransferData>> pending_queue;

    std::mutex active_mutex;
    std::unordered_map<CURL*, std::unique_ptr<TransferData>> active_transfers;

    EventLoopConfig config;
    RateLimiter rate_limiter;

    // Shared DNS cache (static - shared across all workers)
    static DnsCache dns_cache_;

    // Per-worker handle pool for reusing curl handles
    CurlHandlePool handle_pool_;
};

}  // namespace vayu::http::detail
