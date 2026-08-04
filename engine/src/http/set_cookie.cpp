/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/set_cookie.cpp
 * @brief `Set-Cookie` parsing. See `vayu/http/set_cookie.hpp` for why this
 *        exists twice (here and in the renderer) and what pins the two copies.
 */

#include "vayu/http/set_cookie.hpp"

#include <cctype>

namespace vayu::http {

namespace {

bool is_space (char c) {
    return std::isspace (static_cast<unsigned char> (c)) != 0;
}

std::string trim (std::string_view s) {
    size_t begin = 0;
    size_t end   = s.size ();
    while (begin < end && is_space (s[begin])) {
        begin++;
    }
    while (end > begin && is_space (s[end - 1])) {
        end--;
    }
    return std::string (s.substr (begin, end - begin));
}

/**
 * @brief Whether the comma at @p comma starts a new cookie.
 *
 * The renderer spells this as a lookahead - `/,\s*(?=[^;,\s=]+=)/` - and this
 * is the same rule read by hand: skip whitespace, then require at least one
 * character that is not `;`, `,`, whitespace or `=`, then an `=`. A date's
 * " 21 Oct 2015 07:28:00 GMT" fails at the first space before any `=`, so an
 * `Expires` comma is not a boundary.
 */
bool starts_new_cookie (std::string_view header, size_t comma) {
    size_t i = comma + 1;
    while (i < header.size () && is_space (header[i])) {
        i++;
    }
    const size_t name_start = i;
    while (i < header.size () && !is_space (header[i]) && header[i] != ';' &&
    header[i] != ',' && header[i] != '=') {
        i++;
    }
    return i > name_start && i < header.size () && header[i] == '=';
}

/// Read one `name=value; attr; attr` chunk. Returns false for a chunk that
/// names no cookie, so the caller drops it.
bool parse_chunk (std::string_view chunk, SetCookie& out) {
    const size_t first_semicolon = chunk.find (';');
    const std::string_view pair  = chunk.substr (0, first_semicolon);

    const size_t equals = pair.find ('=');
    if (equals == 0 || equals == std::string_view::npos) {
        return false;
    }

    out.name = trim (pair.substr (0, equals));
    // The remainder verbatim, not a second split - a base64 value's `=`
    // padding is part of the value.
    out.value = trim (pair.substr (equals + 1));

    size_t at = first_semicolon;
    while (at != std::string_view::npos) {
        const size_t next           = chunk.find (';', at + 1);
        const std::string_view attr = chunk.substr (at + 1,
        next == std::string_view::npos ? std::string_view::npos : next - at - 1);
        std::string trimmed         = trim (attr);
        if (!trimmed.empty ()) {
            out.attrs.push_back (std::move (trimmed));
        }
        at = next;
    }
    return true;
}

} // namespace

std::vector<SetCookie> parse_set_cookie (std::string_view header) {
    std::vector<SetCookie> cookies;

    size_t chunk_start = 0;
    for (size_t i = 0; i <= header.size (); i++) {
        const bool at_end = i == header.size ();
        if (!at_end && (header[i] != ',' || !starts_new_cookie (header, i))) {
            continue;
        }
        SetCookie cookie;
        if (parse_chunk (header.substr (chunk_start, i - chunk_start), cookie)) {
            cookies.push_back (std::move (cookie));
        }
        chunk_start = i + 1;
    }

    return cookies;
}

} // namespace vayu::http
