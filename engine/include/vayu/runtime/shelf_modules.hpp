#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file runtime/shelf_modules.hpp
 * @brief The names `require()` answers (#2578).
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

/// Every name `require` accepts.
inline constexpr auto SHELF_MODULE_NAMES =
std::to_array<std::string_view> ({ CRYPTO_JS_MODULE });

[[nodiscard]] constexpr bool is_shelf_module (std::string_view name) {
    for (const std::string_view shelf_name : SHELF_MODULE_NAMES) {
        if (shelf_name == name) {
            return true;
        }
    }
    return false;
}

} // namespace vayu::runtime
