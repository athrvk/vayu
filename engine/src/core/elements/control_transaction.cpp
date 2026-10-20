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
 * latency, in microseconds (#2387: whole milliseconds dropped a fast
 * member entirely), to a running sum kept in
 * `ElementContext::controller_state` under `transaction_sum_key`, which folds
 * in this element's `id` and the current `iteration` so a later iteration -
 * or, under a run that never reaches this folder's last member, an abandoned
 * one - never adds onto a stale total. Only the folder's *last* member
 * (`step_position == element_spans->at(element_id).last`) closes the sum:
 * that occurrence alone sets `ElementOutcome::duration_us` to the whole
 * transaction and `message` to its declared `name`, which is what
 * `scenario_runner.cpp` / `scenario_load.cpp` read to record it into the
 * run's `TransactionHistograms`. The close also sets `waited_ms` to the sum
 * rounded to whole milliseconds, for the step trace's `waitedMs`; no runner
 * reads it as a transaction, because timers report their waits there too.
 *
 * `includeTimers` (issue #1569) folds a between-member `timer.*` wait into
 * the same sum key: the fold is the caller's
 * (`fold_between_wait_into_open_transactions`, called from both run modes'
 * `step.between` dispatch), found through the registry's `category` rather
 * than a `kind ==` comparison outside `core/elements` (#1512's
 * extensibility contract, rule 1), and skipped for the folder's *last*
 * member, whose sum has already closed by the time any wait after it runs.
 */

#include "vayu/core/elements.hpp"

#include <algorithm>
#include <cmath>

namespace vayu::core {

namespace {

/// One member's share of the sum: rounded to the nearest microsecond, and a
/// negative or NaN timing counts as zero.
int64_t member_duration_us (const vayu::Response& response) {
    return std::llround (std::max (0.0, response.timing.total_ms) * 1000.0);
}

void report_close (ElementContext& ctx, const std::string& name, int64_t duration_us, bool errored) {
    ctx.outcome_status      = errored ? "failed" : "ok";
    ctx.outcome_duration_us = duration_us;
    // Rounded, not floored: the trace's `waitedMs` should agree with the
    // recorded duration. `duration_us` is never negative.
    ctx.outcome_waited_ms = (duration_us + 500) / 1000;
    ctx.outcome_message   = name;
}

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
            report_close (ctx, name, member_duration_us (*ctx.response),
            ctx.response->has_error ());
            return;
        }

        const std::string sum_key = transaction_sum_key (ctx.element_id, ctx.iteration);
        const std::string error_key =
        ctx.element_id + "#" + std::to_string (ctx.iteration) + "#err";
        auto& sum = (*ctx.controller_state)[sum_key];
        sum += member_duration_us (*ctx.response);
        if (ctx.response->has_error ()) {
            (*ctx.controller_state)[error_key] = 1;
        }

        if (position != last) {
            ctx.outcome_status = "ok"; // accumulating - not this pass's close.
            return;
        }

        report_close (ctx, name, sum, (*ctx.controller_state)[error_key] != 0);
        ctx.controller_state->erase (sum_key);
        ctx.controller_state->erase (error_key);
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
        { { "name",
          { { "type", "string" }, { "minLength", 1 }, { "title", "Transaction name" },
          { "description", "The name this folder's summed latency is reported under." } } },
        { "includeTimers",
        { { "type", "boolean" }, { "title", "Include timers" },
        { "description",
        "Folds a between-member timer wait into the transaction's "
        "summed time." } } } } },
        { "required", { "name" } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
