#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/reentrant.hpp
 * @brief The reentrant spelling of the two C library calls this engine makes
 *        whose classic spelling answers out of process-wide storage
 *        (issue #945, `concurrency-mt-unsafe`).
 *
 * `std::localtime` and `std::strerror` both hand back a pointer into memory the
 * whole process shares, filled on the call. The caller then reads it - through
 * `std::put_time`, or by constructing a `std::string` from it - and anything
 * that calls the same function in between has already overwritten it. The
 * engine is threaded end to end (event loop workers, the thread pool, the
 * metrics collector, every HTTP handler), so "in between" is an ordinary
 * interleaving rather than a rare one, and a lock of our own does not help: the
 * storage is shared with libcurl, QuickJS and the C runtime, none of which
 * takes it.
 *
 * What comes out the other side is not a crash, which is why this is worth
 * stating: it is a timestamp or an error message describing a *different*
 * call's subject. A form part that could not be opened reports the errno of
 * whatever failed elsewhere, and the reader has no way to tell.
 *
 * Both functions here write into storage the caller owns. Reach for them rather
 * than the classic spelling; `tests/reentrant_test.cpp` scans the tree for the
 * classic one and names any file that brings it back.
 */

#include <ctime>
#include <iomanip>
#include <sstream>
#include <string>
#include <system_error>

namespace vayu::utils {

/**
 * @brief @p time in the local zone, formatted by @p format.
 * @param time The instant to render.
 * @param format A `std::strftime` format string.
 * @return The formatted time, or an empty string for an instant the local zone
 *         cannot represent.
 *
 * The platform split is the same one `request_composer.cpp` uses for the UTC
 * side: POSIX spells the reentrant form `localtime_r`, taking the output
 * parameter last, and MSVC spells it `localtime_s`, taking it first. What the
 * classic call returns is a pointer into shared storage; what this one fills
 * is a `std::tm` on the caller's own stack, which is what `std::put_time` then
 * reads.
 *
 * The conversion is checked rather than assumed, because the failure is silent
 * otherwise: a `time_t` outside the zone's range leaves the zero-initialised
 * `std::tm` untouched, which formats as a confident `1899-12-31 00:00:00`. A
 * caller that gets nothing knows it got nothing.
 */
inline std::string format_local_time (std::time_t time, const char* format) {
    std::tm local{};
#if defined(_WIN32)
    const bool converted = localtime_s (&local, &time) == 0;
#else
    const bool converted = localtime_r (&time, &local) != nullptr;
#endif
    if (!converted) {
        return {};
    }
    std::ostringstream out;
    out << std::put_time (&local, format);
    return out.str ();
}

/**
 * @brief The message for @p error_number, an `errno` value.
 *
 * `std::generic_category` and not `std::system_category`: the two agree on
 * POSIX, but on Windows the system category maps `GetLastError` codes, where
 * the same integer means something else entirely - `EACCES` (13) would render
 * as "The data is invalid". The generic category is the one that means `errno`
 * on all three platforms.
 *
 * It is also the reentrant answer. Every standard library the engine builds
 * against implements `message` over the caller-buffer form of `strerror`
 * (`strerror_r`, `strerror_s`) and returns an owned `std::string`, so there is
 * no shared buffer left to race on and no lifetime to reason about.
 */
inline std::string errno_message (int error_number) {
    return std::generic_category ().message (error_number);
}

} // namespace vayu::utils
