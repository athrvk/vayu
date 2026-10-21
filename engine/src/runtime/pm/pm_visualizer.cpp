/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_visualizer.cpp
 * @brief `pm.visualizer` (#2577): Postman's calls, accepted and not rendered.
 *
 * Postman draws a Handlebars template over the response in its Visualize tab.
 * Vayu has no such tab, and a script that only wants one drawn is otherwise a
 * working script: left unbound, `pm.visualizer.set(...)` threw and ended the
 * script before its remaining `pm.test` calls. So the calls are accepted and
 * each leaves one `console.warn`, the only trace there is - the template and
 * its data are not kept anywhere.
 */

#include "pm_internal.hpp"

#include <string>

namespace vayu::runtime::pm_detail {
namespace {

void warn_not_rendered (JSContext* ctx, const char* call) {
    auto* data = get_context_data (ctx);
    if (!data) {
        return;
    }
    data->console_output.push_back ({ ConsoleLevel::Warn,
    std::string ("visualizer not rendered: pm.visualizer.") + call +
    "() is accepted so the script keeps running, but Vayu has no Visualize "
    "tab to draw it in" });
}

// pm.visualizer.set(template, data?, options?) - `template` is required and a
// string, refused loudly otherwise; `data` and `options` are taken as given
// and unread.
JSValue js_visualizer_set (JSContext* ctx, JSValueConst /*this_val*/, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx,
        "pm.visualizer.set(template, data, options) needs the template as a "
        "string");
    }
    warn_not_rendered (ctx, "set");
    return JS_UNDEFINED;
}

JSValue js_visualizer_clear (JSContext* ctx, JSValueConst /*this_val*/, int /*argc*/, JSValueConst* /*argv*/) {
    warn_not_rendered (ctx, "clear");
    return JS_UNDEFINED;
}

} // namespace

void setup_pm_visualizer (JSContext* ctx, JSValue pm) {
    JSValue visualizer = JS_NewObject (ctx);
    JS_SetPropertyStr (
    ctx, visualizer, "set", JS_NewCFunction (ctx, js_visualizer_set, "set", 3));
    JS_SetPropertyStr (ctx, visualizer, "clear",
    JS_NewCFunction (ctx, js_visualizer_clear, "clear", 0));
    JS_SetPropertyStr (ctx, pm, "visualizer", visualizer);
}

} // namespace vayu::runtime::pm_detail
