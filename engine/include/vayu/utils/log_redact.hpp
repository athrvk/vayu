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
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/utils/ascii_case.hpp"

namespace vayu::utils {

/// What every redaction in the engine writes in place of a withheld value - a
/// log field, a curl debug header line, a run's config snapshot (#1803) - so
/// all three read the same to whoever finds one.
inline constexpr std::string_view kRedactedMarker = "<redacted>";

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
    static constexpr std::array<std::string_view, 25> kSecretFieldNames = {
        "authorization", "proxy-authorization", "cookie", "set-cookie",
        "www-authenticate", "proxy-authenticate", "authentication-info",
        "token", "access_token", "refresh_token", "client_secret", "password",
        "apikey", "x-api-key", "x-auth-token", "x-csrf-token", "passphrase",
        "api_key", "id_token", "code", "code_verifier", "private_key",
        "secret_access_key", "secretaccesskey", "session_token"
    };
    return std::any_of (kSecretFieldNames.begin (), kSecretFieldNames.end (),
    [name] (std::string_view secret) { return ascii_lower_equal (name, secret); });
}

/**
 * @brief Whether a header named @p name carries a credential for one request:
 *        a name from the shared set, or one of @p extra_secret_headers (the
 *        header the request's own API-key auth names, which no static list can
 *        know). Case-insensitive, as header names are.
 */
inline bool is_secret_header_name (std::string_view name,
const std::vector<std::string>& extra_secret_headers) {
    return is_secret_field_name (name) ||
    std::any_of (extra_secret_headers.begin (), extra_secret_headers.end (),
    [name] (const std::string& extra) { return ascii_lower_equal (name, extra); });
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
 *        path, dropping `user:pass@`, the query string and the fragment.
 *
 * A log line's job is to say *what* was called, not to carry the credentials
 * or tokens a query string, fragment or userinfo component can hold - the
 * same rule `request_log.cpp`'s line has always followed. `https://u:p@h/x?y=1`
 * becomes `https://h/x`; a path with no scheme (`/p?api_key=S`, a curl request
 * line) becomes `/p`.
 *
 * Userinfo is everything before the *last* `@` of the authority, so a password
 * that itself contains `@` (`http://u:p@ss@h`) leaves nothing behind, and it is
 * dropped with or without a scheme (`user:pw@proxy:8080` is what
 * `proxy_url_rejection` accepts). The authority ends at the first `/`, `?` or
 * `#`, so an `@` inside a query value is never mistaken for userinfo; a bare
 * token containing whitespace (`GET /p HTTP/1.1`) is not an authority at all.
 * Query and fragment each end at the next space, which keeps a curl request
 * line's protocol suffix.
 */
inline std::string strip_url_secrets (std::string_view url) {
    std::string_view rest = url;

    std::string prefix;
    // "://" only opens an authority when nothing path-like precedes it - a
    // query value such as `?next=http://h` is not one.
    auto scheme_end = rest.find ("://");
    if (scheme_end != std::string_view::npos &&
    rest.substr (0, scheme_end).find_first_of ("/?# \t") != std::string_view::npos) {
        scheme_end = std::string_view::npos;
    }
    std::size_t authority_start = 0;
    if (scheme_end != std::string_view::npos) {
        authority_start = scheme_end + 3;
    }
    const auto authority_end   = rest.find_first_of ("/?#", authority_start);
    std::string_view authority = rest.substr (authority_start,
    authority_end == std::string_view::npos ? std::string_view::npos :
                                              authority_end - authority_start);
    const bool is_authority    = scheme_end != std::string_view::npos ||
    (!authority.empty () &&
    authority.find_first_of (" \t") == std::string_view::npos && authority_end != 0);
    if (is_authority) {
        const auto at = authority.rfind ('@');
        if (at != std::string_view::npos) {
            authority = authority.substr (at + 1);
            prefix = std::string (rest.substr (0, authority_start)) + std::string (authority);
            rest = authority_end == std::string_view::npos ?
            std::string_view{} :
            rest.substr (authority_end);
        }
    }

    // A curl request line is not a bare path - "GET /p?k=v HTTP/1.1" - so the
    // query or fragment ends at the next space, not at the end of the string;
    // whatever follows that space (the protocol suffix) is kept.
    std::string suffix;
    const auto cut = rest.find_first_of ("?#");
    if (cut != std::string_view::npos) {
        const auto after = rest.find (' ', cut);
        if (after != std::string_view::npos) {
            suffix = std::string (rest.substr (after));
        }
        rest = rest.substr (0, cut);
    }

    return prefix + std::string (rest) + suffix;
}

/**
 * @brief Run `strip_url_secrets` over every `scheme://...` token in free text.
 *
 * For lines a library composes (curl's `Issue another request to this URL:
 * '...'`), where the URL is embedded in a sentence. A token runs from the
 * last whitespace or quote before the `://` scheme to the next whitespace or
 * quote after it.
 */
inline std::string strip_urls_in_text (std::string_view text) {
    constexpr std::string_view kBoundary = " \t\r\n'\"<>";
    std::string out;
    std::size_t pos = 0;
    while (pos < text.size ()) {
        const auto sep = text.find ("://", pos);
        if (sep == std::string_view::npos) {
            break;
        }
        const auto before = text.substr (pos, sep - pos).find_last_of (kBoundary);
        const auto token_start = before == std::string_view::npos ? pos : pos + before + 1;
        auto token_end = text.find_first_of (kBoundary, sep);
        if (token_end == std::string_view::npos) {
            token_end = text.size ();
        }
        out.append (text.substr (pos, token_start - pos));
        out += strip_url_secrets (text.substr (token_start, token_end - token_start));
        pos = token_end;
    }
    out.append (text.substr (pos));
    return out;
}

/**
 * @brief Redact @p node in place, at every depth.
 *
 * An object key matching `is_secret_field_name` becomes `kRedactedMarker`
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
                value = std::string (kRedactedMarker);
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
