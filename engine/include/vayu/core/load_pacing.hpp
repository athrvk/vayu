#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file load_pacing.hpp
 * @brief Pure cores for load-generation pacing: how long a run lasts, how many
 *        requests it owes right now, and what its concurrency target is on a
 *        ramp. Each is a total function over its inputs so the strategy thread
 *        - which has no catch above it - cannot be handed an out-of-range value
 *        it has to guess about.
 */

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <optional>
#include <string>
#include <string_view>

namespace vayu::core {

namespace detail {

/** Trim ASCII whitespace from both ends. */
[[nodiscard]] inline std::string_view trim (std::string_view value) {
    auto is_space = [] (char c) {
        return std::isspace (static_cast<unsigned char> (c)) != 0;
    };
    while (!value.empty () && is_space (value.front ()))
        value.remove_prefix (1);
    while (!value.empty () && is_space (value.back ()))
        value.remove_suffix (1);
    return value;
}

} // namespace detail

/**
 * @brief Parse a duration string ("500ms", "30s", "5m", "2h") into milliseconds.
 *
 * Units are matched as a whole suffix, so "500ms" is half a second rather than
 * 500 of anything else. A bare number is seconds ("60" == "60s"), which is what
 * the MCP duration cap already assumes of the same field. Case and surrounding
 * whitespace are ignored; the number may carry a fraction ("1.5s").
 *
 * Replaces `stoll(str.substr(0, len - 1)) * 1000`, which stripped one character
 * and always multiplied by 1000: "5m" ran for 5 seconds and "500ms" for 500.
 *
 * @return milliseconds, or `nullopt` when the value is empty, negative, not a
 *         plain decimal number, carries an unknown unit, or overflows. Callers
 *         must reject rather than substitute a default - silently running 60s
 *         for a duration the caller spelled differently is the defect this
 *         function exists to remove.
 */
[[nodiscard]] inline std::optional<int64_t> parse_duration_ms (std::string_view value) {
    std::string_view text = detail::trim (value);
    if (text.empty ())
        return std::nullopt;

    // Split the trailing alphabetic unit from the leading number.
    size_t split = text.size ();
    while (split > 0 && std::isalpha (static_cast<unsigned char> (text[split - 1])) != 0)
        --split;

    std::string unit;
    for (char c : text.substr (split))
        unit.push_back (
        static_cast<char> (std::tolower (static_cast<unsigned char> (c))));

    double multiplier = 0.0;
    if (unit.empty () || unit == "s")
        multiplier = 1000.0;
    else if (unit == "ms")
        multiplier = 1.0;
    else if (unit == "m")
        multiplier = 60.0 * 1000.0;
    else if (unit == "h")
        multiplier = 60.0 * 60.0 * 1000.0;
    else
        return std::nullopt;

    std::string_view number = detail::trim (text.substr (0, split));
    if (number.empty ())
        return std::nullopt;

    // Digits and at most one decimal point only: this rejects "1e3", "0x10",
    // "+5" and "-5" here rather than letting strtod give them a meaning no
    // caller intended.
    bool seen_dot = false, seen_digit = false;
    for (char c : number) {
        if (c == '.') {
            if (seen_dot)
                return std::nullopt;
            seen_dot = true;
        } else if (std::isdigit (static_cast<unsigned char> (c)) != 0) {
            seen_digit = true;
        } else {
            return std::nullopt;
        }
    }
    if (!seen_digit)
        return std::nullopt;

    const double amount = std::strtod (std::string (number).c_str (), nullptr);
    if (!std::isfinite (amount))
        return std::nullopt;

    const double milliseconds = amount * multiplier;
    if (milliseconds > static_cast<double> (std::numeric_limits<int64_t>::max ()))
        return std::nullopt;
    return static_cast<int64_t> (milliseconds);
}

/**
 * @brief Concurrency target on a linear ramp from @p start to @p target,
 *        reached at @p ramp_ms and held flat after it.
 *
 * The interpolation is done in `double`, which is signed: `start > target` is a
 * legitimate profile (ramp down), and computing `target - start` in `size_t`
 * underflowed to ~1.8e19, so the closed-loop controller tried to hold an
 * astronomical in-flight count for the whole ramp - an unbounded flood instead
 * of a descending ramp.
 */
[[nodiscard]] inline size_t
ramp_target_concurrency (size_t start, size_t target, int64_t ramp_ms, int64_t elapsed_ms) {
    if (ramp_ms <= 0 || elapsed_ms >= ramp_ms)
        return target;
    if (elapsed_ms <= 0)
        return start;

    const double progress =
    static_cast<double> (elapsed_ms) / static_cast<double> (ramp_ms);
    const double value = static_cast<double> (start) +
    ((static_cast<double> (target) - static_cast<double> (start)) * progress);
    if (value <= 0.0)
        return 0;
    return static_cast<size_t> (value);
}

/**
 * @brief Open-loop pacing: accrue @p elapsed_us worth of requests at
 *        @p target_rps and take the whole ones, carrying the fraction in
 *        @p debt for the next tick.
 *
 * Replaces `batch_size = size_t(target_rps / 1000.0)` submitted per 1ms tick,
 * which truncated every rate above 1000 to the nearest 1000 (1500 RPS delivered
 * 1000, 2500 delivered 2000). Carrying the fractional remainder makes the
 * delivered count track @p target_rps at any rate and at any tick length, so
 * timer jitter is corrected on the following tick rather than lost.
 *
 * @param debt        carried fraction of a request, in [0, 1); updated in place
 * @param target_rps  requested rate; <= 0 owes nothing
 * @param elapsed_us  microseconds since the last call; <= 0 owes nothing
 * @return whole requests due now
 */
[[nodiscard]] inline size_t
take_due_requests (double& debt, double target_rps, int64_t elapsed_us) {
    if (!(target_rps > 0.0) || elapsed_us <= 0)
        return 0;

    debt += target_rps * (static_cast<double> (elapsed_us) / 1000000.0);
    double whole = std::floor (debt);
    if (!(whole > 0.0))
        return 0;
    debt -= whole;

    // A tick can only ever owe what a caller could plausibly submit; the clamp
    // exists so an absurd rate/elapsed pair cannot overflow the cast.
    constexpr double kMaxDuePerTick = 1e9;
    return static_cast<size_t> (std::min (whole, kMaxDuePerTick));
}

} // namespace vayu::core
