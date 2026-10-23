/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file pm_scopes.cpp
 * @brief `pm.environment`, `pm.globals`, `pm.collectionVariables`, `pm.variables`
 *        and `pm.iterationData`.
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
        // Clear the pending exception so it doesn't leak into the script
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

// Convert a Variable into the JSValue a script reads. A value a script set this
// run answers as itself, but only on a row of the default type: Vayu's
// "string" stands for Postman's `any` as well as a declared string, and
// Postman passes an `any` value through while casting a declared type (#2529).
// Otherwise the stored text is cast by the declared type, mirroring the
// frontend's castByType (app/src/lib/variable-cast.ts) so a loaded row reads
// the same in both runtimes.
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
            // If the whole string didn't parse, surface NaN to match the
            // frontend's Number(value) behavior on partial garbage.
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
        // Non-canonical truthy string: matches Boolean("foo") → true
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

// Which of the run's variable maps a binding reads and writes. The value is the
// `magic` argument QuickJS hands back, so one implementation serves every
// scope. They were three hand-written copies of get/set; six methods each
// would have tripled that, and a copy is exactly what stops a fix landing
// everywhere it belongs. `SCOPE_LOCAL` is the run-local scope behind
// `pm.variables.set` / `unset` / `clear` (#2564); it has no accessor of its own
// on `pm`, so it is not in the binding table below.
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

// Postman resolves an unqualified name local -> data -> environment ->
// collection -> global. Vayu's data tier is not a map of variables but the
// bound row itself, so this is the chain *below* the row: `pm.variables` reads
// the local scope, then the row (issue #1007, `iteration_cell`), then walks
// these - the same order `{{name}}` resolution uses app-side
// (docs/app/variable-resolution.md), which is what keeps a script's reading of
// a name identical to the URL's.
constexpr VariableScope variables_precedence[] = { SCOPE_ENVIRONMENT,
    SCOPE_COLLECTION_VARIABLES, SCOPE_GLOBALS };

// The map behind a scope, or nullptr when the run carries no such scope (a
// design run with no active environment, say). Every binding below reads that
// as an empty scope rather than an error: a script cannot see which scopes a
// run was given, so throwing would fail it for a reason its author has no way
// to inspect.
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

// Every map a *read* of `magic` may see, weakest first. Only the collection
// scope has more than one: its ancestor collections stack underneath it, root
// weakest, so an inherited name resolves for a script the way `{{name}}`
// already resolves it in the URL (issue #234). A write never consults this -
// `scope_variables` alone is the write target, which is what keeps ancestors
// read-only and the copy-down hazard impossible.
//
// One order for the whole file: the lookups below reverse it to stop at the
// nearest definition and the snapshots fold along it so a nearer definition
// overwrites a farther one. Deriving both from one list is what stops `get`
// and `toObject` answering the same name two ways.
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

// The definition of `key` a read of `magic` finds, or null when the walk ends
// without one. A disabled row is looked *past* rather than stopped at, so a
// leaf collection that unticks an inherited name falls through to the
// ancestor's value - the same rule that already makes a disabled variable
// invisible within a single scope.
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

// Hand every enabled variable a read of `magic` can see to `emit`, weakest
// scope first, so a caller merging them lands on the same value
// `lookup_variable` would have answered for that name.
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

// A disabled variable is a row the user unticked in the variables editor, so
// `get`, `has` and `toObject` all look straight past it - reading it would
// resurrect a value that was switched off. `unset` and `clear` still remove it:
// those are asked to delete a key, not to read one.
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

// Update a variable's value while preserving an existing key's secret and type
// fields, unless `options` names one; a brand-new key gets the current
// defaults plus whatever `options` names. Shared by every scope's set(),
// `pm.variables.set` included, so a script that re-sets an existing (e.g.
// secret) variable does not silently strip its flag or reset its type.
//
// `enabled` is the one field a set deliberately turns on (#2479). A set is a
// write of a value the script intends to use, so leaving the row unticked would
// make the script's own get/has/replaceIn and the execute-time residual pass
// look past it and send `{{name}}` literally, and the row would be persisted
// unticked.
//
// A brand-new key is also stamped with its creation time, the app's ordering
// key for the variables editor (issue #135). This is the one place the engine
// may invent a `created_at`, because it is the only place the engine creates a
// variable - stamping an existing one would sort it below rows the user added
// after it.
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

// A type name `set` was given. `"secret"` is not a Postman type; it is the
// importer's reading of `type: "secret"` (`import_document.cpp`), so a script
// can say it the same way: the flag is set and the declared type is left alone.
void apply_type_name (SetOptions& options, const std::string& name) {
    if (name == "secret") {
        options.secret = true;
        return;
    }
    options.type = declared_type_for (name);
}

// `name` of the options object, or undefined when reading it throws: a getter
// that throws is an options object that names nothing, and the exception must
// not stay pending behind a `set` that returns normally.
JSValue read_option_property (JSContext* ctx, JSValueConst options, const char* name) {
    JSValue value = JS_GetPropertyStr (ctx, options, name);
    if (JS_IsException (value)) {
        JS_FreeValue (ctx, JS_GetException (ctx));
        return JS_UNDEFINED;
    }
    return value;
}

// Postman's rules for the third argument: a string is a type; an object
// contributes `type` when it is a string and `secret` when it is a boolean
// (an explicit `secret` beats a `type: "secret"` beside it); anything else is
// ignored.
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

// The text a set stores. It is Postman's `Variable#toString`: JavaScript's
// string conversion, except that `undefined` is "" rather than "undefined". So
// `{{name}}`, the wire and storage read what Postman's would.
//
// A row declared `json` stores an object or an array as its JSON text instead:
// the string conversion is "[object Object]", which the row's own read cannot
// parse back, and `{{name}}` should substitute the document (#2568). Only the
// declared type decides this, so a default-type row keeps Postman's text. The
// declared type is the one this set leaves behind, not the one the row had, so
// `set(name, {...}, 'json')` stores the document it declares.
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

// The value itself rides beside the text for the run's own reads (#2529).
//
// The third argument is read for every scope, `pm.variables.set` included. The
// local scope (#2564) is never persisted and `secret_variable_values` never
// reads it, so a flag set there has no effect beyond the run's own variable.
JSValue
js_pm_scope_set (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic) {
    (void)this_val;
    if (argc < 2) {
        return JS_UNDEFINED;
    }

    Environment* variables = scope_variables (ctx, magic);
    if (!variables) {
        return JS_UNDEFINED;
    }

    std::string key = js_to_string (ctx, argv[0]);
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

// The method with no workaround: setting a variable to "" leaves an enabled
// empty variable behind, which is not the same thing to `{{template}}`
// resolution as the variable being gone. persist_script_variables carries the
// removal to disk as a name the run loaded and no longer holds (#1878).
//
// Like `set` and `clear`, this erases from the scope's own map only. On the
// collection scope that is the request's immediate parent: unsetting a name
// the leaf shadowed makes an ancestor's definition visible again rather than
// deleting it. Inheritance can be shadowed from below, never deleted from
// below (issue #234).
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

    JS_SetPropertyStr (ctx, pm, binding.property, scope);
}

} // namespace

// pm.environment, pm.globals and pm.collectionVariables - one installer over
// the binding table, so the table and its enum stay in this file.
void setup_pm_variable_scopes (JSContext* ctx, JSValue pm) {
    for (const auto& binding : variable_scope_bindings) {
        setup_pm_variable_scope (ctx, pm, binding);
    }
}

namespace {

// ============================================================================
// pm.variables - the merged reader, and the writer of the run-local scope
// ============================================================================

// Defined with `pm.iterationData` below, which is what it was written for: a
// row's cell reaches a script as the JSON it is, through one converter, so the
// merged reader here and the row's own accessor cannot type a column
// differently.
JSValue js_from_json (JSContext* ctx, const nlohmann::json& value, const char* label);

// The cell a bound row holds for `key`, or null - for a run with no row, a row
// that is not an object, or a name it does not carry (issue #1007).
//
// This is the data tier Postman resolves an unqualified name through, and it
// sits above every scope below: an imported collection writes its columns bare,
// so `pm.variables.get("username")` has to read this iteration's row rather
// than an environment variable that happens to share the name. `pm.iterationData`
// remains the accessor that reads *only* the row; this one is the merged view,
// so it answers from the row and falls through to the scopes when the row is
// silent - which is what lets one script run with and without a data file.
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
    // Then the row, typed exactly as `pm.iterationData.get` hands it back - a
    // number column reads as a number through either accessor.
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
    // Then the bound row (issue #1007) and the local scope, the two strongest
    // tiers - the same reason the loop above runs weakest first.
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

// pm.variables.replaceIn - full `{{template}}` resolution of a string the
// script opts in, at call time.
//
// This is the sanctioned way to `{{...}}` inside a script. Script *text* is
// never interpolated (issue #226, D16: a rewrite cannot tell code from a
// string literal, and splicing variable values into source is an injection);
// replaceIn keeps values as data - the same resolver the engine's POST
// /compose uses (`resolve_template`), so the semantics are identical: the
// `{{$vu}}`/`{{$iteration}}` identity answers ahead of every scope (issue
// #1088), the local scope wins over a bound row's column (#2564), which wins
// over the scopes (issue #1007), scopes win over generators, a dynamic
// `{{$guid}}` generates per occurrence, and a name nothing answers keeps its
// braces - an unknown `$name` and an ordinary unknown name alike (issue
// #1009). A substituted value that
// carries tokens of its own is resolved through them in turn, bounded by
// `MAX_NESTED_RESOLUTIONS` (`request_composer.cpp`) and by a cycle rule
// that leaves a name already being expanded written as it stands.
//
// Two deliberate differences from compose-time resolution, both consequences
// of *when* this runs:
//  - The map is built at call time from the script's scopes, so a variable
//    set earlier in the same script resolves here at once; the request's own
//    `{{}}` waits for the pre-request script to end (#2521).
//  - The collection scope is the script context's - the request's collection
//    chain, leaf shadowing ancestor (issue #234) - with pm.variables' own
//    precedence (local > environment > collection > globals). The raw stored
//    string substitutes, never the typed value - matching `{{}}`, not
//    pm.variables.get.
//
// Strict about its argument: a non-string is a TypeError rather than a
// coerced "undefined" - the caller almost certainly holds a bug.
/// The row's columns, in payload order, for the "columns: ..." half of the
/// refusal above. Mirrors `core/scenario_data.cpp`'s `describe_columns`, whose
/// wording a bind-time failure already uses - the same mistake should read the
/// same way whether it was the URL or a script that reached the column.
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

// The local scope's enabled values, the text each substitutes.
vayu::http::VariableValues local_variable_values (JSContext* ctx) {
    vayu::http::VariableValues values;
    merge_visible_variables (
    ctx, SCOPE_LOCAL, [&] (const std::string& key, const Variable& variable) {
        values[key] = variable.value;
    });
    return values;
}

// Every name a script can see, folded weakest scope first so a stronger one
// overwrites - the same walk toObject() does, and the same answer get() would
// give per name. Read at call time rather than at bind time, which is what
// makes a write earlier in the same script visible here. The bound row is not
// in it: `resolve_script_template` hands the row to the resolver beside it.
vayu::http::VariableValues visible_variable_values (JSContext* ctx) {
    vayu::http::VariableValues values;
    for (auto it = std::rbegin (variables_precedence);
    it != std::rend (variables_precedence); ++it) {
        merge_visible_variables (
        ctx, *it, [&] (const std::string& key, const Variable& variable) {
            values[key] = variable.value;
        });
    }
    for (auto& [key, value] : local_variable_values (ctx)) {
        values[key] = std::move (value);
    }
    return values;
}

// Which iteration this script is running beside, as the resolver takes it.
//
// Always an answer, never absent, because every send is an iteration of a run:
// the run's own numbers wherever a run set them - a load run's user and pass, a
// design run's pass - and otherwise the run of one a plain Send is, `1` and `0`.
// Those two are not a second default chosen here: they are this struct's own,
// the same ones `POST /execute` binds into the request this script was handed
// (issue #994, `execution.cpp`), which is what the move of `IterationIdentity`
// down beside the names bought. That
// is the whole of why `replaceIn` may resolve what composition may not: it runs
// beside a request already bound with these two numbers, so leaving the token
// written would make the script and the wire disagree about one send.
//
// It is deliberately *not* `pm.info`, which reads `undefined` on that same
// plain Send: `pm.info` answers "which iteration of which run am I", and there
// is no run to be an iteration of, while a token answers "what does this
// resolve to here" - and here it resolves to what the request beside it carried
// (issue #1057).
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

} // namespace

// One resolution of `input` against everything the script can see: the four
// scopes as they stand now, the iteration identity this script is running as,
// plus the bound data row's columns when the run has one.
// `pm.variables.replaceIn` and `pm.sendRequest` both resolve through this,
// so a script cannot get one answer from the template it renders and another
// from the request it sends.
//
// @param missing_column receives the {{data.column}} name the bound row does
//        not carry, when that is why the resolution failed.
// @return the resolved text, or nullopt when a column was named and missing.
std::optional<std::string> resolve_script_template (JSContext* ctx,
const std::string& input,
std::string& missing_column) {
    const vayu::http::VariableValues values = visible_variable_values (ctx);

    auto* data                                   = get_context_data (ctx);
    const vayu::http::IterationIdentity identity = script_identity (data);
    if (data == nullptr || data->iteration_data == nullptr ||
    !data->iteration_data->is_object ()) {
        // No row to resolve against, so *that* namespace stays written as it
        // stands - what composition does, and what lets one script run in both
        // a data-driven run and a plain send. The identity is not that case:
        // it needs no row behind it, so it answers here too.
        //
        // `Generate` said rather than defaulted: a script renders its own
        // `{{$guid}}` here and now (issue #995 defers the family only for a
        // payload a *run* will repeat), and it does that while resolving the
        // identity it was sent as - the two questions compose.
        return vayu::http::resolve_template (
        input, values, {}, vayu::http::DynamicResolution::Generate, identity);
    }

    vayu::http::DataRowColumns row;
    for (const auto& [column, cell] : data->iteration_data->items ()) {
        row.columns[column] = vayu::http::render_data_value (cell);
    }
    row.local = local_variable_values (ctx);

    std::optional<std::string> missing;
    std::string resolved =
    vayu::http::resolve_template_with_data (input, values, row, missing, identity);
    if (missing) {
        missing_column = *missing;
        return std::nullopt;
    }
    return resolved;
}

// The bind-time rule, in the shape a script can catch: naming the token and the
// columns the row does carry, because the mistake is almost always a spelling
// and the answer is in the second half. One message for both callers, since
// they resolve through one function and so must fail the same way.
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

JSValue js_pm_variables_replace_in (JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx,
        "pm.variables.replaceIn expects a string, e.g. "
        "pm.variables.replaceIn(\"{{$guid}}\")");
    }

    std::string missing;
    auto resolved = resolve_script_template (ctx, js_to_string (ctx, argv[0]), missing);
    if (!resolved) {
        return JS_ThrowTypeError (ctx, "%s",
        missing_column_message (ctx, "pm.variables.replaceIn", missing).c_str ());
    }
    return JS_NewString (ctx, resolved->c_str ());
}

} // namespace

// The reads merge every tier; the writes are Postman's local scope (#2564):
// the scope binding's own set/unset/clear over `SCOPE_LOCAL`, so the value a
// set carries (#2529) and the keep-the-flags rule are the same code.
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

// Turn one JSON value from the row into a JS value.
//
// Dump-and-parse rather than a hand-written walk: a data row is arbitrary JSON,
// and QuickJS's own parser already accepts exactly that - nested objects,
// arrays, `null`, numbers no double-only converter would keep. A second
// implementation here would be a copy that stops receiving the parser's fixes.
// `replace` on the dump because a row is user data: a lone UTF-8 continuation
// byte must become U+FFFD, not throw out of a getter.
JSValue js_from_json (JSContext* ctx, const nlohmann::json& value, const char* label) {
    const std::string dumped =
    value.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
    JSValue parsed = JS_ParseJSON (ctx, dumped.c_str (), dumped.size (), "<iterationData>");
    if (JS_IsException (parsed)) {
        JS_FreeValue (ctx, parsed);
        // Clear QuickJS's own exception before replacing it with one that says
        // which value failed - the raw parse error names only a column.
        JSValue pending = JS_GetException (ctx);
        JS_FreeValue (ctx, pending);
        return JS_ThrowPlainError (ctx,
        "pm.iterationData could not read %s from this iteration's data row - "
        "the value is not representable as JSON",
        label);
    }
    return parsed;
}

// The row this script is bound to, or null with a TypeError already thrown.
//
// `pm.iterationData` is only an object when a row exists, so the ordinary way
// to reach these functions already implies one. The check is defence in depth:
// a context is rebuilt after every script (#1782), so a stashed reference no
// longer reaches a later one, and a call with no row bound must still say so
// rather than answer about a run that has finished.
//
// The message names every surface that binds a row, not just the collection run
// #356 shipped with: #402 made a send-with-row one and #599 made a scenario load
// run's deferred per-step script another, so a message naming only collection
// runs steers a user who stashed the object during either of those to look for a
// mistake that is not there.
ContextData* iteration_data_context (JSContext* ctx, const char* member) {
    auto* data = get_context_data (ctx);
    if (!data || !data->iteration_data) {
        JS_ThrowTypeError (ctx,
        "pm.iterationData.%s is not available here: this script has no data "
        "row "
        "bound. A row is bound by an iteration of a collection run with a data "
        "set, by a send-with-row, and by a scenario load run's deferred "
        "per-step script. See docs/engine/scripting.md.",
        member);
        return nullptr;
    }
    return data;
}

// pm.iterationData.get(key) - the row's value for `key`, or `undefined`.
//
// An unknown key is `undefined`, matching every other `pm` scope reader; the
// argument is coerced the way `pm.variables.get` coerces it, so the two scopes
// answer a non-string key identically.
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

// pm.iterationData.has(key) - whether the row carries that column.
//
// Every other scope reader in the pm surface answers `has` - pm.environment,
// pm.globals, pm.collectionVariables, pm.variables and pm.cookies all do - and
// Postman's pm.iterationData is a VariableScope, which has one too. Absent, the
// question has to be asked as `get(key) !== undefined`, which is both indirect
// and easy to write wrongly for a column whose value is JSON `null`.
//
// A column that is present and null is `true` here: the row carries it. That is
// the one answer `get` cannot phrase as a presence check without the reader
// knowing that a null column comes back as JS `null` rather than `undefined`.
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

// pm.iterationData.set / unset / clear - refused, loudly.
//
// The rows are a run *input*, not a scope: there is no destination a write
// could land in, no persistence story for one, and the next iteration binds a
// different row regardless. Accepting the call and dropping the value is
// exactly #188's false success, so the write is bound and throws rather than
// being absent and answering "not a function" - which reads as a gap in the
// engine rather than as a decision.
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

// pm.iterationData - the row, or `undefined` when the run has no data set.
//
// Rebuilt per execution beside pm.info, and cleared rather than left standing
// when there is no row: contexts are pooled, so the previous step's object
// would otherwise answer a single send with the last collection run's data.
//
// Absence is `undefined` and not an empty scope - see
// `ScriptContext::iteration_data` for why this one binding differs from
// pm.execution and pm.cookies.
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
