#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file uuid_glue.hpp
 * @brief The factory around the vendored `uuid` (engine/vendor/uuid, #2650).
 *
 * `UUID_GLUE_OPEN + UUID_JS + UUID_GLUE_CLOSE` is the source the shelf
 * evaluates. The library is npm's UMD build, unchanged; the glue gives it what
 * it reads from its scope, as locals of the factory so no script sees them:
 *
 * - `module` and `exports`, so the UMD takes its CommonJS branch and does not
 *   assign `globalThis.uuid`;
 * - `crypto.getRandomValues`, filled from `native.randomBytes` (libsodium's
 *   CSPRNG), because QuickJS has no Web Crypto and uuid refuses to run on
 *   anything weaker.
 *
 * The module it returns is callable: Postman's own `uuid` is a function that
 * answers a v4, and npm's is an object of `v1`, `v3`, `v4`, `v5`, `NIL`,
 * `parse`, `stringify`, `validate` and `version`. Vayu's is the function with
 * all of npm's members on it, so `require('uuid')()` and
 * `require('uuid').v4()` both run.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view UUID_GLUE_OPEN = R"js((function (native) {
'use strict';
var module = { exports: {} };
var exports = module.exports;
var crypto = {
  getRandomValues: function (array) {
    array.set(native.randomBytes(array.length));
    return array;
  }
};
)js";

inline constexpr std::string_view UUID_GLUE_CLOSE = R"js(
var api = module.exports;
var uuid = function uuid() {
  return api.v4.apply(this, arguments);
};
return Object.assign(uuid, api);
}))js";

} // namespace vayu::runtime::pm_detail
