#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tv4_glue.hpp
 * @brief The factory around the vendored `tv4` (engine/vendor/tv4, #2656).
 *
 * `TV4_GLUE_OPEN + TV4_JS + TV4_GLUE_CLOSE` is the source the shelf evaluates.
 * The library is tv4 1.3.0's `tv4.js` minified by esbuild (the vendor README
 * has the command). The glue gives it a factory-local `module`, so its UMD
 * wrapper takes the CommonJS branch rather than assigning `tv4` on the global
 * object; the `tv4` global is the shelf's own accessor (`require_shelf.cpp`)
 * and answers the same object `require('tv4')` does, as in Postman. tv4 keeps
 * the last verdict on that object (`error`, `missing`, `valid`), so the global
 * and the module share it.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view TV4_GLUE_OPEN = R"js((function () {
'use strict';
var module = { exports: {} };
var exports = module.exports;
)js";

inline constexpr std::string_view TV4_GLUE_CLOSE = R"js(
return module.exports;
}))js";

} // namespace vayu::runtime::pm_detail
