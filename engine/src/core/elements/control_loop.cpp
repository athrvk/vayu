/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file control_loop.cpp
 * @brief `control.loop` (issue #1515): walks a folder's members `count`
 *        times per iteration.
 *
 * Runs in `step.between`, after this step's own outcome is decided and
 * before flow control reads it - the same seam `timer.think` uses, so a
 * loop-back never counts against the step it follows. `control.loop`
 * inherits into every member of the folder it sits on and compiles once per
 * member, so only the folder's *last* member (`ElementContext::step_position
 * == element_spans->at(element_id).last`, issue #1515's `needs_span`) ever
 * decides anything; every other member's own occurrence is a no-op. The
 * decision itself is an ordinary `Next` (`vayu::ScriptControl::Kind::Next`,
 * `first_step_name` from the same span), read back by
 * `scenario_runner.cpp::run_iteration` and resolved by the very
 * `resolve_next_step` a script's own `pm.execution.setNextRequest` already
 * goes through - a loop-back is not a second flow-control mechanism.
 *
 * Sequential-run only: the load path's virtual users advance through the
 * plan strictly forward (`VirtualUser::step`), with no jump the way a
 * script-driven `setNextRequest` or this element's own `Next` needs, so a
 * scenario load run refuses a plan carrying `control.loop`
 * (`vayu::core::find_load_incompatible_controller`, `scenario_load.cpp`)
 * rather than silently running the folder once per iteration and ignoring
 * `count`.
 */

#include "vayu/core/elements.hpp"

namespace vayu::core {

namespace {

class ControlLoopElement final : public Element {
    public:
    explicit ControlLoopElement (nlohmann::json config)
    : config_ (std::move (config)) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepBetween;
    }

    void apply (ElementContext& ctx) override {
        if (ctx.element_spans == nullptr || !ctx.step_position) {
            ctx.outcome_status = "ok"; // no folder to walk - nothing to repeat.
            return;
        }
        const auto found = ctx.element_spans->find (ctx.element_id);
        if (found == ctx.element_spans->end () ||
        *ctx.step_position != found->second.last) {
            ctx.outcome_status = "ok"; // not this folder's last member yet.
            return;
        }

        const int64_t configured_count = config_.value ("count", int64_t{ 1 });
        const std::string pass_key = ctx.element_id + "#" + std::to_string (ctx.iteration);
        if (ctx.controller_state == nullptr) {
            ctx.outcome_status = "ok";
            return;
        }
        auto& passes = (*ctx.controller_state)[pass_key];
        ++passes;
        if (passes < configured_count) {
            ctx.pre_script_result.control.kind = vayu::ScriptControl::Kind::Next;
            ctx.pre_script_result.control.target = found->second.first_step_name;
            ctx.outcome_status  = "ok";
            ctx.outcome_message = "loop pass " + std::to_string (passes + 1) +
            " of " + std::to_string (configured_count);
        } else {
            ctx.controller_state->erase (pass_key);
            ctx.outcome_status  = "ok";
            ctx.outcome_message = "loop complete";
        }
    }

    private:
    nlohmann::json config_;
};

} // namespace

ElementKind make_control_loop_kind () {
    ElementKind kind;
    kind.kind    = "control.loop";
    kind.version = 1;
    kind.phases  = { Phase::StepBetween };
    kind.label   = "Loop";
    kind.description =
    "Walks a folder's members a fixed number of times per iteration.";
    kind.category         = "controller";
    kind.hot_path         = HotPathClass::Declarative;
    kind.needs_span       = true;
    kind.jumps_or_repeats = true;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ControlLoopElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties", { { "count", { { "type", "integer" }, { "minimum", 1 } } } } },
        { "required", { "count" } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
