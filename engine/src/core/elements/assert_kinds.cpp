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

#include <expected>
#include <format>

#include "json_path.hpp"
#include "user_regex.hpp"

namespace vayu::core {

namespace {

void record_assertion (ElementContext& ctx,
const std::string& name,
bool passed,
const std::string& failure_message) {
    ctx.post_script_result.tests.push_back (vayu::TestResult{ name, passed,
    passed ? std::string () : failure_message, ctx.element_scope });
    ctx.outcome_status = passed ? "ok" : "failed";
    if (!passed) {
        ctx.outcome_message = failure_message;
    }
}

/// An assertion whose own config leaves it nothing to judge (#3043), a row
/// stored before validation refused it: the outcome stays `error`, and the
/// failed test beside it is what fails the step and enters every assertion
/// count, all of which read the `tests` list alone.
void record_unrunnable_assertion (ElementContext& ctx,
const std::string& name,
const std::string& reason) {
    ctx.post_script_result.tests.push_back (
    vayu::TestResult{ name, false, reason, ctx.element_scope });
    ctx.outcome_status  = "error";
    ctx.outcome_message = reason;
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
        // An empty `in` is no operand (validate refuses it): a stored row that
        // pairs one with a `range` is judged by the range, not by "one of []".
        if (config_.contains ("in") && config_["in"].is_array () &&
        !config_["in"].empty ()) {
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
            record_unrunnable_assertion (
            ctx, "Status code", "assert.status needs an 'in' list or a 'range'");
            return;
        }
        record_assertion (ctx, "Status code is " + expected_desc, passed,
        "expected status " + expected_desc + ", got " + std::to_string (code));
    }

    private:
    nlohmann::json config_;
};

/// A config's user pattern, compiled when the element is built: absent when
/// the config does not ask for one, the reason when RE2 refuses it.
using OptionalUserRegex = std::optional<std::expected<UserRegex, std::string>>;

// ---------------------------------------------------------------------------
// assert.jsonpath - the same subset `extract.json` reads: one of `expected`
// (exact match against the first hit), `regex` (the first hit as text) or
// `exists` (true: at least one hit, false: none); `negate` flips the verdict
// (so `exists: false` with `negate` wants a hit), except that a body that
// cannot be read always fails.
// ---------------------------------------------------------------------------

/// A string member, or "" when it is absent or not a string: read in a
/// constructor, where an exception would escape `compile_elements` instead of
/// becoming the element's own "error" outcome, and in a validate hook, which
/// must answer a refusal rather than throw one.
std::string string_member (const nlohmann::json& config, const char* key) {
    const auto found = config.find (key);
    return found != config.end () && found->is_string () ? found->get<std::string> () : "";
}

class AssertJsonPathElement final : public Element {
    public:
    explicit AssertJsonPathElement (nlohmann::json config)
    : config_ (std::move (config)) {
        path_ = detail::parse_json_path (config_.value ("path", ""));
        if (config_.contains ("regex")) {
            regex_ = compile_user_regex (string_member (config_, "regex"));
        }
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepAfter;
    }

    void apply (ElementContext& ctx) override {
        const std::string path_text = config_.value ("path", "");
        const std::string name      = "JSONPath '" + path_text + "'";
        if (!path_) {
            record_unrunnable_assertion (ctx, name, "invalid JSONPath");
            return;
        }
        const nlohmann::ordered_json* body = ensure_parsed_body (ctx);
        if (body == nullptr) {
            // Recorded before `negate` is read: a body nothing can be read
            // from satisfies neither "exists" nor "does not exist".
            record_assertion (ctx, name, false,
            std::string (constants::elements::BODY_UNREADABLE_MESSAGE));
            return;
        }
        const auto matches = detail::evaluate_json_path (*body, *path_);
        const bool negate  = config_.value ("negate", false);

        if (config_.contains ("exists")) {
            // `exists` already says which way it asserts, so `negate` folds
            // into the wanted answer rather than flipping the verdict after.
            const bool want_present = config_["exists"].get<bool> () != negate;
            record_assertion (ctx, name, want_present == !matches.empty (),
            "expected '" + path_text + "' to " + (want_present ? "" : "not ") + "exist");
            return;
        }

        const std::string not_prefix = negate ? "not " : "";
        bool passed;
        std::string failure;
        if (config_.contains ("expected")) {
            // Converted first: `ordered_json` object equality is
            // order-sensitive, and `expected` is not compared by key order.
            passed = !matches.empty () &&
            nlohmann::json (*matches.front ()) == config_["expected"];
            failure = "expected '" + path_text + "' to " + not_prefix +
            "equal " + config_["expected"].dump ();
            if (!negate) {
                failure += matches.empty () ?
                " (no match)" :
                ", got " + detail::json_value_to_string (*matches.front ());
            }
        } else if (const auto& regex = regex_) {
            if (!*regex) {
                record_unrunnable_assertion (ctx, name, regex->error ());
                return;
            }
            passed = !matches.empty () &&
            (*regex)->search (detail::json_value_to_string (*matches.front ()));
            failure = "expected '" + path_text + "' to " + not_prefix +
            "match /" + config_.value ("regex", "") + "/";
        } else {
            record_unrunnable_assertion (ctx, name,
            "assert.jsonpath needs one of 'expected', 'regex' or 'exists'");
            return;
        }

        if (negate) {
            passed = !passed;
        }
        record_assertion (ctx, name, passed, failure);
    }

    private:
    nlohmann::json config_;
    std::optional<std::vector<detail::JsonPathStep>> path_;
    OptionalUserRegex regex_;
};

// ---------------------------------------------------------------------------
// assert.contains - `field` (body | headers | url | status), `text`, `mode`
// (contains | equals | matches), `negate`.
// ---------------------------------------------------------------------------

class AssertContainsElement final : public Element {
    public:
    explicit AssertContainsElement (nlohmann::json config)
    : config_ (std::move (config)) {
        if (string_member (config_, "mode") == "matches") {
            pattern_ = compile_user_regex (string_member (config_, "text"));
        }
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
        const std::string field = config_.value ("field", "body");
        const std::string text  = config_.value ("text", "");
        const std::string mode  = config_.value ("mode", "contains");
        std::string storage;
        const std::string_view subject = response_field_text (ctx, field, storage);

        bool passed;
        std::string verb;
        if (mode == "equals") {
            passed = subject == text;
            verb   = "equal";
        } else if (const auto& pattern = pattern_) {
            if (!*pattern) {
                record_unrunnable_assertion (
                ctx, field + " matches '" + text + "'", pattern->error ());
                return;
            }
            passed = (*pattern)->search (subject);
            verb   = "match";
        } else {
            passed = subject.find (text) != std::string_view::npos;
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
    OptionalUserRegex pattern_;
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

// ---------------------------------------------------------------------------
// The validate-time rules the schemas cannot state (#3043): an assertion that
// would only ever report `error` is refused when it is written.
// ---------------------------------------------------------------------------

/// An empty `in` is no operand: no status is one of nothing.
std::optional<std::string> assert_status_problem (const nlohmann::json& config) {
    const auto codes = config.find ("in");
    if ((codes != config.end () && codes->is_array () && !codes->empty ()) ||
    config.contains ("range")) {
        return std::nullopt;
    }
    return "'in' or 'range' is required - list at least one accepted status "
           "code, or give a range";
}

/// `exists` asserts presence or absence and `expected` / `regex` assert the
/// value, so a config naming both would have one of them silently ignored.
std::optional<std::string> exists_with_value_problem (const nlohmann::json& config) {
    if (!config.contains ("exists")) {
        return std::nullopt;
    }
    for (const char* value_field : { "expected", "regex" }) {
        if (config.contains (value_field)) {
            return std::format (
            "'exists' cannot be combined with '{}' - 'exists' "
            "asserts presence or absence, '{}' asserts the value",
            value_field, value_field);
        }
    }
    return std::nullopt;
}

/// `regex` is checked whenever it is written, even beside an `expected` that
/// would win at run time: a pattern that cannot compile is never kept.
std::optional<std::string> assert_jsonpath_problem (const nlohmann::json& config) {
    if (auto problem = detail::json_path_problem (config, "path", "path")) {
        return problem;
    }
    if (!config.contains ("expected") && !config.contains ("regex") &&
    !config.contains ("exists")) {
        return "one of 'expected', 'regex' or 'exists' is required";
    }
    if (auto problem = exists_with_value_problem (config)) {
        return problem;
    }
    return user_regex_problem (config, "regex", "regex");
}

/// `matches` reads `text` as a pattern (an empty one is a valid match-anything
/// pattern, so it stays accepted); `equals` against "" asks for an empty
/// subject, which is a judgement. Only `contains` finds "" in every subject,
/// so its verdict never depends on the response (#3055).
std::optional<std::string> assert_contains_problem (const nlohmann::json& config) {
    const std::string mode = string_member (config, "mode");
    if (mode == "matches") {
        return user_regex_problem (config, "text", "text");
    }
    if ((mode.empty () || mode == "contains") && string_member (config, "text").empty ()) {
        return "'text' cannot be empty in 'contains' mode - every response "
               "contains the empty text, so the assertion never tells one "
               "response from another";
    }
    return std::nullopt;
}

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
    kind.validate_config = assert_status_problem;
    kind.config_schema   = {
        { "type", "object" },
        { "properties",
        { { "in",
          { { "type", "array" }, { "items", { { "type", "integer" } } }, { "title", "Accepted codes" },
          { "description", "A set of status codes the response must match one of." } } },
        { "range",
        { { "type", "object" }, { "title", "Accepted range" },
        { "description", "The response status must fall within this inclusive range." },
        { "properties",
        { { "min", { { "type", "integer" }, { "title", "Minimum" }, { "description", "The lowest acceptable status code, inclusive." } } },
        { "max", { { "type", "integer" }, { "title", "Maximum" }, { "description", "The highest acceptable status code, inclusive." } } } } },
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
    "Fails the step unless a JSONPath match exists (or is absent), equals a "
    "value or matches a regular expression.";
    kind.category = "assert";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<AssertJsonPathElement> (config);
    };
    kind.validate_config = assert_jsonpath_problem;
    kind.config_schema   = {
        { "type", "object" },
        { "properties",
        { { "path",
          { { "type", "string" }, { "title", "JSONPath" },
          { "description", "A JSONPath ($.a.b, $['a b'], [n], [*], ..name) locating the value to check." } } },
        { "expected", { { "title", "Expected value" }, { "description", "The exact value the match must equal." } } },
        { "regex",
        { { "type", "string" }, { "title", "Pattern" },
        { "description",
        "A regular expression the match's text must contain, in RE2 "
        "syntax: no backreferences or lookaround." } } },
        { "exists",
        { { "type", "boolean" }, { "title", "Must exist" },
        { "description",
        "true passes when at least one match is found, false when "
        "none is. Use it alone: it cannot be combined with 'expected' "
        "or 'regex'." } } },
        { "negate",
        { { "type", "boolean" }, { "title", "Negate" },
        { "description",
        "Flips the assertion's pass/fail verdict. A response "
        "body that cannot be read as JSON fails it either way." } } } } },
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
    kind.validate_config = assert_contains_problem;
    kind.config_schema   = {
        { "type", "object" },
        { "properties",
        { { "field",
          { { "type", "string" }, { "enum", { "body", "headers", "url", "status" } }, { "title", "Field" },
          { "description",
          "Which part of the response to check: body, headers, url "
          "or status." } } },
        { "text", { { "type", "string" }, { "title", "Text" }, { "description", "The text to look for, per the selected mode." } } },
        { "mode",
        { { "type", "string" }, { "enum", { "contains", "equals", "matches" } }, { "title", "Mode" },
        { "description",
        "How to compare: contains, equals or matches (a regular "
        "expression in RE2 syntax)." } } },
        { "negate",
        { { "type", "boolean" }, { "title", "Negate" },
        { "description", "Flips the assertion's pass/fail verdict." } } } } },
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
        { "properties",
        { { "maxMs",
        { { "type", "number" }, { "minimum", 0 },
        { "title", "Maximum response time" }, { "x-vayu-unit", "ms" },
        { "description", "Fails the step when the response takes longer than this." } } } } },
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
        { { "bytes",
          { { "type", "integer" }, { "minimum", 0 }, { "title", "Body size" }, { "x-vayu-unit", "B" },
          { "description", "The body size to compare against, in bytes." } } },
        { "op",
        { { "type", "string" }, { "enum", { "lt", "lte", "gt", "gte", "eq" } }, { "title", "Comparison" },
        { "description",
        "How the body size must compare to the bound: less than, "
        "less than or equal, greater than, greater than or equal, "
        "or equal." } } } } },
        { "required", nlohmann::json::array ({ "bytes" }) },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
