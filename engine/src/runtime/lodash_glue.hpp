#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file lodash_glue.hpp
 * @brief The factory around the vendored `lodash` (engine/vendor/lodash, #2651).
 *
 * `LODASH_GLUE_OPEN + LODASH_JS + LODASH_GLUE_CLOSE` is the source the shelf
 * evaluates. The library is npm's `lodash.min.js`, unchanged. The glue gives it
 * a factory-local `module` and `exports`, so lodash takes its CommonJS branch
 * (`freeModule`) and does not assign `globalThis._`; the `_` global is the
 * shelf's own accessor (`require_shelf.cpp`). The sandbox has no `global`,
 * `process` or `module.require`, so none of lodash's Node probes find anything.
 *
 * lodash reads `globalThis._` once while it evaluates (the `noConflict`
 * restore value), which reaches the shelf's accessor mid-load; `load_library`
 * answers `undefined` to that read.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view LODASH_GLUE_OPEN = R"js((function () {
'use strict';
var module = { exports: {} };
var exports = module.exports;
)js";

inline constexpr std::string_view LODASH_GLUE_CLOSE = R"js(
return module.exports;
}))js";

} // namespace vayu::runtime::pm_detail
