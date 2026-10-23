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
 * all it needs. The module shares nothing with `pm.expect`, which is native
 * (`pm/pm_expect.cpp`): loading it, `use`-ing a plugin on it or calling its
 * `should()` leaves `pm.expect` as it was.
 *
 * One plugin is applied before the module is returned (#2751): the
 * chai-postman response assertions, so `expect(pm.response).to.have.status(200)`
 * answers as `pm.response.to.have.status(200)` does. It is JavaScript here and
 * not a second set of C++ matchers because it only forwards: every verdict and
 * message is the native chain's (`pm/pm_response.cpp`), so the two spellings
 * cannot drift. It adds nothing to the module's own members, a global, or
 * `pm.expect`.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view CHAI_GLUE_OPEN = R"js((function () {
'use strict';
var module = { exports: {} };
)js";

inline constexpr std::string_view CHAI_GLUE_CLOSE = R"js(
// Kept at load, so a script that assigns the global `pm` afterwards cannot
// redirect the assertions. `pm.response` itself is read at each call: the
// object is rebuilt for every execution.
var pm = globalThis.pm;

// What the native chain implements, by where it hangs: `to.have.<name>(...)`
// and `to.be.<name>`. Mirrors pm/pm_response.cpp (`have_matchers`,
// `status_class_matchers`, `to.be.json`, `to.be.withBody`).
var HAVE_METHODS = ['status', 'statusCode', 'statusReason', 'statusCodeClass',
  'header', 'body', 'jsonBody', 'jsonSchema'];
var HAVE_MEASURES = ['responseTime', 'responseSize'];
var BE_PROPERTIES = ['info', 'ok', 'success', 'accepted', 'withoutContent',
  'redirection', 'clientError', 'badRequest', 'unauthorized', 'unauthorised',
  'forbidden', 'notFound', 'notAcceptable', 'rateLimited', 'serverError',
  'error', 'json', 'withBody'];

module.exports.use(function (chai, utils) {
  var Assertion = chai.Assertion;

  function isResponse(assertion) {
    return !!pm && utils.flag(assertion, 'object') === pm.response;
  }

  // The native chain for this assertion's polarity. The native matchers read
  // the execution's response, so the target must be that response, or the
  // assertion would be about one thing and judge another.
  function nativeChain(assertion, name) {
    if (!isResponse(assertion)) {
      throw new TypeError('chai.' + name +
        ' expects pm.response as the target of expect()');
    }
    var to = pm.response.to;
    if (!to) {
      throw new Error('chai.' + name + ' needs a response and this ' +
        'execution has none');
    }
    return utils.flag(assertion, 'negate') ? to.not : to;
  }

  // A name chai already defines (`ok`) keeps chai's meaning for any other
  // target.
  function defineProperty(name, read) {
    if (!(name in Assertion.prototype)) {
      Assertion.addProperty(name, function () { return read(this); });
      return;
    }
    Assertion.overwriteProperty(name, function (original) {
      return function () {
        return isResponse(this) ? read(this) : original.call(this);
      };
    });
  }

  HAVE_METHODS.forEach(function (name) {
    Assertion.addMethod(name, function () {
      var have = nativeChain(this, name).have;
      have[name].apply(have, arguments);
    });
  });
  HAVE_MEASURES.forEach(function (name) {
    defineProperty(name, function (assertion) {
      return nativeChain(assertion, name).have[name];
    });
  });
  BE_PROPERTIES.forEach(function (name) {
    defineProperty(name, function (assertion) {
      // Reading the getter is the assertion.
      void nativeChain(assertion, name).be[name];
    });
  });
});

return module.exports;
}))js";

} // namespace vayu::runtime::pm_detail
