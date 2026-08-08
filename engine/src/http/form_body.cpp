/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/form_body.hpp"

#include <curl/curl.h>

namespace vayu::http {

namespace {

// libcurl's percent-encoder, with its allocation returned to it. The handle
// argument is unused by libcurl (and documented as ignored), so this stays a
// pure function - no easy handle has to exist to encode a body.
std::string percent_encode (const std::string& value) {
    char* escaped =
    curl_easy_escape (nullptr, value.c_str (), static_cast<int> (value.size ()));
    if (!escaped) {
        return {};
    }
    std::string out (escaped);
    curl_free (escaped);
    return out;
}

} // namespace

bool is_form_mode (BodyMode mode) {
    return mode == BodyMode::Form || mode == BodyMode::FormData;
}

std::vector<FormField> enabled_fields (const std::vector<FormField>& fields) {
    std::vector<FormField> out;
    out.reserve (fields.size ());
    for (const auto& field : fields) {
        if (field.enabled) {
            out.push_back (field);
        }
    }
    return out;
}

std::string encode_urlencoded (const std::vector<FormField>& fields) {
    std::string out;
    for (const auto& field : fields) {
        if (!field.enabled) {
            continue;
        }
        if (!out.empty ()) {
            out += '&';
        }
        out += percent_encode (field.key);
        out += '=';
        out += percent_encode (field.value);
    }
    return out;
}

bool has_wire_body (const Body& body) {
    if (body.mode == BodyMode::None) {
        return false;
    }
    if (is_form_mode (body.mode)) {
        for (const auto& field : body.fields) {
            if (field.enabled) {
                return true;
            }
        }
        return false;
    }
    return !body.content.empty ();
}

std::string implied_content_type (const Body& body) {
    if (body.mode == BodyMode::Form && has_wire_body (body)) {
        return "application/x-www-form-urlencoded";
    }
    return {};
}

bool content_type_is_engine_owned (const Body& body) {
    return body.mode == BodyMode::FormData && has_wire_body (body);
}

} // namespace vayu::http
