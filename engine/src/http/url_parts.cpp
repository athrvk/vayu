/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/url_parts.hpp"

#include <curl/curl.h>

namespace vayu::http {

namespace {

/// One field off a parsed handle. `nullopt` is libcurl saying the URL states
/// none of that field - an absent port and an absent fragment are both normal.
std::optional<std::string> url_field (CURLU* handle, CURLUPart part) {
    char* value = nullptr;
    if (curl_url_get (handle, part, &value, 0) != CURLUE_OK) {
        return std::nullopt;
    }
    std::string out (value);
    curl_free (value);
    return out;
}

/// libcurl's percent-decoder, applied to one path segment. The handle argument
/// is documented as unused, so this needs no easy handle - the same reason
/// `form_body.cpp` calls it with `nullptr`. The decoded length comes back
/// out-of-band because a decoded segment may contain NUL bytes.
std::string percent_decode (const std::string& value) {
    int decoded_length = 0;
    char* unescaped    = curl_easy_unescape (
    nullptr, value.c_str (), static_cast<int> (value.size ()), &decoded_length);
    if (!unescaped) {
        return value;
    }
    std::string out (unescaped, static_cast<size_t> (decoded_length));
    curl_free (unescaped);
    return out;
}

/// libcurl's percent-encoder, the inverse of the decode above and the same
/// pure-function call `form_body.cpp` makes. It encodes everything outside the
/// unreserved set, which is wider than a path segment strictly needs - an
/// encoded `:` or `@` is still the same path, and over-encoding cannot change
/// what the URL means the way under-encoding can.
std::string percent_encode (const std::string& value) {
    char* escaped =
    curl_easy_escape (nullptr, value.c_str (), static_cast<int> (value.size ()));
    if (!escaped) {
        return value;
    }
    std::string out (escaped);
    curl_free (escaped);
    return out;
}

/// Split a raw path on `/`, dropping the empty segment the leading slash makes
/// and decoding each of the rest on its own. Segment-at-a-time decoding is the
/// point: decoding the whole path first would turn an encoded `%2F` into a
/// separator and invent a segment that was never there.
std::vector<std::string> split_path (std::string_view raw) {
    std::vector<std::string> segments;
    if (raw.empty ()) {
        return segments;
    }
    if (raw.front () == '/') {
        raw.remove_prefix (1);
    }
    while (true) {
        const size_t slash = raw.find ('/');
        if (slash == std::string_view::npos) {
            segments.push_back (percent_decode (std::string (raw)));
            break;
        }
        segments.push_back (percent_decode (std::string (raw.substr (0, slash))));
        raw.remove_prefix (slash + 1);
    }
    return segments;
}

} // namespace

std::vector<UrlQueryParam> parse_query_params (std::string_view query) {
    std::vector<UrlQueryParam> params;
    while (!query.empty ()) {
        const size_t amp = query.find ('&');
        const std::string_view pair =
        amp == std::string_view::npos ? query : query.substr (0, amp);
        if (!pair.empty ()) {
            const size_t equals = pair.find ('=');
            if (equals == std::string_view::npos) {
                params.push_back ({ std::string (pair), std::nullopt });
            } else {
                params.push_back ({ std::string (pair.substr (0, equals)),
                std::string (pair.substr (equals + 1)) });
            }
        }
        if (amp == std::string_view::npos) {
            break;
        }
        query.remove_prefix (amp + 1);
    }
    return params;
}

std::string compose_query (const std::vector<UrlQueryParam>& params) {
    std::string out;
    for (const auto& param : params) {
        if (!out.empty ()) {
            out += '&';
        }
        out += param.key;
        if (param.value) {
            out += '=';
            out += *param.value;
        }
    }
    return out;
}

std::string compose_url (const UrlParts& parts) {
    if (!parts.parsed) {
        return {};
    }
    std::string out = parts.protocol;
    out += "://";
    out += join_host (parts.host);
    if (!parts.port.empty ()) {
        out += ':';
        out += parts.port;
    }
    // Encoded per segment, undoing `split_path`'s per-segment decode - so a
    // segment an edit put a `/` into stays one segment rather than becoming
    // two, which is the same rule read the other way round.
    for (const auto& segment : parts.path) {
        out += '/';
        out += percent_encode (segment);
    }
    const std::string query = compose_query (parts.query_params);
    if (!query.empty ()) {
        out += '?';
        out += query;
    }
    if (!parts.hash.empty ()) {
        out += '#';
        out += parts.hash;
    }
    return out;
}

std::string join_host (const std::vector<std::string>& host) {
    std::string out;
    for (const auto& segment : host) {
        if (!out.empty ()) {
            out += '.';
        }
        out += segment;
    }
    return out;
}

std::string join_path (const std::vector<std::string>& path) {
    std::string out;
    for (const auto& segment : path) {
        out += '/';
        out += segment;
    }
    return out;
}

UrlParts parse_url_parts (const std::string& url) {
    UrlParts parts;
    CURLU* handle = curl_url ();
    if (!handle) {
        return parts;
    }
    // `CURLU_NON_SUPPORT_SCHEME` so a `ws://` or `grpc://` URL still splits -
    // this parser answers "what are the pieces", never "can libcurl transfer
    // it". No guess flag: inventing a scheme the string does not carry would
    // make `protocol` report something the URL never said.
    const bool ok = curl_url_set (handle, CURLUPART_URL, url.c_str (),
                    CURLU_NON_SUPPORT_SCHEME) == CURLUE_OK;
    if (ok) {
        parts.parsed = true;
        if (auto scheme = url_field (handle, CURLUPART_SCHEME)) {
            parts.protocol = std::move (*scheme);
        }
        if (auto host = url_field (handle, CURLUPART_HOST)) {
            // A host is split on `.` only when it has one to split on; an IPv6
            // literal comes back bracketed and is one segment either way.
            std::string_view remaining (*host);
            while (true) {
                const size_t dot = remaining.find ('.');
                if (dot == std::string_view::npos) {
                    parts.host.emplace_back (remaining);
                    break;
                }
                parts.host.emplace_back (remaining.substr (0, dot));
                remaining.remove_prefix (dot + 1);
            }
        }
        if (auto port = url_field (handle, CURLUPART_PORT)) {
            parts.port = std::move (*port);
        }
        if (auto path = url_field (handle, CURLUPART_PATH)) {
            parts.path = split_path (*path);
        }
        if (auto query = url_field (handle, CURLUPART_QUERY)) {
            parts.query        = std::move (*query);
            parts.query_params = parse_query_params (parts.query);
        }
        if (auto fragment = url_field (handle, CURLUPART_FRAGMENT)) {
            parts.hash = std::move (*fragment);
        }
    }
    curl_url_cleanup (handle);
    return parts;
}

} // namespace vayu::http
