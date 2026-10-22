#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file ajv_glue.hpp
 * @brief The factory around the vendored `ajv` (engine/vendor/ajv, #2656).
 *
 * `AJV_GLUE_OPEN + AJV_JS + AJV_GLUE_CLOSE` is the source the shelf evaluates.
 * The library is npm's `dist/ajv.min.js`, unchanged: a browserify bundle of
 * ajv and its four dependencies behind a UMD wrapper. The glue gives it a
 * factory-local `module` and `exports`, so the wrapper takes its CommonJS
 * branch and assigns no `Ajv` global; Postman binds none either. The module is
 * the `Ajv` constructor.
 *
 * ajv compiles each schema into a function with `new Function`, which the
 * sandbox's context allows. The bundle's loader would fall back to the global
 * `require` (the shelf's) for a module missing from its map, but every module
 * ajv requires is in it, so the fallback is never reached.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view AJV_GLUE_OPEN = R"js((function () {
'use strict';
var module = { exports: {} };
var exports = module.exports;
)js";

inline constexpr std::string_view AJV_GLUE_CLOSE = R"js(
return module.exports;
}))js";

} // namespace vayu::runtime::pm_detail
