#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/stop_signal.hpp
 * @brief A one-way stop request a waiting thread wakes on (#3345).
 *
 * A handler that paces its own answer (a mock's latency, an inbox's canned
 * delay, an issuer's slow mode) used to `sleep_for` the whole delay, so the join
 * that stops its listener waited it out. `wait_for` is the same pause, ended
 * early by `request`; `flag` is the same request for a libcurl transfer to
 * watch (an OAuth callback's token exchange).
 */

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>

namespace vayu::utils {

class StopSignal {
    public:
    /// Wake every `wait_for` and make every later one return at once. Never
    /// cleared: a stopped owner does not start again.
    void request () {
        {
            // Stored under the mutex a waiter checks it under, or a waiter that
            // has just read `false` would miss this notify and sleep it out.
            std::lock_guard<std::mutex> lock (mutex_);
            requested_.store (true, std::memory_order_release);
        }
        wake_.notify_all ();
    }

    [[nodiscard]] bool stopped () const noexcept {
        return requested_.load (std::memory_order_acquire);
    }

    /// What `request` sets, in the shape `ClientConfig::cancel` takes.
    [[nodiscard]] const std::atomic<bool>& flag () const noexcept {
        return requested_;
    }

    /// Wait @p duration or until `request`, whichever comes first. True when
    /// the wait ended because a stop was requested.
    bool wait_for (std::chrono::milliseconds duration) const {
        std::unique_lock<std::mutex> lock (mutex_);
        return wake_.wait_for (lock, duration, [this] { return stopped (); });
    }

    private:
    std::atomic<bool> requested_{ false };
    mutable std::mutex mutex_;
    mutable std::condition_variable wake_;
};

} // namespace vayu::utils
