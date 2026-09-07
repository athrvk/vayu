/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file script_kinds.cpp
 * @brief `script.pre` / `script.post` (issue #1513's registration, issue
 *        #1514's `compile` / `apply`).
 *
 * `apply` never runs the script itself - it calls back into
 * `ElementContext::run_pre_script` / `run_post_script`, which the caller
 * (`execute_exchange`) binds to the exact `execute_script` call design mode
 * has always made. That keeps `ScriptEngine`, `ScriptContext` and the cookie-
 * write staging entirely out of `core/elements`, which knows nothing about
 * scripting beyond `vayu::ScriptResult`'s shape. The element's own outcome is
 * about whether the script ran without throwing; a script's own `pm.test`
 * assertions travel inside that same `ScriptResult` untouched, exactly as
 * they always have.
 */

#include "vayu/core/elements.hpp"

namespace vayu::core {

namespace {

class ScriptPreElement final : public Element {
    public:
    explicit ScriptPreElement (const nlohmann::json& config)
    : script_ (config.value ("script", "")) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepBefore;
    }

    void apply (ElementContext& ctx) override {
        if (!ctx.run_pre_script) {
            ctx.outcome_status  = "error";
            ctx.outcome_message = "no pre-request script runner bound";
            return;
        }
        ctx.pre_script_result = ctx.run_pre_script (script_);
        ctx.outcome_status    = ctx.pre_script_result.success ? "ok" : "error";
        if (!ctx.pre_script_result.success) {
            ctx.outcome_message = ctx.pre_script_result.error_message;
        }
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
        if (!ctx.run_post_script) {
            ctx.outcome_status  = "error";
            ctx.outcome_message = "no post-request script runner bound";
            return;
        }
        ctx.post_script_result = ctx.run_post_script (script_);
        ctx.outcome_status = ctx.post_script_result.success ? "ok" : "error";
        if (!ctx.post_script_result.success) {
            ctx.outcome_message = ctx.post_script_result.error_message;
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
        { "properties", { { "script", { { "type", "string" } } } } },
        { "required", nlohmann::json::array ({ "script" }) },
        { "additionalProperties", false },
    };
    return element_kind;
}

} // namespace

ElementKind make_script_pre_kind () {
    auto kind = make_script_kind (Phase::StepBefore, "script.pre",
    "Pre-request script", "Runs before the request is sent.");
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ScriptPreElement> (config);
    };
    return kind;
}

ElementKind make_script_post_kind () {
    auto kind = make_script_kind (Phase::StepAfter, "script.post",
    "Post-request script", "Runs after the response is received.");
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ScriptPostElement> (config);
    };
    return kind;
}

} // namespace vayu::core
