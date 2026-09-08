/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file controller_kinds.cpp
 * @brief `control.if`, `control.once`, `control.switch`, `control.throughput`
 *        (issue #1515): JMeter-style logic controllers that decide whether
 *        this occurrence sends at all, or which member a folder dispatches
 *        to, never a body parse and never a lock.
 *
 * All four run in `step.before`, reading `ElementContext::pre_script_result`
 * exactly as `execute_exchange`'s own skip check and `decide_next_step`
 * already read a script's `pm.execution.setNextRequest` / `skipRequest` -
 * one flow-control channel, not two. `control.once` and `control.throughput`
 * keep their own count in `ElementContext::controller_state`, keyed by their
 * own `element_id` alone (never folded with `iteration`): both fire at most
 * once *ever* for the user they belong to, not once per iteration.
 */

#include "vayu/core/elements.hpp"

#include <regex>

namespace vayu::core {

namespace {

/// `{{name}} ==/!=/matches value` or `{{name}} exists`, `control.if`'s mini
/// grammar (issue #1515's kind table) - refused at validate by the schema's
/// `pattern`, so `apply` only ever sees a string one of these four splits.
struct ParsedCondition {
    std::string left_template;
    std::string op; // "==" | "!=" | "matches" | "exists"
    std::string right;
};

std::optional<ParsedCondition> parse_condition (const std::string& condition) {
    static const std::regex binary (R"(^\s*(\{\{[^}]+\}\})\s*(==|!=|matches)\s*(.*\S)\s*$)");
    static const std::regex existence (R"(^\s*(\{\{[^}]+\}\})\s*exists\s*$)");
    std::smatch match;
    if (std::regex_match (condition, match, binary)) {
        return ParsedCondition{ match[1].str (), match[2].str (), match[3].str () };
    }
    if (std::regex_match (condition, match, existence)) {
        return ParsedCondition{ match[1].str (), "exists", "" };
    }
    return std::nullopt;
}

bool evaluate_condition (const ParsedCondition& parsed, const std::string& resolved) {
    if (parsed.op == "exists") {
        // A token `resolve_template` could not answer keeps its braces
        // (issue #1009) - still resolved, just to nothing this run knows.
        return !resolved.empty () && resolved.find ("{{") == std::string::npos;
    }
    if (parsed.op == "matches") {
        // `/pattern/` - the same slash-delimited form the config schema's
        // `pattern` requires, so a config that reached here always has both.
        if (parsed.right.size () >= 2 && parsed.right.front () == '/' &&
        parsed.right.back () == '/') {
            try {
                const std::regex pattern (
                parsed.right.substr (1, parsed.right.size () - 2));
                return std::regex_search (resolved, pattern);
            } catch (const std::regex_error&) {
                return false;
            }
        }
        return false;
    }
    // A bare value or a quoted one - either compares as text, matching
    // `resolve_template`'s own output, which is always a string.
    std::string expected = parsed.right;
    if (expected.size () >= 2 && expected.front () == '"' && expected.back () == '"') {
        expected = expected.substr (1, expected.size () - 2);
    }
    return parsed.op == "==" ? resolved == expected : resolved != expected;
}

void mark_skip (ElementContext& ctx, const std::string& reason) {
    ctx.pre_script_result.control.kind = vayu::ScriptControl::Kind::Skip;
    ctx.outcome_status                 = "skipped";
    ctx.outcome_message                = reason;
}

// ---------------------------------------------------------------------------
// control.if
// ---------------------------------------------------------------------------

class ControlIfElement final : public Element {
    public:
    explicit ControlIfElement (nlohmann::json config)
    : config_ (std::move (config)) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepBefore;
    }

    void apply (ElementContext& ctx) override {
        const std::string condition = config_.value ("condition", "");
        const auto parsed           = parse_condition (condition);
        if (!parsed) {
            ctx.outcome_status = "error";
            ctx.outcome_message =
            "condition does not match the supported grammar";
            return;
        }
        const std::string resolved = ctx.resolve_template ?
        ctx.resolve_template (parsed->left_template) :
        parsed->left_template;
        if (!evaluate_condition (*parsed, resolved)) {
            mark_skip (ctx, "condition '" + condition + "' was false");
            return;
        }
        ctx.outcome_status = "ok";
    }

    private:
    nlohmann::json config_;
};

// ---------------------------------------------------------------------------
// control.once - runs on the user's first iteration only.
// ---------------------------------------------------------------------------

class ControlOnceElement final : public Element {
    public:
    [[nodiscard]] Phase phase () const override {
        return Phase::StepBefore;
    }

    void apply (ElementContext& ctx) override {
        if (ctx.controller_state == nullptr) {
            // No state to remember across calls (a design send) - there is
            // no "later" for "once" to distinguish from, so it always runs.
            ctx.outcome_status = "ok";
            return;
        }
        auto& fired = (*ctx.controller_state)[ctx.element_id];
        if (fired != 0) {
            mark_skip (ctx, "already ran on an earlier iteration");
            return;
        }
        fired              = 1;
        ctx.outcome_status = "ok";
    }
};

// ---------------------------------------------------------------------------
// control.switch - dispatches to a named member by a variable's value.
// ---------------------------------------------------------------------------

class ControlSwitchElement final : public Element {
    public:
    explicit ControlSwitchElement (nlohmann::json config)
    : config_ (std::move (config)) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepBefore;
    }

    void apply (ElementContext& ctx) override {
        const std::string variable = config_.value ("variable", "");
        const std::string resolved = ctx.resolve_template ?
        ctx.resolve_template ("{{" + variable + "}}") :
        std::string ();

        std::string target;
        if (config_.contains ("cases") && config_["cases"].is_object () &&
        config_["cases"].contains (resolved)) {
            target = config_["cases"][resolved].get<std::string> ();
        } else if (config_.contains ("default") && config_["default"].is_string ()) {
            target = config_["default"].get<std::string> ();
        } else {
            // No case matched and no default: the issue's own wording is
            // "ends the folder"; without this occurrence's folder boundary
            // (only `needs_span` kinds carry one) the safe, disclosed
            // approximation is to let this member proceed unrouted rather
            // than guess at a boundary nothing here can see.
            ctx.outcome_status = "ok";
            return;
        }
        ctx.pre_script_result.control.kind   = vayu::ScriptControl::Kind::Next;
        ctx.pre_script_result.control.target = target;
        ctx.outcome_status                   = "ok";
        ctx.outcome_message                  = "routed to '" + target + "'";
    }

    private:
    nlohmann::json config_;
};

// ---------------------------------------------------------------------------
// control.throughput - skips on the producer's own counter, no lock.
// ---------------------------------------------------------------------------

class ControlThroughputElement final : public Element {
    public:
    explicit ControlThroughputElement (nlohmann::json config)
    : config_ (std::move (config)) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepBefore;
    }

    void apply (ElementContext& ctx) override {
        if (ctx.controller_state == nullptr) {
            ctx.outcome_status = "ok"; // no counter to keep - never skips.
            return;
        }
        auto& count = (*ctx.controller_state)[ctx.element_id];
        ++count;

        bool run = true;
        if (config_.contains ("everyN")) {
            const int64_t every_n = config_.value ("everyN", int64_t{ 1 });
            run                   = every_n <= 1 || count % every_n == 0;
        } else if (config_.contains ("percent")) {
            // An integer carry, scaled by 1000 so a fractional percentage
            // still accumulates exactly rather than losing precision to a
            // `double` stored through an `int64_t` map - and so the run
            // fires deterministically at the configured rate over many
            // occurrences rather than approximating it with an RNG.
            const int64_t percent_milli =
            static_cast<int64_t> (config_.value ("percent", 100.0) * 1000.0);
            auto& carry = (*ctx.controller_state)[ctx.element_id + "#carry"];
            carry += percent_milli;
            if (carry >= 100000) {
                carry -= 100000;
                run = true;
            } else {
                run = false;
            }
        }

        if (!run) {
            mark_skip (ctx, "throughput budget for this occurrence was spent");
            return;
        }
        ctx.outcome_status = "ok";
    }

    private:
    nlohmann::json config_;
};

} // namespace

ElementKind make_control_if_kind () {
    ElementKind kind;
    kind.kind    = "control.if";
    kind.version = 1;
    kind.phases  = { Phase::StepBefore };
    kind.label   = "If";
    kind.description =
    "Skips this step, or every step of a folder it sits on, when a "
    "condition against a resolved variable is false.";
    kind.category = "controller";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ControlIfElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "condition",
        { { "type", "string" },
        { "pattern", R"(^\s*\{\{[^}]+\}\}\s*(==|!=|matches)\s*\S.*$|^\s*\{\{[^}]+\}\}\s*exists\s*$)" } } } } },
        { "required", { "condition" } },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_control_once_kind () {
    ElementKind kind;
    kind.kind        = "control.once";
    kind.version     = 1;
    kind.phases      = { Phase::StepBefore };
    kind.label       = "Once only";
    kind.description = "Runs on this user's first iteration only.";
    kind.category    = "controller";
    kind.hot_path    = HotPathClass::Declarative;
    kind.compile     = [] (const nlohmann::json&) -> std::unique_ptr<Element> {
        return std::make_unique<ControlOnceElement> ();
    };
    kind.config_schema = {
        { "type", "object" },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_control_switch_kind () {
    ElementKind kind;
    kind.kind    = "control.switch";
    kind.version = 1;
    kind.phases  = { Phase::StepBefore };
    kind.label   = "Switch";
    kind.description =
    "Routes to a named folder member by a variable's resolved value.";
    kind.category         = "controller";
    kind.hot_path         = HotPathClass::Declarative;
    kind.jumps_or_repeats = true;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ControlSwitchElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "variable", { { "type", "string" }, { "minLength", 1 } } },
        { "cases", { { "type", "object" } } }, { "default", { { "type", "string" } } } } },
        { "required", { "variable", "cases" } },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_control_throughput_kind () {
    ElementKind kind;
    kind.kind    = "control.throughput";
    kind.version = 1;
    kind.phases  = { Phase::StepBefore };
    kind.label   = "Throughput";
    kind.description =
    "Runs only a share of this occurrence's calls, by percentage or every "
    "Nth one, decided on the producer's own counter.";
    kind.category = "controller";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ControlThroughputElement> (config);
    };
    // `perUser` (a shared, cross-VU budget) is real follow-up work, not
    // silently dropped: this kind always keeps its counter per user - the
    // sequential run has only one, and a scenario load run keeps one per
    // virtual user - so the schema does not accept a key this build cannot
    // honour. Follow-up: issue #1569.
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "percent", { { "type", "number" }, { "minimum", 0 }, { "maximum", 100 } } },
        { "everyN", { { "type", "integer" }, { "minimum", 1 } } } } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
