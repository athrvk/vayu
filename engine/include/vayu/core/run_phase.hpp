#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_phase.hpp
 * @brief Where a run's worker is, and where it was when the first Stop
 *        landed (#3341).
 *
 * A Stop means a different thing in each phase: before the strategy returns
 * it decides the run's outcome (Stopped); once the strategy has returned on its
 * own it only cuts the drain short and the run still completes. Reading the
 * phase and recording the Stop as two steps would let the worker advance in
 * between, so both live in one atomic word that only compare-exchange loops
 * write: every advance and the latching Stop are totally ordered, and whichever
 * came first is what the other one sees.
 */

#include <atomic>
#include <cstdint>
#include <optional>

namespace vayu::core {

/// A run's phases, in the only order a worker moves through them. A path may
/// skip one (a sequential collection run has no drain; a failure goes straight
/// to `settled`) but never moves back.
enum class RunPhase : std::uint8_t {
    /// Registered, building the request, running `script.setup`.
    setup,
    /// The strategy is submitting load.
    sending,
    /// The strategy returned on its own; in-flight transfers are settling.
    draining,
    /// Nothing is in flight any more; the summary and final status are
    /// being written.
    summarising,
    /// `RunManager::retain_run` has run: the terminal status is written.
    settled,
};

/**
 * The phase and the phase the first Stop landed in, packed into one byte.
 *
 * Low three bits: the current phase. Next three: the latched phase plus one,
 * zero meaning no Stop yet. Written only by compare-exchange, so an advance
 * never erases a latch and a latch never rewinds an advance.
 */
class RunPhaseLatch {
    public:
    /// Moves the phase forward to @p next; a @p next at or behind the current
    /// phase changes nothing. Only the run's worker calls this.
    void advance (RunPhase next) noexcept {
        auto state = state_.load (std::memory_order_relaxed);
        while (phase_of (state) < next) {
            const auto desired = static_cast<std::uint8_t> (
            (state & ~PHASE_MASK) | static_cast<std::uint8_t> (next));
            if (state_.compare_exchange_weak (state, desired,
                std::memory_order_acq_rel, std::memory_order_relaxed)) {
                return;
            }
        }
    }

    /// Records the current phase as the Stop's, unless a Stop latched
    /// already, and answers the phase this call observed. Any thread.
    RunPhase latch_stop () noexcept {
        auto state = state_.load (std::memory_order_acquire);
        while ((state & STOP_MASK) == 0) {
            const auto desired = static_cast<std::uint8_t> (state |
            ((static_cast<std::uint8_t> (phase_of (state)) + 1U) << STOP_SHIFT));
            if (state_.compare_exchange_weak (state, desired,
                std::memory_order_acq_rel, std::memory_order_acquire)) {
                break;
            }
        }
        return phase_of (state);
    }

    [[nodiscard]] RunPhase phase () const noexcept {
        return phase_of (state_.load (std::memory_order_acquire));
    }

    /// The phase the first Stop landed in; empty when none has.
    [[nodiscard]] std::optional<RunPhase> stop_phase () const noexcept {
        const auto latched = static_cast<std::uint8_t> (
        (state_.load (std::memory_order_acquire) & STOP_MASK) >> STOP_SHIFT);
        if (latched == 0) {
            return std::nullopt;
        }
        return static_cast<RunPhase> (latched - 1U);
    }

    private:
    static constexpr std::uint8_t PHASE_MASK = 0x07U;
    static constexpr unsigned STOP_SHIFT     = 3U;
    static constexpr std::uint8_t STOP_MASK  = PHASE_MASK << STOP_SHIFT;
    static_assert (static_cast<std::uint8_t> (RunPhase::settled) < PHASE_MASK,
    "every phase, plus one for the latch, fits in three bits");

    static RunPhase phase_of (std::uint8_t state) noexcept {
        return static_cast<RunPhase> (state & PHASE_MASK);
    }

    std::atomic<std::uint8_t> state_{ static_cast<std::uint8_t> (RunPhase::setup) };
};

} // namespace vayu::core
