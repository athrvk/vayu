/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/elements.hpp"

#include "vayu/core/constants.hpp"

#include <valijson/adapters/nlohmann_json_adapter.hpp>
#include <valijson/schema.hpp>
#include <valijson/schema_parser.hpp>
#include <valijson/validation_results.hpp>
#include <valijson/validator.hpp>

#include <format>
#include <unordered_set>

namespace vayu::core {

// Declared here rather than in a public header: each kind's factory is used
// exactly once, by registry.cpp's own explicit call list below.
ElementKind make_inherit_disable_kind ();
ElementKind make_script_pre_kind ();
ElementKind make_script_post_kind ();
ElementKind make_extract_json_kind ();
ElementKind make_extract_regex_kind ();
ElementKind make_extract_header_kind ();
ElementKind make_assert_status_kind ();
ElementKind make_assert_jsonpath_kind ();
ElementKind make_assert_contains_kind ();
ElementKind make_assert_duration_kind ();
ElementKind make_assert_size_kind ();
ElementKind make_timer_think_kind ();
ElementKind make_timer_pacing_kind ();
ElementKind make_metric_record_kind ();

namespace {

std::string phase_name (Phase phase) {
    switch (phase) {
    case Phase::RunStart: return "run.start";
    case Phase::IterationStart: return "iteration.start";
    case Phase::StepBefore: return "step.before";
    case Phase::StepAfter: return "step.after";
    case Phase::StepBetween: return "step.between";
    case Phase::IterationEnd: return "iteration.end";
    case Phase::RunEnd: return "run.end";
    }
    return "unknown"; // Unreachable for a value the enum actually holds.
}

std::string hot_path_name (HotPathClass hot_path) {
    return hot_path == HotPathClass::Script ? "script" : "declarative";
}

nlohmann::json kind_to_json (const ElementKind& kind) {
    nlohmann::json node;
    node["kind"]          = kind.kind;
    node["version"]       = kind.version;
    node["label"]         = kind.label;
    node["description"]   = kind.description;
    node["category"]      = kind.category;
    node["hotPathClass"]  = hot_path_name (kind.hot_path);
    node["configSchema"]  = kind.config_schema;
    nlohmann::json phases = nlohmann::json::array ();
    for (const auto phase : kind.phases) {
        phases.push_back (phase_name (phase));
    }
    node["phases"] = phases;
    return node;
}

/** The comma-separated, quoted list of known kinds, for a rejection message. */
std::string known_kinds_list (const std::vector<ElementKind>& kinds) {
    std::string list;
    for (const auto& kind : kinds) {
        if (!list.empty ()) {
            list += ", ";
        }
        list += "'" + kind.kind + "'";
    }
    return list;
}

/** One element entry's config against its kind's schema, valijson-backed the
 *  way `schema_validation.cpp::validate_body_against_schema` is. */
std::optional<std::string> validate_config_against_schema (const ElementKind& kind,
const nlohmann::json& config,
size_t index) {
    if (kind.config_schema.is_null () || kind.config_schema.empty ()) {
        return std::nullopt; // A kind with no schema accepts any config shape.
    }
    valijson::Schema parsed;
    try {
        valijson::SchemaParser parser;
        const valijson::adapters::NlohmannJsonAdapter adapter (kind.config_schema);
        parser.populateSchema (adapter, parsed);
    } catch (const std::exception& e) {
        return std::format (
        "elements[{}] (kind '{}'): its schema could not be read - {}", index,
        kind.kind, e.what ());
    }

    valijson::ValidationResults results;
    valijson::Validator validator;
    const valijson::adapters::NlohmannJsonAdapter target (config);
    if (validator.validate (parsed, target, &results)) {
        return std::nullopt;
    }
    valijson::ValidationResults::Error error;
    if (results.popError (error) && !error.description.empty ()) {
        return std::format ("elements[{}] ({}): {}", index, kind.kind, error.description);
    }
    return std::format (
    "elements[{}] ({}): does not match its config schema", index, kind.kind);
}

/**
 * One `elements[i]` entry's shape, id uniqueness and config schema - every
 * check `Registry::validate` needs except the cross-entry metric-name cap,
 * which stays in the caller's loop since it accumulates across entries.
 *
 * @param kind_name_out,config_out Filled on success, for the caller's own
 *        metric-name bookkeeping - split out so `validate` itself does not
 *        re-parse `entry["kind"]` / `entry["config"]` a second time.
 */
std::optional<std::string> validate_element_entry (const Registry& registry,
const nlohmann::json& entry,
size_t index,
std::unordered_set<std::string>& seen_ids,
std::string& kind_name_out,
nlohmann::json& config_out) {
    if (!entry.is_object ()) {
        return std::format ("elements[{}] must be a JSON object", index);
    }
    if (!entry.contains ("id") || !entry["id"].is_string () ||
    entry["id"].get<std::string> ().empty ()) {
        return std::format ("elements[{}]: 'id' must be a non-empty string", index);
    }
    const auto id = entry["id"].get<std::string> ();
    if (!seen_ids.insert (id).second) {
        return std::format ("elements[{}]: duplicate id '{}'", index, id);
    }
    if (!entry.contains ("kind") || !entry["kind"].is_string ()) {
        return std::format ("elements[{}]: 'kind' must be a string", index);
    }
    kind_name_out    = entry["kind"].get<std::string> ();
    const auto* kind = registry.find (kind_name_out);
    if (kind == nullptr) {
        return std::format ("elements[{}] (kind '{}') is not a known "
                            "element kind - expected one of {}",
        index, kind_name_out, known_kinds_list (registry.kinds ()));
    }
    if (entry.contains ("enabled") && !entry["enabled"].is_boolean ()) {
        return std::format (
        "elements[{}] ({}): 'enabled' must be a boolean", index, kind_name_out);
    }
    if (entry.contains ("name") && !entry["name"].is_null () && !entry["name"].is_string ()) {
        return std::format ("elements[{}] ({}): 'name' must be a string", index, kind_name_out);
    }
    config_out = entry.contains ("config") ? entry["config"] : nlohmann::json::object ();
    return validate_config_against_schema (*kind, config_out, index);
}

/// The one cross-entry rule `validate_element_entry` cannot check on its
/// own: the collector's cap on distinct `metric.record` names (issue #1500),
/// scoped to this one array - see `Registry::validate`'s own comment on why
/// that scope is correct.
std::optional<std::string> check_metric_record_cap (const std::string& kind_name,
const nlohmann::json& config,
size_t index,
std::unordered_set<std::string>& metric_names) {
    if (kind_name != "metric.record" || !config.contains ("name") ||
    !config["name"].is_string ()) {
        return std::nullopt;
    }
    metric_names.insert (config["name"].get<std::string> ());
    if (metric_names.size () <= constants::metrics_collector::MAX_CUSTOM_METRIC_NAMES) {
        return std::nullopt;
    }
    return std::format (
    "elements[{}] (metric.record): this declares more than {} "
    "distinct custom metric names, the collector's cap",
    index, constants::metrics_collector::MAX_CUSTOM_METRIC_NAMES);
}

} // namespace

Registry& Registry::instance () {
    static Registry registry;
    // Registry deletes copy and move (it holds no state worth duplicating and
    // there is exactly one), so the built-in list is populated in place rather
    // than assigned from a temporary an initialiser lambda would have to
    // return by value.
    static const bool registered = [] {
        registry.register_kind (make_inherit_disable_kind ());
        registry.register_kind (make_script_pre_kind ());
        registry.register_kind (make_script_post_kind ());
        registry.register_kind (make_extract_json_kind ());
        registry.register_kind (make_extract_regex_kind ());
        registry.register_kind (make_extract_header_kind ());
        registry.register_kind (make_assert_status_kind ());
        registry.register_kind (make_assert_jsonpath_kind ());
        registry.register_kind (make_assert_contains_kind ());
        registry.register_kind (make_assert_duration_kind ());
        registry.register_kind (make_assert_size_kind ());
        registry.register_kind (make_timer_think_kind ());
        registry.register_kind (make_timer_pacing_kind ());
        registry.register_kind (make_metric_record_kind ());
        return true;
    }();
    (void)registered;
    return registry;
}

void Registry::register_kind (ElementKind kind) {
    kinds_.push_back (std::move (kind));
}

void Registry::register_kind_for_test (ElementKind kind) {
    register_kind (std::move (kind));
}

const ElementKind* Registry::find (const std::string& kind) const {
    for (const auto& candidate : kinds_) {
        if (candidate.kind == kind) {
            return &candidate;
        }
    }
    return nullptr;
}

const std::vector<ElementKind>& Registry::kinds () const {
    return kinds_;
}

std::optional<std::string> Registry::validate (const nlohmann::json& elements) const {
    if (!elements.is_array ()) {
        return "'elements' must be an array";
    }

    std::unordered_set<std::string> seen_ids;
    // Every distinct `metric.record` name this one array declares (issue
    // #1500), so a client learns it has spent the collector's cap before a
    // run ever starts rather than discovering it mid-flight - the same
    // "refuse loudly, before the locked write" rule every other bound in
    // this engine follows. Scoped to this one array: a name repeated by
    // inheriting the same element onto several levels is one declaration,
    // and it appears here once because `validate` is called with exactly
    // this collection's or request's own stored `elements` field, never the
    // chain-merged list `compose_elements` builds for a run.
    std::unordered_set<std::string> metric_names;
    for (size_t i = 0; i < elements.size (); ++i) {
        std::string kind_name;
        nlohmann::json config;
        if (auto reason = validate_element_entry (
            *this, elements[i], i, seen_ids, kind_name, config)) {
            return reason;
        }
        if (auto reason = check_metric_record_cap (kind_name, config, i, metric_names)) {
            return reason;
        }
    }
    return std::nullopt;
}

nlohmann::json elements_catalogue () {
    nlohmann::json catalogue = nlohmann::json::array ();
    for (const auto& kind : Registry::instance ().kinds ()) {
        catalogue.push_back (kind_to_json (kind));
    }
    return catalogue;
}

} // namespace vayu::core
