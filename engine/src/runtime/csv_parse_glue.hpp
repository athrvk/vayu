#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file csv_parse_glue.hpp
 * @brief The factory around the vendored `csv-parse/lib/sync`
 *        (engine/vendor/csv-parse, #2653).
 *
 * `CSV_PARSE_GLUE_OPEN + CSV_PARSE_SYNC_JS + CSV_PARSE_GLUE_CLOSE` is the
 * source the shelf evaluates. The library is csv-parse 1.2.4's `lib/sync.js`
 * bundled into one file (the vendor README has the build); it assigns
 * `module.exports` the parse function and reads nothing else from its scope,
 * so the glue's factory-local `module` is all it needs and the module is the
 * function itself, as Postman's `require('csv-parse/lib/sync')` is. The
 * bundle's Node shims stay inside it: no `Buffer`, `process` or stream
 * reaches the script.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view CSV_PARSE_GLUE_OPEN = R"js((function () {
'use strict';
var module = { exports: {} };
)js";

inline constexpr std::string_view CSV_PARSE_GLUE_CLOSE = R"js(
return module.exports;
}))js";

} // namespace vayu::runtime::pm_detail
