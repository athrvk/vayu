/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `pm.environment`, `pm.globals`, `pm.collectionVariables`, `pm.variables` and
 * `pm.iterationData`.
 */

#include "pm_internal.hpp"

#include <cctype>
#include <chrono>
#include <iterator>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "vayu/http/request_composer.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::runtime::pm_detail {
namespace {

// ============================================================================
// Variable Type Casting
// ============================================================================

// `json` parsed, or `text` as a string when `json` does not parse, so a script
// author reading a malformed json row can see what is there.
JSValue parse_json_or_text (JSContext* ctx, const std::string& json, const std::string& text) {
    JSValue parsed = JS_ParseJSON (ctx, json.c_str (), json.size (), "<variable>");
    if (JS_IsException (parsed)) {
        JS_FreeValue (ctx, parsed);
        // The parse error must not leak into the script.
        JSValue err = JS_GetException (ctx);
        JS_FreeValue (ctx, err);
        return JS_NewString (ctx, text.c_str ());
    }
    return parsed;
}

// The value a script set on `var` this run (#2529), rebuilt in this context.
JSValue carried_to_jsvalue (JSContext* ctx, const Variable& var) {
    const ScriptValue& carried = var.script_value;
    switch (carried.kind) {
    case ScriptValue::Kind::Undefined: return JS_UNDEFINED;
    case ScriptValue::Kind::Number: return JS_NewFloat64 (ctx, carried.number);
    case ScriptValue::Kind::Json:
        return parse_json_or_text (ctx, carried.json, var.value);
    case ScriptValue::Kind::None: break;
    }
    return JS_NewString (ctx, var.value.c_str ());
}

// A Variable as the JSValue a script reads. A value a script set this run
// answers as itself, but only on a default-type row: Vayu's "string" stands for
// Postman's `any` as well as a declared string, and Postman passes `any`
// through while casting a declared type (#2529). Otherwise the stored text is
// cast by type, as the app's `castByType` (app/src/lib/variable-cast.ts) does,
// so a loaded row reads alike in both runtimes.
JSValue cast_variable_to_jsvalue (JSContext* ctx, const Variable& var) {
    const std::string& type = var.type.empty () ? std::string{ "string" } : var.type;

    if (type == "string" && var.script_value.kind != ScriptValue::Kind::None) {
        return carried_to_jsvalue (ctx, var);
    }

    if (type == "number") {
        if (var.value.empty ())
            return JS_NewFloat64 (ctx, std::numeric_limits<double>::quiet_NaN ());
        try {
            size_t idx = 0;
            double num = std::stod (var.value, &idx);
            // A string that did not parse whole is NaN, as the app's
            // `Number(value)` reads partial garbage.
            if (idx != var.value.size ())
                return JS_NewFloat64 (ctx, std::numeric_limits<double>::quiet_NaN ());
            return JS_NewFloat64 (ctx, num);
        } catch (...) {
            return JS_NewFloat64 (ctx, std::numeric_limits<double>::quiet_NaN ());
        }
    }

    if (type == "boolean") {
        std::string lowered = vayu::utils::ascii_lower (var.value);
        // Trim whitespace
        auto isspace_pred = [] (unsigned char c) { return std::isspace (c); };
        while (!lowered.empty () &&
        isspace_pred (static_cast<unsigned char> (lowered.front ())))
            lowered.erase (lowered.begin ());
        while (!lowered.empty () &&
        isspace_pred (static_cast<unsigned char> (lowered.back ())))
            lowered.pop_back ();

        if (lowered == "true" || lowered == "1" || lowered == "yes")
            return JS_NewBool (ctx, 1);
        if (lowered == "false" || lowered == "0" || lowered == "no" || lowered.empty ())
            return JS_NewBool (ctx, 0);
        // A non-canonical truthy string is true, as `Boolean("foo")` is.
        return JS_NewBool (ctx, 1);
    }

    if (type == "json") {
        return parse_json_or_text (ctx, var.value, var.value);
    }

    // Default / "string"
    return JS_NewString (ctx, var.value.c_str ());
}

// ============================================================================
// Variable scopes: pm.environment / pm.globals / pm.collectionVariables
// ============================================================================

// Which of the run's variable maps a binding reads and writes: the `magic`
// QuickJS hands back, so one implementation serves every scope (a copy per
// method is what stops a fix landing everywhere). `SCOPE_LOCAL` is the
// run-local scope behind `pm.variables.set` / `unset` / `clear` (#2564), with
// no accessor of its own on `pm`, so not in the binding table.
enum VariableScope : int {
    SCOPE_ENVIRONMENT,
    SCOPE_GLOBALS,
    SCOPE_COLLECTION_VARIABLES,
    SCOPE_LOCAL
};

struct VariableScopeBinding {
    const char* property; // the name this scope answers to on `pm`
    VariableScope scope;
};

constexpr VariableScopeBinding variable_scope_bindings[] = {
    { "environment", SCOPE_ENVIRONMENT },
    { "globals", SCOPE_GLOBALS },
    { "collectionVariables", SCOPE_COLLECTION_VARIABLES },
};

// Postman resolves an unqualified name local, data, environment, collection,
// global. Vayu's data tier is the bound row, not a map, so this is the chain
// below the row: `pm.variables` reads the local scope, then the row (#1007,
// `iteration_cell`), then these, the order `{{name}}` resolution uses app-side
// (docs/app/variable-resolution.md), so a script reads a name as the URL does.
constexpr VariableScope variables_precedence[] = { SCOPE_ENVIRONMENT,
    SCOPE_COLLECTION_VARIABLES, SCOPE_GLOBALS };

// The map behind a scope, or nullptr when the run has none (a design run with
// no active environment). Every binding reads that as an empty scope, not an
// error: a script cannot see which scopes a run was given, so a throw would
// fail it for a reason its author cannot inspect.
Environment* scope_variables (JSContext* ctx, int magic) {
    auto* data = get_context_data (ctx);
    if (!data) {
        return nullptr;
    }
    switch (magic) {
    case SCOPE_ENVIRONMENT: return data->environment;
    case SCOPE_GLOBALS: return data->globals;
    case SCOPE_COLLECTION_VARIABLES: return data->collectionVariables;
    case SCOPE_LOCAL: return data->local;
    default: return nullptr;
    }
}

// Every map a read of `magic` may see, weakest first. Only the collection scope
// has more than one: its ancestors stack under it, root weakest, so an
// inherited name resolves as `{{name}}` does in the URL (#234). A write never
// consults this: `scope_variables` alone is the target, keeping ancestors
// read-only and the copy-down hazard impossible. One order for the file: the
// lookups reverse it to stop at the nearest definition and the snapshots fold
// along it, so `get` and `toObject` cannot answer one name two ways.
std::vector<const Environment*> scope_maps (JSContext* ctx, int magic) {
    std::vector<const Environment*> maps;
    auto* data = get_context_data (ctx);
    if (data && magic == SCOPE_COLLECTION_VARIABLES && data->collectionAncestors) {
        maps.reserve (data->collectionAncestors->size () + 1);
        for (const Environment& ancestor : *data->collectionAncestors) {
            maps.push_back (&ancestor);
        }
    }
    if (const Environment* own = scope_variables (ctx, magic)) {
        maps.push_back (own);
    }
    return maps;
}

// The definition of `key` a read of `magic` finds, or null. A disabled row is
// looked past, not stopped at, so a leaf unticking an inherited name falls
// through to the ancestor's value, the rule that already hides a disabled
// variable within one scope.
const Variable* lookup_variable (JSContext* ctx, int magic, const std::string& key) {
    const auto maps = scope_maps (ctx, magic);
    for (auto it = maps.rbegin (); it != maps.rend (); ++it) {
        auto found = (*it)->find (key);
        if (found != (*it)->end () && found->second.enabled) {
            return &found->second;
        }
    }
    return nullptr;
}

// Every enabled variable a read of `magic` can see, to `emit`, weakest scope
// first, so a merging caller lands on the value `lookup_variable` would answer.
template <typename Emit>
void merge_visible_variables (JSContext* ctx, int magic, Emit&& emit) {
    for (const Environment* map : scope_maps (ctx, magic)) {
        for (const auto& [key, variable] : *map) {
            if (variable.enabled) {
                emit (key, variable);
            }
        }
    }
}

// A disabled variable is a row the user unticked, so `get`, `has` and
// `toObject` look past it (reading it would resurrect a switched-off value);
// `unset` and `clear` still remove it, being asked to delete, not read.
JSValue
js_pm_scope_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    if (const Variable* found =
        lookup_variable (ctx, magic, js_to_string (ctx, argv[0]))) {
        return cast_variable_to_jsvalue (ctx, *found);
    }

    return JS_UNDEFINED;
}

// What `set`'s optional third argument asked for (Postman's
// `VariableScope#set(key, value, options)`, postman-collection 5.3.0). A field
// left empty means "keep what the row has".
struct SetOptions {
    std::optional<std::string> type; // one of string, number, boolean, json
    std::optional<bool> secret;
};

// Updates a variable's value, keeping an existing key's secret and type unless
// `options` names one; a new key gets the defaults plus what `options` names.
// Shared by every scope's set(), `pm.variables.set` included, so re-setting a
// secret variable does not strip its flag or reset its type.
//
// `enabled` is the one field a set turns on (#2479): a set writes a value the
// script means to use, and an unticked row would make its own get / has /
// replaceIn and the execute-time residual pass look past it, sending `{{name}}`
// literally, and persist it unticked.
//
// A new key is stamped with its creation time, the variables editor's ordering
// key (#135); the one place the engine invents a `created_at`, being the only
// place it creates a variable; stamping an existing one would sort it below
// rows added after it.
void set_variable_preserving (Environment& map,
const std::string& key,
std::string value,
ScriptValue carried,
const SetOptions& options) {
    auto it = map.find (key);
    if (it != map.end ()) {
        it->second.value        = std::move (value);
        it->second.script_value = std::move (carried);
        it->second.enabled      = true; // keeps created_at
    } else {
        Variable created{ std::move (value), false, true }; // new var: current defaults
        created.created_at = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                             .count ();
        created.script_value = std::move (carried);
        it = map.insert_or_assign (key, std::move (created)).first;
    }
    if (options.type) {
        it->second.type = *options.type;
    }
    if (options.secret) {
        it->second.secret = *options.secret;
    }
}

// What a later read of a variable set to `value` answers (#2529); see
// `ScriptValue` for which values carry and how faithfully.
ScriptValue script_value_of (JSContext* ctx, JSValueConst value) {
    ScriptValue carried;
    if (JS_IsString (value)) {
        return carried;
    }
    if (JS_IsUndefined (value)) {
        carried.kind = ScriptValue::Kind::Undefined;
        return carried;
    }
    if (JS_IsNumber (value)) {
        carried.kind = ScriptValue::Kind::Number;
        JS_ToFloat64 (ctx, &carried.number, value); // cannot fail on a number
        return carried;
    }
    JSValue json = JS_JSONStringify (ctx, value, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException (json)) {
        // A cycle, a BigInt or a throwing toJSON: the set still stores the
        // text, so the read falls back to it rather than failing the script.
        JS_FreeValue (ctx, JS_GetException (ctx));
        return carried;
    }
    if (JS_IsString (json)) { // a function or a symbol stringifies to undefined
        carried.kind = ScriptValue::Kind::Json;
        carried.json = js_to_string (ctx, json);
    }
    JS_FreeValue (ctx, json);
    return carried;
}

bool is_declared_json (const Environment& map, const std::string& key) {
    auto it = map.find (key);
    return it != map.end () && it->second.type == "json";
}

// Vayu's declared type for a Postman type name, or none for a name that leaves
// the type alone (`any`, `default`, an unknown word). `array` and `object` are
// Postman's spellings of what Vayu stores as `json`.
std::optional<std::string> declared_type_for (const std::string& name) {
    if (name == "string" || name == "number" || name == "boolean" || name == "json") {
        return name;
    }
    if (name == "object" || name == "array") {
        return std::string{ "json" };
    }
    return std::nullopt;
}

// A type name `set` was given. `"secret"` is no Postman type but the importer's
// reading of `type: "secret"` (`import_document.cpp`), so a script says it
// alike: the flag is set and the declared type left alone.
void apply_type_name (SetOptions& options, const std::string& name) {
    if (name == "secret") {
        options.secret = true;
        return;
    }
    options.type = declared_type_for (name);
}

// `name` of the options object, or undefined when reading it throws: a throwing
// getter names nothing, and the exception must not stay pending behind a `set`
// returning normally.
JSValue read_option_property (JSContext* ctx, JSValueConst options, const char* name) {
    JSValue value = JS_GetPropertyStr (ctx, options, name);
    if (JS_IsException (value)) {
        JS_FreeValue (ctx, JS_GetException (ctx));
        return JS_UNDEFINED;
    }
    return value;
}

// Postman's rules for the third argument: a string is a type; an object gives
// `type` when a string and `secret` when a boolean (an explicit `secret` beats
// a `type: "secret"` beside it); anything else is ignored.
SetOptions read_set_options (JSContext* ctx, JSValueConst arg) {
    SetOptions options;
    if (JS_IsString (arg)) {
        apply_type_name (options, js_to_string (ctx, arg));
        return options;
    }
    if (!JS_IsObject (arg)) {
        return options;
    }

    JSValue type = read_option_property (ctx, arg, "type");
    if (JS_IsString (type)) {
        apply_type_name (options, js_to_string (ctx, type));
    }
    JS_FreeValue (ctx, type);

    JSValue secret = read_option_property (ctx, arg, "secret");
    if (JS_IsBool (secret)) {
        options.secret = JS_ToBool (ctx, secret) != 0;
    }
    JS_FreeValue (ctx, secret);
    return options;
}

// The text a set stores: Postman's `Variable#toString`, JavaScript's string
// conversion except that `undefined` is "", so `{{name}}`, the wire and storage
// read what Postman's would. A row declared `json` stores an object or array as
// its JSON text instead: "[object Object]" cannot be parsed back by the row's
// own read, and `{{name}}` should substitute the document (#2568). Only the
// declared type decides, so a default-type row keeps Postman's text; it is the
// type this set leaves, so `set(name, {...}, 'json')` stores the document it
// declares.
std::string
stored_text (JSContext* ctx, JSValueConst value, const ScriptValue& carried, bool declared_json) {
    if (JS_IsUndefined (value)) {
        return {};
    }
    if (carried.kind == ScriptValue::Kind::Json && declared_json) {
        return carried.json;
    }
    return js_to_string (ctx, value);
}

// What a script calls the scope behind @p magic: `pm.environment` and its
// siblings from the binding table, `pm.variables` for the run-local scope.
std::string scope_api (int magic) {
    for (const auto& binding : variable_scope_bindings) {
        if (binding.scope == magic) {
            return std::string ("pm.") + binding.property;
        }
    }
    return "pm.variables";
}

// The value itself rides beside the text for the run's own reads (#2529). The
// third argument is read for every scope, `pm.variables.set` included; the
// local scope (#2564) is never persisted nor read by `secret_variable_values`,
// so a flag there affects only the run's own variable. A name no `{{name}}` can
// read back, which the write API and the extractors refuse, is a TypeError
// storing nothing (#3461); `unset` does not check, so a stored bad name stays
// removable. The legacy `postman.set*Variable` calls reach this function, so
// one throw covers them.
JSValue
js_pm_scope_set (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    if (argc < 2) {
        return JS_UNDEFINED;
    }

    const std::string key = js_to_string (ctx, argv[0]);
    if (const auto refusal = vayu::http::variable_name_refusal (key)) {
        return JS_ThrowTypeError (ctx, "%s.set: variable name '%s' %s",
        scope_api (magic).c_str (), key.c_str (), std::string (*refusal).c_str ());
    }

    Environment* variables = scope_variables (ctx, magic);
    if (!variables) {
        return JS_UNDEFINED;
    }

    const SetOptions options = argc > 2 ? read_set_options (ctx, argv[2]) : SetOptions{};
    ScriptValue carried = script_value_of (ctx, argv[1]);
    const bool declared_json =
    options.type ? *options.type == "json" : is_declared_json (*variables, key);
    std::string text = stored_text (ctx, argv[1], carried, declared_json);

    set_variable_preserving (*variables, key, std::move (text), std::move (carried), options);

    return JS_UNDEFINED;
}

JSValue
js_pm_scope_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_NewBool (ctx, 0);
    }

    return JS_NewBool (ctx,
    lookup_variable (ctx, magic, js_to_string (ctx, argv[0])) != nullptr ? 1 : 0);
}

// The method with no workaround: setting "" leaves an enabled empty variable,
// not the same to `{{template}}` resolution as a gone one;
// `persist_script_variables` carries the removal to disk as a name the run
// loaded and no longer holds (#1878). Like `set` and `clear`, it erases from
// the scope's own map only: on the collection scope, the request's immediate
// parent, so unsetting a name the leaf shadowed reveals the ancestor's
// definition. Inheritance can be shadowed from below, never deleted (#234).
JSValue
js_pm_scope_unset (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    Environment* variables = scope_variables (ctx, magic);
    if (!variables) {
        return JS_UNDEFINED;
    }

    variables->erase (js_to_string (ctx, argv[0]));

    return JS_UNDEFINED;
}

JSValue
js_pm_scope_clear (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;

    if (Environment* variables = scope_variables (ctx, magic)) {
        variables->clear ();
    }

    return JS_UNDEFINED;
}

JSValue
js_pm_scope_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    (void)argc;
    (void)argv;

    JSValue snapshot = JS_NewObject (ctx);
    if (JS_IsException (snapshot)) {
        return snapshot;
    }

    merge_visible_variables (ctx, magic, [&] (const std::string& key, const Variable& variable) {
        JS_SetPropertyStr (
        ctx, snapshot, key.c_str (), cast_variable_to_jsvalue (ctx, variable));
    });

    return snapshot;
}

// Defined with `pm.variables.replaceIn` below, which resolves through the same
// helpers.
JSValue
js_pm_scope_replace_in (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic);

void setup_pm_variable_scope (JSContext* ctx, JSValue pm, const VariableScopeBinding& binding) {
    JSValue scope   = JS_NewObject (ctx);
    const int magic = binding.scope;

    JS_SetPropertyStr (ctx, scope, "get",
    JS_NewCFunctionMagic (ctx, js_pm_scope_get, "get", 1, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "set",
    JS_NewCFunctionMagic (ctx, js_pm_scope_set, "set", 3, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "has",
    JS_NewCFunctionMagic (ctx, js_pm_scope_has, "has", 1, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "unset",
    JS_NewCFunctionMagic (ctx, js_pm_scope_unset, "unset", 1, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "clear",
    JS_NewCFunctionMagic (ctx, js_pm_scope_clear, "clear", 0, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "toObject",
    JS_NewCFunctionMagic (
    ctx, js_pm_scope_to_object, "toObject", 0, JS_CFUNC_generic_magic, magic));
    JS_SetPropertyStr (ctx, scope, "replaceIn",
    JS_NewCFunctionMagic (
    ctx, js_pm_scope_replace_in, "replaceIn", 1, JS_CFUNC_generic_magic, magic));

    JS_SetPropertyStr (ctx, pm, binding.property, scope);
}

} // namespace

// pm.environment, pm.globals and pm.collectionVariables, one installer over the
// binding table, keeping the table and its enum in this file.
void setup_pm_variable_scopes (JSContext* ctx, JSValue pm) {
    for (const auto& binding : variable_scope_bindings) {
        setup_pm_variable_scope (ctx, pm, binding);
    }
}

namespace {

// ============================================================================
// pm.variables - the merged reader, and the writer of the run-local scope
// ============================================================================

// Defined with `pm.iterationData` below, for which it was written: a row's cell
// reaches a script as the JSON it is through one converter, so this merged
// reader and the row's accessor cannot type a column differently.
JSValue js_from_json (JSContext* ctx, const nlohmann::json& value, const char* label);

// The cell a bound row holds for `key`, or null for no row, a non-object row or
// a name it lacks (#1007). This is the data tier Postman resolves an
// unqualified name through, above every scope: an imported collection writes
// its columns bare, so `pm.variables.get("username")` must read this
// iteration's row, not a same-named environment variable. `pm.iterationData`
// reads only the row; this merged view falls through to the scopes when the row
// is silent, so one script runs with and without a data file.
const nlohmann::json* iteration_cell (JSContext* ctx, const std::string& key) {
    auto* data = get_context_data (ctx);
    if (data == nullptr || data->iteration_data == nullptr ||
    !data->iteration_data->is_object ()) {
        return nullptr;
    }
    const auto found = data->iteration_data->find (key);
    return found == data->iteration_data->end () ? nullptr : &*found;
}

JSValue js_pm_variables_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    const std::string key = js_to_string (ctx, argv[0]);
    if (const Variable* found = lookup_variable (ctx, SCOPE_LOCAL, key)) {
        return cast_variable_to_jsvalue (ctx, *found);
    }
    // Then the row, typed as `pm.iterationData.get` hands it back: a number
    // column reads as a number either way.
    if (const nlohmann::json* cell = iteration_cell (ctx, key)) {
        return js_from_json (ctx, *cell, key.c_str ());
    }
    for (const VariableScope scope : variables_precedence) {
        if (const Variable* found = lookup_variable (ctx, scope, key)) {
            return cast_variable_to_jsvalue (ctx, *found);
        }
    }

    return JS_UNDEFINED;
}

JSValue js_pm_variables_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1) {
        return JS_NewBool (ctx, 0);
    }

    const std::string key = js_to_string (ctx, argv[0]);
    // A column that is present and null is `true` here, as it is on
    // `pm.iterationData.has`: the row carries the name (issue #1007).
    if (lookup_variable (ctx, SCOPE_LOCAL, key) != nullptr ||
    iteration_cell (ctx, key) != nullptr) {
        return JS_NewBool (ctx, 1);
    }
    for (const VariableScope scope : variables_precedence) {
        if (lookup_variable (ctx, scope, key)) {
            return JS_NewBool (ctx, 1);
        }
    }

    return JS_NewBool (ctx, 0);
}

JSValue js_pm_variables_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;

    JSValue snapshot = JS_NewObject (ctx);
    if (JS_IsException (snapshot)) {
        return snapshot;
    }

    // Weakest scope first, so a stronger one overwrites it and the snapshot
    // agrees with what get() would have answered for every key in it.
    for (auto it = std::rbegin (variables_precedence);
    it != std::rend (variables_precedence); ++it) {
        merge_visible_variables (
        ctx, *it, [&] (const std::string& key, const Variable& variable) {
            JS_SetPropertyStr (ctx, snapshot, key.c_str (),
            cast_variable_to_jsvalue (ctx, variable));
        });
    }
    // Then the bound row (#1007) and the local scope, the two strongest tiers,
    // for the reason the loop above runs weakest first.
    auto* data = get_context_data (ctx);
    if (data != nullptr && data->iteration_data != nullptr &&
    data->iteration_data->is_object ()) {
        for (const auto& [column, cell] : data->iteration_data->items ()) {
            JS_SetPropertyStr (ctx, snapshot, column.c_str (),
            js_from_json (ctx, cell, column.c_str ()));
        }
    }
    merge_visible_variables (
    ctx, SCOPE_LOCAL, [&] (const std::string& key, const Variable& variable) {
        JS_SetPropertyStr (
        ctx, snapshot, key.c_str (), cast_variable_to_jsvalue (ctx, variable));
    });

    return snapshot;
}

/// The row's columns in payload order, for the refusal's "columns: ..." half,
/// worded as `core/scenario_data.cpp`'s `describe_columns` words a bind-time
/// failure, so one mistake reads alike from the URL or a script.
std::string describe_iteration_columns (const nlohmann::json& row) {
    std::string out;
    for (const auto& [key, value] : row.items ()) {
        (void)value;
        if (!out.empty ()) {
            out += ", ";
        }
        out += key;
    }
    return out.empty () ? "none" : out;
}

// One scope's enabled values, the text each substitutes.
vayu::http::VariableValues scope_variable_values (JSContext* ctx, int magic) {
    vayu::http::VariableValues values;
    merge_visible_variables (ctx, magic, [&] (const std::string& key, const Variable& variable) {
        values[key] = variable.value;
    });
    return values;
}

// Every name a script can see, folded weakest first so a stronger scope
// overwrites, as toObject() walks and get() answers. Read at call time, so an
// earlier write in the same script is visible; the bound row is not in it, as
// `resolve_against` hands the row to the resolver beside it.
vayu::http::VariableValues visible_variable_values (JSContext* ctx) {
    vayu::http::VariableValues values;
    for (auto it = std::rbegin (variables_precedence);
    it != std::rend (variables_precedence); ++it) {
        merge_visible_variables (
        ctx, *it, [&] (const std::string& key, const Variable& variable) {
            values[key] = variable.value;
        });
    }
    for (auto& [key, value] : scope_variable_values (ctx, SCOPE_LOCAL)) {
        values[key] = std::move (value);
    }
    return values;
}

// Which iteration this script runs beside, as the resolver takes it: always an
// answer, since every send is an iteration of a run. The run's numbers where a
// run set them (a load run's user and pass, a design run's pass), else the run
// of one a plain Send is, `1` and `0`: this struct's own defaults, the ones
// `POST /execute` binds into the request this script was handed (#994,
// `execution.cpp`). That is why `replaceIn` may resolve what composition may
// not: leaving the token written would make script and wire disagree about one
// send.
//
// Not `pm.info`, which reads `undefined` on that plain Send: `pm.info` answers
// "which iteration of which run am I", with no run to be one of, while a token
// answers "what does this resolve to here", what the request beside it carried
// (#1057).
vayu::http::IterationIdentity script_identity (const ContextData* data) {
    vayu::http::IterationIdentity identity; // the run of one
    if (data == nullptr) {
        return identity;
    }
    if (data->vu) {
        identity.vu = *data->vu;
    }
    if (data->iteration) {
        identity.iteration = *data->iteration;
    }
    return identity;
}

// Full `{{template}}` resolution of a string a script opts in, at call time,
// against @p values: the one resolver behind every `replaceIn`, the sanctioned
// way to `{{...}}` in a script. Script text is never interpolated (#226, D16: a
// rewrite cannot tell code from a string literal, and splicing values into
// source is an injection); replaceIn keeps values as data, through POST
// /compose's `resolve_template`, so the semantics match: the `{{$vu}}` /
// `{{$iteration}}` identity answers ahead of every scope (#1088), @p local
// beats a bound row's column (#2564), which beats @p values (#1007), which beat
// generators; a dynamic `{{$guid}}` generates per occurrence, and a name
// nothing answers keeps its braces, unknown `$name` included (#1009). A
// substituted value carrying tokens resolves through them, bounded by
// `MAX_NESTED_RESOLUTIONS` (`request_composer.cpp`) and a cycle rule leaving a
// name already being expanded as written.
//
// Two differences from compose time, both from when this runs:
//  - The maps are built at call time from the script's scopes, so a variable
//    set earlier in the script resolves at once; the request's own `{{}}` waits
//    for the pre-request script to end (#2521).
//  - The collection scope is the script context's, the request's chain, leaf
//    shadowing ancestor (#234). The raw stored string substitutes, never the
//    typed value, as `{{}}` does, unlike pm.variables.get.
//
// @param local the run-local scope's values, the one tier above a bound row.
// @param missing_column receives the {{data.column}} name the bound row does
//        not carry, when that is why the resolution failed.
// @return the resolved text, or nullopt when a column was named and missing.
std::optional<std::string> resolve_against (JSContext* ctx,
const std::string& input,
const vayu::http::VariableValues& values,
const vayu::http::VariableValues& local,
std::string& missing_column) {
    auto* data                                   = get_context_data (ctx);
    const vayu::http::IterationIdentity identity = script_identity (data);
    if (data == nullptr || data->iteration_data == nullptr ||
    !data->iteration_data->is_object ()) {
        // No row, so that namespace stays written as it stands, as composition
        // does, which lets one script run in a data-driven run and a plain
        // send. The identity needs no row, so it answers here too. `Generate`
        // is said, not defaulted: a script renders its own `{{$guid}}` now
        // (#995 defers the family only for a payload a run will repeat), while
        // also resolving the identity it was sent as.
        return vayu::http::resolve_template (
        input, values, {}, vayu::http::DynamicResolution::Generate, identity);
    }

    vayu::http::DataRowColumns row;
    for (const auto& [column, cell] : data->iteration_data->items ()) {
        row.columns[column] = vayu::http::render_data_value (cell);
    }
    row.local = local;

    std::optional<std::string> missing;
    std::string resolved =
    vayu::http::resolve_template_with_data (input, values, row, missing, identity);
    if (missing) {
        missing_column = *missing;
        return std::nullopt;
    }
    return resolved;
}

} // namespace

// One resolution of `input` against all a script can see (the four scopes as
// they stand, the iteration identity, the bound row's columns when present).
// `pm.variables.replaceIn` and `pm.sendRequest` both use it, so a script gets
// one answer from the template it renders and the request it sends; the rules
// are `resolve_against`'s.
std::optional<std::string> resolve_script_template (JSContext* ctx,
const std::string& input,
std::string& missing_column) {
    return resolve_against (ctx, input, visible_variable_values (ctx),
    scope_variable_values (ctx, SCOPE_LOCAL), missing_column);
}

// The bind-time rule in a shape a script can catch, naming the token and the
// row's columns, as the mistake is almost always a spelling and the answer is
// in the second half; one message for both callers, which resolve through one
// function and so fail alike.
std::string
missing_column_message (JSContext* ctx, const std::string& what, const std::string& column) {
    auto* data = get_context_data (ctx);
    const std::string columns = (data != nullptr && data->iteration_data != nullptr &&
                                data->iteration_data->is_object ()) ?
    describe_iteration_columns (*data->iteration_data) :
    std::string ("none");
    return what + ": {{" + column +
    "}} names a column this data row does not have (columns: " + columns + ")";
}

namespace {

// The argument check and answer of every `replaceIn`; @p resolve, the values
// resolved against, is the one difference, and @p api names the call in both
// refusals. A non-string is a TypeError, not a coerced "undefined": the caller
// almost certainly holds a bug.
template <typename Resolve>
JSValue
replace_in (JSContext* ctx, int argc, JSValueConst* argv, const std::string& api, Resolve&& resolve) {
    if (argc < 1 || !JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx,
        "%s expects a string, e.g. %s(\"{{$guid}}\")", api.c_str (), api.c_str ());
    }

    std::string missing;
    auto resolved = resolve (js_to_string (ctx, argv[0]), missing);
    if (!resolved) {
        return JS_ThrowTypeError (
        ctx, "%s", missing_column_message (ctx, api, missing).c_str ());
    }
    return JS_NewString (ctx, resolved->c_str ());
}

JSValue js_pm_variables_replace_in (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    return replace_in (ctx, argc, argv, "pm.variables.replaceIn",
    [&] (const std::string& input, std::string& missing) {
        return resolve_script_template (ctx, input, missing);
    });
}

// `pm.environment.replaceIn` and its siblings: Postman resolves against that
// scope alone, so a name only another scope defines stays written. What is no
// scope (the `$` names, the identity, the bound row) answers as for
// `pm.variables.replaceIn`; the run-local scope, a scope of its own, sits out.
JSValue
js_pm_scope_replace_in (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    const std::string api = scope_api (magic) + ".replaceIn";
    return replace_in (
    ctx, argc, argv, api, [&] (const std::string& input, std::string& missing) {
        return resolve_against (ctx, input, scope_variable_values (ctx, magic), {}, missing);
    });
}

} // namespace

// Reads merge every tier; writes are Postman's local scope (#2564), the scope
// binding's own set / unset / clear over `SCOPE_LOCAL`, so the carried value
// (#2529) and the keep-the-flags rule are the same code.
void setup_pm_variables (JSContext* ctx, JSValue pm) {
    JSValue variables = JS_NewObject (ctx);

    JS_SetPropertyStr (
    ctx, variables, "get", JS_NewCFunction (ctx, js_pm_variables_get, "get", 1));
    JS_SetPropertyStr (
    ctx, variables, "has", JS_NewCFunction (ctx, js_pm_variables_has, "has", 1));
    JS_SetPropertyStr (ctx, variables, "toObject",
    JS_NewCFunction (ctx, js_pm_variables_to_object, "toObject", 0));
    JS_SetPropertyStr (ctx, variables, "replaceIn",
    JS_NewCFunction (ctx, js_pm_variables_replace_in, "replaceIn", 1));
    JS_SetPropertyStr (ctx, variables, "set",
    JS_NewCFunctionMagic (ctx, js_pm_scope_set, "set", 3, JS_CFUNC_generic_magic, SCOPE_LOCAL));
    JS_SetPropertyStr (ctx, variables, "unset",
    JS_NewCFunctionMagic (
    ctx, js_pm_scope_unset, "unset", 1, JS_CFUNC_generic_magic, SCOPE_LOCAL));
    JS_SetPropertyStr (ctx, variables, "clear",
    JS_NewCFunctionMagic (
    ctx, js_pm_scope_clear, "clear", 0, JS_CFUNC_generic_magic, SCOPE_LOCAL));

    JS_SetPropertyStr (ctx, pm, "variables", variables);
}

namespace {

// ============================================================================
// pm.iterationData - the data row bound to this iteration (issue #356)
// ============================================================================

// One JSON value from the row as a JS value. Dump-and-parse, not a hand walk: a
// row is arbitrary JSON, which QuickJS's parser already accepts (nested
// objects, arrays, `null`, numbers a double-only converter would not keep), and
// a second implementation would stop receiving the parser's fixes. `replace` on
// the dump because a row is user data: a lone continuation byte becomes U+FFFD
// rather than throwing out of a getter.
JSValue js_from_json (JSContext* ctx, const nlohmann::json& value, const char* label) {
    const std::string dumped =
    value.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
    JSValue parsed = JS_ParseJSON (ctx, dumped.c_str (), dumped.size (), "<iterationData>");
    if (JS_IsException (parsed)) {
        JS_FreeValue (ctx, parsed);
        // QuickJS's exception is replaced with one naming the failed value; the
        // raw parse error names only a column.
        JSValue pending = JS_GetException (ctx);
        JS_FreeValue (ctx, pending);
        return JS_ThrowPlainError (ctx,
        "pm.iterationData could not read %s from this iteration's data row - "
        "the value is not representable as JSON",
        label);
    }
    return parsed;
}

// The row this script is bound to, or null with a TypeError thrown.
// `pm.iterationData` is an object only when a row exists, so the ordinary way
// here implies one; the check is defence in depth: a context is rebuilt after
// every script (#1782), and a stashed reference reaching a later call with no
// row must say so, not answer about a finished run. The message names every
// surface binding a row, not just the collection run (#356): a send-with-row
// (#402) and every script of a load run given rows (#599, #993, #3124) bind one
// too. It ends at the scripting directory, not a page: with the longest member
// name the text already fills QuickJS's 256-byte formatting buffer
// (`JS_MakeError`).
ContextData* iteration_data_context (JSContext* ctx, const char* member) {
    auto* data = get_context_data (ctx);
    if (!data || !data->iteration_data) {
        JS_ThrowTypeError (ctx,
        "pm.iterationData.%s is not available here: this script has no data "
        "row "
        "bound. A row is bound by an iteration of a collection run with a data "
        "set, by a send-with-row, and by a load run's scripts when the run has "
        "a data set. See docs/engine/scripting/.",
        member);
        return nullptr;
    }
    return data;
}

// pm.iterationData.get(key): the row's value, or `undefined` for an unknown
// key, as every pm scope reader answers; the argument is coerced as
// `pm.variables.get` coerces it, so the two answer a non-string key alike.
JSValue js_iteration_data_get (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto* data = iteration_data_context (ctx, "get");
    if (!data) {
        return JS_EXCEPTION;
    }
    if (argc < 1) {
        return JS_UNDEFINED;
    }

    const std::string key = js_to_string (ctx, argv[0]);
    const auto found      = data->iteration_data->find (key);
    if (found == data->iteration_data->end ()) {
        return JS_UNDEFINED;
    }
    return js_from_json (ctx, *found, key.c_str ());
}

// pm.iterationData.has(key): whether the row carries that column. Every other
// pm scope reader has `has`, and Postman's pm.iterationData is a VariableScope
// with one; without it the question is `get(key) !== undefined`, indirect and
// easily wrong for a JSON `null` column. A present null column is `true`: the
// row carries it, an answer `get` cannot phrase without the reader knowing a
// null comes back as `null`, not `undefined`.
JSValue js_iteration_data_has (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    auto* data = iteration_data_context (ctx, "has");
    if (!data) {
        return JS_EXCEPTION;
    }
    // No argument is "no such column", the same answer pm.variables.has gives.
    if (argc < 1) {
        return JS_NewBool (ctx, 0);
    }

    const std::string key = js_to_string (ctx, argv[0]);
    return JS_NewBool (ctx, data->iteration_data->contains (key) ? 1 : 0);
}

// pm.iterationData.toObject() - the whole row, as a plain object.
JSValue js_iteration_data_to_object (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    auto* data = iteration_data_context (ctx, "toObject");
    if (!data) {
        return JS_EXCEPTION;
    }
    return js_from_json (ctx, *data->iteration_data, "this row");
}

// pm.iterationData.set / unset / clear: refused, loudly. The rows are a run
// input, not a scope: no destination, no persistence, and the next iteration
// binds another row. Accepting and dropping the value is #188's false success,
// so the write is bound and throws rather than being absent, where "not a
// function" reads as an engine gap rather than a decision.
JSValue js_iteration_data_write (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    return JS_ThrowTypeError (ctx,
    "pm.iterationData is read-only: the data rows are an input to this run, "
    "not a variable scope, so a write here would have nowhere to land. Use "
    "pm.environment, pm.collectionVariables or pm.globals to carry a value on "
    "from a row.");
}

} // namespace

// pm.iterationData: the row, or `undefined` with no data set. Rebuilt per
// execution beside pm.info and cleared when there is no row: contexts are
// pooled, so the previous step's object would answer a single send with the
// last collection run's data. Absence is `undefined`, not an empty scope
// (`ScriptContext::iteration_data` says why this binding differs from
// pm.execution and pm.cookies).
void setup_pm_iteration_data (JSContext* ctx, JSValue pm) {
    auto* data = get_context_data (ctx);

    JSValue previous = JS_GetPropertyStr (ctx, pm, "iterationData");
    if (!JS_IsUndefined (previous)) {
        JS_FreeValue (ctx, previous);
    }

    if (!data || !data->iteration_data) {
        JS_SetPropertyStr (ctx, pm, "iterationData", JS_UNDEFINED);
        return;
    }

    JSValue iteration_data = JS_NewObject (ctx);
    JS_SetPropertyStr (ctx, iteration_data, "get",
    JS_NewCFunction (ctx, js_iteration_data_get, "get", 1));
    JS_SetPropertyStr (ctx, iteration_data, "has",
    JS_NewCFunction (ctx, js_iteration_data_has, "has", 1));
    JS_SetPropertyStr (ctx, iteration_data, "toObject",
    JS_NewCFunction (ctx, js_iteration_data_to_object, "toObject", 0));
    for (const char* writer : { "set", "unset", "clear" }) {
        JS_SetPropertyStr (ctx, iteration_data, writer,
        JS_NewCFunction (ctx, js_iteration_data_write, writer, 2));
    }
    JS_SetPropertyStr (ctx, pm, "iterationData", iteration_data);
}

} // namespace vayu::runtime::pm_detail
