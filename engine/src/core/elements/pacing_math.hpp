#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The start-to-start interval arithmetic `timer.pacing` (#1498) and
 * `timer.throughput` (#1571) share: a node's next entry is its previous entry
 * plus a fixed interval, whatever the node's own duration was.
 *
 * The kinds differ only in where the interval comes from (`everyMs`, or
 * `60000 / targetPerMinute`) and in what `perUser: false` means, so the rest is
 * one implementation, not two copies that can disagree about a wait.
 *
 * Source-tree-local: nothing outside `engine/src/core/elements/` needs it.
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

/// `deadline - now`, never negative: "a step longer than the interval continues
/// at once" (#1498's acceptance criteria).
[[nodiscard]] inline int64_t
remaining_wait_ms (int64_t last_started_ms, int64_t every_ms, int64_t now_ms) {
    if (last_started_ms <= 0) {
        return 0; // Never started before - the first pass is never delayed.
    }
    return std::max<int64_t> (0, last_started_ms + every_ms - now_ms);
}

/// The per-VU half of `Element::scheduled_ready_delay_ms`: books this VU's next
/// entry at its previous entry plus @p every_ms and returns the wait that
/// implies. The deadline is written back so the next call books from it, not
/// from when the step actually ran, which keeps the cadence steady when a
/// step's duration varies.
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
 * The blocking `step.before` wait an interval timer performs on the design send
 * and the sequential run, and the outcome it reports: the whole of such a
 * kind's `apply` once it has decided it is this node's scope entry.
 *
 * @p every_ms is the kind's computed interval; the run-level `elements.timers`
 * override is applied to it here.
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
        // `scheduled_ready_delay_ms` already deferred the VU before dispatch,
        // so this only confirms the outcome. Touching `pacing_state` here would
        // double-book the next pass's wait.
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
