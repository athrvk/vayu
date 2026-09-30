/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/query_encoding.hpp"

#include "vayu/core/path_template.hpp"

namespace vayu::core {

namespace {

bool in_postman_query_encode_set (unsigned char byte) {
    if (byte < 0x20 || byte > 0x7E) {
        return true;
    }
    switch (byte) {
    case ' ':
    case '"':
    case '#':
    case '\'':
    case '<':
    case '>': return true;
    default: return false;
    }
}

bool in_query_value_set (unsigned char byte) {
    return byte == '&' || in_postman_query_encode_set (byte);
}

bool in_query_key_set (unsigned char byte) {
    return byte == '=' || in_query_value_set (byte);
}

} // namespace

std::string encode_query_component (std::string_view text, QueryPart part) {
    return encode_outside_tokens (
    text, part == QueryPart::Key ? in_query_key_set : in_query_value_set);
}

} // namespace vayu::core
