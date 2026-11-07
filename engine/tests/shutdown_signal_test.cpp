/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/shutdown_signal_test.cpp
 * @brief The daemon's shutdown handler takes no lock and logs nothing (#3346).
 *
 * A signal lands on whichever thread the OS picks, including one inside
 * `Logger::write` with the logger's non-recursive mutex held. The test puts the
 * handler in exactly that spot: a streambuf installed as `std::cout`'s buffer
 * invokes the handler from inside the console write, so the handler runs on the
 * thread that owns the mutex, deterministically and without a real signal (which
 * Windows delivers differently).
 *
 * Mutation-check: add a `log_info` to the lambda in `make_shutdown_handler` and
 * the worker thread re-locks the mutex it holds, never finishes, and the bounded
 * wait fails.
 */

#include <atomic>
#include <chrono>
#include <filesystem>
#include <functional>
#include <future>
#include <iostream>
#include <streambuf>
#include <string>
#include <thread>

#include <gtest/gtest.h>

#include "vayu/platform/shutdown_signal.hpp"
#include "vayu/utils/logger.hpp"
#include "wait_until.hpp"

namespace {

using vayu::platform::ShutdownSignal;

/// Calls @p on_write the first time anything is written through it, which for
/// `std::cout` is inside `Logger::write_to_console_locked` with `mutex_` held.
class TrapBuf : public std::streambuf {
    public:
    explicit TrapBuf (std::function<void ()> on_write)
    : on_write_ (std::move (on_write)) {
    }

    protected:
    int_type overflow (int_type ch) override {
        trip ();
        return traits_type::not_eof (ch);
    }
    std::streamsize xsputn (const char*, std::streamsize n) override {
        trip ();
        return n;
    }

    private:
    void trip () {
        if (!tripped_) {
            tripped_ = true;
            on_write_ ();
        }
    }
    std::function<void ()> on_write_;
    bool tripped_ = false;
};

std::atomic<int> g_forced_exits{ 0 };
void record_forced_exit () {
    g_forced_exits.fetch_add (1);
}

/// Runs `log_warning` (a console line at any verbosity) on a worker thread whose
/// `std::cout` write fires @p signals in order. True if the worker finished
/// inside the budget.
bool log_while_signalled (std::function<void ()> signals) {
    TrapBuf trap (std::move (signals));
    auto* previous = std::cout.rdbuf (&trap);
    std::promise<void> done;
    auto finished = done.get_future ();
    std::thread worker ([&done] {
        vayu::utils::log_warning ("test", "a line written under the logger mutex");
        done.set_value ();
    });
    const bool completed =
    finished.wait_for (vayu::tests::WAIT_DEADLINE) == std::future_status::ready;
    if (completed) {
        worker.join ();
    } else {
        // Deadlocked on a mutex it already owns; nothing can join it.
        worker.detach ();
    }
    std::cout.rdbuf (previous);
    return completed;
}

} // namespace

TEST (ShutdownSignalTest, AFirstSignalLandingUnderTheLoggerMutexOnlyStoresTheState) {
    std::atomic<ShutdownSignal> state{ ShutdownSignal::none };
    g_forced_exits = 0;
    const auto handler = vayu::platform::make_shutdown_handler (state, &record_forced_exit);

    ASSERT_TRUE (log_while_signalled ([&] { handler (false); }));

    EXPECT_EQ (state.load (), ShutdownSignal::requested);
    EXPECT_EQ (g_forced_exits.load (), 0);
}

TEST (ShutdownSignalTest, ASecondSignalUnderTheLoggerMutexForcesTheExitWithoutLogging) {
    std::atomic<ShutdownSignal> state{ ShutdownSignal::none };
    g_forced_exits = 0;
    const auto handler = vayu::platform::make_shutdown_handler (state, &record_forced_exit);

    ASSERT_TRUE (log_while_signalled ([&] {
        handler (false);
        handler (true);
    }));

    EXPECT_EQ (state.load (), ShutdownSignal::forced);
    EXPECT_EQ (g_forced_exits.load (), 1);
}
