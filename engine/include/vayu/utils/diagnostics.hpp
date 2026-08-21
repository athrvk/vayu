#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/diagnostics.hpp
 * @brief Scoped suppressions for the three GCC diagnostics that fire only on
 *        code we did not write (issue #897).
 *
 * The engine builds warning-clean, and every suppression here is a *proven*
 * false positive rather than a warning someone found inconvenient - each macro
 * names the family, the analysis that produces it, and what would have to
 * change for the suppression to be deleted. A real defect gets fixed at the
 * source; nothing belongs here that a code change could remove.
 *
 * Two rules the shape enforces:
 *
 *  - **Scoped, never global.** Each macro is a `push` that a matching
 *    `VAYU_DIAGNOSTIC_POP` ends, so a suppression covers the one function whose
 *    inlining produces the diagnostic and nothing after it. Adding `-Wno-...`
 *    to `vayu_warnings` would hide the next genuine instance of the same family
 *    everywhere, which is the whole value of having the flag on.
 *  - **GCC only.** These are GCC 13 heuristics; clang has no
 *    `-Wdangling-reference` at all, and an unknown name inside a diagnostic
 *    pragma is itself a warning there (`-Wunknown-warning-option`). MSVC has
 *    neither the pragma spelling nor the analyses. So off GCC each macro
 *    expands to nothing.
 *
 * Written once here rather than as raw pragmas at each site because the
 * compiler guard is the part that is easy to get subtly wrong, and a hand-rolled
 * copy of it would not receive this one's fixes.
 */

#if defined(__GNUC__) && !defined(__clang__)

/**
 * GCC 13's ref-in/ref-out heuristic: a function taking a reference and
 * returning one is assumed to return a reference *into a temporary*, whether or
 * not the argument was one. A helper that indexes into a caller-owned object
 * and hands back a reference to a member trips it at every call site.
 *
 * Delete this when the engine's minimum GCC carries `[[gnu::no_dangling]]`
 * (GCC 14), which states the fact at the function instead of at its callers.
 */
#define VAYU_IGNORE_FALSE_DANGLING_REFERENCE                                             \
    _Pragma ("GCC diagnostic push")                                                      \
    _Pragma ("GCC diagnostic ignored \"-Wdangling-reference\"")

/**
 * `-Wnull-dereference` traced into libstdc++, never into our own code: the
 * pointer GCC cannot prove non-null belongs to a `std::basic_streambuf` or to
 * nlohmann's internal `swap`, both reached only by inlining at `-O2`. Both are
 * known false-positive families - a stream we opened and checked has a buffer,
 * and a `basic_json` we just constructed has a value.
 *
 * The flag is opt-in here (`vayu_warnings` adds it on top of `-Wextra`), so it
 * is worth keeping for the cases it would catch in our own code - which is
 * exactly why these are suppressed one function at a time.
 */
#define VAYU_IGNORE_FALSE_NULL_DEREFERENCE                                               \
    _Pragma ("GCC diagnostic push")                                                      \
    _Pragma ("GCC diagnostic ignored \"-Wnull-dereference\"")

/**
 * GCC 13's string-concatenation family: folding `operator+` over a
 * `std::string` makes the optimizer reason about the 32-byte small-string
 * buffer as though it were the whole object, and it reports the heap copy that
 * follows as an out-of-bounds `memcpy`. Nothing is out of bounds - the string
 * has already reallocated by the time the copy runs.
 *
 * **Both flags, because it is one diagnostic wearing two names.** GCC reports
 * the same `char_traits.h:435` `memcpy` as `-Warray-bounds` or as
 * `-Wstringop-overflow` depending on which pass reaches it first, so silencing
 * one alone just moves the warning to the other spelling.
 */
#define VAYU_IGNORE_FALSE_STRING_CONCAT_BOUNDS                                           \
    _Pragma ("GCC diagnostic push")                                                      \
    _Pragma ("GCC diagnostic ignored \"-Warray-bounds\"")                                \
    _Pragma ("GCC diagnostic ignored \"-Wstringop-overflow\"")

/// Ends the region opened by any `VAYU_IGNORE_FALSE_*` above.
#define VAYU_DIAGNOSTIC_POP _Pragma ("GCC diagnostic pop")

#else

#define VAYU_IGNORE_FALSE_DANGLING_REFERENCE
#define VAYU_IGNORE_FALSE_NULL_DEREFERENCE
#define VAYU_IGNORE_FALSE_STRING_CONCAT_BOUNDS
#define VAYU_DIAGNOSTIC_POP

#endif
