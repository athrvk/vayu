#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/competing_writer.hpp
 * @brief A second client driven into the window a route holds the DB lock over.
 *
 * Every route that reads, decides and then writes claims that the three are one
 * lock scope (`Database::with_lock`, issue #386). The claim is about an
 * interleaving, so a test for it has to produce one: this starts a genuinely
 * concurrent writer from inside the scope, through the route's `before_write`
 * seam, and gives it a bounded window to finish before the route commits.
 *
 * With the lock scope in place the writer blocks on the DB mutex, the wait runs
 * its full timeout every time, and the route commits first deterministically -
 * there is no ordering in which it does not. Remove the lock scope and the
 * writer proceeds immediately against the pre-write state, the wait returns as
 * soon as it is done, and the test sees the interleaving it forbids. That is
 * what makes each of these tests decide in both directions.
 */

#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>
#include <utility>

namespace vayu::tests {

class CompetingWriter {
    public:
    explicit CompetingWriter (std::function<void ()> work)
    : work_ (std::move (work)) {
    }
    ~CompetingWriter () {
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    CompetingWriter (const CompetingWriter&)            = delete;
    CompetingWriter& operator= (const CompetingWriter&) = delete;
    CompetingWriter (CompetingWriter&&)                 = delete;
    CompetingWriter& operator= (CompetingWriter&&)      = delete;

    /** The `before_write` probe: starts the writer, then waits out the window. */
    std::function<void ()> probe () {
        return [this] {
            thread_ = std::thread ([this] {
                work_ ();
                {
                    std::lock_guard<std::mutex> guard (mutex_);
                    done_ = true;
                }
                cv_.notify_all ();
            });
            std::unique_lock<std::mutex> guard (mutex_);
            cv_.wait_for (
            guard, std::chrono::milliseconds (300), [this] { return done_; });
        };
    }

    void join () {
        thread_.join ();
    }

    private:
    std::function<void ()> work_;
    std::thread thread_;
    std::mutex mutex_;
    std::condition_variable cv_;
    bool done_ = false;
};

} // namespace vayu::tests
