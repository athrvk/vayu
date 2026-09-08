/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pipeline.cpp
 * @brief `compile_elements` and `ElementPipeline::run` (issue #1514): turning
 *        a resolved `elements` array into compiled behaviour and running it
 *        at one phase of a step.
 */

#include "vayu/core/elements.hpp"

#include <algorithm>
#include <cmath>
#include <random>

#include "vayu/core/scenario_plan.hpp"

namespace vayu::core {

std::string transaction_sum_key (const std::string& element_id, size_t iteration) {
    return element_id + "#" + std::to_string (iteration) + "#sum";
}

SharedThroughputCounters::SharedThroughputCounters (const ScenarioPlan& plan) {
    const auto& registry = Registry::instance ();
    for (const auto& step : plan.steps) {
        if (!step.elements) {
            continue;
        }
        for (const auto& element : *step.elements) {
            if (counters_.contains (element.id)) {
                continue; // Already slotted - a folder-inherited occurrence
                          // carries the same id at every member position.
            }
            const auto* kind = registry.find (element.kind);
            if (kind == nullptr || !kind->supports_shared_state) {
                continue;
            }
            if (element.config.value ("perUser", true)) {
                continue; // This occurrence kept its own, per-VU counter.
            }
            counters_[element.id] = std::make_unique<Counters> ();
        }
    }
}

SharedThroughputCounters::Counters* SharedThroughputCounters::find (
const std::string& element_id) {
    const auto found = counters_.find (element_id);
    return found == counters_.end () ? nullptr : found->second.get ();
}

void fold_between_wait_into_open_transactions (const std::vector<CompiledElement>& elements,
const std::unordered_map<std::string, ElementSpan>& spans,
size_t step_index,
size_t iteration,
int64_t wait_ms,
std::unordered_map<std::string, int64_t>& controller_state) {
    const auto& registry = Registry::instance ();
    for (const auto& compiled : elements) {
        const auto* kind = registry.find (compiled.kind);
        if (kind == nullptr || kind->category != "transaction" ||
        !compiled.config.value ("includeTimers", false)) {
            continue;
        }
        const auto span = spans.find (compiled.id);
        if (span == spans.end () || span->second.last == step_index) {
            continue; // Unspanned, or this occurrence already closed it.
        }
        controller_state[transaction_sum_key (compiled.id, iteration)] += wait_ms;
    }
}

SharedPacingClocks::SharedPacingClocks (const std::vector<std::string>& names) {
    for (const auto& name : names) {
        index_of_id_.try_emplace (name, index_of_id_.size ());
    }
    // Sized exactly once, from the count just discovered above - growing a
    // `vector<atomic<...>>` afterwards would need to move-construct an
    // atomic, which is neither copyable nor movable.
    clocks_ = std::vector<std::atomic<int64_t>> (index_of_id_.size ());
    for (auto& clock : clocks_) {
        clock.store (0, std::memory_order_relaxed);
    }
}

int64_t SharedPacingClocks::advance (const std::string& name, int64_t every_ms, int64_t now_ms) {
    const auto found = index_of_id_.find (name);
    if (found == index_of_id_.end ()) {
        return 0;
    }
    std::atomic<int64_t>& clock = clocks_[found->second];
    int64_t prev                = clock.load (std::memory_order_relaxed);
    int64_t deadline            = 0;
    do {
        deadline = prev <= 0 ? now_ms : prev + every_ms;
    } while (!clock.compare_exchange_weak (
    prev, deadline, std::memory_order_relaxed, std::memory_order_relaxed));
    return std::max<int64_t> (0, deadline - now_ms);
}

SharedThroughputBudgets::SharedThroughputBudgets (const std::vector<std::string>& names) {
    for (const auto& name : names) {
        index_of_id_.try_emplace (name, index_of_id_.size ());
    }
    // Sized exactly once, from the count just discovered - a `std::mutex` is
    // neither copyable nor movable, so this vector can never be grown.
    budgets_ = std::vector<Budget> (index_of_id_.size ());
}

int64_t SharedThroughputBudgets::claim (const std::string& name, double target_rps, int64_t now_ms) {
    const auto found = index_of_id_.find (name);
    if (found == index_of_id_.end () || !(target_rps > 0.0)) {
        return 0;
    }
    Budget& budget = budgets_[found->second];
    const std::lock_guard<std::mutex> guard (budget.lock);

    if (budget.last_tick_ms == 0) {
        budget.last_tick_ms = now_ms;
    } else if (now_ms > budget.last_tick_ms) {
        budget.balance +=
        target_rps * (static_cast<double> (now_ms - budget.last_tick_ms) / 1000.0);
        budget.last_tick_ms = now_ms;
    }

    // At most one slot survives a stretch with no claims: a run that idled
    // resumes at its rate rather than releasing everything it "saved up" at
    // once, which is the burst this kind exists to prevent.
    budget.balance = std::min (budget.balance, 1.0);
    budget.balance -= 1.0;
    // A balance this close to zero is a slot the accrual paid for, arrived at
    // through a rate that does not divide the elapsed time evenly - releasing
    // it now rather than charging a rounded-up millisecond for a billionth of
    // a slot is what keeps the rate exact over a long run.
    constexpr double kSettledSlot = 1e-9;
    if (budget.balance >= -kSettledSlot) {
        return 0;
    }
    // The fraction is carried, never rounded away: the wait is computed from
    // the whole outstanding balance each time, so a rate that does not divide
    // a millisecond evenly stays on rate instead of drifting one rounding
    // error per slot. Milliseconds first, then the rate: an exact balance
    // over an exact rate then divides exactly (3 slots at 10/s is 300ms, not
    // 300.00000000000006 rounded up to 301).
    return static_cast<int64_t> (std::ceil ((-budget.balance * 1000.0) / target_rps));
}

nlohmann::json ElementOutcome::to_json () const {
    nlohmann::json node;
    node["id"]      = id;
    node["kind"]    = kind;
    node["origin"]  = origin;
    node["outcome"] = status;
    if (message) {
        node["message"] = *message;
    }
    if (waited_ms) {
        node["waitedMs"] = *waited_ms;
    }
    if (wrote) {
        node["wrote"] = *wrote;
    }
    return node;
}

nlohmann::json build_lifecycle_node (const std::vector<ElementOutcome>& run_start,
const std::vector<ElementOutcome>& run_end) {
    nlohmann::json node = nlohmann::json::object ();
    if (!run_start.empty ()) {
        nlohmann::json setup = nlohmann::json::array ();
        for (const auto& outcome : run_start) {
            setup.push_back (outcome.to_json ());
        }
        node["setup"] = std::move (setup);
    }
    if (!run_end.empty ()) {
        nlohmann::json teardown = nlohmann::json::array ();
        for (const auto& outcome : run_end) {
            teardown.push_back (outcome.to_json ());
        }
        node["teardown"] = std::move (teardown);
    }
    return node;
}

std::vector<CompiledElement> compile_elements (const nlohmann::json& elements) {
    std::vector<CompiledElement> compiled;
    if (!elements.is_array ()) {
        return compiled;
    }
    compiled.reserve (elements.size ());

    const auto& registry = Registry::instance ();
    for (const auto& entry : elements) {
        CompiledElement out;
        out.id      = entry.value ("id", "");
        out.kind    = entry.value ("kind", "");
        out.origin  = entry.value ("origin", nlohmann::json::object ());
        out.config  = entry.value ("config", nlohmann::json::object ());
        out.enabled = !entry.contains ("enabled") ||
        entry["enabled"].is_null () || entry.value ("enabled", true);

        if (const auto* kind = registry.find (out.kind); kind != nullptr && kind->compile) {
            // Stamped onto a *copy* passed to `compile`, never onto
            // `out.config` itself - `out.config` is what the load path's
            // deferred `script.post` replay reads back verbatim
            // (`run_manager.cpp`), which must stay exactly what the caller
            // wrote. `timer.pacing` (issue #1498) is the one kind that reads
            // `_elementId`, to key its per-node "last started" state by the
            // same id `scenario_plan.cpp` also stamped `_scopeEntry` onto.
            nlohmann::json compile_config = out.config;
            compile_config["_elementId"]  = out.id;
            out.element                   = kind->compile (compile_config);
        }
        compiled.push_back (std::move (out));
    }
    return compiled;
}

std::optional<int64_t> apply_timers_override (const TimersOverride* override_,
int64_t own_wait_ms,
std::mt19937_64* rng) {
    if (override_ == nullptr) {
        return own_wait_ms;
    }
    switch (override_->mode) {
    case TimersOverride::Mode::AsConfigured: return own_wait_ms;
    case TimersOverride::Mode::Off: return std::nullopt;
    case TimersOverride::Mode::Fixed: return override_->fixed_ms;
    case TimersOverride::Mode::Range: {
        int64_t min_ms = override_->min_ms;
        int64_t max_ms = override_->max_ms;
        if (max_ms < min_ms) {
            std::swap (min_ms, max_ms);
        }
        if (max_ms == min_ms) {
            return min_ms;
        }
        std::uniform_int_distribution<int64_t> dist (min_ms, max_ms);
        if (rng != nullptr) {
            return dist (*rng);
        }
        static thread_local std::mt19937_64 fallback{ std::random_device{}() };
        return dist (fallback);
    }
    }
    return own_wait_ms; // Unreachable for a value the enum actually holds.
}

const nlohmann::json* ensure_parsed_body (ElementContext& ctx) {
    if (ctx.response == nullptr) {
        return nullptr;
    }
    if (!ctx.body_parse_attempted) {
        ctx.body_parse_attempted = true;
        if (ctx.response->body.size () <= ctx.max_body_bytes) {
            auto parsed = nlohmann::json::parse (
            ctx.response->body, nullptr, /*allow_exceptions=*/false);
            if (!parsed.is_discarded ()) {
                ctx.parsed_body = std::move (parsed);
            }
        }
    }
    return ctx.parsed_body ? &*ctx.parsed_body : nullptr;
}

void ElementPipeline::run (Phase phase,
ElementContext& ctx,
const std::vector<CompiledElement>& elements,
std::vector<ElementOutcome>& sink,
const std::function<std::optional<std::string> (const CompiledElement&)>& skip_reason) {
    for (const auto& compiled : elements) {
        if (!compiled.element || compiled.element->phase () != phase) {
            continue;
        }

        ctx.outcome_status = "ok";
        ctx.outcome_message.reset ();
        ctx.outcome_waited_ms.reset ();
        ctx.outcome_wrote.reset ();
        ctx.element_id = compiled.id;

        std::optional<std::string> skipped;
        if (!compiled.enabled) {
            skipped = "disabled";
        } else if (skip_reason) {
            skipped = skip_reason (compiled);
        }

        if (skipped) {
            ctx.outcome_status  = "skipped";
            ctx.outcome_message = skipped;
        } else {
            try {
                compiled.element->apply (ctx);
            } catch (const std::exception& e) {
                ctx.outcome_status  = "error";
                ctx.outcome_message = e.what ();
            }
        }

        sink.push_back (ElementOutcome{
        compiled.id,
        compiled.kind,
        compiled.origin,
        ctx.outcome_status,
        ctx.outcome_message,
        ctx.outcome_waited_ms,
        ctx.outcome_wrote,
        });
    }
}

} // namespace vayu::core
