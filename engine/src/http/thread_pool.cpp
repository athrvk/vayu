#include "vayu/http/thread_pool.hpp"

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <queue>
#include <thread>

#include "vayu/http/client.hpp"

namespace vayu::http {

struct ThreadPool::Impl {
    std::vector<std::thread> workers;
    std::queue<std::function<void()>> tasks;
    mutable std::mutex queue_mutex_;
    std::condition_variable condition;
    std::atomic<bool> stop{false};

    explicit Impl(size_t num_threads) {
        if (num_threads == 0) {
            num_threads = std::thread::hardware_concurrency();
            if (num_threads == 0) {
                num_threads = 4;  // Fallback
            }
        }

        workers.reserve(num_threads);
        for (size_t i = 0; i < num_threads; ++i) {
            workers.emplace_back([this] { worker_loop(); });
        }
    }

    ~Impl() {
        stop = true;
        condition.notify_all();

        for (auto& worker : workers) {
            if (worker.joinable()) {
                worker.join();
            }
        }
    }

    void worker_loop() {
        while (true) {
            std::function<void()> task;

            {
                std::unique_lock<std::mutex> lock(queue_mutex_);
                condition.wait(lock, [this] { return stop || !tasks.empty(); });

                if (stop && tasks.empty()) {
                    return;
                }

                task = std::move(tasks.front());
                tasks.pop();
            }

            task();
        }
    }

    void submit(std::function<void()> task) {
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            tasks.push(std::move(task));
        }
        condition.notify_one();
    }

    size_t queue_size() const {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        return tasks.size();
    }
};

ThreadPool::ThreadPool(size_t num_threads) : impl_(std::make_unique<Impl>(num_threads)) {}

ThreadPool::~ThreadPool() = default;

void ThreadPool::submit_impl(std::function<void()> task) {
    impl_->submit(std::move(task));
}

BatchResult ThreadPool::execute_batch(const std::vector<Request>& requests) {
    BatchResult result;

    auto start_time = std::chrono::steady_clock::now();

    std::vector<std::future<Result<Response>>> futures;
    futures.reserve(requests.size());

    // Submit all requests to thread pool
    for (const auto& req : requests) {
        futures.push_back(submit([req]() -> Result<Response> {
            Client client;
            return client.send(req);
        }));
    }

    // Wait for all results and collect them
    result.responses.reserve(requests.size());
    for (size_t i = 0; i < futures.size(); ++i) {
        auto response = futures[i].get();

        if (response.is_ok()) {
            result.successful++;
        } else {
            result.failed++;
        }

        result.responses.push_back(std::move(response));
    }

    auto end_time = std::chrono::steady_clock::now();
    result.total_time_ms = std::chrono::duration<double, std::milli>(end_time - start_time).count();

    return result;
}

size_t ThreadPool::thread_count() const {
    return impl_->workers.size();
}

size_t ThreadPool::queue_size() const {
    return impl_->queue_size();
}

}  // namespace vayu::http
