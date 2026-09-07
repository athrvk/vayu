/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file extract_kinds.cpp
 * @brief `extract.json`, `extract.regex`, `extract.header` (issue #1514).
 *
 * All three run in `step.after` (they read the response) and share one write
 * convention: `matchNo` picks among however many matches a step produced -
 * 1-based ("the first match" is 1, not 0, JMeter's own convention), `0` picks
 * one at random, `-1` writes every match as `<variable>_1` .. `<variable>_N`
 * plus a `<variable>_matchNr` count. A miss writes `default` when the config
 * gives one, else reports `"missing"`, and - only when `required` is set -
 * also appends a failed assertion to the step's test tally, the same channel
 * `assert_kinds.cpp` uses, so a required extractor participating in a step's
 * pass/fail is one mechanism rather than two.
 */

#include "vayu/core/elements.hpp"

#include <random>
#include <regex>

#include "json_path.hpp"

namespace vayu::core {

namespace {

std::string json_value_to_string (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    return value.dump ();
}

void mark_required_miss (ElementContext& ctx, const std::string& variable, const std::string& why) {
    ctx.post_script_result.tests.push_back (
    vayu::TestResult{ "extract " + variable, false, why });
}

/// Writes @p matches under @p variable per the shared `matchNo` convention
/// above. `to_text` turns one match into the string a variable holds.
template <typename Match, typename ToText>
void write_matches (ElementContext& ctx,
const std::vector<Match>& matches,
const std::string& scope,
const std::string& variable,
long match_no,
const std::optional<std::string>& fallback,
bool required,
const std::string& miss_reason,
ToText to_text) {
    if (match_no == -1) {
        if (matches.empty ()) {
            if (fallback) {
                ctx.set_variable (scope, variable, *fallback);
                ctx.outcome_status = "ok";
                ctx.outcome_wrote  = true;
                return;
            }
            ctx.outcome_status = "missing";
            if (required) {
                mark_required_miss (ctx, variable, miss_reason);
            }
            return;
        }
        for (size_t i = 0; i < matches.size (); ++i) {
            ctx.set_variable (scope, variable + "_" + std::to_string (i + 1),
            to_text (matches[i]));
        }
        ctx.set_variable (scope, variable + "_matchNr", std::to_string (matches.size ()));
        ctx.outcome_status = "ok";
        ctx.outcome_wrote  = true;
        return;
    }

    const Match* picked = nullptr;
    if (match_no == 0) {
        if (!matches.empty ()) {
            static thread_local std::mt19937 rng{ std::random_device{}() };
            std::uniform_int_distribution<size_t> dist (0, matches.size () - 1);
            picked = &matches[dist (rng)];
        }
    } else if (match_no >= 1 && static_cast<size_t> (match_no) <= matches.size ()) {
        picked = &matches[static_cast<size_t> (match_no) - 1];
    }

    if (picked == nullptr) {
        if (fallback) {
            ctx.set_variable (scope, variable, *fallback);
            ctx.outcome_status = "ok";
            ctx.outcome_wrote  = true;
            return;
        }
        ctx.outcome_status = "missing";
        if (required) {
            mark_required_miss (ctx, variable, miss_reason);
        }
        return;
    }

    ctx.set_variable (scope, variable, to_text (*picked));
    ctx.outcome_status = "ok";
    ctx.outcome_wrote  = true;
}

// ---------------------------------------------------------------------------
// extract.json - a JSONPath subset: `$.a.b`, `[n]`, `[*]`, `..name`. Filters
// (`[?...]`) are refused at validate through the schema's `path` pattern.
// The subset itself lives in `json_path.{hpp,cpp}`, shared with
// `assert.jsonpath` below.
// ---------------------------------------------------------------------------

class ExtractJsonElement final : public Element {
    public:
    explicit ExtractJsonElement (nlohmann::json config)
    : config_ (std::move (config)) {
        path_     = detail::parse_json_path (config_.value ("path", ""));
        variable_ = config_.value ("variable", "");
        scope_    = config_.value ("scope", "collection");
        if (config_.contains ("default") && config_["default"].is_string ()) {
            fallback_ = config_["default"].get<std::string> ();
        }
        match_no_ = config_.value ("matchNo", 1);
        required_ = config_.value ("required", false);
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
        write_matches (ctx, matches, scope_, variable_, match_no_, fallback_,
        required_, "no match for '" + config_.value ("path", "") + "'",
        [] (const nlohmann::json* m) { return json_value_to_string (*m); });
    }

    private:
    nlohmann::json config_;
    std::optional<std::vector<detail::JsonPathStep>> path_;
    std::string variable_;
    std::string scope_;
    std::optional<std::string> fallback_;
    long match_no_ = 1;
    bool required_ = false;
};

// ---------------------------------------------------------------------------
// extract.regex - `pattern` compiled once, at compile time; `template` `$1$`
// style back-references; `field`: body | headers | url | status.
// ---------------------------------------------------------------------------

std::string regex_field_text (const ElementContext& ctx, const std::string& field) {
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

/// `$1$`-style template: `$N$` becomes capture group N, `$0$` the whole match.
std::string apply_regex_template (const std::string& tpl, const std::smatch& match) {
    std::string out;
    for (size_t i = 0; i < tpl.size (); ++i) {
        if (tpl[i] == '$' && i + 1 < tpl.size ()) {
            size_t j        = i + 1;
            size_t group    = 0;
            bool has_digits = false;
            while (j < tpl.size () &&
            std::isdigit (static_cast<unsigned char> (tpl[j])) != 0) {
                group = group * 10 + static_cast<size_t> (tpl[j] - '0');
                ++j;
                has_digits = true;
            }
            if (has_digits && j < tpl.size () && tpl[j] == '$') {
                if (group < match.size ()) {
                    out += match[group].str ();
                }
                i = j;
                continue;
            }
        }
        out += tpl[i];
    }
    return out;
}

class ExtractRegexElement final : public Element {
    public:
    explicit ExtractRegexElement (nlohmann::json config)
    : config_ (std::move (config)) {
        variable_ = config_.value ("variable", "");
        scope_    = config_.value ("scope", "collection");
        field_    = config_.value ("field", "body");
        template_ = config_.value ("template", "$0$");
        match_no_ = config_.value ("matchNo", 1);
        required_ = config_.value ("required", false);
        if (config_.contains ("default") && config_["default"].is_string ()) {
            fallback_ = config_["default"].get<std::string> ();
        }
        try {
            pattern_.emplace (config_.value ("pattern", ""));
        } catch (const std::regex_error&) {
            // @deliberate `pattern_` stays unset; `apply` reports the compile
            // failure as this element's own "error" outcome rather than an
            // exception the pipeline would have to catch generically.
        }
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepAfter;
    }

    void apply (ElementContext& ctx) override {
        if (!pattern_) {
            ctx.outcome_status  = "error";
            ctx.outcome_message = "invalid regular expression";
            return;
        }
        const std::string text = regex_field_text (ctx, field_);
        std::vector<std::string> matches;
        auto begin = std::sregex_iterator (text.begin (), text.end (), *pattern_);
        for (auto it = begin; it != std::sregex_iterator (); ++it) {
            matches.push_back (apply_regex_template (template_, *it));
        }
        write_matches (ctx, matches, scope_, variable_, match_no_, fallback_,
        required_, "no match for the regular expression",
        [] (const std::string& m) { return m; });
    }

    private:
    nlohmann::json config_;
    std::optional<std::regex> pattern_;
    std::string variable_;
    std::string scope_;
    std::string field_;
    std::string template_;
    std::optional<std::string> fallback_;
    long match_no_ = 1;
    bool required_ = false;
};

// ---------------------------------------------------------------------------
// extract.header - one response header, by name, case-insensitively.
// ---------------------------------------------------------------------------

class ExtractHeaderElement final : public Element {
    public:
    explicit ExtractHeaderElement (nlohmann::json config)
    : config_ (std::move (config)) {
        header_   = config_.value ("header", "");
        variable_ = config_.value ("variable", "");
        scope_    = config_.value ("scope", "collection");
        required_ = config_.value ("required", false);
        if (config_.contains ("default") && config_["default"].is_string ()) {
            fallback_ = config_["default"].get<std::string> ();
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
        const auto it = ctx.response->headers.find (header_);
        if (it == ctx.response->headers.end ()) {
            if (fallback_) {
                ctx.set_variable (scope_, variable_, *fallback_);
                ctx.outcome_status = "ok";
                ctx.outcome_wrote  = true;
                return;
            }
            ctx.outcome_status = "missing";
            if (required_) {
                mark_required_miss (ctx, variable_, "no '" + header_ + "' response header");
            }
            return;
        }
        ctx.set_variable (scope_, variable_, it->second);
        ctx.outcome_status = "ok";
        ctx.outcome_wrote  = true;
    }

    private:
    nlohmann::json config_;
    std::string header_;
    std::string variable_;
    std::string scope_;
    std::optional<std::string> fallback_;
    bool required_ = false;
};

nlohmann::json variable_scope_schema () {
    return { { "type", "string" }, { "enum", { "env", "collection", "globals" } } };
}

} // namespace

ElementKind make_extract_json_kind () {
    ElementKind kind;
    kind.kind    = "extract.json";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Extract from JSON";
    kind.description =
    "Reads one value out of the JSON response body by a JSONPath "
    "subset ($.a.b, [n], [*], ..name) into a variable.";
    kind.category = "extract";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ExtractJsonElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "path", { { "type", "string" }, { "pattern", "^\\$(\\.[A-Za-z0-9_]+|\\.\\.[A-Za-z0-9_]+|\\[\\*\\]|\\[-?[0-9]+\\])*$" } } },
        { "variable", { { "type", "string" }, { "minLength", 1 } } },
        { "scope", variable_scope_schema () }, { "default", { { "type", "string" } } },
        { "matchNo", { { "type", "integer" } } }, { "required", { { "type", "boolean" } } } } },
        { "required", nlohmann::json::array ({ "path", "variable" }) },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_extract_regex_kind () {
    ElementKind kind;
    kind.kind    = "extract.regex";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Extract with a regular expression";
    kind.description =
    "Runs a regular expression against the response and writes a "
    "match (or a $1$-style template of its groups) into a variable.";
    kind.category = "extract";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ExtractRegexElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "pattern", { { "type", "string" }, { "minLength", 1 } } },
        { "template", { { "type", "string" } } },
        { "field", { { "type", "string" }, { "enum", { "body", "headers", "url", "status" } } } },
        { "variable", { { "type", "string" }, { "minLength", 1 } } },
        { "scope", variable_scope_schema () }, { "default", { { "type", "string" } } },
        { "matchNo", { { "type", "integer" } } }, { "required", { { "type", "boolean" } } } } },
        { "required", nlohmann::json::array ({ "pattern", "variable" }) },
        { "additionalProperties", false },
    };
    return kind;
}

ElementKind make_extract_header_kind () {
    ElementKind kind;
    kind.kind        = "extract.header";
    kind.version     = 1;
    kind.phases      = { Phase::StepAfter };
    kind.label       = "Extract a response header";
    kind.description = "Copies one response header's value into a variable.";
    kind.category    = "extract";
    kind.hot_path    = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<ExtractHeaderElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "header", { { "type", "string" }, { "minLength", 1 } } },
        { "variable", { { "type", "string" }, { "minLength", 1 } } },
        { "scope", variable_scope_schema () }, { "default", { { "type", "string" } } },
        { "required", { { "type", "boolean" } } } } },
        { "required", nlohmann::json::array ({ "header", "variable" }) },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
