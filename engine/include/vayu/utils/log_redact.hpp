#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/log_redact.hpp
 * @brief Redaction by key for a `LogRecord`'s `fields` (issue #1556, #1557).
 *
 * Text logging could not scrub a secret because nothing separated a secret's
 * value from the sentence around it. A `LogRecord`'s fields are structured, so
 * redaction can run once, by key, in `Logger::write`, before either renderer
 * sees the record - a caller never redacts its own fields.
 */

#include <algorithm>
#include <array>
#include <string_view>

#include <nlohmann/json.hpp>

#include "vayu/utils/ascii_case.hpp"

namespace vayu::utils {

/**
 * @brief Whether @p name is a field name whose value must never reach a log.
 *
 * Matched case-insensitively, as a whole name - "auth_token" is not "token"
 * and is deliberately not caught, the same way `debug_redact.hpp`'s header
 * list only ever matched whole header names. The set is #1556's, shared by
 * the engine and the (not yet landed) app side so a record either side emits
 * redacts the same fields.
 */
inline bool is_secret_field_name (std::string_view name) {
    static constexpr std::array<std::string_view, 14> kSecretFieldNames = {
        "authorization", "proxy-authorization", "cookie", "set-cookie",
        "www-authenticate", "proxy-authenticate", "authentication-info", "token",
        "access_token", "refresh_token", "client_secret", "password", "apikey", "x-api-key"
    };
    return std::any_of (kSecretFieldNames.begin (), kSecretFieldNames.end (),
    [name] (std::string_view secret) { return ascii_lower_equal (name, secret); });
}

/**
 * @brief Whether @p name is a field the URL rule applies to - ends in `url`
 *        or `Url` (`proxyUrl`, `url`, `refreshTokenUrl`, ...).
 */
inline bool is_url_field_name (std::string_view name) {
    static constexpr std::string_view kSuffix = "url";
    if (name.size () < kSuffix.size ()) {
        return false;
    }
    return ascii_lower_equal (name.substr (name.size () - kSuffix.size ()), kSuffix);
}

/**
 * @brief Strip a URL (or a bare path-and-query) down to scheme, host and
 *        path, dropping `user:pass@` and the whole query string.
 *
 * A log line's job is to say *what* was called, not to carry the credentials
 * or tokens a query string or userinfo component can hold - the same rule
 * `request_log.cpp`'s line has always followed. `https://u:p@h/x?y=1` becomes
 * `https://h/x`; a path with no scheme (`/p?api_key=S`, a curl request line)
 * becomes `/p`.
 */
inline std::string strip_url_secrets (std::string_view url) {
    std::string_view rest = url;

    // Scheme + host, so userinfo is only ever searched for after them - a
    // query value that happens to contain "@" must never be mistaken for one.
    std::string prefix;
    const auto scheme_end = rest.find ("://");
    if (scheme_end != std::string_view::npos) {
        const auto host_start      = scheme_end + 3;
        const auto path_start      = rest.find ('/', host_start);
        std::string_view authority = rest.substr (host_start,
        path_start == std::string_view::npos ? std::string_view::npos : path_start - host_start);
        const auto at              = authority.find ('@');
        if (at != std::string_view::npos) {
            authority = authority.substr (at + 1);
        }
        prefix = std::string (rest.substr (0, scheme_end + 3)) + std::string (authority);
        rest = path_start == std::string_view::npos ? std::string_view{} :
                                                      rest.substr (path_start);
    }

    // A curl request line is not a bare path - "GET /p?k=v HTTP/1.1" - so the
    // query ends at the next space, not at the end of the string; whatever
    // follows that space (the protocol suffix) is kept.
    std::string suffix;
    const auto query = rest.find ('?');
    if (query != std::string_view::npos) {
        const auto after_query = rest.find (' ', query);
        if (after_query != std::string_view::npos) {
            suffix = std::string (rest.substr (after_query));
        }
        rest = rest.substr (0, query);
    }

    return prefix + std::string (rest) + suffix;
}

/**
 * @brief Redact @p node in place, at every depth.
 *
 * An object key matching `is_secret_field_name` becomes `"<redacted>"`
 * wholesale; a string-valued key matching `is_url_field_name` goes through
 * `strip_url_secrets`. Arrays and nested objects are walked rather than
 * treated as opaque leaves, because the config dump this exists for
 * (`server.cpp`'s `{"config": {...}}` field) is one level deeper than the
 * field itself.
 */
inline void redact_fields (nlohmann::json& node) {
    if (node.is_object ()) {
        for (auto& [key, value] : node.items ()) {
            if (is_secret_field_name (key)) {
                value = "<redacted>";
            } else if (value.is_string () && is_url_field_name (key)) {
                value = strip_url_secrets (value.get<std::string> ());
            } else {
                redact_fields (value);
            }
        }
    } else if (node.is_array ()) {
        for (auto& element : node) {
            redact_fields (element);
        }
    }
}

} // namespace vayu::utils
