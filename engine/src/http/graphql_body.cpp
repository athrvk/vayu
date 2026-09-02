/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/graphql_body.cpp
 * @brief The GraphQL-over-HTTP envelope. See `vayu/http/graphql_body.hpp` for
 *        why the engine applies it rather than each client.
 */

#include "vayu/http/graphql_body.hpp"

#include "vayu/http/url_parts.hpp"

#include <nlohmann/json.hpp>

#include <cctype>
#include <string_view>
#include <vector>

namespace vayu::http {

namespace {

bool is_space (char c) {
    return std::isspace (static_cast<unsigned char> (c)) != 0;
}

std::string_view lstrip (std::string_view text) {
    while (!text.empty () && is_space (text.front ())) {
        text.remove_prefix (1);
    }
    return text;
}

/// True when the text opens as a JSON object - `{` followed by a quoted key -
/// whether or not the rest of it parses. The only reason to ask is when the
/// parse already failed; see the header for why an unreadable body is passed
/// through rather than wrapped.
bool opens_as_json_object (std::string_view text) {
    std::string_view rest = lstrip (text);
    if (rest.empty () || rest.front () != '{') {
        return false;
    }
    rest.remove_prefix (1);
    rest = lstrip (rest);
    return !rest.empty () && rest.front () == '"';
}

} // namespace

bool graphql_body_is_enveloped (const std::string& content) {
    // Non-throwing parse: a body arrives from a user and being unreadable is
    // an expected answer here, not an exceptional one.
    const auto parsed = nlohmann::json::parse (content, nullptr, false);
    if (parsed.is_discarded ()) {
        return opens_as_json_object (content);
    }
    if (!parsed.is_object ()) {
        return false;
    }
    const auto query = parsed.find ("query");
    return query != parsed.end () && query->is_string ();
}

std::string graphql_wire_body (const std::string& content) {
    if (content.empty () || graphql_body_is_enveloped (content)) {
        return content;
    }
    return nlohmann::json{ { "query", content } }.dump ();
}

std::optional<std::string> graphql_get_parameters (const std::string& content) {
    if (content.empty ()) {
        return std::nullopt;
    }
    if (!graphql_body_is_enveloped (content)) {
        // A bare document is the whole query, and the only parameter there is
        // to send. This is the common case: the request builder writes an
        // envelope, an agent or a `curl` caller writes the document.
        return compose_query ({ { "query", percent_encode (content) } });
    }

    const auto envelope = nlohmann::json::parse (content, nullptr, false);
    if (envelope.is_discarded () || !envelope.is_object ()) {
        // Envelope-shaped and unreadable - see the header.
        return std::nullopt;
    }

    std::vector<UrlQueryParam> params;
    for (const auto& [key, value] : envelope.items ()) {
        if (key == "query") {
            // `graphql_body_is_enveloped` already proved this is a string.
            params.push_back ({ "query", percent_encode (value.get<std::string> ()) });
        } else if (key == "operationName") {
            // An explicit `null` is how a client says "no named operation",
            // which the absent parameter says too.
            if (value.is_null ()) {
                continue;
            }
            if (!value.is_string ()) {
                return std::nullopt;
            }
            params.push_back (
            { "operationName", percent_encode (value.get<std::string> ()) });
        } else if (key == "variables" || key == "extensions") {
            if (value.is_null ()) {
                continue;
            }
            if (!value.is_object ()) {
                return std::nullopt;
            }
            params.push_back ({ key, percent_encode (value.dump ()) });
        } else {
            // A member with no parameter to carry it - see the header for why
            // that is a reason to keep the body transport rather than to drop
            // what the user wrote.
            return std::nullopt;
        }
    }

    // `items()` walks in the object's own order, which nlohmann sorts by key,
    // so the parameters come out in a stable order regardless of how the
    // envelope was written. Sorted or not, a server reads them by name.
    return compose_query (params);
}

} // namespace vayu::http
