/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file metric_kinds.cpp
 * @brief `metric.record` (issue #1500): a custom trend, counter or rate,
 *        recorded in `step.after` and reported beside the built-in phases -
 *        `customMetrics.<name>` in the run report, `custom.<name>.<stat>` in
 *        the thresholds block.
 *
 * A trend or counter reads a number off the response (`jsonpath`, `header`,
 * `latency`, `status` or `size` - the shared JSONPath subset for the first,
 * everything else read straight off `ElementContext::response` the way
 * `assert.size` / `assert.duration` already do). A rate reads a boolean from
 * a small, self-contained comparison (`condition`) rather than the full
 * `control.if` grammar issue #1515 defines: that kind is not yet part of
 * this tree, and a rate's condition needs nothing beyond "does this one field
 * compare true" - inventing a dependency on an unlanded kind for a feature
 * that does not need its full expressiveness would be exactly the kind of
 * complexity CLAUDE.md's "no config knob the issue didn't ask for" rule
 * exists to refuse.
 */

#include "vayu/core/elements.hpp"

#include <cmath>
#include <limits>

#include "json_path.hpp"

namespace vayu::core {

namespace {

std::string json_value_to_string (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    return value.dump ();
}

/// The one response-derived value @p field names, or `nullopt` for a field
/// this kind does not know (already refused by the config schema's `enum`)
/// or a response that is not there yet (`step.after` runs after the send, so
/// this is only reachable when the pipeline was asked to run this kind
/// before a response exists, which the caller guards against separately).
std::optional<nlohmann::json>
read_field (ElementContext& ctx, const std::string& field, const nlohmann::json& config) {
    if (ctx.response == nullptr) {
        return std::nullopt;
    }
    if (field == "latency") {
        return ctx.response->timing.total_ms;
    }
    if (field == "status") {
        return ctx.response->status_code;
    }
    if (field == "size") {
        return static_cast<int64_t> (ctx.response->body.size ());
    }
    if (field == "header") {
        const auto it = ctx.response->headers.find (config.value ("header", ""));
        if (it == ctx.response->headers.end ()) {
            return std::nullopt;
        }
        return it->second;
    }
    if (field == "jsonpath") {
        const auto path = detail::parse_json_path (config.value ("jsonpath", ""));
        if (!path) {
            return std::nullopt;
        }
        const nlohmann::json* body = ensure_parsed_body (ctx);
        if (body == nullptr) {
            return std::nullopt;
        }
        const auto matches = detail::evaluate_json_path (*body, *path);
        if (matches.empty ()) {
            return std::nullopt;
        }
        return std::make_optional<nlohmann::json> (*matches.front ());
    }
    return std::nullopt;
}

/// @p value coerced to a double for a trend or counter - a string is parsed
/// (a header's value, or a jsonpath match that landed on a numeric string),
/// anything else that is not already a JSON number fails the coercion.
std::optional<double> coerce_number (const nlohmann::json& value) {
    if (value.is_number ()) {
        return value.get<double> ();
    }
    if (value.is_string ()) {
        try {
            size_t consumed = 0;
            const double parsed = std::stod (value.get<std::string> (), &consumed);
            if (consumed == value.get<std::string> ().size ()) {
                return parsed;
            }
        } catch (const std::exception&) {
            // @deliberate falls through to nullopt - a non-numeric string is
            // reported as this element's own "error" outcome, not a crash.
        }
    }
    return std::nullopt;
}

/// One `{field, operator, value}` comparison, `condition`'s whole grammar -
/// deliberately narrower than `control.if` (see the file header). `nullopt`
/// means the comparison could not be made (the named field is missing, or an
/// order comparison was asked of two things that do not order); the caller
/// reports that as this element's "error" outcome.
std::optional<bool> evaluate_condition (ElementContext& ctx, const nlohmann::json& condition) {
    const std::string field = condition.value ("field", "");
    const auto actual       = read_field (ctx, field, condition);
    if (!actual) {
        return std::nullopt;
    }
    const std::string op = condition.value ("operator", "eq");
    const auto& expected = condition["value"];

    if (op == "contains") {
        return json_value_to_string (*actual).find (
               json_value_to_string (expected)) != std::string::npos;
    }
    if (op == "eq") {
        return *actual == expected;
    }
    if (op == "ne") {
        return *actual != expected;
    }
    // Every remaining operator is a numeric order comparison.
    const auto lhs = coerce_number (*actual);
    const auto rhs = coerce_number (expected);
    if (!lhs || !rhs) {
        return std::nullopt;
    }
    if (op == "lt") {
        return *lhs < *rhs;
    }
    if (op == "lte") {
        return *lhs <= *rhs;
    }
    if (op == "gt") {
        return *lhs > *rhs;
    }
    if (op == "gte") {
        return *lhs >= *rhs;
    }
    return std::nullopt; // Not reachable past the schema's `enum`.
}

/// `config.type`, read once in the constructor - unknown or absent falls
/// back to `trend`, the schema's own default.
CustomMetricType parse_metric_type (const std::string& type) {
    if (type == "counter") {
        return CustomMetricType::Counter;
    }
    if (type == "rate") {
        return CustomMetricType::Rate;
    }
    return CustomMetricType::Trend;
}

/// The `source` object's one populated key, or empty for a config the schema
/// should already have refused (`oneOf` is not expressed here - see the
/// kind's `config_schema` comment for why).
std::string source_kind (const nlohmann::json& source) {
    for (const char* key : { "jsonpath", "header", "latency", "status", "size", "condition" }) {
        if (source.contains (key)) {
            return key;
        }
    }
    return "";
}

class MetricRecordElement final : public Element {
    public:
    explicit MetricRecordElement (nlohmann::json config)
    : config_ (std::move (config)) {
        name_ = config_.value ("name", "");
        type_ = parse_metric_type (config_.value ("type", "trend"));
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepAfter;
    }

    void apply (ElementContext& ctx) override {
        if (!ctx.record_metric) {
            ctx.outcome_status  = "skipped";
            ctx.outcome_message = "no run to record into";
            return;
        }
        if (ctx.response == nullptr) {
            ctx.outcome_status  = "error";
            ctx.outcome_message = "no response";
            return;
        }

        const nlohmann::json source =
        config_.value ("source", nlohmann::json::object ());
        const std::string kind = source_kind (source);

        if (type_ == CustomMetricType::Rate) {
            if (kind != "condition") {
                ctx.outcome_status = "error";
                ctx.outcome_message =
                "a rate metric needs a 'condition' source";
                return;
            }
            const auto matched = evaluate_condition (ctx, source["condition"]);
            if (!matched) {
                ctx.outcome_status  = "error";
                ctx.outcome_message = "the condition could not be evaluated";
                return;
            }
            ctx.record_metric (name_, CustomMetricType::Rate, *matched ? 1.0 : 0.0);
            ctx.outcome_status = "ok";
            return;
        }

        if (kind.empty () || kind == "condition") {
            ctx.outcome_status = "error";
            ctx.outcome_message =
            "a trend or counter metric needs a 'jsonpath', 'header', "
            "'latency', 'status' or 'size' source";
            return;
        }
        const auto raw   = read_field (ctx, kind, source);
        const auto value = raw ? coerce_number (*raw) : std::nullopt;
        if (!value) {
            ctx.outcome_status = "missing";
            ctx.outcome_message = "no numeric value at the '" + kind + "' source";
            return;
        }
        ctx.record_metric (name_, type_, *value);
        ctx.outcome_status = "ok";
    }

    private:
    nlohmann::json config_;
    std::string name_;
    CustomMetricType type_ = CustomMetricType::Trend;
};

nlohmann::json condition_schema () {
    return {
        { "type", "object" },
        { "title", "Condition" },
        { "description", "Records 1 when the condition holds, 0 otherwise (for a rate metric)." },
        { "properties",
        { { "field",
          { { "type", "string" },
          { "enum", { "status", "header", "jsonpath", "latency", "size" } }, { "title", "Field" },
          { "description",
          "Which part of the response the condition reads: status, "
          "header, jsonpath, latency or size." } } },
        { "header",
        { { "type", "string" }, { "title", "Header name" },
        { "description", "The response header to read, when field is header." } } },
        { "jsonpath",
        { { "type", "string" }, { "title", "JSONPath" },
        { "description", "The JSONPath to read, when field is jsonpath." } } },
        { "operator",
        { { "type", "string" }, { "enum", { "eq", "ne", "lt", "lte", "gt", "gte", "contains" } },
        { "title", "Operator" }, { "description", "How the field's value compares against value." } } },
        { "value", { { "title", "Value" }, { "description", "The value the field is compared against." } } } } },
        { "required", nlohmann::json::array ({ "field", "operator", "value" }) },
        { "additionalProperties", false },
    };
}

} // namespace

ElementKind make_metric_record_kind () {
    ElementKind kind;
    kind.kind    = "metric.record";
    kind.version = 1;
    kind.phases  = { Phase::StepAfter };
    kind.label   = "Record a custom metric";
    kind.description =
    "Records a named trend, counter or rate from the response, reported "
    "beside the built-in phases and usable as a custom.<name>.<stat> "
    "threshold.";
    kind.category = "metric";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<MetricRecordElement> (config);
    };
    // Not a strict `oneOf` across `source`'s six shapes: valijson's `oneOf`
    // failure reports "matched N schemas", which names none of the six
    // by name, where `MetricRecordElement::apply`'s own checks report
    // exactly which source is missing what. The schema's job here is the
    // shape (an object, from a closed set of keys, each of the right type);
    // which single key is actually required by which `type` is a runtime
    // decision the schema alone cannot express without losing that message.
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "name",
          { { "type", "string" }, { "minLength", 1 }, { "maxLength", 100 }, { "title", "Metric name" },
          { "description",
          "The name this metric is reported under, and used in a "
          "custom.<name>.<stat> threshold." } } },
        { "type",
        { { "type", "string" }, { "enum", { "trend", "counter", "rate" } }, { "title", "Type" },
        { "description", "Whether the metric is a trend, a counter or a rate." } } },
        { "source",
        { { "type", "object" }, { "title", "Source" }, { "description", "Where the metric's value comes from." },
        { "properties",
        { { "jsonpath",
          { { "type", "string" }, { "title", "JSONPath" },
          { "description",
          "Reads the metric's value from the response body at "
          "this JSONPath." } } },
        { "header", { { "type", "string" }, { "title", "Header name" }, { "description", "Reads the metric's value from this response header." } } },
        { "latency", { { "type", "boolean" }, { "title", "Latency" }, { "description", "Records the response's latency." } } },
        { "status", { { "type", "boolean" }, { "title", "Status code" }, { "description", "Records the response's status code." } } },
        { "size", { { "type", "boolean" }, { "title", "Body size" }, { "description", "Records the response body's size, in bytes." } } },
        { "condition", condition_schema () } } },
        { "additionalProperties", false } } } } },
        { "required", nlohmann::json::array ({ "name", "type", "source" }) },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
