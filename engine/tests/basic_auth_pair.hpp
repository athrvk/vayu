#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <string>
#include <string_view>

#include "vayu/utils/encoding.hpp"

namespace vayu::tests {

/// The `user:password` pair a basic `Authorization` value carries, decoded, so
/// a failure prints the credential that went out rather than its base64.
inline std::string basic_pair_of (const std::string& header) {
    constexpr std::string_view prefix = "Basic ";
    if (header.rfind (prefix, 0) != 0) {
        return "<not basic: " + header + ">";
    }
    return vayu::utils::base64_decode (std::string_view (header).substr (prefix.size ()))
    .value_or ("<not base64: " + header + ">");
}

} // namespace vayu::tests
