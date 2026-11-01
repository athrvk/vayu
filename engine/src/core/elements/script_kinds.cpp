/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file script_kinds.cpp
 * @brief `script.pre` / `script.post` (issue #1513's registration, issue
 *        #1514's `compile` / `apply`), and `script.setup` / `script.teardown`
 *        (issue #1499), the same shape at the run's own boundary instead of a
 *        step's.
 *
 * `apply` never runs the script itself - it calls back into
 * `ElementContext::run_pre_script` / `run_post_script` (or, for the run-level
 * pair, `run_setup_script` / `run_teardown_script`), which the caller
 * (`execute_exchange`, or the run.start/run.end dispatch site) binds to the
 * exact `execute_script` call design mode has always made. That keeps
 * `ScriptEngine`, `ScriptContext` and the cookie-write staging entirely out of
 * `core/elements`, which knows nothing about scripting beyond
 * `vayu::ScriptResult`'s shape. The element's own outcome is about this one
 * script: `error` when it threw, `failed` when it ran and only a `pm.test`
 * assertion did not hold, `ok` otherwise (#2663). The step's verdict is
 * separate - a script's assertions travel inside the step's `ScriptResult`,
 * folded beside every other level's (`fold_script_result`).
 *
 * `script.setup` / `script.teardown` are `collection_only`: run once per run
 * rather than once per step, attaching one to a request would run it once per
 * request that happened to carry it, a question the model has no answer for.
 */

#include "vayu/core/element_defaults.hpp"
#include "vayu/core/elements.hpp"

#include <initializer_list>
#include <vector>

#include "vayu/utils/log_text.hpp"

namespace vayu::core {

bool script_threw (const vayu::ScriptResult& result) {
    return !result.success && !result.error_message.empty ();
}

namespace {

/// A failed test as `name: message`, or its name alone when it gave none.
std::string failed_test_text (const vayu::TestResult& test) {
    if (test.error_message.empty ()) {
        return test.name;
    }
    return test.name + ": " + test.error_message;
}

std::string first_failed_test_text (std::initializer_list<const vayu::ScriptResult*> results) {
    size_t failures = 0;
    std::string first;
    for (const auto* result : results) {
        for (const auto& test : result->tests) {
            if (test.passed) {
                continue;
            }
            ++failures;
            if (first.empty ()) {
                first = failed_test_text (test);
            }
        }
    }
    if (failures == 0) {
        return "";
    }
    if (failures == 1) {
        return "Test failed - " + first;
    }
    return std::to_string (failures) + " tests failed - " + first;
}

} // namespace

std::string describe_failed_tests (const vayu::ScriptResult& result) {
    return first_failed_test_text ({ &result });
}

std::string describe_failed_tests (const vayu::ScriptResult& pre,
const vayu::ScriptResult& post) {
    return first_failed_test_text ({ &pre, &post });
}

namespace {

/**
 * Folds one level's script result into the step's slot (#2522). A step runs
 * a script per level - collection, each folder, the request - into one slot
 * that `assert.*` / `extract.*` and the controllers also write, so each
 * result is added to what is there, never assigned over it: tests and
 * console lines appended in run order and stamped with @p scope, `success`
 * false once any level's is, the first level that threw kept as the error,
 * and `control` replaced only by an instruction (a script that asked for
 * nothing does not cancel a controller's skip).
 */
void fold_script_result (vayu::ScriptResult& slot,
vayu::ScriptResult next,
const std::string& scope) {
    if (script_threw (next) && slot.error_message.empty ()) {
        slot.error_message = std::move (next.error_message);
        slot.error_scope   = scope;
    }
    slot.success = slot.success && next.success;
    for (auto& test : next.tests) {
        test.scope = scope;
        slot.tests.push_back (std::move (test));
    }
    for (auto& entry : next.console_output) {
        entry.scope = scope;
        slot.console_output.push_back (std::move (entry));
    }
    if (next.control.kind != vayu::ScriptControl::Kind::None) {
        slot.control = std::move (next.control);
    }
}

/// What @p result said, for a load run's per-element sample (#3127): the error
/// it threw, each failing test, and every console line, each cut to
/// `MAX_ELEMENT_MESSAGE_BYTES`.
std::vector<ElementMessage> script_messages (const vayu::ScriptResult& result) {
    using Kind = ElementMessage::Kind;
    constexpr size_t MAX_BYTES = constants::script_validation::MAX_ELEMENT_MESSAGE_BYTES;
    std::vector<ElementMessage> messages;
    if (script_threw (result)) {
        messages.push_back ({ Kind::Error, vayu::ConsoleLevel::Log,
        utils::bounded_text (result.error_message, MAX_BYTES) });
    }
    for (const auto& test : result.tests) {
        if (!test.passed) {
            messages.push_back ({ Kind::Test, vayu::ConsoleLevel::Log,
            utils::bounded_text (failed_test_text (test), MAX_BYTES) });
        }
    }
    for (const auto& line : result.console_output) {
        messages.push_back (
        { Kind::Console, line.level, utils::bounded_text (line.message, MAX_BYTES) });
    }
    return messages;
}

/// `script.pre` / `script.post`'s shared `apply`: the element's own outcome
/// is about this one script, the slot about the whole step. A thrown script is
/// `error`; one that ran and failed only assertions is `failed`, with the
/// first failure as its message, because `success` alone cannot tell the two
/// apart (#2663).
void run_step_script (ElementContext& ctx,
const std::function<vayu::ScriptResult (const std::string&)>& runner,
vayu::ScriptResult& slot,
const std::string& script,
const char* unbound_message) {
    if (!runner) {
        ctx.outcome_status  = "error";
        ctx.outcome_message = unbound_message;
        return;
    }
    auto result = runner (script);
    if (script_threw (result)) {
        ctx.outcome_status  = "error";
        ctx.outcome_message = result.error_message;
    } else if (auto failed = describe_failed_tests (result); !failed.empty ()) {
        ctx.outcome_status  = "failed";
        ctx.outcome_message = std::move (failed);
    } else {
        ctx.outcome_status = "ok";
    }
    ctx.outcome_messages = script_messages (result);
    fold_script_result (slot, std::move (result), ctx.element_scope);
}

class ScriptPreElement final : public Element {
    public:
    explicit ScriptPreElement (const nlohmann::json& config)
    : script_ (config.value ("script", "")) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepBefore;
    }

    void apply (ElementContext& ctx) override {
        run_step_script (ctx, ctx.run_pre_script, ctx.pre_script_result,
        script_, "no pre-request script runner bound");
    }

    private:
    std::string script_;
};

class ScriptPostElement final : public Element {
    public:
    explicit ScriptPostElement (const nlohmann::json& config)
    : script_ (config.value ("script", "")) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepAfter;
    }

    void apply (ElementContext& ctx) override {
        run_step_script (ctx, ctx.run_post_script, ctx.post_script_result,
        script_, "no post-request script runner bound");
    }

    private:
    std::string script_;
};

class ScriptSetupElement final : public Element {
    public:
    explicit ScriptSetupElement (const nlohmann::json& config)
    : script_ (config.value ("script", "")) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::RunStart;
    }

    void apply (ElementContext& ctx) override {
        if (!ctx.run_setup_script) {
            ctx.outcome_status  = "error";
            ctx.outcome_message = "no setup script runner bound";
            return;
        }
        auto result        = ctx.run_setup_script (script_);
        ctx.outcome_status = result.success ? "ok" : "error";
        if (!result.success) {
            ctx.outcome_message = result.error_message;
        }
    }

    private:
    std::string script_;
};

class ScriptTeardownElement final : public Element {
    public:
    explicit ScriptTeardownElement (const nlohmann::json& config)
    : script_ (config.value ("script", "")) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::RunEnd;
    }

    void apply (ElementContext& ctx) override {
        if (!ctx.run_teardown_script) {
            ctx.outcome_status  = "error";
            ctx.outcome_message = "no teardown script runner bound";
            return;
        }
        auto result        = ctx.run_teardown_script (script_);
        ctx.outcome_status = result.success ? "ok" : "error";
        if (!result.success) {
            ctx.outcome_message = result.error_message;
        }
    }

    private:
    std::string script_;
};

ElementKind
make_script_kind (Phase phase, const char* kind, const char* label, const char* description) {
    ElementKind element_kind;
    element_kind.kind          = kind;
    element_kind.version       = 1;
    element_kind.phases        = { phase };
    element_kind.label         = label;
    element_kind.description   = description;
    element_kind.category      = "script";
    element_kind.hot_path      = HotPathClass::Script;
    element_kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "script",
        { { "type", "string" }, { "title", "Script" },
        { "description", "The JavaScript source to execute." } } } } },
        { "required", nlohmann::json::array ({ "script" }) },
        { "additionalProperties", false },
    };
    element_kind.writes_variables = true;
    return element_kind;
}

/**
 * `config.inline`, on the two step-level script kinds only (issue #1495,
 * `RunContext::script_element_runs_inline`): a load run reads it to decide
 * whether this script runs on the producer/completion hooks or is left to the
 * deferred replay. The base schema above closes `additionalProperties`, so a
 * kind that does not add it here refuses the marking outright - which is what
 * made the opt-in unreachable through every validated write path there is
 * (`apply_elements_field`, `validate_request_elements_run_override`) until
 * issue #1594 exercised one end to end. `script.setup` / `script.teardown` do
 * not get it: a run-boundary kind has no inline-or-deferred choice to make.
 */
void allow_inline_marking (ElementKind& kind) {
    kind.config_schema["properties"]["inline"] = {
        { "type", "boolean" },
        { "default", element_defaults::SCRIPT_INLINE },
        { "title", "Run inline" },
        { "description",
        "Runs on the load path's own producer/completion hooks instead of "
        "the deferred post-run replay." },
        { "x-vayu-group", "advanced" },
    };
}

} // namespace

bool is_blank_script_text (const std::string& text) {
    return text.find_first_not_of (" \t\r\n") == std::string::npos;
}

bool is_blank_script_element (const std::string& kind, const nlohmann::json& config) {
    if (kind != "script.pre" && kind != "script.post" &&
    kind != "script.setup" && kind != "script.teardown") {
        return false;
    }
    return is_blank_script_text (config.value ("script", ""));
}

ElementKind make_script_pre_kind () {
    auto kind = make_script_kind (Phase::StepBefore, "script.pre", "Pre-request script",
    "Runs before the request is sent, with the pm API. Edits to pm.request "
    "change what is actually sent. Under a load test it runs only when Run "
    "inline is on.");
    allow_inline_marking (kind);
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ScriptPreElement> (config);
    };
    return kind;
}

ElementKind make_script_post_kind () {
    auto kind = make_script_kind (Phase::StepAfter, "script.post", "Post-request script",
    "Runs after the response is received. Use pm.test() for assertions: "
    "pm.response.to asserts about the response itself, pm.expect asserts "
    "about any value handed to it.");
    allow_inline_marking (kind);
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ScriptPostElement> (config);
    };
    return kind;
}

ElementKind make_script_setup_kind () {
    auto kind            = make_script_kind (Phase::RunStart, "script.setup",
    "Setup script", "Runs once, on a collection, before the run starts.");
    kind.collection_only = true;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ScriptSetupElement> (config);
    };
    return kind;
}

ElementKind make_script_teardown_kind () {
    auto kind            = make_script_kind (Phase::RunEnd, "script.teardown",
    "Teardown script", "Runs once, on a collection, after the run ends.");
    kind.collection_only = true;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ScriptTeardownElement> (config);
    };
    return kind;
}

} // namespace vayu::core
