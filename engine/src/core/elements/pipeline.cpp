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

#include <random>

namespace vayu::core {

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
