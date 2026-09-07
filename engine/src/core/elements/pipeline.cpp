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
            out.element = kind->compile (out.config);
        }
        compiled.push_back (std::move (out));
    }
    return compiled;
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
