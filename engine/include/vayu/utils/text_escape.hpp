#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <string>
#include <string_view>

namespace vayu::utils {

/**
 * @p text as the inside of a JSON string literal.
 *
 * Only what JSON forbids raw is rewritten - the quote, the backslash and the
 * control characters - so every other byte survives exactly as written.
 * Deliberately *not* `nlohmann::json::dump`, which additionally validates
 * UTF-8 and would throw on a cell a latin-1 CSV produced; neither a data bind
 * nor a snapshot mask is the place to reject bytes the rest of the request
 * would have carried.
 */
inline std::string escape_json_string_content (std::string_view text) {
    std::string out;
    out.reserve (text.size ());
    for (const char c : text) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char> (c) < 0x20) {
                constexpr std::string_view kHex = "0123456789abcdef";
                out += "\\u00";
                out += kHex[(static_cast<unsigned char> (c) >> 4U) & 0x0FU];
                out += kHex[static_cast<unsigned char> (c) & 0x0FU];
            } else {
                out += c;
            }
        }
    }
    return out;
}

/**
 * @p text as XML content, with @p attribute_quote - the delimiter of the
 * attribute the token sits in, or `'\0'` in character data - escaped too.
 *
 * `&` and `<` are the two characters XML forbids raw in both positions. `>` is
 * only forbidden as part of `]]>`, but escaping it always is conventional and
 * cannot change what the document says, so it is not worth tracking the one
 * sequence that needs it. A quote is legal in character data and inside the
 * attribute the *other* quote delimits, so only the delimiter actually in force
 * is rewritten - `it's` stays readable in a double-quoted attribute.
 */
inline std::string escape_xml_content (std::string_view text, char attribute_quote) {
    std::string out;
    out.reserve (text.size ());
    for (const char c : text) {
        switch (c) {
        case '&': out += "&amp;"; break;
        case '<': out += "&lt;"; break;
        case '>': out += "&gt;"; break;
        case '"': out += (attribute_quote == '"') ? "&quot;" : "\""; break;
        case '\'': out += (attribute_quote == '\'') ? "&apos;" : "'"; break;
        default: out += c;
        }
    }
    return out;
}

} // namespace vayu::utils
