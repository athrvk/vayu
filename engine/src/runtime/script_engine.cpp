/**
 * @file script_engine.cpp
 * @brief QuickJS-based JavaScript scripting engine implementation
 */

#include "vayu/runtime/script_engine.hpp"

#include <algorithm>
#include <mutex>
#include <sstream>
#include <vector>

#include "vayu/utils/json.hpp"

#ifdef VAYU_HAS_QUICKJS
// Disable warnings for QuickJS C header in C++ code
#if defined(__clang__) || defined(__GNUC__)
#pragma GCC diagnostic push
#if defined(__clang__)
#pragma GCC diagnostic ignored "-Wc99-extensions"
#pragma GCC diagnostic ignored "-Wcast-function-type-mismatch"
#pragma GCC diagnostic ignored "-Wshorten-64-to-32"
#endif
#pragma GCC diagnostic ignored "-Wsign-conversion"
#endif
extern "C" {
#include "quickjs.h"
}
#if defined(__clang__) || defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#endif

namespace vayu::runtime {

#ifdef VAYU_HAS_QUICKJS

// ============================================================================
// QuickJS Helper Functions
// ============================================================================

namespace {
// Context data stored in JS runtime
struct ContextData {
    std::vector<TestResult> tests;
    std::vector<std::string> console_output;
    const Request* request = nullptr;
    const Response* response = nullptr;
    Environment* environment = nullptr;
    bool has_error = false;
    std::string error_message;
};

// Get context data from JS context
ContextData* get_context_data(JSContext* ctx) {
    return static_cast<ContextData*>(JS_GetContextOpaque(ctx));
}

// Convert JS string to C++ string
std::string js_to_string(JSContext* ctx, JSValue val) {
    const char* str = JS_ToCString(ctx, val);
    if (!str) return "";
    std::string result(str);
    JS_FreeCString(ctx, str);
    return result;
}

// ============================================================================
// Console Implementation
// ============================================================================

JSValue js_console_log(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* data = get_context_data(ctx);
    std::stringstream ss;

    for (int i = 0; i < argc; i++) {
        if (i > 0) ss << " ";
        const char* str = JS_ToCString(ctx, argv[i]);
        if (str) {
            ss << str;
            JS_FreeCString(ctx, str);
        }
    }

    data->console_output.push_back(ss.str());
    return JS_UNDEFINED;
}

void setup_console(JSContext* ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue console = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, console, "log", JS_NewCFunction(ctx, js_console_log, "log", 1));
    JS_SetPropertyStr(ctx, console, "info", JS_NewCFunction(ctx, js_console_log, "info", 1));
    JS_SetPropertyStr(ctx, console, "warn", JS_NewCFunction(ctx, js_console_log, "warn", 1));
    JS_SetPropertyStr(ctx, console, "error", JS_NewCFunction(ctx, js_console_log, "error", 1));

    JS_SetPropertyStr(ctx, global, "console", console);
    JS_FreeValue(ctx, global);
}

// ============================================================================
// pm.expect() Chainable Assertions
// ============================================================================

// Expectation state stored in JS object
struct ExpectState {
    JSValue actual;
    bool negated = false;
};

JSClassID expect_class_id = 0;

void expect_finalizer(JSRuntime* rt, JSValue val) {
    auto* state = static_cast<ExpectState*>(JS_GetOpaque(val, expect_class_id));
    if (state) {
        JS_FreeValueRT(rt, state->actual);
        delete state;
    }
}

void expect_gc_mark(JSRuntime* rt, JSValueConst val, JS_MarkFunc* mark_func) {
    auto* state = static_cast<ExpectState*>(JS_GetOpaque(val, expect_class_id));
    if (state) {
        JS_MarkValue(rt, state->actual, mark_func);
    }
}

JSClassDef expect_class = {.class_name = "Expectation",
                           .finalizer = expect_finalizer,
                           .gc_mark = expect_gc_mark,
                           .call = nullptr,
                           .exotic = nullptr};

JSValue expect_to_getter(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void) argc;
    (void) argv;
    // "to" just returns this for chaining
    return JS_DupValue(ctx, this_val);
}

JSValue expect_not_getter(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void) argc;
    (void) argv;
    auto* state = static_cast<ExpectState*>(JS_GetOpaque(this_val, expect_class_id));
    if (state) {
        state->negated = !state->negated;
    }
    return JS_DupValue(ctx, this_val);
}

JSValue expect_be_getter(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void) argc;
    (void) argv;
    return JS_DupValue(ctx, this_val);
}

JSValue expect_equal(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "equal() requires an argument");
    }

    auto* state = static_cast<ExpectState*>(JS_GetOpaque(this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError(ctx, "Invalid expectation state");
    }

    // Compare values
    bool equal = false;

    // Handle different types
    if (JS_IsNumber(state->actual) && JS_IsNumber(argv[0])) {
        double a, b;
        JS_ToFloat64(ctx, &a, state->actual);
        JS_ToFloat64(ctx, &b, argv[0]);
        equal = (a == b);
    } else if (JS_IsString(state->actual) && JS_IsString(argv[0])) {
        std::string a = js_to_string(ctx, state->actual);
        std::string b = js_to_string(ctx, argv[0]);
        equal = (a == b);
    } else if (JS_IsBool(state->actual) && JS_IsBool(argv[0])) {
        equal = JS_ToBool(ctx, state->actual) == JS_ToBool(ctx, argv[0]);
    } else if (JS_IsNull(state->actual) && JS_IsNull(argv[0])) {
        equal = true;
    } else if (JS_IsUndefined(state->actual) && JS_IsUndefined(argv[0])) {
        equal = true;
    } else {
        // Try JSON comparison for objects
        JSValue json1 = JS_JSONStringify(ctx, state->actual, JS_UNDEFINED, JS_UNDEFINED);
        JSValue json2 = JS_JSONStringify(ctx, argv[0], JS_UNDEFINED, JS_UNDEFINED);
        if (!JS_IsException(json1) && !JS_IsException(json2)) {
            equal = js_to_string(ctx, json1) == js_to_string(ctx, json2);
        }
        JS_FreeValue(ctx, json1);
        JS_FreeValue(ctx, json2);
    }

    bool pass = state->negated ? !equal : equal;

    if (!pass) {
        std::string actual_str = js_to_string(ctx, state->actual);
        std::string expected_str = js_to_string(ctx, argv[0]);
        std::string msg = state->negated
                              ? "Expected " + actual_str + " to not equal " + expected_str
                              : "Expected " + actual_str + " to equal " + expected_str;
        return JS_ThrowTypeError(ctx, "%s", msg.c_str());
    }

    return JS_UNDEFINED;
}

JSValue expect_exist(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = static_cast<ExpectState*>(JS_GetOpaque(this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError(ctx, "Invalid expectation state");
    }

    bool exists = !JS_IsUndefined(state->actual) && !JS_IsNull(state->actual);
    bool pass = state->negated ? !exists : exists;

    if (!pass) {
        const char* msg =
            state->negated ? "Expected value to not exist" : "Expected value to exist";
        return JS_ThrowTypeError(ctx, "%s", msg);
    }

    return JS_UNDEFINED;
}

JSValue expect_true(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = static_cast<ExpectState*>(JS_GetOpaque(this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError(ctx, "Invalid expectation state");
    }

    bool is_true = JS_ToBool(ctx, state->actual) == 1;
    bool pass = state->negated ? !is_true : is_true;

    if (!pass) {
        const char* msg =
            state->negated ? "Expected value to be falsy" : "Expected value to be truthy";
        return JS_ThrowTypeError(ctx, "%s", msg);
    }

    return JS_UNDEFINED;
}

JSValue expect_false(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* state = static_cast<ExpectState*>(JS_GetOpaque(this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError(ctx, "Invalid expectation state");
    }

    bool is_false = JS_ToBool(ctx, state->actual) == 0;
    bool pass = state->negated ? !is_false : is_false;

    if (!pass) {
        const char* msg =
            state->negated ? "Expected value to not be false" : "Expected value to be false";
        return JS_ThrowTypeError(ctx, "%s", msg);
    }

    return JS_UNDEFINED;
}

JSValue expect_above(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "above() requires an argument");
    }

    auto* state = static_cast<ExpectState*>(JS_GetOpaque(this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError(ctx, "Invalid expectation state");
    }

    double actual, expected;
    if (JS_ToFloat64(ctx, &actual, state->actual) < 0 ||
        JS_ToFloat64(ctx, &expected, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "above() requires numeric values");
    }

    bool above = actual > expected;
    bool pass = state->negated ? !above : above;

    if (!pass) {
        std::string msg = state->negated ? "Expected " + std::to_string(actual) +
                                               " to not be above " + std::to_string(expected)
                                         : "Expected " + std::to_string(actual) + " to be above " +
                                               std::to_string(expected);
        return JS_ThrowTypeError(ctx, "%s", msg.c_str());
    }

    return JS_UNDEFINED;
}

JSValue expect_below(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "below() requires an argument");
    }

    auto* state = static_cast<ExpectState*>(JS_GetOpaque(this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError(ctx, "Invalid expectation state");
    }

    double actual, expected;
    if (JS_ToFloat64(ctx, &actual, state->actual) < 0 ||
        JS_ToFloat64(ctx, &expected, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "below() requires numeric values");
    }

    bool below = actual < expected;
    bool pass = state->negated ? !below : below;

    if (!pass) {
        std::string msg = state->negated ? "Expected " + std::to_string(actual) +
                                               " to not be below " + std::to_string(expected)
                                         : "Expected " + std::to_string(actual) + " to be below " +
                                               std::to_string(expected);
        return JS_ThrowTypeError(ctx, "%s", msg.c_str());
    }

    return JS_UNDEFINED;
}

JSValue expect_include(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "include() requires an argument");
    }

    auto* state = static_cast<ExpectState*>(JS_GetOpaque(this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError(ctx, "Invalid expectation state");
    }

    bool includes = false;

    if (JS_IsString(state->actual)) {
        std::string str = js_to_string(ctx, state->actual);
        std::string substr = js_to_string(ctx, argv[0]);
        includes = str.find(substr) != std::string::npos;
    } else if (JS_IsArray(ctx, state->actual)) {
        JSValue length = JS_GetPropertyStr(ctx, state->actual, "length");
        uint32_t len;
        JS_ToUint32(ctx, &len, length);
        JS_FreeValue(ctx, length);

        std::string needle = js_to_string(ctx, argv[0]);
        for (uint32_t i = 0; i < len; i++) {
            JSValue elem = JS_GetPropertyUint32(ctx, state->actual, i);
            if (js_to_string(ctx, elem) == needle) {
                includes = true;
            }
            JS_FreeValue(ctx, elem);
            if (includes) break;
        }
    }

    bool pass = state->negated ? !includes : includes;

    if (!pass) {
        const char* msg = state->negated ? "Expected value to not include the substring"
                                         : "Expected value to include the substring";
        return JS_ThrowTypeError(ctx, "%s", msg);
    }

    return JS_UNDEFINED;
}

JSValue expect_have_property(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "property() requires a property name");
    }

    auto* state = static_cast<ExpectState*>(JS_GetOpaque(this_val, expect_class_id));
    if (!state) {
        return JS_ThrowInternalError(ctx, "Invalid expectation state");
    }

    std::string prop_name = js_to_string(ctx, argv[0]);
    JSAtom atom = JS_NewAtom(ctx, prop_name.c_str());
    bool has_prop = JS_HasProperty(ctx, state->actual, atom) == 1;
    JS_FreeAtom(ctx, atom);

    // If second argument provided, also check value
    if (has_prop && argc >= 2) {
        JSValue actual_val = JS_GetPropertyStr(ctx, state->actual, prop_name.c_str());
        JSValue json1 = JS_JSONStringify(ctx, actual_val, JS_UNDEFINED, JS_UNDEFINED);
        JSValue json2 = JS_JSONStringify(ctx, argv[1], JS_UNDEFINED, JS_UNDEFINED);
        has_prop = js_to_string(ctx, json1) == js_to_string(ctx, json2);
        JS_FreeValue(ctx, json1);
        JS_FreeValue(ctx, json2);
        JS_FreeValue(ctx, actual_val);
    }

    bool pass = state->negated ? !has_prop : has_prop;

    if (!pass) {
        std::string msg = state->negated
                              ? "Expected object to not have property '" + prop_name + "'"
                              : "Expected object to have property '" + prop_name + "'";
        return JS_ThrowTypeError(ctx, "%s", msg.c_str());
    }

    return JS_UNDEFINED;
}

JSValue create_expectation(JSContext* ctx, JSValue actual) {
    JSValue obj = JS_NewObjectClass(ctx, static_cast<int>(expect_class_id));
    if (JS_IsException(obj)) {
        return obj;
    }

    auto* state = new ExpectState{JS_DupValue(ctx, actual), false};
    JS_SetOpaque(obj, state);

    // Add "to" getter for chaining
    JSAtom to_atom = JS_NewAtom(ctx, "to");
    JS_DefinePropertyGetSet(
        ctx, obj, to_atom, JS_NewCFunction(ctx, expect_to_getter, "to", 0), JS_UNDEFINED, 0);
    JS_FreeAtom(ctx, to_atom);

    // Add "not" getter for negation
    JSAtom not_atom = JS_NewAtom(ctx, "not");
    JS_DefinePropertyGetSet(
        ctx, obj, not_atom, JS_NewCFunction(ctx, expect_not_getter, "not", 0), JS_UNDEFINED, 0);
    JS_FreeAtom(ctx, not_atom);

    // Add "be" getter for chaining
    JSAtom be_atom = JS_NewAtom(ctx, "be");
    JS_DefinePropertyGetSet(
        ctx, obj, be_atom, JS_NewCFunction(ctx, expect_be_getter, "be", 0), JS_UNDEFINED, 0);
    JS_FreeAtom(ctx, be_atom);

    // Add "have" getter for chaining (same as "to")
    JSAtom have_atom = JS_NewAtom(ctx, "have");
    JS_DefinePropertyGetSet(
        ctx, obj, have_atom, JS_NewCFunction(ctx, expect_to_getter, "have", 0), JS_UNDEFINED, 0);
    JS_FreeAtom(ctx, have_atom);

    // Add assertion methods
    JS_SetPropertyStr(ctx, obj, "equal", JS_NewCFunction(ctx, expect_equal, "equal", 1));
    JS_SetPropertyStr(ctx, obj, "eql", JS_NewCFunction(ctx, expect_equal, "eql", 1));
    JS_SetPropertyStr(ctx, obj, "exist", JS_NewCFunction(ctx, expect_exist, "exist", 0));
    JS_SetPropertyStr(ctx, obj, "true", JS_NewCFunction(ctx, expect_true, "true", 0));
    JS_SetPropertyStr(ctx, obj, "false", JS_NewCFunction(ctx, expect_false, "false", 0));
    JS_SetPropertyStr(ctx, obj, "above", JS_NewCFunction(ctx, expect_above, "above", 1));
    JS_SetPropertyStr(ctx, obj, "below", JS_NewCFunction(ctx, expect_below, "below", 1));
    JS_SetPropertyStr(ctx, obj, "include", JS_NewCFunction(ctx, expect_include, "include", 1));
    JS_SetPropertyStr(
        ctx, obj, "property", JS_NewCFunction(ctx, expect_have_property, "property", 2));

    return obj;
}

// ============================================================================
// pm Object Implementation
// ============================================================================

JSValue js_pm_test(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "pm.test requires name and callback");
    }

    auto* data = get_context_data(ctx);
    std::string test_name = js_to_string(ctx, argv[0]);

    TestResult result;
    result.name = test_name;

    // Call the test function
    JSValue ret = JS_Call(ctx, argv[1], JS_UNDEFINED, 0, nullptr);

    if (JS_IsException(ret)) {
        JSValue exc = JS_GetException(ctx);
        result.passed = false;
        result.error_message = js_to_string(ctx, exc);
        JS_FreeValue(ctx, exc);
    } else {
        result.passed = true;
    }

    JS_FreeValue(ctx, ret);
    data->tests.push_back(std::move(result));

    return JS_UNDEFINED;
}

JSValue js_pm_expect(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "pm.expect requires a value");
    }

    return create_expectation(ctx, argv[0]);
}

JSValue js_response_json(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* data = get_context_data(ctx);
    if (!data->response) {
        return JS_ThrowInternalError(ctx, "No response available");
    }

    JSValue json =
        JS_ParseJSON(ctx, data->response->body.c_str(), data->response->body.size(), "<response>");
    if (JS_IsException(json)) {
        return JS_ThrowTypeError(ctx, "Response body is not valid JSON");
    }

    return json;
}

JSValue js_response_text(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* data = get_context_data(ctx);
    if (!data->response) {
        return JS_ThrowInternalError(ctx, "No response available");
    }

    return JS_NewString(ctx, data->response->body.c_str());
}

// ============================================================================
// pm.response.to.have Assertions (Postman-compatible)
// ============================================================================

JSValue js_response_have_status(JSContext* ctx,
                                JSValueConst this_val,
                                int argc,
                                JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "status() requires an expected status code");
    }

    auto* data = get_context_data(ctx);
    if (!data->response) {
        return JS_ThrowInternalError(ctx, "No response available");
    }

    int32_t expected_status;
    if (JS_ToInt32(ctx, &expected_status, argv[0]) < 0) {
        return JS_ThrowTypeError(ctx, "status() expects a number");
    }

    if (data->response->status_code != expected_status) {
        std::string msg = "Expected status code " + std::to_string(expected_status) + " but got " +
                          std::to_string(data->response->status_code);
        return JS_ThrowTypeError(ctx, "%s", msg.c_str());
    }

    return JS_UNDEFINED;
}

JSValue js_response_have_header(JSContext* ctx,
                                JSValueConst this_val,
                                int argc,
                                JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "header() requires a header name");
    }

    auto* data = get_context_data(ctx);
    if (!data->response) {
        return JS_ThrowInternalError(ctx, "No response available");
    }

    std::string header_name = js_to_string(ctx, argv[0]);

    // Case-insensitive header lookup
    bool found = false;
    std::string found_value;
    for (const auto& [key, value] : data->response->headers) {
        std::string lower_key = key;
        std::string lower_name = header_name;
        std::transform(lower_key.begin(), lower_key.end(), lower_key.begin(), ::tolower);
        std::transform(lower_name.begin(), lower_name.end(), lower_name.begin(), ::tolower);
        if (lower_key == lower_name) {
            found = true;
            found_value = value;
            break;
        }
    }

    if (!found) {
        std::string msg = "Expected response to have header '" + header_name + "'";
        return JS_ThrowTypeError(ctx, "%s", msg.c_str());
    }

    // If a second argument is provided, check the value
    if (argc >= 2) {
        std::string expected_value = js_to_string(ctx, argv[1]);
        if (found_value != expected_value) {
            std::string msg = "Expected header '" + header_name + "' to be '" + expected_value +
                              "' but got '" + found_value + "'";
            return JS_ThrowTypeError(ctx, "%s", msg.c_str());
        }
    }

    return JS_UNDEFINED;
}

JSValue js_response_have_body(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "body() requires expected content");
    }

    auto* data = get_context_data(ctx);
    if (!data->response) {
        return JS_ThrowInternalError(ctx, "No response available");
    }

    std::string expected = js_to_string(ctx, argv[0]);

    if (data->response->body.find(expected) == std::string::npos) {
        std::string msg = "Expected response body to contain '" + expected + "'";
        return JS_ThrowTypeError(ctx, "%s", msg.c_str());
    }

    return JS_UNDEFINED;
}

JSValue js_response_have_jsonBody(JSContext* ctx,
                                  JSValueConst this_val,
                                  int argc,
                                  JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "jsonBody() requires a property path");
    }

    auto* data = get_context_data(ctx);
    if (!data->response) {
        return JS_ThrowInternalError(ctx, "No response available");
    }

    std::string prop_path = js_to_string(ctx, argv[0]);

    // Parse body as JSON
    JSValue json =
        JS_ParseJSON(ctx, data->response->body.c_str(), data->response->body.size(), "<response>");
    if (JS_IsException(json)) {
        return JS_ThrowTypeError(ctx, "Response body is not valid JSON");
    }

    // Navigate to the property
    JSValue current = JS_DupValue(ctx, json);
    std::string::size_type start = 0;
    std::string::size_type end;

    while ((end = prop_path.find('.', start)) != std::string::npos || start < prop_path.size()) {
        std::string key = (end != std::string::npos) ? prop_path.substr(start, end - start)
                                                     : prop_path.substr(start);

        if (key.empty()) break;

        JSValue next = JS_GetPropertyStr(ctx, current, key.c_str());
        JS_FreeValue(ctx, current);
        current = next;

        if (JS_IsUndefined(current)) {
            JS_FreeValue(ctx, json);
            std::string msg = "Expected response body to have property '" + prop_path + "'";
            return JS_ThrowTypeError(ctx, "%s", msg.c_str());
        }

        if (end == std::string::npos) break;
        start = end + 1;
    }

    JS_FreeValue(ctx, current);
    JS_FreeValue(ctx, json);
    return JS_UNDEFINED;
}

// Create the pm.response.to.have chain object
JSValue create_response_have_object(JSContext* ctx) {
    JSValue have = JS_NewObject(ctx);
    JS_SetPropertyStr(
        ctx, have, "status", JS_NewCFunction(ctx, js_response_have_status, "status", 1));
    JS_SetPropertyStr(
        ctx, have, "header", JS_NewCFunction(ctx, js_response_have_header, "header", 2));
    JS_SetPropertyStr(ctx, have, "body", JS_NewCFunction(ctx, js_response_have_body, "body", 1));
    JS_SetPropertyStr(
        ctx, have, "jsonBody", JS_NewCFunction(ctx, js_response_have_jsonBody, "jsonBody", 1));
    return have;
}

// Create the pm.response.to chain object
JSValue create_response_to_object(JSContext* ctx) {
    JSValue to = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, to, "have", create_response_have_object(ctx));
    JS_SetPropertyStr(ctx, to, "be", JS_NewObject(ctx));  // placeholder for future assertions
    return to;
}

void setup_pm_response(JSContext* ctx, JSValue pm) {
    auto* data = get_context_data(ctx);

    // Free old response object if it exists to prevent memory leak
    JSValue old_response = JS_GetPropertyStr(ctx, pm, "response");
    if (!JS_IsUndefined(old_response)) {
        JS_FreeValue(ctx, old_response);
    }

    JSValue response = JS_NewObject(ctx);

    if (data && data->response) {
        // pm.response.code
        JS_SetPropertyStr(ctx, response, "code", JS_NewInt32(ctx, data->response->status_code));

        // pm.response.status (same as code for compatibility)
        JS_SetPropertyStr(ctx, response, "status", JS_NewInt32(ctx, data->response->status_code));

        // pm.response.responseTime
        JS_SetPropertyStr(
            ctx, response, "responseTime", JS_NewFloat64(ctx, data->response->timing.total_ms));

        // pm.response.json()
        JS_SetPropertyStr(ctx, response, "json", JS_NewCFunction(ctx, js_response_json, "json", 0));

        // pm.response.text()
        JS_SetPropertyStr(ctx, response, "text", JS_NewCFunction(ctx, js_response_text, "text", 0));

        // pm.response.headers
        JSValue headers = JS_NewObject(ctx);
        for (const auto& [key, value] : data->response->headers) {
            JS_SetPropertyStr(ctx, headers, key.c_str(), JS_NewString(ctx, value.c_str()));
        }
        JS_SetPropertyStr(ctx, response, "headers", headers);

        // pm.response.to.have chain for Postman-compatible assertions
        JS_SetPropertyStr(ctx, response, "to", create_response_to_object(ctx));
    }

    JS_SetPropertyStr(ctx, pm, "response", response);
}

void setup_pm_request(JSContext* ctx, JSValue pm) {
    auto* data = get_context_data(ctx);

    // Free old request object if it exists to prevent memory leak
    JSValue old_request = JS_GetPropertyStr(ctx, pm, "request");
    if (!JS_IsUndefined(old_request)) {
        JS_FreeValue(ctx, old_request);
    }

    JSValue request = JS_NewObject(ctx);

    if (data && data->request) {
        // pm.request.url
        JS_SetPropertyStr(ctx, request, "url", JS_NewString(ctx, data->request->url.c_str()));

        // pm.request.method
        JS_SetPropertyStr(
            ctx, request, "method", JS_NewString(ctx, to_string(data->request->method)));

        // pm.request.headers
        JSValue headers = JS_NewObject(ctx);
        for (const auto& [key, value] : data->request->headers) {
            JS_SetPropertyStr(ctx, headers, key.c_str(), JS_NewString(ctx, value.c_str()));
        }
        JS_SetPropertyStr(ctx, request, "headers", headers);

        // pm.request.body
        if (data->request->body.mode != BodyMode::None) {
            JS_SetPropertyStr(
                ctx, request, "body", JS_NewString(ctx, data->request->body.content.c_str()));
        }
    }

    JS_SetPropertyStr(ctx, pm, "request", request);
}

JSValue js_pm_environment_get(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    auto* data = get_context_data(ctx);
    if (!data->environment) {
        return JS_UNDEFINED;
    }

    std::string key = js_to_string(ctx, argv[0]);
    auto it = data->environment->find(key);
    if (it != data->environment->end() && it->second.enabled) {
        return JS_NewString(ctx, it->second.value.c_str());
    }

    return JS_UNDEFINED;
}

JSValue js_pm_environment_set(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 2) {
        return JS_UNDEFINED;
    }

    auto* data = get_context_data(ctx);
    if (!data->environment) {
        return JS_UNDEFINED;
    }

    std::string key = js_to_string(ctx, argv[0]);
    std::string value = js_to_string(ctx, argv[1]);

    (*data->environment)[key] = Variable{value, false, true};

    return JS_UNDEFINED;
}

void setup_pm_environment(JSContext* ctx, JSValue pm) {
    JSValue env = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, env, "get", JS_NewCFunction(ctx, js_pm_environment_get, "get", 1));
    JS_SetPropertyStr(ctx, env, "set", JS_NewCFunction(ctx, js_pm_environment_set, "set", 2));

    JS_SetPropertyStr(ctx, pm, "environment", env);
}

void setup_pm_object(JSContext* ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue pm = JS_NewObject(ctx);

    // pm.test()
    JS_SetPropertyStr(ctx, pm, "test", JS_NewCFunction(ctx, js_pm_test, "test", 2));

    // pm.expect()
    JS_SetPropertyStr(ctx, pm, "expect", JS_NewCFunction(ctx, js_pm_expect, "expect", 1));

    // pm.response
    setup_pm_response(ctx, pm);

    // pm.request
    setup_pm_request(ctx, pm);

    // pm.environment
    setup_pm_environment(ctx, pm);

    JS_SetPropertyStr(ctx, global, "pm", pm);
    JS_FreeValue(ctx, global);
}

}  // anonymous namespace

// ============================================================================
// ScriptEngine Implementation
// ============================================================================

class ScriptEngine::Impl {
public:
    ScriptConfig config;
    // Pool of Runtime+Context pairs
    // We need separate runtimes because QuickJS JSRuntime is not thread-safe
    using ContextPair = std::pair<JSRuntime*, JSContext*>;
    std::vector<ContextPair> context_pool;
    std::mutex pool_mutex;

    explicit Impl(const ScriptConfig& cfg) : config(cfg) {}

    ~Impl() {
        std::lock_guard<std::mutex> lock(pool_mutex);
        for (auto& pair : context_pool) {
            JS_FreeContext(pair.second);
            JS_FreeRuntime(pair.first);
        }
        context_pool.clear();
    }

    ContextPair acquire_context() {
        std::lock_guard<std::mutex> lock(pool_mutex);
        if (!context_pool.empty()) {
            ContextPair pair = context_pool.back();
            context_pool.pop_back();
            return pair;
        }

        // Create new runtime and context
        JSRuntime* rt = JS_NewRuntime();
        if (!rt) return {nullptr, nullptr};

        JS_SetMemoryLimit(rt, config.memory_limit);
        JS_SetMaxStackSize(rt, config.stack_size);

        // Register Expectation class
        if (expect_class_id == 0) {
            JS_NewClassID(&expect_class_id);
        }
        JS_NewClass(rt, expect_class_id, &expect_class);

        JSContext* ctx = JS_NewContext(rt);
        if (ctx) {
            if (config.enable_console) {
                setup_console(ctx);
            }
            setup_pm_object(ctx);
        } else {
            JS_FreeRuntime(rt);
            return {nullptr, nullptr};
        }

        return {rt, ctx};
    }

    void release_context(ContextPair pair) {
        if (!pair.first || !pair.second) return;

        // Run garbage collection before returning to pool to free any unreferenced objects
        // This prevents memory buildup from script execution
        JS_RunGC(pair.first);

        std::lock_guard<std::mutex> lock(pool_mutex);
        context_pool.push_back(pair);
    }

    ScriptResult execute(const std::string& script, const ScriptContext& ctx) {
        ScriptResult result;

        // Acquire runtime/context pair
        ContextPair pair = acquire_context();
        JSRuntime* rt = pair.first;
        JSContext* js_ctx = pair.second;

        if (!rt || !js_ctx) {
            result.success = false;
            result.error_message = "Failed to create QuickJS runtime/context";
            return result;
        }

        // Set up context data
        ContextData ctx_data;
        ctx_data.request = ctx.request;
        ctx_data.response = ctx.response;
        ctx_data.environment = ctx.environment;
        JS_SetContextOpaque(js_ctx, &ctx_data);

        // Refresh pm.request and pm.response with new data
        JSValue global = JS_GetGlobalObject(js_ctx);
        JSValue pm = JS_GetPropertyStr(js_ctx, global, "pm");
        if (!JS_IsUndefined(pm)) {
            setup_pm_response(js_ctx, pm);
            setup_pm_request(js_ctx, pm);
        }
        JS_FreeValue(js_ctx, pm);
        JS_FreeValue(js_ctx, global);

        // Wrap script in IIFE to avoid global scope pollution
        std::string wrapped_script = "(function() { " + script + " \n})()";

        // Execute script
        JSValue eval_result = JS_Eval(
            js_ctx, wrapped_script.c_str(), wrapped_script.size(), "<script>", JS_EVAL_TYPE_GLOBAL);

        if (JS_IsException(eval_result)) {
            JSValue exc = JS_GetException(js_ctx);
            result.success = false;
            result.error_message = js_to_string(js_ctx, exc);
            JS_FreeValue(js_ctx, exc);
        } else {
            result.success = true;
        }

        JS_FreeValue(js_ctx, eval_result);

        // Copy results
        result.tests = std::move(ctx_data.tests);
        result.console_output = std::move(ctx_data.console_output);

        // Check if any tests failed
        for (const auto& test : result.tests) {
            if (!test.passed) {
                result.success = false;
                break;
            }
        }

        // Return context to pool
        release_context(pair);
        return result;
    }
};

ScriptEngine::ScriptEngine(const ScriptConfig& config) : impl_(std::make_unique<Impl>(config)) {}

ScriptEngine::~ScriptEngine() = default;

ScriptEngine::ScriptEngine(ScriptEngine&&) noexcept = default;
ScriptEngine& ScriptEngine::operator=(ScriptEngine&&) noexcept = default;

ScriptResult ScriptEngine::execute(const std::string& script, const ScriptContext& ctx) {
    return impl_->execute(script, ctx);
}

ScriptResult ScriptEngine::execute_prerequest(const std::string& script,
                                              Request& request,
                                              Environment& env) {
    ScriptContext ctx;
    ctx.request = &request;
    ctx.environment = &env;
    return execute(script, ctx);
}

ScriptResult ScriptEngine::execute_test(const std::string& script,
                                        const Request& request,
                                        const Response& response,
                                        Environment& env) {
    ScriptContext ctx;
    ctx.request = &request;
    ctx.response = &response;
    ctx.environment = &env;
    return execute(script, ctx);
}

bool ScriptEngine::is_available() {
    return true;
}

std::string ScriptEngine::version() {
    return "QuickJS 2024-01-13";
}

#else  // !VAYU_HAS_QUICKJS

// ============================================================================
// Stub Implementation (No QuickJS)
// ============================================================================

class ScriptEngine::Impl {};

ScriptEngine::ScriptEngine(const ScriptConfig&) : impl_(nullptr) {}

ScriptEngine::~ScriptEngine() = default;
ScriptEngine::ScriptEngine(ScriptEngine&&) noexcept = default;
ScriptEngine& ScriptEngine::operator=(ScriptEngine&&) noexcept = default;

ScriptResult ScriptEngine::execute(const std::string&, const ScriptContext&) {
    ScriptResult result;
    result.success = false;
    result.error_message = "Scripting not available (QuickJS not compiled)";
    return result;
}

ScriptResult ScriptEngine::execute_prerequest(const std::string&, Request&, Environment&) {
    ScriptResult result;
    result.success = false;
    result.error_message = "Scripting not available (QuickJS not compiled)";
    return result;
}

ScriptResult ScriptEngine::execute_test(const std::string&,
                                        const Request&,
                                        const Response&,
                                        Environment&) {
    ScriptResult result;
    result.success = false;
    result.error_message = "Scripting not available (QuickJS not compiled)";
    return result;
}

bool ScriptEngine::is_available() {
    return false;
}

std::string ScriptEngine::version() {
    return "";
}

#endif  // VAYU_HAS_QUICKJS

}  // namespace vayu::runtime
