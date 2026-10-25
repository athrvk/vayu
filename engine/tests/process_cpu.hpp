#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/process_cpu.hpp
 * @brief `process_cpu_ms` - this process's own CPU time, for the tests that
 *        catch a thread spinning a wait away instead of sleeping it (#1596).
 *        Such a bug changes no count a test could read, only CPU.
 */

#include <cstdint>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/resource.h>
#endif

namespace vayu::tests {

/// User plus system CPU time of every thread in this process, in
/// milliseconds. `getrusage (RUSAGE_SELF)` sums every thread on Unix;
/// `GetProcessTimes` is its Windows equivalent. Sample it before and after the
/// work under test: the mock servers share the process, so only a loose bound
/// on the difference is credible.
inline int64_t process_cpu_ms () {
#ifdef _WIN32
    FILETIME creation{};
    FILETIME exit_time{};
    FILETIME kernel{};
    FILETIME user{};
    if (!GetProcessTimes (GetCurrentProcess (), &creation, &exit_time, &kernel, &user)) {
        return 0;
    }
    auto to_ms = [] (const FILETIME& ft) -> int64_t {
        // FILETIME is a 64-bit count of 100ns intervals split across two
        // 32-bit words.
        const uint64_t ticks =
        (static_cast<uint64_t> (ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
        return static_cast<int64_t> (ticks / 10000);
    };
    return to_ms (kernel) + to_ms (user);
#else
    struct rusage usage{};
    getrusage (RUSAGE_SELF, &usage);
    return (static_cast<int64_t> (usage.ru_utime.tv_sec) * 1000) +
    (usage.ru_utime.tv_usec / 1000) +
    (static_cast<int64_t> (usage.ru_stime.tv_sec) * 1000) +
    (usage.ru_stime.tv_usec / 1000);
#endif
}

} // namespace vayu::tests
