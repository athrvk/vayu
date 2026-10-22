#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file moment_glue.hpp
 * @brief The factory around the vendored `moment` (engine/vendor/moment, #2652).
 *
 * `MOMENT_GLUE_OPEN + MOMENT_JS + MOMENT_GLUE_CLOSE` is the source the shelf
 * evaluates. The library is npm's `min/moment.min.js`, unchanged: the English
 * build with no locale files, which is what Postman's `require('moment')`
 * gives. The glue gives it a factory-local `module` and `exports`, so moment's
 * UMD wrapper takes its CommonJS branch and assigns no global. Postman binds
 * no `moment` global either, so the shelf defines none.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view MOMENT_GLUE_OPEN = R"js((function () {
'use strict';
var module = { exports: {} };
var exports = module.exports;
)js";

inline constexpr std::string_view MOMENT_GLUE_CLOSE = R"js(
return module.exports;
}))js";

} // namespace vayu::runtime::pm_detail
