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
 *        requests it owes right now, how much of that a stalled tick still
 *        sends, and what its concurrency target is on a ramp. Each is a total
 *        function over its inputs so the strategy thread - which has no catch
 *        above it - cannot be handed an out-of-range value it has to guess
 *        about.
 */

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <optional>
#include <string>
#include <string_view>

#include "vayu/utils/ascii_case.hpp"

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

    const std::string unit = vayu::utils::ascii_lower (text.substr (split));

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
 * @brief The longest the closed-loop controller (`maintain_concurrency`) waits
 *        before it re-reads its concurrency target when no completion wakes it.
 */
inline constexpr int64_t CONTROLLER_TICK_MS = 50;

/**
 * @brief Concurrency target on a linear ramp from @p start to @p target,
 *        reached within one controller tick of @p ramp_ms and held flat after.
 *
 * A run whose `duration` equals its ramp never samples at or past @p ramp_ms:
 * its last sample is the controller's final refill at `duration - 1`
 * (`maintain_concurrency`'s `run_end_ms`). A target owed only from @p ramp_ms
 * on is never asked for (1 -> 50 over 20s peaked at 49, #2913); treating the
 * last tick of the ramp as its end covers that sample, and never answers past
 * @p target.
 *
 * The interpolation is done in `double`, which is signed: `start > target` is a
 * legitimate profile (ramp down), and computing `target - start` in `size_t`
 * underflowed to ~1.8e19, so the closed-loop controller tried to hold an
 * astronomical in-flight count for the whole ramp - an unbounded flood instead
 * of a descending ramp.
 */
[[nodiscard]] inline size_t
ramp_target_concurrency (size_t start, size_t target, int64_t ramp_ms, int64_t elapsed_ms) {
    if (ramp_ms <= 0)
        return target;
    // Before the end-of-ramp check, so a ramp no longer than one tick still
    // seeds at `start` rather than at its target.
    if (elapsed_ms <= 0)
        return start;
    if (elapsed_ms >= ramp_ms - CONTROLLER_TICK_MS)
        return target;

    const double progress =
    static_cast<double> (elapsed_ms) / static_cast<double> (ramp_ms);
    const double value = static_cast<double> (start) +
    ((static_cast<double> (target) - static_cast<double> (start)) * progress);
    if (value <= 0.0)
        return 0;
    return static_cast<size_t> (value);
}

/**
 * @brief Open-loop pacing: the whole requests a constant @p target_rps has
 *        owed by @p elapsed into the run, `floor(target_rps x elapsed)`.
 *
 * Request k (counting from 1) is owed at `k / target_rps`, so a run of length
 * D owes `floor(target_rps x D)` in all. The pacer asks this of the absolute
 * time since the run started and submits the difference from what it has
 * already taken (#2910): a per-tick delta lost its sub-microsecond remainder
 * every tick, and a run sent one request short. A run's `requests_expected`
 * is this same call at its duration, so the final accrual, clamped to the
 * deadline, owes exactly that count whatever the rounding.
 *
 * A rate and a duration written in decimal can multiply to a whole number that
 * binary lands just below (0.57 req/s x 100 s is 56.99999999999999), so the
 * product is read with a few ulps of slack. Parsing the rate, converting the
 * span and multiplying round once each, half an ulp apiece, so the slack only
 * ever reaches a product that is whole in decimal.
 *
 * @param target_rps  requested rate; <= 0 owes nothing
 * @param elapsed     time since the run started; <= 0 owes nothing
 */
[[nodiscard]] inline size_t
requests_owed_by (double target_rps, std::chrono::nanoseconds elapsed) {
    if (!(target_rps > 0.0) || elapsed.count () <= 0)
        return 0;

    constexpr double kProductSlack = 8 * std::numeric_limits<double>::epsilon ();
    // Bounds the cast for any rate the caller passes; a run inside
    // MAX_TARGET_RPS and an int64 nanosecond span stays orders below it.
    constexpr double kMaxOwed = 1e18;

    const double seconds = std::chrono::duration<double> (elapsed).count ();
    const double owed = std::floor (target_rps * seconds * (1.0 + kProductSlack));
    return static_cast<size_t> (std::min (owed, kMaxOwed));
}

/**
 * How far past its scheduled instant a stalled open-loop tick still pays the
 * schedule (#2911). Requests the schedule owed later than this into the stall
 * are skipped, not sent: a burst of seconds of backlog measures the pacer's
 * stall, not the target.
 */
inline constexpr std::chrono::milliseconds MAX_CATCH_UP_BACKLOG{ 100 };

/** What one open-loop tick does with the requests it owes. */
struct TickPayout {
    size_t to_submit = 0; ///< sent, subject to the maxInFlight headroom
    size_t skipped   = 0; ///< owed more than MAX_CATCH_UP_BACKLOG into a stall
};

/**
 * @brief Split what an open-loop tick owes into what it submits and what it
 *        skips as stalled backlog.
 *
 * The tick submits what the schedule owes up to @p scheduled plus
 * `MAX_CATCH_UP_BACKLOG` and skips the rest. Backlog is measured from the
 * instant the tick was due rather than as a request count: at low rates the
 * tick wakes just before or just after a due point, so its ordinary share is
 * one or two requests whatever the rate, and only the time since the tick was
 * due separates jitter from a stall.
 *
 * `to_submit + skipped == owed - taken`, so a caller advancing `taken` to
 * @p owed accounts for every owed request exactly once.
 *
 * @param target_rps the run's rate; the same value @p owed was computed from
 * @param owed       `requests_owed_by (target_rps, now)`, clamped to the deadline
 * @param taken      what earlier ticks submitted, dropped or skipped
 * @param scheduled  time since the start at which this tick was due
 */
[[nodiscard]] inline TickPayout
split_tick_backlog (double target_rps, size_t owed, size_t taken, std::chrono::nanoseconds scheduled) {
    if (owed <= taken) {
        return {};
    }
    const size_t catch_up_limit =
    std::max (requests_owed_by (target_rps, scheduled + MAX_CATCH_UP_BACKLOG), taken);
    const size_t to_submit = std::min (owed, catch_up_limit) - taken;
    return { to_submit, owed - taken - to_submit };
}

} // namespace vayu::core
