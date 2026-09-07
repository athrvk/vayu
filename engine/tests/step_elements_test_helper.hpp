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

} // namespace vayu::tests
