#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/postman_encode_sets.hpp
 * @brief The bytes `postman-url-encoder` 3.0.8 percent-encodes in each URL
 *        component (`encoder/encode-set.js`).
 *
 * One copy, so the path-variable writer, the query writer, the whole-URL
 * encoder, the component walk in `query_encoding.cpp` and `wire_url`'s check
 * for a URL the encoder would leave alone cannot disagree about a set.
 */

namespace vayu::core {

/**
 * The C0 controls, space, DEL and every byte above `~` (so each byte of a
 * UTF-8 sequence): what an HTTP request target cannot carry raw (RFC 9112),
 * and the base every Postman set below extends.
 */
constexpr bool is_unsendable_url_byte (unsigned char byte) {
    return byte <= 0x20 || byte >= 0x7F;
}

/// `FRAGMENT_ENCODE_SET`: the unsendable bytes, `"`, `<`, `>` and backtick.
constexpr bool in_postman_fragment_encode_set (unsigned char byte) {
    if (is_unsendable_url_byte (byte)) {
        return true;
    }
    switch (byte) {
    case '"':
    case '<':
    case '>':
    case '`': return true;
    default: return false;
    }
}

/**
 * `PATH_ENCODE_SET`: the fragment set plus `#`, `?`, `{` and `}`. Nothing
 * else - `/`, `%`, `@`, `:`, a backslash and the rest of the reserved set go
 * out as written.
 */
constexpr bool in_postman_path_encode_set (unsigned char byte) {
    if (in_postman_fragment_encode_set (byte)) {
        return true;
    }
    switch (byte) {
    case '#':
    case '?':
    case '{':
    case '}': return true;
    default: return false;
    }
}

/// `QUERY_ENCODE_SET`: the unsendable bytes, `"`, `#`, `'`, `<` and `>`.
constexpr bool in_postman_query_encode_set (unsigned char byte) {
    if (is_unsendable_url_byte (byte)) {
        return true;
    }
    switch (byte) {
    case '"':
    case '#':
    case '\'':
    case '<':
    case '>': return true;
    default: return false;
    }
}

} // namespace vayu::core
