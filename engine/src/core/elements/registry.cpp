/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/elements.hpp"

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
    for (size_t i = 0; i < elements.size (); ++i) {
        const auto& entry = elements[i];
        if (!entry.is_object ()) {
            return std::format ("elements[{}] must be a JSON object", i);
        }
        if (!entry.contains ("id") || !entry["id"].is_string () ||
        entry["id"].get<std::string> ().empty ()) {
            return std::format ("elements[{}]: 'id' must be a non-empty string", i);
        }
        const auto id = entry["id"].get<std::string> ();
        if (!seen_ids.insert (id).second) {
            return std::format ("elements[{}]: duplicate id '{}'", i, id);
        }
        if (!entry.contains ("kind") || !entry["kind"].is_string ()) {
            return std::format ("elements[{}]: 'kind' must be a string", i);
        }
        const auto kind_name = entry["kind"].get<std::string> ();
        const auto* kind     = find (kind_name);
        if (kind == nullptr) {
            return std::format ("elements[{}] (kind '{}') is not a known "
                                "element kind - expected one of {}",
            i, kind_name, known_kinds_list (kinds_));
        }
        if (entry.contains ("enabled") && !entry["enabled"].is_boolean ()) {
            return std::format (
            "elements[{}] ({}): 'enabled' must be a boolean", i, kind_name);
        }
        if (entry.contains ("name") && !entry["name"].is_null () &&
        !entry["name"].is_string ()) {
            return std::format ("elements[{}] ({}): 'name' must be a string", i, kind_name);
        }
        const auto config =
        entry.contains ("config") ? entry["config"] : nlohmann::json::object ();
        if (auto reason = validate_config_against_schema (*kind, config, i)) {
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
