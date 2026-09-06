/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file inherit_disable.cpp
 * @brief The one phase-0 behaviour kind: `inherit.disable` (issue #1513).
 *
 * Not itself a behaviour - it names an inherited element's id to drop when
 * `compose_elements` resolves a request's chain (`request_composer.cpp`), so
 * it validates and carries no `compile` (nothing ever constructs an
 * `Element` from it, and `compose_elements` reads its `config.elementId`
 * directly rather than through the pipeline).
 */

#include "vayu/core/elements.hpp"

namespace vayu::core {

ElementKind make_inherit_disable_kind () {
    ElementKind kind;
    kind.kind    = "inherit.disable";
    kind.version = 1;
    kind.phases  = {}; // Not run at any phase; consumed at compose time.
    kind.label   = "Disable inherited element";
    kind.description =
    "Drops one element inherited from an ancestor collection, "
    "named by id, out of this request or collection's "
    "resolved list.";
    kind.category      = "inherit";
    kind.hot_path      = HotPathClass::Declarative;
    kind.config_schema = {
        { "type", "object" },
        { "properties", { { "elementId", { { "type", "string" }, { "minLength", 1 } } } } },
        { "required", nlohmann::json::array ({ "elementId" }) },
        { "additionalProperties", false },
    };
    // No `compile`: this kind never becomes a running `Element`.
    return kind;
}

} // namespace vayu::core
