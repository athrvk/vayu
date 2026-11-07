/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

/**
 * @file shutdown_signal.hpp
 * @brief What the daemon's SIGINT / SIGTERM / Ctrl-C handler is allowed to do.
 *
 * A handler runs on whichever thread the signal lands on, and that thread may
 * be holding any lock the engine has. `Logger` guards its sinks with a
 * non-recursive `std::mutex`, and a load run logs from every worker, so a
 * handler that logs deadlocks the thread it interrupts whenever the signal
 * arrives mid-write (#3346). The handler therefore only stores an atomic; the
 * daemon's main loop reads it and writes the log line from an ordinary thread.
 */

#include <atomic>
#include <cstdint>

#include "vayu/platform/platform.hpp"

namespace vayu::platform {

/// `none` until a signal lands, `requested` after the first, `forced` after the
/// second (the process is already gone by then, so `forced` is only ever seen
/// by a `force_exit` that returns).
enum class ShutdownSignal : std::uint8_t { none, requested, forced };

static_assert (std::atomic<ShutdownSignal>::is_always_lock_free,
"the signal handler stores into this; a lock-based atomic is not "
"async-signal-safe");

/// The callback `setup_signal_handlers` is given. Stores into @p state and, on a
/// forced second signal, calls @p force_exit. It takes no lock and logs
/// nothing; @p force_exit must be async-signal-safe (`std::_Exit` in the daemon).
inline ShutdownCallback
make_shutdown_handler (std::atomic<ShutdownSignal>& state, void (*force_exit) ()) {
    return [&state, force_exit] (bool force) {
        state.store (force ? ShutdownSignal::forced : ShutdownSignal::requested);
        if (force) {
            force_exit ();
        }
    };
}

} // namespace vayu::platform
