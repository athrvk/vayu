/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file require_shelf.cpp
 * @brief `require()` and the library globals Postman binds, over a fixed shelf
 *        of bundled libraries (#2578).
 *
 * `require(name)` answers a library from `SHELF` and refuses every other name;
 * there is no loader behind it, so nothing reads a file or the network. A
 * library global (`CryptoJS`) is an accessor that loads its library on first
 * read and then replaces itself with the value, as `responseCookies` does.
 *
 * A library's source is evaluated on first use in an execution, never when a
 * context is built: every script gets a freshly built context
 * (`release_context`), so a library evaluated there would be paid for by every
 * element whether or not it touches the library. Within one execution the
 * evaluated module is kept in `ContextData::shelf_modules`, so `require` and
 * the global answer the same object.
 */

#include "pm/pm_internal.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "crypto_js_shim.hpp"
#include "vayu/runtime/shelf_modules.hpp"
#include "vayu/utils/digest.hpp"

namespace vayu::runtime::pm_detail {
namespace {

// ============================================================================
// crypto-js's natives: the digests the shim's hashers call
// ============================================================================

std::optional<vayu::utils::DigestAlgorithm> read_algorithm (JSContext* ctx, JSValueConst value) {
    const std::string name = js_to_string (ctx, value);
    const auto algorithm   = vayu::utils::digest_algorithm_named (name);
    if (!algorithm) {
        JS_ThrowTypeError (ctx, "unknown digest algorithm '%s'", name.c_str ());
    }
    return algorithm;
}

JSValue digest_bytes (JSContext* ctx, const std::optional<std::vector<std::uint8_t>>& digest) {
    if (!digest) {
        return JS_ThrowInternalError (ctx, "OpenSSL could not compute the digest");
    }
    return JS_NewUint8ArrayCopy (ctx, digest->data (), digest->size ());
}

/// `native.digest(algorithm, data)`.
JSValue js_native_digest (JSContext* ctx, JSValueConst /*this_val*/, int /*argc*/, JSValueConst* argv) {
    const auto algorithm = read_algorithm (ctx, argv[0]);
    std::string data;
    if (!algorithm || !read_crypto_bytes (ctx, argv[1], "the data", data)) {
        return JS_EXCEPTION;
    }
    return digest_bytes (ctx, vayu::utils::digest (*algorithm, data));
}

/// `native.hmac(algorithm, key, data)`.
JSValue js_native_hmac (JSContext* ctx, JSValueConst /*this_val*/, int /*argc*/, JSValueConst* argv) {
    const auto algorithm = read_algorithm (ctx, argv[0]);
    std::string key;
    std::string data;
    if (!algorithm || !read_crypto_bytes (ctx, argv[1], "the key", key) ||
    !read_crypto_bytes (ctx, argv[2], "the data", data)) {
        return JS_EXCEPTION;
    }
    return digest_bytes (ctx, vayu::utils::hmac (*algorithm, key, data));
}

JSValue crypto_js_natives (JSContext* ctx) {
    JSValue natives = JS_NewObject (ctx);
    // The declared lengths matter: QuickJS pads a call short of them with
    // undefined, which read_crypto_bytes then refuses.
    JS_SetPropertyStr (ctx, natives, "digest",
    JS_NewCFunction (ctx, js_native_digest, "digest", 2));
    JS_SetPropertyStr (
    ctx, natives, "hmac", JS_NewCFunction (ctx, js_native_hmac, "hmac", 3));
    return natives;
}

// ============================================================================
// The shelf
// ============================================================================

struct ShelfLibrary {
    /// What `require` takes.
    std::string_view name;
    /// Evaluates to a factory that is called with `natives (ctx)` and returns
    /// the module.
    std::string_view source;
    JSValue (*natives) (JSContext* ctx);
};

constexpr auto SHELF = std::to_array<ShelfLibrary> ({
{ CRYPTO_JS_MODULE, CRYPTO_JS_SHIM, crypto_js_natives },
});

// The import scan reads SHELF_MODULE_NAMES; a library here that is not there
// would be reported as unsupported although it runs.
static_assert (
[] {
    for (const auto& library : SHELF) {
        if (!is_shelf_module (library.name)) {
            return false;
        }
    }
    return SHELF.size () == SHELF_MODULE_NAMES.size ();
}(),
"SHELF and SHELF_MODULE_NAMES list different modules");

struct ShelfGlobal {
    const char* name;
    std::size_t library; ///< An index into SHELF.
};

constexpr auto SHELF_GLOBALS = std::to_array<ShelfGlobal> ({
{ "CryptoJS", 0 },
});

constinit std::atomic<std::size_t> library_loads{ 0 };

/// The shelf's names, comma-separated, for the refusal.
std::string shelf_names () {
    std::string names;
    for (const auto& library : SHELF) {
        names += names.empty () ? "" : ", ";
        names += library.name;
    }
    return names;
}

/// Evaluates @p library's source and builds its module.
JSValue evaluate_library (JSContext* ctx, const ShelfLibrary& library) {
    const std::string file = "<" + std::string (library.name) + ">";
    ScopedValue factory (ctx,
    JS_Eval (ctx, library.source.data (), library.source.size (), file.c_str (),
    JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT));
    if (JS_IsException (factory.get ())) {
        return JS_EXCEPTION;
    }
    library_loads.fetch_add (1, std::memory_order_relaxed);
    JSValue natives  = library.natives (ctx);
    JSValue exported = JS_Call (ctx, factory.get (), JS_UNDEFINED, 1, &natives);
    JS_FreeValue (ctx, natives);
    return exported;
}

/// The module SHELF[@p index] evaluates to in this execution, evaluating it on
/// the first call.
JSValue load_library (JSContext* ctx, std::size_t index) {
    auto* data = get_context_data (ctx);
    if (data == nullptr) {
        return JS_ThrowInternalError (ctx, "require() ran outside a script execution");
    }
    const ShelfLibrary& library = SHELF.at (index);
    if (auto loaded = data->shelf_modules.find (library.name);
    loaded != data->shelf_modules.end ()) {
        return JS_DupValue (ctx, loaded->second);
    }
    JSValue exported = evaluate_library (ctx, library);
    if (JS_IsException (exported)) {
        return exported;
    }
    data->shelf_modules.emplace (library.name, JS_DupValue (ctx, exported));
    return exported;
}

JSValue js_require (JSContext* ctx, JSValueConst /*this_val*/, int /*argc*/, JSValueConst* argv) {
    if (!JS_IsString (argv[0])) {
        return JS_ThrowTypeError (ctx, "require() takes a module name string, not %s",
        js_type_name (ctx, argv[0]));
    }
    const std::string name = js_to_string (ctx, argv[0]);
    for (std::size_t i = 0; i < SHELF.size (); ++i) {
        if (SHELF.at (i).name == name) {
            return load_library (ctx, i);
        }
    }
    return JS_ThrowPlainError (ctx,
    "Cannot find module '%s'. require() here loads only the libraries Vayu "
    "bundles (%s); it reads no file and fetches nothing.",
    name.c_str (), shelf_names ().c_str ());
}

/// Makes the global @p name an ordinary data property holding @p value,
/// taking that reference.
int replace_global (JSContext* ctx, const char* name, JSValue value) {
    ScopedValue global (ctx, JS_GetGlobalObject (ctx));
    return JS_DefinePropertyValueStr (ctx, global.get (), name, value, JS_PROP_C_W_E);
}

/// A library global's getter: the library, which then replaces the accessor.
JSValue js_shelf_global_get (JSContext* ctx,
JSValueConst /*this_val*/,
int /*argc*/,
JSValueConst* /*argv*/,
int magic) {
    const ShelfGlobal& shelf_global = SHELF_GLOBALS.at (static_cast<std::size_t> (magic));
    JSValue exported = load_library (ctx, shelf_global.library);
    if (JS_IsException (exported)) {
        return exported;
    }
    if (replace_global (ctx, shelf_global.name, JS_DupValue (ctx, exported)) < 0) {
        JS_FreeValue (ctx, exported);
        return JS_EXCEPTION;
    }
    return exported;
}

/// A library global's setter: an assignment replaces it, as it would any
/// global, without loading the library.
JSValue js_shelf_global_set (JSContext* ctx,
JSValueConst /*this_val*/,
int /*argc*/,
JSValueConst* argv,
int magic) {
    const ShelfGlobal& shelf_global = SHELF_GLOBALS.at (static_cast<std::size_t> (magic));
    if (replace_global (ctx, shelf_global.name, JS_DupValue (ctx, argv[0])) < 0) {
        return JS_EXCEPTION;
    }
    return JS_UNDEFINED;
}

} // namespace

void setup_require_shelf (JSContext* ctx) {
    ScopedValue global (ctx, JS_GetGlobalObject (ctx));
    JS_SetPropertyStr (ctx, global.get (), "require",
    JS_NewCFunction (ctx, js_require, "require", 1));

    for (std::size_t i = 0; i < SHELF_GLOBALS.size (); ++i) {
        const char* name = SHELF_GLOBALS.at (i).name;
        const int magic  = static_cast<int> (i);
        JSValue getter   = JS_NewCFunctionMagic (
        ctx, js_shelf_global_get, name, 0, JS_CFUNC_generic_magic, magic);
        JSValue setter = JS_NewCFunctionMagic (
        ctx, js_shelf_global_set, name, 1, JS_CFUNC_generic_magic, magic);
        const JSAtom atom = JS_NewAtom (ctx, name);
        // Takes the getter and setter references.
        JS_DefinePropertyGetSet (ctx, global.get (), atom, getter, setter,
        JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
        JS_FreeAtom (ctx, atom);
    }
}

void release_shelf_modules (JSContext* ctx, ContextData& data) {
    for (auto& entry : data.shelf_modules) {
        JS_FreeValue (ctx, entry.second);
    }
    data.shelf_modules.clear ();
}

std::size_t shelf_library_loads () {
    return library_loads.load (std::memory_order_relaxed);
}

} // namespace vayu::runtime::pm_detail
