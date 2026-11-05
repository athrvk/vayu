#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/variable_text.hpp
 * @brief The one reading of a stored variable's `value` (issue #3245).
 *
 * The app stores strings, but a raw API or MCP caller can store a number, a
 * boolean or a structure. The resolver (`parse_variables`) and the Postman
 * environment export both read the value through this function, so a variable
 * sends the same text it exports as and the two cannot drift apart.
 */

#include <nlohmann/json.hpp>
#include <string>

namespace vayu::utils {

/**
 * @p value as the text a request sends: a string verbatim, a number or boolean
 * as its JSON text (`5`, `true`), an object or array as compact JSON text with
 * members in key order (the same order whichever JSON type the caller holds),
 * and `null` as "".
 */
template <typename BasicJson>
[[nodiscard]] std::string variable_value_text (const BasicJson& value) {
    if (value.is_string ()) {
        return value.template get<std::string> ();
    }
    if (value.is_null ()) {
        return {};
    }
    if (value.is_object () || value.is_array ()) {
        return nlohmann::json (value).dump ();
    }
    return value.dump ();
}

} // namespace vayu::utils
