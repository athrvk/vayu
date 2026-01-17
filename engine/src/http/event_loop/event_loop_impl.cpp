/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/event_loop_impl.hpp"

#include <chrono>
#include <thread>

#include "vayu/http/event_loop/event_loop_worker.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

EventLoopImpl::EventLoopImpl(EventLoopConfig cfg) : config(std::move(cfg)) {
    // Determine number of workers
    size_t num_workers = config.num_workers;
    if (num_workers == 0) {
        num_workers = std::thread::hardware_concurrency();
        if (num_workers == 0) {
            num_workers = 4;  // Fallback
        }
    }

    // Create workers
    workers.reserve(num_workers);
    for (size_t i = 0; i < num_workers; ++i) {
        workers.push_back(std::make_unique<EventLoopWorker>(config));
    }
}

EventLoopImpl::~EventLoopImpl() {
    stop(false);
}

void EventLoopImpl::start() {
    if (running.exchange(true)) {
        return;  // Already running
    }

    // Start all workers
    for (auto& worker : workers) {
        worker->start();
    }
}

void EventLoopImpl::stop(bool wait_for_pending) {
    if (!running) {
        return;
    }

    // Stop all workers
    for (auto& worker : workers) {
        worker->stop(wait_for_pending);
    }

    running = false;
}

void EventLoopImpl::submit(std::unique_ptr<TransferData> data) {
    // Round-robin sharding across workers
    size_t worker_idx = next_worker.fetch_add(1, std::memory_order_relaxed) % workers.size();
    workers[worker_idx]->submit(std::move(data));
}

EventLoopStats EventLoopImpl::stats() const {
    EventLoopStats result;
    result.total_requests = next_request_id.load() - 1;

    for (const auto& worker : workers) {
        result.active_requests += worker->active_count();
        result.pending_requests += worker->pending_count();
        result.completed_requests += worker->local_processed.load(std::memory_order_relaxed);
    }

    return result;
}

size_t EventLoopImpl::submit(const Request& request,
                             RequestCallback callback,
                             ProgressCallback progress) {
    auto data = std::make_unique<TransferData>();
    data->request_id = next_request_id.fetch_add(1, std::memory_order_relaxed);
    data->request = request;
    data->callback = std::move(callback);
    data->progress = std::move(progress);

    size_t id = data->request_id;
    submit(std::move(data));
    return id;
}

RequestHandle EventLoopImpl::submit_async(const Request& request) {
    auto data = std::make_unique<TransferData>();
    data->request_id = next_request_id.fetch_add(1, std::memory_order_relaxed);
    data->request = request;
    data->has_promise = true;

    RequestHandle handle;
    handle.id = data->request_id;
    handle.future = data->promise.get_future();

    submit(std::move(data));
    return handle;
}

bool EventLoopImpl::cancel(size_t request_id) {
    // SPSC Queue does not support random access/removal.
    // To support cancellation, we would need a separate mechanism (e.g. cancellation tokens or a
    // cancelled-ID list). For now, we disable pending-queue cancellation to prioritize throughput.
    // Active transfers could still be cancelled if we tracked them, but the original implementation
    // only checked the pending queue anyway.

    (void) request_id;  // Unused
    return false;
}

BatchResult EventLoopImpl::execute_batch(const std::vector<Request>& requests) {
    BatchResult result;

    auto start_time = std::chrono::steady_clock::now();

    std::vector<RequestHandle> handles;
    handles.reserve(requests.size());

    // Submit all requests
    for (const auto& req : requests) {
        handles.push_back(submit_async(req));
    }

    // Wait for all results and collect them
    result.responses.reserve(requests.size());
    for (size_t i = 0; i < handles.size(); ++i) {
        auto response = handles[i].future.get();

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

size_t EventLoopImpl::active_count() const {
    size_t count = 0;
    for (const auto& worker : workers) {
        count += worker->active_count();
    }
    return count;
}

size_t EventLoopImpl::pending_count() const {
    size_t count = 0;
    for (const auto& worker : workers) {
        count += worker->pending_count();
    }
    return count;
}

size_t EventLoopImpl::total_processed() const {
    size_t count = 0;
    for (const auto& worker : workers) {
        count += worker->local_processed.load(std::memory_order_relaxed);
    }
    return count;
}

}  // namespace vayu::http::detail
