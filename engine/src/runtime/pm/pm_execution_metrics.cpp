/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_execution_metrics.cpp
 * @brief `pm.execution` (flow control) and `pm.metrics` (custom metrics).
 */

#include "pm_internal.hpp"

#include <cmath>
#include <optional>
#include <string>
#include <utility>

namespace vayu::runtime::pm_detail {
namespace {

// ============================================================================
// pm.execution - flow control (issue #355)
// ============================================================================

// The context a flow-control call may record on, or nullptr having thrown.
// Outside a scenario run there is no sequence to redirect, and the call is
// refused rather than accepted and dropped: `setNextRequest("checkout")`
// silently ignored in a single send is the false success issue #188's rule
// exists to prevent.
ContextData* execution_context (JSContext* ctx, const char* member) {
    auto* data = get_context_data (ctx);
    if (!data) {
        JS_ThrowInternalError (ctx, "No script context available");
        return nullptr;
    }
    if (!data->in_scenario) {
        // Kept under 256 bytes with the longest member name substituted
        // (issue #1503): QuickJS formats this into a fixed-size buffer
        // (`JS_MakeError`, `vendor/quickjs-ng/quickjs.c`) and silently cuts
        // whatever does not fit, mid-word - a vendored bound this file
        // cannot raise, so the fix is a message that stays under it.
        JS_ThrowPlainError (ctx,
        "pm.execution.%s is not available here: a single send has no next "
        "request, and a load run's scripts run after it finishes, against "
        "recorded responses. See docs/engine/scripting.md.",
        member);
        return nullptr;
    }
    return data;
}

// pm.execution.setNextRequest(name) - jump to the named step after this one
// completes; setNextRequest(null) ends the iteration (Postman's convention).
//
// The argument is required and must be a string or null. Omitting it is a
// TypeError rather than a synonym for null: "end the iteration" and "I forgot
// the name" are different intents, and guessing between them would silently
// end runs.
JSValue js_execution_set_next_request (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto* data = execution_context (ctx, "setNextRequest");
    if (!data) {
        return JS_EXCEPTION;
    }

    if (argc < 1) {
        return JS_ThrowTypeError (ctx,
        "pm.execution.setNextRequest(name) needs a request name, or null to "
        "end this iteration - it was called with no argument");
    }
    if (JS_IsNull (argv[0])) {
        data->control = { ScriptControl::Kind::EndIteration, {} };
        return JS_UNDEFINED;
    }
    if (!JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx,
        "pm.execution.setNextRequest(name) needs a request name string, or "
        "null to end this iteration - got %s",
        js_type_name (ctx, argv[0]));
    }

    std::string target = js_to_string (ctx, argv[0]);
    if (target.empty ()) {
        return JS_ThrowTypeError (ctx,
        "pm.execution.setNextRequest(name) was given an empty name, which "
        "matches no request - pass a request's name, or null to end this "
        "iteration");
    }
    data->control = { ScriptControl::Kind::Next, std::move (target) };
    return JS_UNDEFINED;
}

// pm.execution.skipRequest() - do not send this step.
//
// Pre-request only. In a test script the request has already gone out and
// there is nothing left to skip, so the call throws instead of recording an
// intent the runner would have to refuse afterwards.
JSValue js_execution_skip_request (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = execution_context (ctx, "skipRequest");
    if (!data) {
        return JS_EXCEPTION;
    }
    if (data->event && *data->event == ScriptEvent::Test) {
        return JS_ThrowPlainError (ctx,
        "pm.execution.skipRequest() can only be called from a pre-request "
        "script: by the time a test script runs, the request has already been "
        "sent and there is nothing left to skip.");
    }
    data->control = { ScriptControl::Kind::Skip, {} };
    return JS_UNDEFINED;
}

} // namespace

// pm.execution - always bound, like pm.cookies, so a script that reaches for it
// outside a collection run is told why rather than meeting "not a function".
void setup_pm_execution (JSContext* ctx, JSValue pm) {
    JSValue execution = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, execution, "setNextRequest",
    JS_NewCFunction (ctx, js_execution_set_next_request, "setNextRequest", 1));
    JS_SetPropertyStr (ctx, execution, "skipRequest",
    JS_NewCFunction (ctx, js_execution_skip_request, "skipRequest", 0));
    JS_SetPropertyStr (ctx, pm, "execution", execution);
}

namespace {

// ============================================================================
// pm.metrics - custom trends, counters and rates (issue #1500)
// ============================================================================

// The context a metrics call may record on, or nullptr having thrown. A
// context with no bound collector - a context built by hand, or the deferred
// `tests` replay running against a recorded sample rather than the run - has
// nowhere for the value to go, and the call is refused rather than accepted
// and dropped, the same false-success reasoning `execution_context` documents.
ContextData* metrics_context (JSContext* ctx, const char* member) {
    auto* data = get_context_data (ctx);
    if (!data) {
        JS_ThrowInternalError (ctx, "No script context available");
        return nullptr;
    }
    if (!data->record_metric) {
        // Kept under 256 bytes for the reason `execution_context`'s message
        // is (issue #1503's vendored `JS_MakeError` buffer).
        JS_ThrowPlainError (ctx,
        "pm.metrics.%s is not available here: this script has no run to "
        "record into - a bare send, and the deferred replay against a "
        "recorded sample, are not the run itself. See "
        "docs/engine/scripting.md.",
        member);
        return nullptr;
    }
    return data;
}

// The `name` argument every pm.metrics call takes first: a non-empty string,
// or a TypeError - an empty or missing name has nowhere to be reported under.
std::optional<std::string>
js_metric_name (JSContext* ctx, JSValueConst arg, const char* member) {
    if (!JS_IsString (arg)) {
        JS_ThrowTypeError (ctx, "pm.metrics.%s(name, ...) needs a metric name string", member);
        return std::nullopt;
    }
    std::string name = js_to_string (ctx, arg);
    if (name.empty ()) {
        JS_ThrowTypeError (ctx, "pm.metrics.%s(name, ...) was given an empty name", member);
        return std::nullopt;
    }
    return name;
}

// pm.metrics.trend(name, value) - one distribution sample.
JSValue js_pm_metrics_trend (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto* data = metrics_context (ctx, "trend");
    if (!data) {
        return JS_EXCEPTION;
    }
    if (argc < 2) {
        return JS_ThrowTypeError (ctx, "pm.metrics.trend(name, value) needs both arguments");
    }
    const auto name = js_metric_name (ctx, argv[0], "trend");
    double value    = 0.0;
    if (!name || JS_ToFloat64 (ctx, &value, argv[1]) != 0) {
        return name ?
        JS_ThrowTypeError (ctx, "pm.metrics.trend(name, value) needs a numeric value") :
        JS_EXCEPTION;
    }
    data->record_metric (*name, vayu::core::CustomMetricType::Trend, value);
    return JS_UNDEFINED;
}

// pm.metrics.counter(name, increment = 1) - added to a running total. An
// explicit `undefined` takes the default, as a JS default parameter would.
// A negative or non-finite increment is refused rather than recorded (#1937):
// a counter only grows, and NaN or Infinity would poison the total for good.
JSValue js_pm_metrics_counter (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto* data = metrics_context (ctx, "counter");
    if (!data) {
        return JS_EXCEPTION;
    }
    if (argc < 1) {
        return JS_ThrowTypeError (ctx, "pm.metrics.counter(name, increment?) needs a name");
    }
    const auto name = js_metric_name (ctx, argv[0], "counter");
    if (!name) {
        return JS_EXCEPTION;
    }
    double increment = 1.0;
    if (argc >= 2 && !JS_IsUndefined (argv[1])) {
        if (JS_ToFloat64 (ctx, &increment, argv[1]) != 0) {
            return JS_ThrowTypeError (ctx,
            "pm.metrics.counter(name, increment?) needs a numeric increment");
        }
        if (!std::isfinite (increment) || increment < 0.0) {
            return JS_ThrowTypeError (
            ctx, "pm.metrics.counter(name, increment?) needs a finite increment of 0 or more");
        }
    }
    data->record_metric (*name, vayu::core::CustomMetricType::Counter, increment);
    return JS_UNDEFINED;
}

// pm.metrics.rate(name, value) - one true/false sample toward a percentage.
JSValue js_pm_metrics_rate (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto* data = metrics_context (ctx, "rate");
    if (!data) {
        return JS_EXCEPTION;
    }
    if (argc < 2) {
        return JS_ThrowTypeError (ctx, "pm.metrics.rate(name, value) needs both arguments");
    }
    const auto name = js_metric_name (ctx, argv[0], "rate");
    if (!name) {
        return JS_EXCEPTION;
    }
    const bool matched = JS_ToBool (ctx, argv[1]) != 0;
    data->record_metric (*name, vayu::core::CustomMetricType::Rate, matched ? 1.0 : 0.0);
    return JS_UNDEFINED;
}

} // namespace

// pm.metrics - always bound, like pm.execution, so a script that reaches for
// it with no run behind it is told why rather than meeting "not a function".
void setup_pm_metrics (JSContext* ctx, JSValue pm) {
    JSValue metrics = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, metrics, "trend",
    JS_NewCFunction (ctx, js_pm_metrics_trend, "trend", 2));
    JS_SetPropertyStr (ctx, metrics, "counter",
    JS_NewCFunction (ctx, js_pm_metrics_counter, "counter", 1));
    JS_SetPropertyStr (
    ctx, metrics, "rate", JS_NewCFunction (ctx, js_pm_metrics_rate, "rate", 2));
    JS_SetPropertyStr (ctx, pm, "metrics", metrics);
}

} // namespace vayu::runtime::pm_detail
