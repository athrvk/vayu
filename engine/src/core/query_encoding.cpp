/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/query_encoding.hpp"

#include "vayu/core/path_template.hpp"
#include "vayu/core/postman_encode_sets.hpp"

#include <cstddef>
#include <utility>

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

std::vector<QueryPair> split_query_pairs (std::string_view query) {
    std::vector<QueryPair> pairs;
    std::size_t start = 0;
    while (start <= query.size ()) {
        const std::size_t amp = query.find ('&', start);
        const std::string_view pair =
        query.substr (start, amp == std::string_view::npos ? amp : amp - start);
        start = amp == std::string_view::npos ? query.size () + 1 : amp + 1;
        if (pair.empty ()) {
            continue;
        }
        const std::size_t equals = pair.find ('=');
        QueryPair split;
        split.key       = std::string (pair.substr (0, equals));
        split.valueless = equals == std::string_view::npos;
        if (!split.valueless) {
            split.value = std::string (pair.substr (equals + 1));
        }
        pairs.push_back (std::move (split));
    }
    return pairs;
}

namespace {

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

// The component moves *before* a byte is judged, so a `?` or `#` is always
// structure, never encoded.
std::string encode_at_url_component (std::string_view value, UrlComponent& where) {
    static constexpr std::string_view hex = "0123456789ABCDEF";
    std::string out;
    out.reserve (value.size ());
    for (std::size_t at = 0; at < value.size ();) {
        if (const std::size_t end = template_token_end (value, at);
        end != std::string_view::npos) {
            out += value.substr (at, end - at);
            where = after_url_token (where);
            at    = end;
            continue;
        }
        const char ch   = value[at++];
        where           = after_url_byte (ch, where);
        const auto byte = static_cast<unsigned char> (ch);
        if (in_substituted_set (byte, where)) {
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
