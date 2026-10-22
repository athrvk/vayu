#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file xml2js_glue.hpp
 * @brief The factory around the vendored `xml2js` (engine/vendor/xml2js,
 *        #2654), and the `xml2Json` global built over it.
 *
 * `XML2JS_GLUE_OPEN + XML2JS_JS + XML2JS_GLUE_CLOSE` is the source the shelf
 * evaluates. The library is xml2js 0.6.2 with sax and xmlbuilder bundled into
 * one file (the vendor README has the build); it assigns its members to the
 * free `exports`, so the glue gives it a factory-local `module` and `exports`
 * and the module is that object. The bundle's Node shims stay inside it: no
 * `Buffer`, `process` or `setImmediate` reaches the script.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view XML2JS_GLUE_OPEN = R"js((function () {
'use strict';
var module = { exports: {} };
var exports = module.exports;
)js";

inline constexpr std::string_view XML2JS_GLUE_CLOSE = R"js(
return module.exports;
}))js";

/**
 * A function that takes the xml2js module and returns Postman's `xml2Json`
 * (postman-sandbox's `lib/sandbox/xml2Json.js`, the same call with the same
 * options): a synchronous parse whose answer is what the callback was handed.
 * That is `undefined` for a document the parser refuses, `null` for empty
 * input, and `{}` should the callback never run. With `async: false` the
 * parser calls back before `parseString` returns.
 */
inline constexpr std::string_view XML2JSON_FROM_XML2JS = R"js((function (xml2js) {
'use strict';
var options = { explicitArray: false, async: false, trim: true, mergeAttrs: false };
return function xml2Json(string) {
    var result = {};
    xml2js.parseString(string, options, function (_, parsed) {
        result = parsed;
    });
    return result;
};
}))js";

} // namespace vayu::runtime::pm_detail
