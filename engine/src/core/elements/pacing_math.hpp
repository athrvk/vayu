#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pacing_math.hpp
 * @brief The start-to-start interval arithmetic `timer.pacing` (issue #1498)
 *        and `timer.throughput` (issue #1571) share: a node's next entry is
 *        its previous entry plus a fixed interval, whatever the node's own
 *        duration was.
 *
 * The two kinds differ only in where that interval comes from - stated
 * directly as `everyMs`, or derived from a rate as `60000 / targetPerMinute`
 * - and in what each one's `perUser: false` case means. Everything below the
 * interval is therefore one implementation rather than two copies that can
 * come to disagree about the same wait.
 *
 * Source-tree-local (not under `include/vayu/`), on `json_path.hpp`'s
 * precedent: nothing outside `engine/src/core/elements/` needs it.
 */

#include "vayu/core/elements.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <string>
#include <thread>
#include <unordered_map>

namespace vayu::core::detail {

/// How often a blocking wait re-checks `should_stop` - short enough that a
/// stop signalled mid-wait is honoured promptly, long enough not to spin.
constexpr auto PACING_POLL_INTERVAL = std::chrono::milliseconds (50);

[[nodiscard]] inline int64_t steady_now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now ().time_since_epoch ())
    .count ();
}

/// `deadline - now`, clamped to never negative and never below @p every_ms
/// having elapsed - "a step longer than the interval continues at once"
/// (issue #1498's acceptance criteria), not with a negative wait.
[[nodiscard]] inline int64_t
remaining_wait_ms (int64_t last_started_ms, int64_t every_ms, int64_t now_ms) {
    if (last_started_ms <= 0) {
        return 0; // Never started before - the first pass is never delayed.
    }
    return std::max<int64_t> (0, last_started_ms + every_ms - now_ms);
}

/// The per-VU half of `Element::scheduled_ready_delay_ms`: books this VU's
/// next entry at its previous entry plus @p every_ms and returns the wait
/// that implies. Writes the deadline back, so the *next* call books from it
/// rather than from whenever the step actually ran - which is what keeps a
/// cadence steady across a step whose own duration varies.
[[nodiscard]] inline int64_t advance_per_user_pacing (
std::unordered_map<std::string, int64_t>& pacing_state,
const std::string& element_id,
int64_t every_ms,
int64_t now_ms) {
    const int64_t last_started = pacing_state[element_id];
    const int64_t deadline = last_started <= 0 ? now_ms : last_started + every_ms;
    pacing_state[element_id] = deadline;
    return std::max<int64_t> (0, deadline - now_ms);
}

/**
 * The blocking `step.before` wait an interval timer performs on the design
 * send and the sequential run, and the outcome it reports - the whole body of
 * such a kind's `apply` once it has decided it is this node's scope entry.
 *
 * @p every_ms is that kind's own computed interval, before the run-level
 * `elements.timers` override is applied to it here.
 */
inline void apply_paced_wait (ElementContext& ctx, const std::string& element_id, int64_t every_ms) {
    const auto overridden =
    apply_timers_override (ctx.timers_override, every_ms, ctx.rng);
    if (!overridden) {
        ctx.outcome_status    = "ok";
        ctx.outcome_waited_ms = 0;
        return;
    }
    const int64_t interval_ms = *overridden;

    if (!ctx.blocking_allowed) {
        // The wait already happened through `scheduled_ready_delay_ms`
        // deferring the VU before this step was ever dispatched - this call
        // only confirms the outcome, and must not re-touch `pacing_state` or
        // it would double-book the next pass's wait.
        ctx.outcome_status    = "ok";
        ctx.outcome_waited_ms = 0;
        return;
    }

    const int64_t now = steady_now_ms ();
    const int64_t last_started = ctx.pacing_state ? (*ctx.pacing_state)[element_id] : 0;
    const int64_t wait_ms = remaining_wait_ms (last_started, interval_ms, now);
    const auto deadline =
    std::chrono::steady_clock::now () + std::chrono::milliseconds (wait_ms);
    while (wait_ms > 0) {
        if (ctx.should_stop && ctx.should_stop ()) {
            break;
        }
        const auto remaining = deadline - std::chrono::steady_clock::now ();
        if (remaining <= std::chrono::steady_clock::duration::zero ()) {
            break;
        }
        std::this_thread::sleep_for (std::min<std::chrono::steady_clock::duration> (
        PACING_POLL_INTERVAL, remaining));
    }

    if (ctx.pacing_state) {
        (*ctx.pacing_state)[element_id] = steady_now_ms ();
    }
    ctx.outcome_status    = "ok";
    ctx.outcome_waited_ms = wait_ms;
}

} // namespace vayu::core::detail
