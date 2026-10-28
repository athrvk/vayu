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
 * or an abandoned one - never adds onto a stale total.
 *
 * The element never closes the sum itself in a run: a skipped member never
 * reaches `step.after`, and a member's failed assertion is decided by kinds
 * that may run after this one. Both runners call `settle_transactions` once a
 * step's outcome and the iteration's next position are known (#3054), and
 * that close is what they record into `TransactionHistograms`. A design send
 * has no accumulator, so there this one response is the whole transaction.
 *
 * `includeTimers` (issue #1569) folds a between-member `timer.*` wait into
 * the same sum key: the fold is the caller's
 * (`fold_between_wait_into_open_transactions`, called from both run modes'
 * `step.between` dispatch), found through the registry's `category` rather
 * than a `kind ==` comparison outside `core/elements` (#1512's
 * extensibility contract, rule 1).
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

/// A close's `waited_ms`: rounded, not floored, so the trace's `waitedMs`
/// agrees with the recorded duration. `duration_us` is never negative.
int64_t whole_ms (int64_t duration_us) {
    return (duration_us + 500) / 1000;
}

void report_close (ElementContext& ctx, const std::string& name, int64_t duration_us, bool errored) {
    ctx.outcome_status      = errored ? "failed" : "ok";
    ctx.outcome_duration_us = duration_us;
    ctx.outcome_waited_ms   = whole_ms (duration_us);
    ctx.outcome_message     = name;
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
        if (ctx.controller_state == nullptr) {
            // No accumulator to fold into (a design send) - this one
            // response is the whole transaction.
            report_close (ctx, config_.value ("name", ""),
            member_duration_us (*ctx.response), ctx.response->has_error ());
            return;
        }
        (*ctx.controller_state)[transaction_sum_key (ctx.element_id, ctx.iteration)] +=
        member_duration_us (*ctx.response);
    }

    private:
    nlohmann::json config_;
};

bool is_transaction (const Registry& registry, const CompiledElement& compiled) {
    if (!compiled.enabled || !compiled.element) {
        return false;
    }
    const auto* kind = registry.find (compiled.kind);
    return kind != nullptr && kind->category == "transaction";
}

/// Whether the iteration leaves @p span after @p member: the folder's last
/// member always ends a pass, even when `control.loop` walks it again.
bool leaves_span (const ElementSpan& span, const TransactionMember& member) {
    if (member.step_index == span.last || !member.next_position) {
        return true;
    }
    return *member.next_position < span.first || *member.next_position > span.last;
}

/// The close, written onto this step's own outcome for @p compiled when its
/// `step.after` ran, or appended when it did not.
void write_close (const CompiledElement& compiled,
int64_t duration_us,
bool errored,
std::vector<ElementOutcome>& outcomes) {
    auto own = std::find_if (
    outcomes.begin (), outcomes.end (), [&] (const ElementOutcome& outcome) {
        return outcome.id == compiled.id && outcome.kind == compiled.kind;
    });
    if (own == outcomes.end ()) {
        ElementOutcome appended;
        appended.id     = compiled.id;
        appended.kind   = compiled.kind;
        appended.origin = compiled.origin;
        outcomes.push_back (std::move (appended));
        own = std::prev (outcomes.end ());
    }
    ElementOutcome& close = *own;
    close.status          = errored ? "failed" : "ok";
    close.message         = compiled.config.value ("name", "");
    close.duration_us     = duration_us;
    close.waited_ms       = whole_ms (duration_us);
}

} // namespace

void settle_transactions (const std::vector<CompiledElement>& elements,
const std::unordered_map<std::string, ElementSpan>& spans,
const TransactionMember& member,
std::unordered_map<std::string, int64_t>& controller_state,
std::vector<ElementOutcome>& outcomes) {
    const auto& registry = Registry::instance ();
    for (const auto& compiled : elements) {
        if (!is_transaction (registry, compiled)) {
            continue;
        }
        const auto span = spans.find (compiled.id);
        if (span == spans.end ()) {
            continue;
        }
        const std::string sum_key = transaction_sum_key (compiled.id, member.iteration);
        const std::string error_key = transaction_error_key (compiled.id, member.iteration);
        if (member.attempted) {
            // A member that failed before `step.after` added no time, but
            // it still opens the pass it belongs to.
            controller_state.try_emplace (sum_key, 0);
            if (member.errored) {
                controller_state[error_key] = 1;
            }
        }
        if (!leaves_span (span->second, member)) {
            continue;
        }
        const auto sum = controller_state.find (sum_key);
        if (sum == controller_state.end ()) {
            continue; // No member of this pass was attempted.
        }
        const int64_t duration_us = sum->second;
        controller_state.erase (sum);
        const bool errored = controller_state.erase (error_key) > 0;
        write_close (compiled, duration_us, errored, outcomes);
    }
}

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
