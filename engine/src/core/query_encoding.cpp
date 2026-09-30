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

UrlComponent advance_url_component (std::string_view text, UrlComponent from) {
    UrlComponent where = from;
    for (std::size_t at = 0; at < text.size () && where != UrlComponent::Fragment;) {
        if (const std::size_t end = template_token_end (text, at);
        end != std::string_view::npos) {
            at = end;
            continue;
        }
        const char c = text[at++];
        if (c == '#') {
            where = UrlComponent::Fragment;
        } else if (where == UrlComponent::Head) {
            where = c == '?' ? UrlComponent::QueryKey : where;
        } else if (c == '&') {
            where = UrlComponent::QueryKey;
        } else if (c == '=' && where == UrlComponent::QueryKey) {
            where = UrlComponent::QueryValue;
        }
    }
    return where;
}

std::string encode_at_url_component (std::string_view value, UrlComponent where) {
    switch (where) {
    case UrlComponent::QueryKey:
        return encode_query_component (value, QueryPart::Key);
    case UrlComponent::QueryValue:
        return encode_query_component (value, QueryPart::Value);
    case UrlComponent::Head:
    case UrlComponent::Fragment: break;
    }
    return std::string (value);
}

} // namespace vayu::core
