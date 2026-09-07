/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file timer_think.cpp
 * @brief `timer.think` (issue #1514): a fixed or uniform-random wait between
 *        this step and the next.
 *
 * Runs in `step.between`, never `step.before` - the whole point is that the
 * wait does not count against this step's own latency. The wait polls
 * `ElementContext::should_stop` on a short interval rather than sleeping the
 * whole span in one call, so a run stop lands within that interval instead of
 * at the end of a multi-second think time.
 */

#include "vayu/core/elements.hpp"

#include <algorithm>
#include <chrono>
#include <random>
#include <thread>

namespace vayu::core {

namespace {

constexpr auto POLL_INTERVAL = std::chrono::milliseconds (50);

class TimerThinkElement final : public Element {
    public:
    explicit TimerThinkElement (nlohmann::json config)
    : config_ (std::move (config)) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepBetween;
    }

    void apply (ElementContext& ctx) override {
        const long wait_ms = resolve_wait_ms ();
        if (wait_ms <= 0) {
            ctx.outcome_status    = "ok";
            ctx.outcome_waited_ms = 0;
            return;
        }

        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::milliseconds (wait_ms);
        while (true) {
            if (ctx.should_stop && ctx.should_stop ()) {
                break;
            }
            const auto now = std::chrono::steady_clock::now ();
            if (now >= deadline) {
                break;
            }
            std::this_thread::sleep_for (std::min<std::chrono::steady_clock::duration> (
            POLL_INTERVAL, deadline - now));
        }
        ctx.outcome_status    = "ok";
        ctx.outcome_waited_ms = wait_ms;
    }

    private:
    [[nodiscard]] long resolve_wait_ms () const {
        if (config_.contains ("minMs") || config_.contains ("maxMs")) {
            long min_ms = config_.value ("minMs", 0);
            long max_ms = config_.value ("maxMs", min_ms);
            if (max_ms < min_ms) {
                std::swap (min_ms, max_ms);
            }
            if (max_ms == min_ms) {
                return min_ms;
            }
            static thread_local std::mt19937 rng{ std::random_device{}() };
            std::uniform_int_distribution<long> dist (min_ms, max_ms);
            return dist (rng);
        }
        return config_.value ("ms", 0L);
    }

    nlohmann::json config_;
};

} // namespace

ElementKind make_timer_think_kind () {
    ElementKind kind;
    kind.kind    = "timer.think";
    kind.version = 1;
    kind.phases  = { Phase::StepBetween };
    kind.label   = "Think time";
    kind.description =
    "Waits a fixed or uniformly random span before the next step, "
    "outside this step's own latency.";
    kind.category = "timer";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<TimerThinkElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "ms", { { "type", "integer" }, { "minimum", 0 } } },
        { "minMs", { { "type", "integer" }, { "minimum", 0 } } },
        { "maxMs", { { "type", "integer" }, { "minimum", 0 } } } } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
