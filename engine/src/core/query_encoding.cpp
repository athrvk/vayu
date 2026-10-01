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

namespace {

/// Where a `?` or `#` read at @p where moves the URL; every other byte stays.
UrlComponent after_url_byte (char c, UrlComponent where) {
    if (c == '#') {
        return UrlComponent::Fragment;
    }
    return c == '?' && where == UrlComponent::Head ? UrlComponent::Query : where;
}

} // namespace

UrlComponent advance_url_component (std::string_view text, UrlComponent from) {
    UrlComponent where = from;
    for (std::size_t at = 0; at < text.size () && where != UrlComponent::Fragment;) {
        if (const std::size_t end = template_token_end (text, at);
        end != std::string_view::npos) {
            at = end;
            continue;
        }
        where = after_url_byte (text[at++], where);
    }
    return where;
}

std::string encode_at_url_component (std::string_view value, UrlComponent& where) {
    static constexpr std::string_view hex = "0123456789ABCDEF";
    std::string out;
    out.reserve (value.size ());
    for (std::size_t at = 0; at < value.size ();) {
        if (const std::size_t end = template_token_end (value, at);
        end != std::string_view::npos) {
            out += value.substr (at, end - at);
            at = end;
            continue;
        }
        const char ch   = value[at++];
        where           = after_url_byte (ch, where);
        const auto byte = static_cast<unsigned char> (ch);
        if (where == UrlComponent::Query && in_postman_query_encode_set (byte)) {
            out += '%';
            out += hex[byte >> 4U];
            out += hex[byte & 0x0FU];
        } else {
            out += ch;
        }
    }
    return out;
}

} // namespace vayu::core
