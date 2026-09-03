/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/default_headers.hpp"

#include <algorithm>
#include <cctype>
#include <format>

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include "vayu/db/database.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::http {

namespace {

/// RFC 9110 `tchar`: what a header name is allowed to be built from.
bool is_token_char (char c) {
    const auto byte = static_cast<unsigned char> (c);
    if (std::isalnum (byte) != 0) {
        return true;
    }
    constexpr std::string_view SYMBOLS = "!#$%&'*+-.^_`|~";
    return SYMBOLS.find (c) != std::string_view::npos;
}

/// The encodings libcurl was built to decode, in the order curl itself lists
/// them. Built once, on first use: nothing at namespace scope is built at run
/// time, and `curl_version_info` is a call.
const std::string& built_accept_encodings () {
    static const std::string value = [] {
        const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
        std::string encodings;
        const auto add = [&encodings] (std::string_view name) {
            if (!encodings.empty ()) {
                encodings += ", ";
            }
            encodings.append (name);
        };
        if (info != nullptr) {
            if ((info->features & CURL_VERSION_LIBZ) != 0) {
                add ("gzip");
                add ("deflate");
            }
            if ((info->features & CURL_VERSION_BROTLI) != 0) {
                add ("br");
            }
            if ((info->features & CURL_VERSION_ZSTD) != 0) {
                add ("zstd");
            }
        }
        return encodings;
    }();
    return value;
}

/// A bare RFC 4122 UUID - `generateUUID()`'s shape, and the only `X-Request-ID`
/// value the repair pass treats as the renderer's rather than the user's.
bool is_bare_uuid (std::string_view value) {
    constexpr std::string_view LAYOUT = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
    if (value.size () != LAYOUT.size ()) {
        return false;
    }
    for (size_t i = 0; i < LAYOUT.size (); ++i) {
        const bool want_dash = LAYOUT[i] == '-';
        const auto byte      = static_cast<unsigned char> (value[i]);
        if (want_dash ? value[i] != '-' : std::isxdigit (byte) == 0) {
            return false;
        }
    }
    return true;
}

/// A stored row's `value`, or "" for a row that carries none.
std::string row_value (const nlohmann::json& row) {
    if (row.contains ("value") && row["value"].is_string ()) {
        return row["value"].get<std::string> ();
    }
    return {};
}

/// Is this stored row one a pre-#1229 renderer wrote? See
/// `strip_legacy_managed_headers` for why each rule is as narrow as it is.
bool legacy_managed_row (const std::string& key, const std::string& value) {
    const std::string folded = vayu::utils::ascii_lower (key);
    if (folded == "x-vayu-version") {
        return true;
    }
    if (folded == "x-request-id") {
        return is_bare_uuid (value);
    }
    if (folded == "user-agent") {
        return vayu::utils::ascii_lower (value).starts_with ("vayu/");
    }
    return false;
}

} // namespace

const std::string& supported_accept_encodings () {
    return built_accept_encodings ();
}

std::optional<std::string> unusable_header_name (std::string_view name) {
    if (name.empty ()) {
        return "a header name cannot be empty";
    }
    const auto offending = std::find_if_not (name.begin (), name.end (), is_token_char);
    if (offending != name.end ()) {
        return std::format (
        "'{}' is not a header name: '{}' cannot appear in one", name, *offending);
    }
    return std::nullopt;
}

DefaultHeaderPolicy resolve_default_header_policy (vayu::db::Database& db,
DefaultHeaderScope scope) {
    DefaultHeaderPolicy policy;

    if (db.get_config_bool (std::string (CORRELATION_ID_ENABLED_KEY), false)) {
        std::string name = db.get_config_string (std::string (CORRELATION_ID_HEADER_KEY),
        std::string (DEFAULT_CORRELATION_HEADER));
        // The write path refuses a name that is not one (`key_rejection` in
        // routes/config.cpp), so a bad value here is a hand-edited or
        // downgraded row rather than user input: fall back to the namespaced
        // default instead of putting a broken line on the wire.
        policy.correlation_header =
        unusable_header_name (name) ? std::string (DEFAULT_CORRELATION_HEADER) : name;
    }

    const bool compress = scope == DefaultHeaderScope::Load ?
    db.get_config_bool (std::string (LOAD_NEGOTIATE_COMPRESSION_KEY), true) :
    db.get_config_bool (std::string (NEGOTIATE_COMPRESSION_KEY), true);
    if (compress) {
        policy.accept_encoding = supported_accept_encodings ();
    }

    return policy;
}

std::vector<DeclaredDefaultHeader> declared_default_headers (
const DefaultHeaderPolicy& policy) {
    std::vector<DeclaredDefaultHeader> declared;
    if (!policy.user_agent.empty ()) {
        declared.push_back (
        DeclaredDefaultHeader{ "User-Agent", policy.user_agent, {}, false });
    }
    if (!policy.accept_encoding.empty ()) {
        declared.push_back (DeclaredDefaultHeader{ "Accept-Encoding",
        policy.accept_encoding, std::string (NEGOTIATE_COMPRESSION_KEY), false });
    }
    if (!policy.correlation_header.empty ()) {
        declared.push_back (DeclaredDefaultHeader{ policy.correlation_header,
        {}, std::string (CORRELATION_ID_ENABLED_KEY), true });
    }
    return declared;
}

std::optional<std::string> strip_legacy_managed_headers (const std::string& headers_json) {
    nlohmann::json rows;
    try {
        rows = nlohmann::json::parse (headers_json);
    } catch (const nlohmann::json::parse_error&) {
        return std::nullopt;
    }
    if (!rows.is_array ()) {
        return std::nullopt;
    }

    nlohmann::json kept = nlohmann::json::array ();
    bool dropped        = false;
    for (const auto& row : rows) {
        if (row.is_object () && row.contains ("key") && row["key"].is_string () &&
        legacy_managed_row (row["key"].get<std::string> (), row_value (row))) {
            dropped = true;
            continue;
        }
        kept.push_back (row);
    }
    if (!dropped) {
        return std::nullopt;
    }
    return kept.dump ();
}

bool suppresses_default_header (const Request& request, std::string_view name) {
    return request.suppressed_default_headers.contains (std::string (name));
}

bool negotiates_compression (const Request& request, const DefaultHeaderPolicy& policy) {
    return !policy.accept_encoding.empty () &&
    !request.headers.contains ("Accept-Encoding") &&
    !suppresses_default_header (request, "Accept-Encoding");
}

} // namespace vayu::http
