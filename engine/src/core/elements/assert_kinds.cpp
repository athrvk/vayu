/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file assert_kinds.cpp
 * @brief `assert.status`, `assert.jsonpath`, `assert.contains`,
 *        `assert.duration`, `assert.size` (issue #1514).
 *
 * All five run in `step.after` and report through the same channel a `pm.test`
 * call does: one `TestResult` appended to `ElementContext::post_script_result`
 * regardless of the verdict, so `classify_step`'s `describe_failed_tests` and
 * the SSE frame's `tests` tally count a declarative assertion exactly as they
 * count a scripted one (issue #1512's "Outcomes" section) - one mechanism,
 * not two.
 */

#include "vayu/core/elements.hpp"

#include <regex>

#include "json_path.hpp"

namespace vayu::core {

namespace {

void record_assertion (ElementContext& ctx,
const std::string& name,
bool passed,
const std::string& failure_message) {
    ctx.post_script_result.tests.push_back (
    vayu::TestResult{ name, passed, passed ? std::string () : failure_message });
    ctx.outcome_status = passed ? "ok" : "failed";
    if (!passed) {
        ctx.outcome_message = failure_message;
    }
}

std::string json_value_to_string (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    return value.dump ();
}

// ---------------------------------------------------------------------------
// assert.status - `in` (a set of codes) or `range` ({min, max}).
// ---------------------------------------------------------------------------

class AssertStatusElement final : public Element {
    public:
    explicit AssertStatusElement (nlohmann::json config)
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
        const int code = ctx.response->status_code;
        bool passed    = false;
        std::string expected_desc;
        if (config_.contains ("in") && config_["in"].is_array ()) {
            for (const auto& value : config_["in"]) {
                if (value.is_number_integer () && value.get<int> () == code) {
                    passed = true;
                    break;
                }
            }
            expected_desc = "one of " + config_["in"].dump ();
        } else if (config_.contains ("range") && config_["range"].is_object ()) {
            const int min = config_["range"].value ("min", 0);
            const int max = config_["range"].value ("max", 999);
            passed        = code >= min && code <= max;
            expected_desc =
            "in [" + std::to_string (min) + ", " + std::to_string (max) + "]";
        } else {
            ctx.outcome_status = "error";
            ctx.outcome_message =
            "assert.status needs an 'in' list or a 'range'";
            return;
        }
        record_assertion (ctx, "Status code is " + expected_desc, passed,
        "expected status " + expected_desc + ", got " + std::to_string (code));
    }

    private:
    nlohmann::json config_;
};

// ---------------------------------------------------------------------------
// assert.jsonpath - the same subset `extract.json` reads: one of `expected`
// (exact match against the first hit), `regex` (the first hit as text) or
// `exists` (at least one hit); `negate` flips the verdict.
// ---------------------------------------------------------------------------

class AssertJsonPathElement final : public Element {
    public:
    explicit AssertJsonPathElement (nlohmann::json config)
    : config_ (std::move (config)) {
        path_ = detail::parse_json_path (config_.value ("path", ""));
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepAfter;
    }

    void apply (ElementContext& ctx) override {
        if (!path_) {
            ctx.outcome_status  = "error";
            ctx.outcome_message = "invalid JSONPath";
            return;
        }
        const nlohmann::json* body = ensure_parsed_body (ctx);
        if (body == nullptr) {
            ctx.outcome_status = "skipped";
            ctx.outcome_message =
            "response body is not JSON, or exceeds maxElementBodyBytes";
            return;
        }
        const auto matches = detail::evaluate_json_path (*body, *path_);
        const bool negate  = config_.value ("negate", false);
        const std::string path_text = config_.value ("path", "");

        bool passed;
        std::string failure;
        if (config_.contains ("exists")) {
            passed = !matches.empty ();
            failure = "expected '" + path_text + "' to " + (negate ? "not " : "") + "exist";
        } else if (config_.contains ("expected")) {
            const bool found = !matches.empty () && *matches.front () == config_["expected"];
            passed  = found;
            failure = "expected '" + path_text + "' to equal " +
            config_["expected"].dump () +
            (matches.empty () ? " (no match)" :
                                ", got " + json_value_to_string (*matches.front ()));
        } else if (config_.contains ("regex")) {
            bool found = false;
            if (!matches.empty ()) {
                try {
                    const std::regex pattern (config_.value ("regex", ""));
                    found = std::regex_search (
                    json_value_to_string (*matches.front ()), pattern);
                } catch (const std::regex_error& e) {
                    ctx.outcome_status = "error";
                    ctx.outcome_message =
                    std::string ("invalid regular expression: ") + e.what ();
                    return;
                }
            }
            passed  = found;
            failure = "expected '" + path_text + "' to match /" +
            config_.value ("regex", "") + "/";
        } else {
            ctx.outcome_status = "error";
            ctx.outcome_message =
            "assert.jsonpath needs one of 'expected', 'regex' or 'exists'";
            return;
        }

        if (negate) {
            passed = !passed;
        }
        record_assertion (ctx, "JSONPath '" + path_text + "'", passed, failure);
    }

    private:
    nlohmann::json config_;
    std::optional<std::vector<detail::JsonPathStep>> path_;
};

// ---------------------------------------------------------------------------
// assert.contains - `field` (body | headers | url | status), `text`, `mode`
// (contains | equals | matches), `negate`.
// ---------------------------------------------------------------------------

std::string contains_field_text (const ElementContext& ctx, const std::string& field) {
    if (ctx.response == nullptr) {
        return "";
    }
    if (field == "headers") {
        std::string joined;
        for (const auto& [name, value] : ctx.response->headers) {
            if (!joined.empty ()) {
                joined += "\n";
            }
            joined += name;
            joined += ": ";
            joined += value;
        }
        return joined;
    }
    if (field == "url") {
        return ctx.request.url;
    }
    if (field == "status") {
        return std::to_string (ctx.response->status_code);
    }
    return ctx.response->body;
}

class AssertContainsElement final : public Element {
    public:
    explicit AssertContainsElement (nlohmann::json config)
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
        const std::string field   = config_.value ("field", "body");
        const std::string text    = config_.value ("text", "");
        const std::string mode    = config_.value ("mode", "contains");
        const std::string subject = contains_field_text (ctx, field);

        bool passed;
        std::string verb;
        if (mode == "equals") {
            passed = subject == text;
            verb   = "equal";
        } else if (mode == "matches") {
            try {
                passed = std::regex_search (subject, std::regex (text));
            } catch (const std::regex_error& e) {
                ctx.outcome_status = "error";
                ctx.outcome_message =
                std::string ("invalid regular expression: ") + e.what ();
                return;
            }
            verb = "match";
        } else {
            passed = subject.find (text) != std::string::npos;
            verb   = "contain";
        }
        if (config_.value ("negate", false)) {
            passed = !passed;
        }
        record_assertion (ctx,
        field + " " + (config_.value ("negate", false) ? "does not " + verb : verb) +
        " '" + text + "'",
        passed,
        "expected " + field + " to " +
        (config_.value ("negate", false) ? "not " + verb : verb) + " '" + text + "'");
    }

    private:
    nlohmann::json config_;
};

// ---------------------------------------------------------------------------
// assert.duration - `maxMs`.
// ---------------------------------------------------------------------------

class AssertDurationElement final : public Element {
    public:
    explicit AssertDurationElement (nlohmann::json config)
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
        const double max_ms = config_.value ("maxMs", 0.0);
        const double actual = ctx.response->timing.total_ms;
        const bool passed   = actual <= max_ms;
        record_assertion (ctx,
        "Response time under " + std::to_string (static_cast<long> (max_ms)) + "ms", passed,
        "response took " + std::to_string (static_cast<long> (actual)) +
        "ms, expected at most " + std::to_string (static_cast<long> (max_ms)) + "ms");
    }

    private:
    nlohmann::json config_;
};

// ---------------------------------------------------------------------------
// assert.size - `bytes`, `op` (lt | lte | gt | gte | eq).
// ---------------------------------------------------------------------------

class AssertSizeElement final : public Element {
    public:
    explicit AssertSizeElement (nlohmann::json config)
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
        const int64_t bound = config_.value ("bytes", 0);
        const auto actual   = static_cast<int64_t> (ctx.response->body.size ());
        const std::string op = config_.value ("op", "lte");
        bool passed;
        if (op == "lt") {
            passed = actual < bound;
        } else if (op == "gt") {
            passed = actual > bound;
        } else if (op == "gte") {
            passed = actual >= bound;
        } else if (op == "eq") {
            passed = actual == bound;
        } else {
            passed = actual <= bound; // "lte", and the schema's default.
        }
        record_assertion (ctx,
        "Body size " + op + " " + std::to_string (bound) + " bytes", passed,
        "body was " + std::to_string (actual) + " bytes, expected " + op + " " +
        std::to_string (bound));
    }

    private:
    nlohmann::json config_;
};

} // namespace

ElementKind make_assert_status_kind () {
    ElementKind kind;
    kind.kind    = "assert.status";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Assert status code";
    kind.description =
    "Fails the step unless the response status is in a set or a range.";
    kind.category = "assert";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<AssertStatusElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "in", { { "type", "array" }, { "items", { { "type", "integer" } } } } },
        { "range",
        { { "type", "object" },
        { "properties", { { "min", { { "type", "integer" } } }, { "max", { { "type", "integer" } } } } },
        { "required", nlohmann::json::array ({ "min", "max" }) },
        { "additionalProperties", false } } } } },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_assert_jsonpath_kind () {
    ElementKind kind;
    kind.kind    = "assert.jsonpath";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Assert JSON value";
    kind.description =
    "Fails the step unless a JSONPath match exists, equals a value or "
    "matches a regular expression.";
    kind.category = "assert";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<AssertJsonPathElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "path", { { "type", "string" } } }, { "expected", {} },
        { "regex", { { "type", "string" } } }, { "exists", { { "type", "boolean" } } },
        { "negate", { { "type", "boolean" } } } } },
        { "required", nlohmann::json::array ({ "path" }) },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_assert_contains_kind () {
    ElementKind kind;
    kind.kind    = "assert.contains";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Assert text";
    kind.description =
    "Fails the step unless a field contains, equals or matches text.";
    kind.category = "assert";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<AssertContainsElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "field", { { "type", "string" }, { "enum", { "body", "headers", "url", "status" } } } },
        { "text", { { "type", "string" } } },
        { "mode", { { "type", "string" }, { "enum", { "contains", "equals", "matches" } } } },
        { "negate", { { "type", "boolean" } } } } },
        { "required", nlohmann::json::array ({ "text" }) },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_assert_duration_kind () {
    ElementKind kind;
    kind.kind    = "assert.duration";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Assert response time";
    kind.description =
    "Fails the step if the response took longer than a bound.";
    kind.category = "assert";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<AssertDurationElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties", { { "maxMs", { { "type", "number" }, { "minimum", 0 } } } } },
        { "required", nlohmann::json::array ({ "maxMs" }) },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_assert_size_kind () {
    ElementKind kind;
    kind.kind    = "assert.size";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Assert body size";
    kind.description =
    "Fails the step unless the response body size compares as configured.";
    kind.category = "assert";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<AssertSizeElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "bytes", { { "type", "integer" }, { "minimum", 0 } } },
        { "op", { { "type", "string" }, { "enum", { "lt", "lte", "gt", "gte", "eq" } } } } } },
        { "required", nlohmann::json::array ({ "bytes" }) },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
