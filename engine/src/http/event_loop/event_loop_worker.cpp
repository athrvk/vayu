#include "vayu/http/event_loop/event_loop_worker.hpp"

#include <chrono>

#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

EventLoopWorker::EventLoopWorker(const EventLoopConfig& cfg)
    : config(cfg), rate_limiter(RateLimiterConfig{cfg.target_rps, cfg.burst_size}) {
    multi_handle = curl_multi_init();
    if (!multi_handle) {
        throw std::runtime_error("Failed to initialize curl_multi for worker");
    }

    // Set multi handle options
    curl_multi_setopt(multi_handle, CURLMOPT_MAXCONNECTS, static_cast<long>(config.max_concurrent));
    curl_multi_setopt(
        multi_handle, CURLMOPT_MAX_HOST_CONNECTIONS, static_cast<long>(config.max_per_host));

    // Enable connection reuse / keep-alive
    curl_multi_setopt(multi_handle, CURLMOPT_PIPELINING, CURLPIPE_MULTIPLEX);
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
            CURL* easy = setup_easy_handle(data.get(), config);
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
                curl_easy_cleanup(easy);
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
