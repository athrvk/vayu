/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/event_loop.cpp
 * @brief Async HTTP event loop implementation using curl_multi
 */

#include "vayu/http/event_loop.hpp"

#include "vayu/http/event_loop/event_loop_impl.hpp"

namespace vayu::http {

EventLoop::EventLoop(EventLoopConfig config)
    : impl_(std::make_unique<detail::EventLoopImpl>(std::move(config))) {}

EventLoop::~EventLoop() = default;

EventLoop::EventLoop(EventLoop&&) noexcept = default;
EventLoop& EventLoop::operator=(EventLoop&&) noexcept = default;

void EventLoop::start() {
    impl_->start();
}

void EventLoop::stop(bool wait_for_pending) {
    impl_->stop(wait_for_pending);
}

bool EventLoop::is_running() const {
    return impl_->running;
}

size_t EventLoop::submit(const Request& request,
                         RequestCallback callback,
                         ProgressCallback progress) {
    return impl_->submit(request, std::move(callback), std::move(progress));
}

RequestHandle EventLoop::submit_async(const Request& request) {
    return impl_->submit_async(request);
}

bool EventLoop::cancel(size_t request_id) {
    return impl_->cancel(request_id);
}

BatchResult EventLoop::execute_batch(const std::vector<Request>& requests) {
    return impl_->execute_batch(requests);
}

size_t EventLoop::active_count() const {
    return impl_->active_count();
}

size_t EventLoop::pending_count() const {
    return impl_->pending_count();
}

size_t EventLoop::total_processed() const {
    return impl_->total_processed();
}

EventLoopStats EventLoop::stats() const {
    return impl_->stats();
}

}  // namespace vayu::http
