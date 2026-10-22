#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file runtime/shelf_modules.hpp
 * @brief The names `require()` answers (#2578), and the members of crypto-js,
 *        the one library on its shelf the import scan reads member by member.
 *
 * Header-only on purpose: `runtime/require_shelf.cpp` builds the shelf from
 * these names and only exists where QuickJS does, while the Postman import's
 * script scan (`core/script_api_scan.cpp`) must know the same names in every
 * build to leave a `require` of one of them out of its notice. One list means
 * a library added to the shelf stops being reported in the same edit.
 */

#include <array>
#include <string_view>

namespace vayu::runtime {

inline constexpr std::string_view CRYPTO_JS_MODULE = "crypto-js";
inline constexpr std::string_view UUID_MODULE      = "uuid";
inline constexpr std::string_view LODASH_MODULE    = "lodash";
inline constexpr std::string_view MOMENT_MODULE    = "moment";
/// A sub-path, matched as the whole name: Postman exposes csv-parse only here,
/// so a bare `csv-parse` or any other path under it is not on the shelf.
inline constexpr std::string_view CSV_PARSE_SYNC_MODULE = "csv-parse/lib/sync";
inline constexpr std::string_view XML2JS_MODULE         = "xml2js";
inline constexpr std::string_view CHAI_MODULE           = "chai";
inline constexpr std::string_view AJV_MODULE            = "ajv";
inline constexpr std::string_view TV4_MODULE            = "tv4";

/// Every name `require` accepts.
inline constexpr auto SHELF_MODULE_NAMES = std::to_array<std::string_view> (
{ CRYPTO_JS_MODULE, UUID_MODULE, LODASH_MODULE, MOMENT_MODULE,
CSV_PARSE_SYNC_MODULE, XML2JS_MODULE, CHAI_MODULE, AJV_MODULE, TV4_MODULE });

[[nodiscard]] constexpr bool is_shelf_module (std::string_view name) {
    for (const std::string_view shelf_name : SHELF_MODULE_NAMES) {
        if (shelf_name == name) {
            return true;
        }
    }
    return false;
}

/**
 * Every dotted path under `CryptoJS` that the shim (`runtime/crypto_js_shim.hpp`)
 * defines, and the one list the import scan reads to tell a crypto-js use that
 * runs from one that throws. A namespace (`enc`, `lib`, `lib.WordArray`) is
 * listed beside its members, and a path with no member listed under it is a
 * leaf: whatever follows it (`.stringify`, `.toString`) is the value's own.
 * `script_completions_test.cpp` pins this list to what the runtime defines and
 * to what the editor offers, so a member added to the shim is added here or
 * the build is red.
 */
inline constexpr auto CRYPTO_JS_MEMBERS = std::to_array<std::string_view> (
{ "MD5", "SHA1", "SHA224", "SHA256", "SHA384", "SHA512", "HmacMD5", "HmacSHA1",
"HmacSHA224", "HmacSHA256", "HmacSHA384", "HmacSHA512", "enc", "enc.Hex", "enc.Latin1",
"enc.Utf8", "enc.Base64", "lib", "lib.WordArray", "lib.WordArray.create" });

[[nodiscard]] constexpr bool is_crypto_js_member (std::string_view path) {
    for (const std::string_view member : CRYPTO_JS_MEMBERS) {
        if (member == path) {
            return true;
        }
    }
    return false;
}

/// Whether @p path has members listed under it.
[[nodiscard]] constexpr bool is_crypto_js_namespace (std::string_view path) {
    for (const std::string_view member : CRYPTO_JS_MEMBERS) {
        if (member.size () > path.size () && member.starts_with (path) &&
        member[path.size ()] == '.') {
            return true;
        }
    }
    return false;
}

} // namespace vayu::runtime
