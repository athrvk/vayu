/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/url_encoding.hpp"

#include <cstddef>

#include "vayu/core/path_template.hpp"
#include "vayu/core/query_encoding.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::core {

namespace {

constexpr std::size_t npos = std::string_view::npos;

/// `FRAGMENT_ENCODE_SET` (`postman-url-encoder/encoder/encode-set.js`).
bool in_postman_fragment_encode_set (unsigned char byte) {
    if (byte < 0x20 || byte > 0x7E) {
        return true;
    }
    switch (byte) {
    case ' ':
    case '"':
    case '<':
    case '>':
    case '`': return true;
    default: return false;
    }
}

/// `USERINFO_ENCODE_SET`: `PATH_ENCODE_SET` extended with `/ : ; = @ [ \ ] ^ |`.
bool in_postman_userinfo_encode_set (unsigned char byte) {
    if (in_postman_fragment_encode_set (byte)) {
        return true;
    }
    switch (byte) {
    case '#':
    case '?':
    case '{':
    case '}':
    case '/':
    case ':':
    case ';':
    case '=':
    case '@':
    case '[':
    case '\\':
    case ']':
    case '^':
    case '|': return true;
    default: return false;
    }
}

/// Where each separator sits in @p text with every `{{...}}` token skipped,
/// so a separator inside a variable name splits nothing - the parser's own
/// masking (`normalizeVariables`).
class Scanner {
    public:
    explicit Scanner (std::string_view text) : text_ (text) {
    }

    /// First @p c in [@p from, @p to) outside a token, or npos.
    [[nodiscard]] std::size_t find (char c, std::size_t from, std::size_t to) const {
        for (std::size_t at = from; at < to;) {
            if (const std::size_t end = template_token_end (text_, at); end != npos) {
                at = end;
                continue;
            }
            if (text_[at] == c) {
                return at;
            }
            ++at;
        }
        return npos;
    }

    /// Last @p c in [@p from, @p to) outside a token, or npos.
    [[nodiscard]] std::size_t rfind (char c, std::size_t from, std::size_t to) const {
        std::size_t found = npos;
        for (std::size_t at = find (c, from, to); at != npos; at = find (c, at + 1, to)) {
            found = at;
        }
        return found;
    }

    private:
    std::string_view text_;
};

std::string encode_query (std::string_view query) {
    const Scanner scan (query);
    std::string out;
    for (std::size_t begin = 0;;) {
        std::size_t end = scan.find ('&', begin, query.size ());
        if (end == npos) {
            end = query.size ();
        }
        const std::string_view pair = query.substr (begin, end - begin);
        const std::size_t equals = Scanner (pair).find ('=', 0, pair.size ());
        out += encode_query_component (pair.substr (0, equals), QueryPart::Key);
        if (equals != npos) {
            out += '=';
            out += encode_query_component (pair.substr (equals + 1), QueryPart::Value);
        }
        if (end == query.size ()) {
            return out;
        }
        out += '&';
        begin = end + 1;
    }
}

std::string encode_userinfo (std::string_view userinfo) {
    const std::size_t colon = Scanner (userinfo).find (':', 0, userinfo.size ());
    std::string out =
    encode_outside_tokens (userinfo.substr (0, colon), in_postman_userinfo_encode_set);
    if (colon != npos) {
        out += ':';
        out += encode_outside_tokens (userinfo.substr (colon + 1), in_postman_userinfo_encode_set);
    }
    return out;
}

/// @p text with each ASCII letter outside a token lowercased, and each
/// backslash outside one made a `/` when @p slashes.
std::string rewrite_outside_tokens (std::string_view text, bool lowercase, bool slashes) {
    std::string out (text);
    for (std::size_t at = 0; at < text.size ();) {
        if (const std::size_t end = template_token_end (text, at); end != npos) {
            at = end;
            continue;
        }
        char& c = out[at++];
        if (slashes && c == '\\') {
            c = '/';
        } else if (lowercase && c >= 'A' && c <= 'Z') {
            c = static_cast<char> (c - 'A' + 'a');
        }
    }
    return out;
}

/// `toNodeUrl`'s host: lowercased, then `encodeHost` - `url.domainToASCII`,
/// or the host as typed when that answers `""`. @p host_port may end in a
/// `:port`; an IPv6 literal is ASCII and only lowercased.
std::string postman_host (std::string_view host_port) {
    std::string out =
    rewrite_outside_tokens (host_port, /*lowercase=*/true, /*slashes=*/false);
    if (out.starts_with ('[')) {
        return out;
    }
    const std::size_t colon = Scanner (out).find (':', 0, out.size ());
    const std::size_t end   = colon == npos ? out.size () : colon;
    if (auto ascii = vayu::http::ascii_host (std::string_view (out).substr (0, end))) {
        out.replace (0, end, *ascii);
    }
    return out;
}

} // namespace

std::string encode_url_as_postman (std::string_view url) {
    const std::size_t first = url.find_first_not_of (" \t\n\v\f\r");
    if (first == npos) {
        return {};
    }
    url.remove_prefix (first);
    const Scanner scan (url);

    const std::size_t hash_at  = scan.find ('#', 0, url.size ());
    const std::size_t head_end = hash_at == npos ? url.size () : hash_at;
    const std::size_t query_at = scan.find ('?', 0, head_end);
    const std::string head =
    rewrite_outside_tokens (url.substr (0, query_at == npos ? head_end : query_at),
    /*lowercase=*/false, /*slashes=*/true);

    // The authority starts after the first `://` and any further slashes (the
    // parser drops those, keeping one for `file`), or at the start when there
    // is no `://`.
    const Scanner head_scan (head);
    std::size_t authority = 0;
    for (std::size_t colon = head_scan.find (':', 0, head.size ());
    colon != npos; colon   = head_scan.find (':', colon + 1, head.size ())) {
        if (head.compare (colon + 1, 2, "//") != 0) {
            continue;
        }
        authority = head.find_first_not_of ('/', colon + 3);
        authority = authority == npos ? head.size () : authority;
        if (authority > colon + 3 &&
        vayu::utils::ascii_lower_equal (head.substr (0, colon), "file")) {
            --authority;
        }
        break;
    }
    std::size_t path_at = head_scan.find ('/', authority, head.size ());
    path_at             = path_at == npos ? head.size () : path_at;

    std::string out (head, 0, authority);
    const std::size_t at_sign = head_scan.rfind ('@', authority, path_at);
    std::size_t host          = authority;
    if (at_sign != npos) {
        out += encode_userinfo (
        std::string_view (head).substr (authority, at_sign - authority));
        out += '@';
        host = at_sign + 1;
    }
    out += postman_host (std::string_view (head).substr (host, path_at - host));
    out += encode_path_variable_value (std::string_view (head).substr (path_at));

    if (query_at != npos) {
        out += '?';
        out += encode_query (url.substr (query_at + 1, head_end - query_at - 1));
    }
    if (hash_at != npos) {
        out += '#';
        out += encode_outside_tokens (url.substr (hash_at + 1), in_postman_fragment_encode_set);
    }
    return out;
}

} // namespace vayu::core
