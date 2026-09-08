/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file control_transaction.cpp
 * @brief `control.transaction` (issue #1515): one latency histogram per
 *        named transaction, fed from every member of the folder it sits on.
 *
 * Runs in `step.after`, once per member - inherited elements compile once
 * per occurrence, so a folder's several members each carry their own
 * instance rather than sharing one. Every occurrence adds its own response
 * latency to a running sum kept in `ElementContext::controller_state`, keyed
 * by this element's `id` and the current `iteration` (issue #1515's
 * `needs_span`, resolved through `element_spans`) so a later iteration - or,
 * under a run that never reaches this folder's last member, an abandoned one
 * - never adds onto a stale total. Only the folder's *last* member
 * (`step_position == element_spans->at(element_id).last`) closes the sum:
 * that occurrence's `ElementOutcome::waited_ms` carries the transaction's
 * whole elapsed time and `message` carries its declared `name`, which is
 * what `scenario_runner.cpp` / `scenario_load.cpp` read to fold the value
 * into the run's own `TransactionHistograms` - every other occurrence
 * reports `waited_ms` absent, which is what tells the two apart without a
 * second field.
 *
 * `includeTimers` (issue #1569) folds a between-member `timer.*` wait into
 * the running sum too: this element's own `apply` never changes for it -
 * the fold is the caller's, done generically in `scenario_runner.cpp`'s and
 * `scenario_load.cpp`'s own `step.between` dispatch, which reads this
 * element's config by the registry's `category` (never a `kind ==`
 * comparison outside `core/elements`, #1512's extensibility contract, rule
 * 1) and adds the just-completed step's between-phase wait to the same
 * `controller_state` sum key (`transaction_sum_key`) this file already
 * accumulates into - skipped for the folder's *last* member, whose sum has
 * already closed and reported by the time any wait after it could run.
 */

#include "vayu/core/elements.hpp"

#include <algorithm>

namespace vayu::core {

namespace {

class ControlTransactionElement final : public Element {
    public:
    explicit ControlTransactionElement (nlohmann::json config)
    : config_ (std::move (config)) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepAfter;
    }

    void apply (ElementContext& ctx) override {
        if (ctx.response == nullptr) {
            ctx.outcome_status  = "error";
            ctx.outcome_message = "no response";
            return;
        }
        const std::string name = config_.value ("name", "");
        const size_t position  = ctx.step_position.value_or (0);
        size_t last            = position;
        if (ctx.element_spans != nullptr) {
            if (const auto found = ctx.element_spans->find (ctx.element_id);
            found != ctx.element_spans->end ()) {
                last = found->second.last;
            }
        }

        if (ctx.controller_state == nullptr) {
            // No accumulator to fold into (a design send) - this one
            // response is the whole transaction.
            ctx.outcome_status = ctx.response->has_error () ? "failed" : "ok";
            ctx.outcome_waited_ms =
            static_cast<int64_t> (std::max (0.0, ctx.response->timing.total_ms));
            ctx.outcome_message = name;
            return;
        }

        const std::string prefix =
        ctx.element_id + "#" + std::to_string (ctx.iteration) + "#";
        auto& sum = (*ctx.controller_state)[prefix + "sum"];
        sum += static_cast<int64_t> (std::max (0.0, ctx.response->timing.total_ms));
        if (ctx.response->has_error ()) {
            (*ctx.controller_state)[prefix + "err"] = 1;
        }

        if (position != last) {
            ctx.outcome_status = "ok"; // accumulating - not this pass's close.
            return;
        }

        const bool errored    = (*ctx.controller_state)[prefix + "err"] != 0;
        ctx.outcome_status    = errored ? "failed" : "ok";
        ctx.outcome_waited_ms = sum;
        ctx.outcome_message   = name;
        ctx.controller_state->erase (prefix + "sum");
        ctx.controller_state->erase (prefix + "err");
    }

    private:
    nlohmann::json config_;
};

} // namespace

ElementKind make_control_transaction_kind () {
    ElementKind kind;
    kind.kind    = "control.transaction";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Transaction";
    kind.description =
    "Sums a folder's own member latencies into one named transaction, "
    "reported with its own percentiles.";
    // Its own category, distinct from the other five `control.*` kinds
    // (`"controller"`): `TransactionHistograms`' plan scan reads this to
    // find every transaction name without a `kind ==` comparison outside
    // `core/elements` (#1512's extensibility contract, rule 1).
    kind.category   = "transaction";
    kind.hot_path   = HotPathClass::Declarative;
    kind.needs_span = true;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ControlTransactionElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "name", { { "type", "string" }, { "minLength", 1 } } },
        { "includeTimers", { { "type", "boolean" } } } } },
        { "required", { "name" } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
