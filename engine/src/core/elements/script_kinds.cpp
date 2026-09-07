/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file script_kinds.cpp
 * @brief `script.pre` / `script.post`, registered validate-only (issue #1513).
 *
 * `Database::fold_scripts_into_elements` writes exactly this shape - `{"id",
 * "kind": "script.pre" | "script.post", "enabled": true, "config": {"script"}}`
 * - into a migrated row's `elements`. Without a registration a client reading
 * that row back could never `PUT` it as-is: `Registry::validate` would refuse
 * its own migration's output as "not a known element kind". No `compile`:
 * running a script element is #1514's pipeline, not this one.
 */

#include "vayu/core/elements.hpp"

namespace vayu::core {

namespace {

ElementKind make_script_kind (const char* kind, const char* label, const char* description) {
    ElementKind element_kind;
    element_kind.kind    = kind;
    element_kind.version = 1;
    element_kind.phases = {}; // #1514 assigns the real phase when it runs these.
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
    // No `compile`: phase 0 validates and stores these, it does not run them.
    return element_kind;
}

} // namespace

ElementKind make_script_pre_kind () {
    return make_script_kind (
    "script.pre", "Pre-request script", "Runs before the request is sent.");
}

ElementKind make_script_post_kind () {
    return make_script_kind ("script.post", "Post-request script",
    "Runs after the response is received.");
}

} // namespace vayu::core
