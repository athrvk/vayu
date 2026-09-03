/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file high_resolution_timer.cpp
 * @brief The refcounted 1 ms timer request, and the one OS call behind it
 *
 * Portable on purpose, unlike its two neighbours in this directory: the
 * refcount, the scope and the balance rule are the same everywhere, and only
 * the two `timeapi.h` calls are Windows'. Splitting it the other way - the
 * count here, the call in `platform_windows.cpp` - would spread one mechanism
 * over three files and leave the invariant testable on one CI leg only.
 */

#include "vayu/platform/platform.hpp"

#include <mutex>

#if VAYU_PLATFORM_WINDOWS
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
// clang-format off
// The engine's one exemption from `SortIncludes` (issue #886), which moved
// here with the timer request it is for: timeapi.h uses MMRESULT, UINT and
// WINAPI, which windows.h defines, so it does not compile standalone - and
// alphabetically it sorts first. Nothing catches that but the Windows CI leg,
// which is why this is pinned rather than left to the sorter.
#include <windows.h>
#include <timeapi.h>
// clang-format on
#endif

namespace vayu::platform {

namespace {

/**
 * The refcount and the mutex that pairs it with the OS call.
 *
 * A function-local static rather than two namespace-scope objects: nothing
 * here is built before `main` (engine/CLAUDE.md), and the pairing has to be a
 * mutex rather than an atomic counter. With a bare `fetch_sub`, a run
 * finishing and a run starting can interleave so that the release lands
 * *after* the acquire - a correct count over a resolution the OS has already
 * put back, for as long as the new run lasts.
 */
struct TimerRequest {
    std::mutex mutex;
    int holders = 0;
};

TimerRequest& timer_request () {
    static TimerRequest request;
    return request;
}

/// The whole of what is platform-specific here. Called under the mutex.
void apply_timer_resolution ([[maybe_unused]] bool requested) {
#if VAYU_PLATFORM_WINDOWS
    if (requested) {
        (void)timeBeginPeriod (1);
    } else {
        (void)timeEndPeriod (1);
    }
#endif
}

} // namespace

HighResolutionTimerScope::HighResolutionTimerScope () {
    TimerRequest& request = timer_request ();
    std::lock_guard<std::mutex> lock (request.mutex);
    if (request.holders++ == 0) {
        apply_timer_resolution (true);
    }
}

HighResolutionTimerScope::~HighResolutionTimerScope () {
    TimerRequest& request = timer_request ();
    std::lock_guard<std::mutex> lock (request.mutex);
    // A destructor is total (engine/CLAUDE.md): neither the count nor the OS
    // call throws, so there is nothing here to catch.
    if (--request.holders == 0) {
        apply_timer_resolution (false);
    }
}

int high_resolution_timer_holders () {
    TimerRequest& request = timer_request ();
    std::lock_guard<std::mutex> lock (request.mutex);
    return request.holders;
}

} // namespace vayu::platform
