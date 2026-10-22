#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file chai_glue.hpp
 * @brief The factory around the vendored `chai` (engine/vendor/chai, #2655).
 *
 * `CHAI_GLUE_OPEN + CHAI_JS + CHAI_GLUE_CLOSE` is the source the shelf
 * evaluates. The library is chai 4.4.1 with its seven dependencies bundled into
 * one file (the vendor README has the build); it assigns `module.exports` and
 * reads nothing else from its scope, so the glue's factory-local `module` is
 * all it needs. The module is the library as it ships and shares nothing with
 * `pm.expect`, which is native (`pm/pm_expect.cpp`): loading it, `use`-ing a
 * plugin on it or calling its `should()` leaves `pm.expect` as it was.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view CHAI_GLUE_OPEN = R"js((function () {
'use strict';
var module = { exports: {} };
)js";

inline constexpr std::string_view CHAI_GLUE_CLOSE = R"js(
return module.exports;
}))js";

} // namespace vayu::runtime::pm_detail
