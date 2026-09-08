#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file step_elements_test_helper.hpp
 * @brief A `script.pre` / `script.post` compiled element list, for tests that
 *        used to set `ScenarioStep::pre_script` / `post_script` or
 *        `ExchangeInputs::pre_script` / `post_script` directly before issue
 *        #1514 replaced both with a compiled `elements` list.
 *
 * Goes through the real `vayu::core::compile_elements`, not a hand-built
 * `CompiledElement`, so the returned list carries a genuine `Element` -
 * exactly what a caller that runs the pipeline (`execute_exchange`, the
 * sequential runner) needs; a caller that only reads `kind` / `config` (the
 * load path's `find_step_post_script`, `step_has_script`) is served just as
 * well by it.
 */

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/elements.hpp"

namespace vayu::tests {

inline std::shared_ptr<const std::vector<vayu::core::CompiledElement>>
step_elements_with_scripts (const std::string& pre_script, const std::string& post_script) {
    nlohmann::json elements = nlohmann::json::array ();
    if (!pre_script.empty ()) {
        elements.push_back (nlohmann::json{ { "id", "el_pre" }, { "kind", "script.pre" },
        { "enabled", true }, { "config", { { "script", pre_script } } } });
    }
    if (!post_script.empty ()) {
        elements.push_back (nlohmann::json{ { "id", "el_post" }, { "kind", "script.post" },
        { "enabled", true }, { "config", { { "script", post_script } } } });
    }
    return std::make_shared<const std::vector<vayu::core::CompiledElement>> (
    vayu::core::compile_elements (elements));
}

inline std::shared_ptr<const std::vector<vayu::core::CompiledElement>>
step_elements_with_pre_script (const std::string& script) {
    return step_elements_with_scripts (script, "");
}

inline std::shared_ptr<const std::vector<vayu::core::CompiledElement>>
step_elements_with_post_script (const std::string& script) {
    return step_elements_with_scripts ("", script);
}

/**
 * One `element` array entry, for a test building a step with more than the
 * two-script shape above covers (issue #1495: an `extract.*` beside a
 * `script.*` marked `inline`, several elements on one step, and so on).
 * Combine with @ref compiled_elements.
 */
inline nlohmann::json extract_json_element_json (const std::string& id,
const std::string& path,
const std::string& variable,
const std::string& scope = "collection") {
    return { { "id", id }, { "kind", "extract.json" }, { "enabled", true },
        { "config", { { "path", path }, { "variable", variable }, { "scope", scope } } } };
}

/// @copydoc extract_json_element_json, a `script.pre` / `script.post` entry.
/// @p inline_script matches `config.inline` - the load path's own opt-in
/// (issue #1495); design mode and the sequential run ignore it.
inline nlohmann::json script_element_json (const std::string& id,
const std::string& kind,
const std::string& script,
bool inline_script = false) {
    nlohmann::json config = { { "script", script } };
    if (inline_script) {
        config["inline"] = true;
    }
    return { { "id", id }, { "kind", kind }, { "enabled", true }, { "config", config } };
}

/// @copydoc extract_json_element_json, a gaussian `timer.think` entry (issue
/// #1498) - the shape a wall-clock-bracketing test wants, as opposed to the
/// plain `{"ms": N}` shape existing tests already build inline.
inline nlohmann::json timer_think_gaussian_element_json (const std::string& id,
double mean_ms,
double deviation_ms) {
    return { { "id", id }, { "kind", "timer.think" }, { "enabled", true },
        { "config",
        { { "gaussian", { { "meanMs", mean_ms }, { "deviationMs", deviation_ms } } } } } };
}

/// @copydoc extract_json_element_json, a `timer.pacing` entry (issue #1498).
/// @p scope_entry mirrors the `config._scopeEntry` stamp `scenario_plan.cpp`'s
/// `mark_scope_entries` writes onto a resolved plan - true for the one
/// occurrence of this element's id that is its node's actual start. A caller
/// that compiles through `resolve_scenario` gets the real stamp regardless of
/// what is passed here (`mark_scope_entries` overwrites it); a caller that
/// compiles this entry directly with @ref compiled_elements, bypassing that
/// pass, has to state it.
inline nlohmann::json timer_pacing_element_json (const std::string& id,
int64_t every_ms,
bool scope_entry = true,
bool per_user    = true) {
    return { { "id", id }, { "kind", "timer.pacing" }, { "enabled", true },
        { "config",
        { { "everyMs", every_ms }, { "perUser", per_user }, { "_scopeEntry", scope_entry } } } };
}

/// Compile an arbitrary list of element JSON entries (@ref extract_json_element_json,
/// @ref script_element_json) the same way plan resolution does.
inline std::shared_ptr<const std::vector<vayu::core::CompiledElement>>
compiled_elements (std::vector<nlohmann::json> entries) {
    nlohmann::json array = nlohmann::json::array ();
    for (auto& entry : entries) {
        array.push_back (std::move (entry));
    }
    return std::make_shared<const std::vector<vayu::core::CompiledElement>> (
    vayu::core::compile_elements (array));
}

} // namespace vayu::tests
