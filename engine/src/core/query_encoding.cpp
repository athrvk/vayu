/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/query_encoding.hpp"

#include "vayu/core/path_template.hpp"
#include "vayu/core/postman_encode_sets.hpp"

namespace vayu::core {

namespace {

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

bool in_head (UrlComponent where) {
    return where == UrlComponent::Head || where == UrlComponent::HeadSeparator;
}

/// Where reading @p c at @p where moves the URL.
UrlComponent after_url_byte (char c, UrlComponent where) {
    if (c == '#') {
        return UrlComponent::Fragment;
    }
    if (where == UrlComponent::Query || where == UrlComponent::Fragment) {
        return where;
    }
    if (c == '?') {
        return UrlComponent::Query;
    }
    if (where == UrlComponent::Path) {
        return where;
    }
    if (c == ':') {
        return UrlComponent::HeadSeparator;
    }
    if (c == '/') {
        return where == UrlComponent::HeadSeparator ? where : UrlComponent::Path;
    }
    return UrlComponent::Head;
}

/// A kept `{{...}}` token reads as head text, a scheme or a host: a `/` after
/// `http://{{host}}` opens the path.
UrlComponent after_url_token (UrlComponent where) {
    return where == UrlComponent::HeadSeparator ? UrlComponent::Head : where;
}

using ComponentSet = bool (*) (unsigned char byte, UrlComponent where);

/// @p text with each byte @p in_set answers true for at the component it is
/// read in written as `%XX`, every whole `{{...}}` token kept verbatim, and
/// @p where advanced past it. The component moves *before* a byte is judged,
/// so a `?` or `#` is always structure, never encoded.
std::string encode_by_component (std::string_view text, UrlComponent& where, ComponentSet in_set) {
    static constexpr std::string_view hex = "0123456789ABCDEF";
    std::string out;
    out.reserve (text.size ());
    for (std::size_t at = 0; at < text.size ();) {
        if (const std::size_t end = template_token_end (text, at);
        end != std::string_view::npos) {
            out += text.substr (at, end - at);
            where = after_url_token (where);
            at    = end;
            continue;
        }
        const char ch   = text[at++];
        where           = after_url_byte (ch, where);
        const auto byte = static_cast<unsigned char> (ch);
        if (in_set (byte, where)) {
            out += '%';
            out += hex[byte >> 4U];
            out += hex[byte & 0x0FU];
        } else {
            out += ch;
        }
    }
    return out;
}

bool in_substituted_set (unsigned char byte, UrlComponent where) {
    switch (where) {
    case UrlComponent::Path: return in_postman_path_encode_set (byte);
    case UrlComponent::Query: return in_postman_query_encode_set (byte);
    case UrlComponent::Fragment: return in_postman_fragment_encode_set (byte);
    case UrlComponent::Head:
    case UrlComponent::HeadSeparator: return false;
    }
    return false;
}

bool in_literal_set (unsigned char byte, UrlComponent where) {
    return !in_head (where) && is_unsendable_url_byte (byte);
}

} // namespace

UrlComponent advance_url_component (std::string_view text, UrlComponent from) {
    UrlComponent where = from;
    for (std::size_t at = 0; at < text.size () && where != UrlComponent::Fragment;) {
        if (const std::size_t end = template_token_end (text, at);
        end != std::string_view::npos) {
            where = after_url_token (where);
            at    = end;
            continue;
        }
        where = after_url_byte (text[at++], where);
    }
    return where;
}

std::string encode_at_url_component (std::string_view value, UrlComponent& where) {
    return encode_by_component (value, where, in_substituted_set);
}

std::string encode_literal_at_url_component (std::string_view text, UrlComponent& where) {
    return encode_by_component (text, where, in_literal_set);
}

} // namespace vayu::core
