#pragma once

#include <curl/curl.h>

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <queue>
#include <thread>
#include <unordered_map>

#include "vayu/http/event_loop.hpp"
#include "vayu/http/rate_limiter.hpp"

namespace vayu::http::detail {

// Forward declaration
struct TransferData;

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
};

}  // namespace vayu::http::detail
