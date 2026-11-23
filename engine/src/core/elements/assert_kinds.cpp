/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file assert_kinds.cpp
 * @brief `assert.status`, `assert.jsonpath`, `assert.jsonschema`,
 *        `assert.snapshot`, `assert.contains`, `assert.duration`,
 *        `assert.size` (issue #1514; `assert.jsonschema` #3806,
 *        `assert.snapshot` #3807).
 *
 * All seven run in `step.after` and report through the same channel a `pm.test`
 * call does: one `TestResult` appended to `ElementContext::post_script_result`
 * regardless of the verdict, so `classify_step`'s `describe_failed_tests` and
 * the SSE frame's `tests` tally count a declarative assertion exactly as they
 * count a scripted one (issue #1512's "Outcomes" section) - one mechanism,
 * not two.
 */

#include "vayu/core/element_defaults.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/list_snapshot.hpp"
#include "vayu/core/schema_validation.hpp"
#include "vayu/http/request_composer.hpp"

#include <algorithm>
#include <expected>
#include <format>
#include <string_view>
#include <vector>

#include "user_regex.hpp"
#include "vayu/core/json_path.hpp"

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
// Operands written with `{{name}}` tokens (#3779): `assert.contains`'s `text`
// outside `matches`, and the strings of `assert.jsonpath`'s `expected`. They
// resolve through `ElementContext::resolve_template` when the assertion
// applies, the hook `control.if` reads. A token that cannot be answered fails
// the assertion, because comparing the template as typed would turn a mistyped
// column name into a verdict about the wrong operand.
// ---------------------------------------------------------------------------

constexpr std::string_view TOKEN_OPEN = "{{";

/// The names of the tokens @p written holds, each once, in order of appearance.
std::vector<std::string> token_names (const std::string& written) {
    const auto split =
    vayu::http::split_tokens (written, [] (const std::string&) { return true; });
    std::vector<std::string> names;
    for (const auto& name : split.names) {
        if (std::ranges::find (names, name) == names.end ()) {
            names.push_back (name);
        }
    }
    return names;
}

/// Whether the step's variables answer the token @p name. Asked of the token
/// alone: the data-row resolver hands back a whole text unchanged when any one
/// of its columns is missing, so the whole text cannot say which name failed.
/// A value that still holds a token counts as unanswered, as in `control.if`'s
/// `exists`.
bool token_is_answered (const ElementContext& ctx, const std::string& name) {
    if (!ctx.resolve_template) {
        return false;
    }
    const std::string token = "{{" + name + "}}";
    return ctx.resolve_template (token).find (TOKEN_OPEN) == std::string::npos;
}

/// @p written with its tokens resolved. A token nothing answers is added to
/// @p unresolved (once) and @p written comes back unchanged, which the caller
/// must not compare. Text without a token is returned as it stands.
std::string resolve_operand (const ElementContext& ctx,
const std::string& written,
std::vector<std::string>& unresolved) {
    if (written.find (TOKEN_OPEN) == std::string::npos) {
        return written;
    }
    bool answered = true;
    for (const auto& name : token_names (written)) {
        if (token_is_answered (ctx, name)) {
            continue;
        }
        answered = false;
        if (std::ranges::find (unresolved, name) == unresolved.end ()) {
            unresolved.push_back (name);
        }
    }
    return answered && ctx.resolve_template ? ctx.resolve_template (written) : written;
}

/// Every string value of @p value resolved as @ref resolve_operand does, at any
/// depth. A resolved string stays a string (`"{{n}}"` answering `5` is `"5"`),
/// and object keys are left as written.
nlohmann::json resolve_json_strings (const ElementContext& ctx,
const nlohmann::json& value,
std::vector<std::string>& unresolved) {
    if (value.is_string ()) {
        return resolve_operand (ctx, value.get<std::string> (), unresolved);
    }
    if (value.is_array ()) {
        nlohmann::json out = nlohmann::json::array ();
        for (const auto& item : value) {
            out.push_back (resolve_json_strings (ctx, item, unresolved));
        }
        return out;
    }
    if (value.is_object ()) {
        nlohmann::json out = nlohmann::json::object ();
        for (const auto& [key, item] : value.items ()) {
            out[key] = resolve_json_strings (ctx, item, unresolved);
        }
        return out;
    }
    return value;
}

/// Whether any string value of @p value, at any depth, holds a token: decided
/// when the element is built, so an operand with none costs nothing per apply.
bool json_holds_token (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get_ref<const std::string&> ().find (TOKEN_OPEN) != std::string::npos;
    }
    if (!value.is_array () && !value.is_object ()) {
        return false;
    }
    return std::ranges::any_of (value, json_holds_token);
}

/// What an unresolved operand reports: the names only, never a value, since a
/// resolved variable can be a secret and the message reaches whoever reads the
/// run.
std::string unresolved_message (const std::string& operand,
const std::vector<std::string>& unresolved) {
    std::string names;
    for (const auto& name : unresolved) {
        names += (names.empty () ? "{{" : ", {{") + name + "}}";
    }
    return "'" + operand + "' uses " + names + ", which no variable or data column answers";
}

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
        const auto expected = config_.find ("expected");
        expected_holds_token_ = expected != config_.end () && json_holds_token (*expected);
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
        const bool negate = config_.value ("negate", element_defaults::ASSERT_NEGATE);

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
            nlohmann::json resolved;
            const nlohmann::json* expected = expected_operand (ctx, name, resolved);
            if (expected == nullptr) {
                return;
            }
            // Converted first: `ordered_json` object equality is
            // order-sensitive, and `expected` is not compared by key order.
            passed = !matches.empty () && nlohmann::json (*matches.front ()) == *expected;
            // The written value: a resolved one may be a secret.
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
    /// `expected` as this step reads it: @p storage holds the resolved copy
    /// when it carries tokens, otherwise the config's own value is returned
    /// untouched. Null once a token nothing answers has been recorded as the
    /// assertion's failure.
    const nlohmann::json* expected_operand (ElementContext& ctx,
    const std::string& name,
    nlohmann::json& storage) const {
        if (!expected_holds_token_) {
            return &config_.at ("expected");
        }
        std::vector<std::string> unresolved;
        storage = resolve_json_strings (ctx, config_.at ("expected"), unresolved);
        if (unresolved.empty ()) {
            return &storage;
        }
        record_unrunnable_assertion (ctx, name, unresolved_message ("expected", unresolved));
        return nullptr;
    }

    nlohmann::json config_;
    std::optional<std::vector<detail::JsonPathStep>> path_;
    OptionalUserRegex regex_;
    bool expected_holds_token_ = false;
};

// ---------------------------------------------------------------------------
// assert.jsonschema (#3806) - the body, or the first value a JSONPath finds in
// it, against a JSON Schema, through the validator `pm.response.to.have
// .jsonSchema` and the OpenAPI contracts share. That validator is draft-07: a
// keyword it does not evaluate fails the assertion naming it, because a pass
// would read as "the contract held" when part of it went unread.
// ---------------------------------------------------------------------------

/// One failure as the message lists it: where, then what.
std::string schema_failure_line (const SchemaFailure& failure) {
    return std::format ("{}: {}",
    failure.path.empty () ? "the root" : failure.path, failure.message);
}

/// The failures the verdict kept, then how many the validator's cap left out.
std::string schema_failure_list (const ValidationVerdict& verdict) {
    std::string list;
    for (const auto& failure : verdict.failures) {
        list += (list.empty () ? "" : "; ") + schema_failure_line (failure);
    }
    const size_t omitted = verdict.failures_total - verdict.failures.size ();
    if (omitted > 0) {
        list += std::format (" ({} more)", omitted);
    }
    return list;
}

/// Why @p verdict is not a pass, or nothing when it is one. A verdict that
/// names unevaluated keywords is never a pass, whichever way the checked part
/// went: ignored, such a keyword makes the schema looser than its author wrote.
std::optional<std::string> schema_verdict_failure (const ValidationVerdict& verdict,
const std::string& subject) {
    if (!verdict.unevaluated_keywords.empty ()) {
        std::string message = "the schema " + unevaluated_keywords_disclosure (verdict);
        if (!verdict.valid && !verdict.failures.empty ()) {
            message += "; of what was checked, the first failure is " +
            schema_failure_line (verdict.failures.front ());
        }
        return message;
    }
    if (verdict.valid) {
        return std::nullopt;
    }
    return std::format ("expected {} to match the schema, but it fails: {}",
    subject, schema_failure_list (verdict));
}

bool reads_a_jsonpath (const nlohmann::json& config) {
    return string_member (config, "source") == "jsonpath";
}

/// What `assert.jsonschema`'s config leaves it nothing to judge with: no schema
/// to hold the value to, or a path that is missing, outside the subset, or
/// written beside a `source` that never reads it.
std::optional<std::string> assert_jsonschema_shape_problem (const nlohmann::json& config) {
    const auto schema = config.find ("schema");
    if (schema == config.end () || !(schema->is_object () || schema->is_boolean ())) {
        return "'schema' is required and must be a JSON Schema object (or true "
               "or false)";
    }
    if (!reads_a_jsonpath (config)) {
        if (config.contains ("path")) {
            return "'path' is only read when 'source' is 'jsonpath'";
        }
        return std::nullopt;
    }
    if (!config.contains ("path")) {
        return "'path' is required when 'source' is 'jsonpath' - name the "
               "value to check, for an MCP tool result "
               "$.result.structuredContent";
    }
    return detail::json_path_problem (config, "path", "path");
}

class AssertJsonSchemaElement final : public Element {
    public:
    explicit AssertJsonSchemaElement (nlohmann::json config)
    : config_ (std::move (config)) {
        if (reads_a_jsonpath (config_)) {
            path_ = detail::parse_json_path (string_member (config_, "path"));
        }
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepAfter;
    }

    void apply (ElementContext& ctx) override {
        const std::string path_text = string_member (config_, "path");
        const std::string subject =
        reads_a_jsonpath (config_) ? "'" + path_text + "'" : "the body";
        const std::string name = subject + " matches the JSON Schema";
        if (const auto problem = assert_jsonschema_shape_problem (config_)) {
            record_unrunnable_assertion (ctx, name, "assert.jsonschema: " + *problem);
            return;
        }
        const nlohmann::ordered_json* body = ensure_parsed_body (ctx);
        if (body == nullptr) {
            record_assertion (ctx, name, false,
            std::string (constants::elements::BODY_UNREADABLE_MESSAGE));
            return;
        }
        const nlohmann::ordered_json* judged = body;
        if (path_) {
            const auto matches = detail::evaluate_json_path (*body, *path_);
            if (matches.empty ()) {
                record_assertion (ctx, name, false,
                "expected " + subject + " to match the schema, but the path has no match");
                return;
            }
            judged = matches.front ();
        }
        // Converted: the validator reads a `nlohmann::json`, and the body was
        // parsed ordered so a path's wildcard visits members in the body's order.
        const auto verdict = validate_document_against_schema (
        config_.at ("schema"), nlohmann::json (*judged));
        if (!verdict) {
            record_unrunnable_assertion (
            ctx, name, "the schema could not be read: " + verdict.error ());
            return;
        }
        const auto failure = schema_verdict_failure (*verdict, subject);
        record_assertion (ctx, name, !failure, failure.value_or (""));
    }

    private:
    nlohmann::json config_;
    std::optional<std::vector<detail::JsonPathStep>> path_;
};

// ---------------------------------------------------------------------------
// assert.snapshot (#3807) - the items an MCP list method answers against a
// recorded baseline, so a server that renames a tool or changes its input
// schema fails the step. A generic kind rather than an MCP-only one: the
// registry has no protocol gate, and a kind that read `result.tools` on any
// other reply would only report that the list is missing. What is compared,
// and how, is `core/list_snapshot.hpp`.
// ---------------------------------------------------------------------------

/// The list `method` names (the default when it is absent), or why it names
/// none.
std::expected<const SnapshotList*, std::string> snapshot_list_of (
const nlohmann::json& config) {
    const auto method = config.find ("method");
    if (method == config.end ()) {
        return find_snapshot_list (element_defaults::ASSERT_SNAPSHOT_METHOD);
    }
    const SnapshotList* list =
    method->is_string () ? find_snapshot_list (method->get<std::string> ()) : nullptr;
    if (list != nullptr) {
        return list;
    }
    std::string offered;
    for (const auto& known : snapshot_lists ()) {
        offered += (offered.empty () ? "'" : ", '") + std::string (known.method) + "'";
    }
    return std::unexpected ("'method' must be one of " + offered);
}

/// What `assert.snapshot`'s config leaves it nothing to compare with: a method
/// that names no list, or no baseline that can be compared against.
std::optional<std::string> assert_snapshot_problem (const nlohmann::json& config) {
    const auto list = snapshot_list_of (config);
    if (!list) {
        return list.error ();
    }
    const auto baseline = config.find ("baseline");
    if (baseline == config.end ()) {
        return "'baseline' is required - record the items " +
        std::string ((*list)->method) + " answers";
    }
    return snapshot_baseline_problem (*baseline, **list);
}

class AssertSnapshotElement final : public Element {
    public:
    explicit AssertSnapshotElement (nlohmann::json config)
    : config_ (std::move (config)) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepAfter;
    }

    void apply (ElementContext& ctx) override {
        const auto list = snapshot_list_of (config_);
        const std::string name =
        (list ? std::string ((*list)->method) : std::string ("the list")) + " matches the snapshot";
        if (const auto problem = assert_snapshot_problem (config_)) {
            record_unrunnable_assertion (ctx, name, "assert.snapshot: " + *problem);
            return;
        }
        const nlohmann::ordered_json* body = ensure_parsed_body (ctx);
        if (body == nullptr) {
            record_assertion (ctx, name, false,
            std::string (constants::elements::BODY_UNREADABLE_MESSAGE));
            return;
        }
        const auto drift = snapshot_drift (**list, *body, config_.at ("baseline"));
        record_assertion (ctx, name, !drift, drift.value_or (""));
    }

    private:
    nlohmann::json config_;
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
        const std::string field = config_.value ("field", element_defaults::RESPONSE_FIELD);
        const std::string mode =
        config_.value ("mode", element_defaults::ASSERT_CONTAINS_MODE);
        const bool negate = config_.value ("negate", element_defaults::ASSERT_NEGATE);
        // The text as written is what the name and the failure quote: the
        // resolved one may be a secret. `matches` was compiled as a pattern
        // when the element was built, so its text is never resolved.
        const std::string written = config_.value ("text", "");
        std::string verb          = "contain";
        if (mode == "equals") {
            verb = "equal";
        } else if (pattern_) {
            verb = "match";
        }
        const std::string name =
        field + " " + (negate ? "does not " + verb : verb) + " '" + written + "'";
        std::vector<std::string> unresolved;
        const std::string text =
        pattern_ ? written : resolve_operand (ctx, written, unresolved);
        if (!unresolved.empty ()) {
            record_unrunnable_assertion (ctx, name, unresolved_message ("text", unresolved));
            return;
        }
        std::string storage;
        const std::string_view subject = response_field_text (ctx, field, storage);

        bool passed;
        if (mode == "equals") {
            passed = subject == text;
        } else if (const auto& pattern = pattern_) {
            if (!*pattern) {
                record_unrunnable_assertion (
                ctx, field + " matches '" + text + "'", pattern->error ());
                return;
            }
            passed = (*pattern)->search (subject);
        } else {
            passed = subject.find (text) != std::string_view::npos;
        }
        if (negate) {
            passed = !passed;
        }
        record_assertion (ctx, name, passed,
        "expected " + field + " to " + (negate ? "not " + verb : verb) + " '" + written + "'");
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
        const std::string op = config_.value ("op", element_defaults::ASSERT_SIZE_OP);
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

/// The shape problems, then a schema whose `$ref`s loop without reaching a
/// value, which the validator would refuse on every run.
std::optional<std::string> assert_jsonschema_problem (const nlohmann::json& config) {
    if (auto problem = assert_jsonschema_shape_problem (config)) {
        return problem;
    }
    const auto& schema = config.at ("schema");
    if (const auto loop = find_schema_loop (schema, nlohmann::json::object ())) {
        return "'schema' refers to itself without describing any value (" + *loop + ")";
    }
    return std::nullopt;
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
        { "expected",
        { { "title", "Expected value" },
        { "description",
        "The exact value the match must equal. {{name}} and "
        "{{data.column}} inside any string of it are replaced with the "
        "step's variables when the assertion runs, and the result stays "
        "a string; a name nothing answers fails the assertion. "
        "'regex' is a pattern and is never resolved." } } },
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
        { { "type", "boolean" }, { "default", element_defaults::ASSERT_NEGATE }, { "title", "Negate" },
        { "description",
        "Flips the assertion's pass/fail verdict. A response "
        "body that cannot be read as JSON fails it either way." } } } } },
        { "required", nlohmann::json::array ({ "path" }) },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_assert_jsonschema_kind () {
    ElementKind kind;
    kind.kind    = "assert.jsonschema";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Assert JSON Schema";
    kind.description =
    "Fails the step unless the response body, or the value a JSONPath finds in "
    "it, conforms to a JSON Schema.";
    kind.category = "assert";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<AssertJsonSchemaElement> (config);
    };
    kind.validate_config = assert_jsonschema_problem;
    kind.config_schema   = {
        { "type", "object" },
        { "properties",
        { { "source",
          { { "type", "string" }, { "enum", { "body", "jsonpath" } },
          { "default", element_defaults::ASSERT_JSONSCHEMA_SOURCE }, { "title", "Check" },
          { "description",
          "What the schema judges: the whole response body, or the first "
          "value a JSONPath finds in it." } } },
        { "path",
        { { "type", "string" }, { "title", "JSONPath" },
        { "description",
        "Locates the value to check when the source is a JSONPath, e.g. "
        "$.result.structuredContent for an MCP tool result. The first "
        "match is checked, and no match fails the assertion." } } },
        { "schema",
        { { "title", "JSON Schema" },
        { "description",
        "The schema the value must conform to: an object, or true / false. "
        "Draft-07 is evaluated; a keyword from a later draft is not, and "
        "a schema that uses one fails the assertion naming it." } } } } },
        { "required", nlohmann::json::array ({ "schema" }) },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_assert_snapshot_kind () {
    ElementKind kind;
    kind.kind    = "assert.snapshot";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Assert list snapshot";
    kind.description =
    "Fails the step when the items an MCP list method returns differ from a "
    "recorded baseline, naming what was added, removed or changed.";
    kind.category = "assert";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<AssertSnapshotElement> (config);
    };
    kind.validate_config   = assert_snapshot_problem;
    nlohmann::json methods = nlohmann::json::array ();
    for (const auto& list : snapshot_lists ()) {
        methods.push_back (list.method);
    }
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "method",
          { { "type", "string" }, { "enum", std::move (methods) },
          { "default", element_defaults::ASSERT_SNAPSHOT_METHOD }, { "title", "List" },
          { "description",
          "Which list the reply holds: tools, resources or prompts. The "
          "reply is the server's answer to that method." } } },
        { "baseline",
        { { "type", "array" }, { "title", "Baseline" },
        { "description",
        "The items the list held when it was recorded. Only the fields a "
        "client reads are compared (a tool's name, title, description, "
        "inputSchema, outputSchema and annotations), items are matched by "
        "name (uri for resources) so their order does not matter, and a "
        "difference names the item and the JSON Pointer where it "
        "differs." } } } } },
        { "required", nlohmann::json::array ({ "baseline" }) },
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
          { { "type", "string" }, { "enum", { "body", "headers", "url", "status" } },
          { "default", element_defaults::RESPONSE_FIELD }, { "title", "Field" },
          { "description",
          "Which part of the response to check: body, headers, url "
          "or status." } } },
        { "text",
        { { "type", "string" }, { "title", "Text" },
        { "description",
        "The text to look for, per the selected mode. In 'contains' and "
        "'equals' mode, {{name}} and {{data.column}} are replaced with the "
        "step's variables when the assertion runs, and a name nothing "
        "answers fails the assertion. In 'matches' mode it is a pattern "
        "and is never resolved." } } },
        { "mode",
        { { "type", "string" }, { "enum", { "contains", "equals", "matches" } },
        { "default", element_defaults::ASSERT_CONTAINS_MODE }, { "title", "Mode" },
        { "description",
        "How to compare: contains, equals or matches (a regular "
        "expression in RE2 syntax)." } } },
        { "negate",
        { { "type", "boolean" }, { "default", element_defaults::ASSERT_NEGATE }, { "title", "Negate" },
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
        { { "type", "string" }, { "enum", { "lt", "lte", "gt", "gte", "eq" } },
        { "default", element_defaults::ASSERT_SIZE_OP }, { "title", "Comparison" },
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
