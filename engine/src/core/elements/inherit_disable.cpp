/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `inherit.disable` (#1513), the one phase-0 kind, and not a behaviour: it
 * names an inherited element's id for `compose_elements`
 * (`request_composer.cpp`) to drop from a request's chain, reading
 * `config.elementId` directly. It validates and has no `compile`, since nothing
 * constructs an `Element` from it.
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
        { "properties",
        { { "elementId",
        { { "type", "string" }, { "minLength", 1 }, { "title", "Element to disable" },
        { "description",
        "The id of an inherited element to drop from this request or "
        "collection's resolved list." } } } } },
        { "required", nlohmann::json::array ({ "elementId" }) },
        { "additionalProperties", false },
    };
    // No `compile`: this kind never becomes a running `Element`.
    return kind;
}

} // namespace vayu::core
