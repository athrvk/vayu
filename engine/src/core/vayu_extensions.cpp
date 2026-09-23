/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/vayu_extensions.cpp
 * @brief See the header: the `x-vayu-request` / `x-vayu-collection` vocabulary,
 *        its secret redaction, and the checks an import runs before trusting it.
 */

#include "vayu/core/vayu_extensions.hpp"

#include "vayu/core/constants.hpp"

#include <algorithm>
#include <array>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>

namespace vayu::core::vayu_ext {

namespace {

/**
 * The auth members that hold a credential rather than describe one, across
 * every mode Vayu stores (`bearer.token`, `basic.password`, `apikey.value`, an
 * OAuth 2.0 config's `clientSecret` and password-grant `password`, AWS's key
 * pair and session token, and the tokens a config may have cached).
 */
constexpr auto SECRET_AUTH_KEYS = std::to_array<std::string_view> (
{ "token", "password", "value", "clientSecret", "secretKey", "accessKey",
"sessionToken", "accessToken", "refreshToken", "idToken", "secret" });

/// Vayu's body modes (`RequestBody["mode"]` in the app's `domain.ts`).
constexpr auto BODY_MODES = std::to_array<std::string_view> ({ "none", "json",
"text", "graphql", "jsonrpc", "xml", "form-data", "x-www-form-urlencoded" });

/// Vayu's auth modes (`AuthMode` in `domain.ts`).
constexpr auto AUTH_MODES = std::to_array<std::string_view> ({ "none", "noauth",
"inherit", "bearer", "basic", "apikey", "oauth2", "digest", "aws", "ntlm" });

/// The `httpVersion` values the request routes accept.
constexpr auto HTTP_VERSIONS =
std::to_array<std::string_view> ({ "auto", "http1.1", "http2" });

/// A form-data part's optional members besides the row's own.
constexpr auto FORM_PART_KEYS =
std::to_array<std::string_view> ({ "type", "fileName", "contentType" });

template <size_t N>
bool one_of (const std::array<std::string_view, N>& set, std::string_view value) {
    return std::find (set.begin (), set.end (), value) != set.end ();
}

/**
 * Whether @p text is one `{{variable}}` reference and nothing else. Such a
 * value names where the secret lives without being it, so it is portable -
 * and blanking it would lose the one thing the user configured.
 */
bool is_variable_reference (std::string_view text) {
    while (!text.empty () && text.front () == ' ') {
        text.remove_prefix (1);
    }
    while (!text.empty () && text.back () == ' ') {
        text.remove_suffix (1);
    }
    if (text.size () < 5 || !text.starts_with ("{{") || !text.ends_with ("}}")) {
        return false;
    }
    const std::string_view inner = text.substr (2, text.size () - 4);
    return inner.find_first_of ("{}") == std::string_view::npos &&
    inner.find_first_not_of (' ') != std::string_view::npos;
}

/// Blanks every secret member of one auth level, and recurses into `config`.
void redact_level (Json& node, int& omitted) {
    if (!node.is_object ()) {
        return;
    }
    for (auto member = node.begin (); member != node.end (); ++member) {
        if (member.key () == "config") {
            redact_level (member.value (), omitted);
            continue;
        }
        if (!one_of (SECRET_AUTH_KEYS, member.key ()) || !member->is_string ()) {
            continue;
        }
        const auto& text = member->get_ref<const std::string&> ();
        if (text.empty () || is_variable_reference (text)) {
            continue;
        }
        *member = "";
        omitted += 1;
    }
}

bool is_string_member (const Json& node, const char* key) {
    const auto found = node.find (key);
    return found != node.end () && found->is_string ();
}

/// One row as the write routes accept it, plus @p extra optional string keys.
template <size_t N>
std::optional<Json>
row_of (const Json& value, const std::array<std::string_view, N>& extra) {
    if (!value.is_object () || !is_string_member (value, "key")) {
        return std::nullopt;
    }
    Json row{ { "key", value.at ("key") },
        { "value", is_string_member (value, "value") ? value.at ("value") : Json ("") } };
    const auto enabled = value.find ("enabled");
    if (enabled != value.end () && !enabled->is_boolean ()) {
        return std::nullopt;
    }
    row["enabled"] = enabled == value.end () ? true : enabled->get<bool> ();
    for (const char* key : { "description", "source" }) {
        if (is_string_member (value, key)) {
            row[key] = value.at (key);
        }
    }
    for (const std::string_view key : extra) {
        const std::string name (key);
        if (is_string_member (value, name.c_str ())) {
            row[name] = value.at (name);
        }
    }
    return std::make_optional (std::move (row));
}

template <size_t N>
std::optional<Json>
rows_with (const Json& value, const std::array<std::string_view, N>& extra) {
    if (!value.is_array ()) {
        return std::nullopt;
    }
    Json rows = Json::array ();
    for (const Json& entry : value) {
        std::optional<Json> row = row_of (entry, extra);
        if (!row) {
            return std::nullopt;
        }
        rows.push_back (std::move (*row));
    }
    return std::make_optional (std::move (rows));
}

} // namespace

Json redact_auth (const Json& auth, int& omitted) {
    Json out = auth;
    redact_level (out, omitted);
    return out;
}

Json redact_variables (const Json& variables, int& omitted) {
    Json out = variables;
    if (!out.is_object ()) {
        return out;
    }
    for (auto& [name, entry] : out.items ()) {
        if (!entry.is_object ()) {
            continue;
        }
        const auto secret = entry.find ("secret");
        const auto value  = entry.find ("value");
        if (secret == entry.end () || !secret->is_boolean () ||
        !secret->get<bool> () || value == entry.end () || !value->is_string ()) {
            continue;
        }
        const auto& text = value->get_ref<const std::string&> ();
        if (text.empty () || is_variable_reference (text)) {
            continue;
        }
        *value = "";
        omitted += 1;
    }
    return out;
}

Json portable_body (const Json& body) {
    Json out          = body;
    const auto fields = out.find ("fields");
    if (fields == out.end () || !fields->is_array ()) {
        return out;
    }
    for (Json& field : *fields) {
        if (field.is_object ()) {
            field.erase ("src");
            field.erase ("unresolved");
        }
    }
    return out;
}

std::optional<Json> rows_of (const Json& value) {
    return rows_with (value, std::array<std::string_view, 0>{});
}

std::optional<Json> body_of (const Json& value) {
    if (!value.is_object () || !is_string_member (value, "mode")) {
        return std::nullopt;
    }
    const std::string mode = value.at ("mode").get<std::string> ();
    if (!one_of (BODY_MODES, mode)) {
        return std::nullopt;
    }
    if (mode == "none") {
        return std::make_optional (Json{ { "mode", "none" } });
    }
    if (mode == "form-data" || mode == "x-www-form-urlencoded") {
        const auto fields        = value.find ("fields");
        std::optional<Json> rows = std::make_optional (Json::array ());
        if (fields != value.end ()) {
            rows = mode == "form-data" ? rows_with (*fields, FORM_PART_KEYS) :
                                         rows_of (*fields);
        }
        if (!rows) {
            return std::nullopt;
        }
        return std::make_optional (
        Json{ { "mode", mode }, { "fields", std::move (*rows) } });
    }
    const auto content = value.find ("content");
    if (content != value.end () && !content->is_string ()) {
        return std::nullopt;
    }
    return std::make_optional (Json{ { "mode", mode },
    { "content", content == value.end () ? Json ("") : *content } });
}

std::optional<Json> auth_of (const Json& value, bool collection) {
    if (!value.is_object () || !is_string_member (value, "mode")) {
        return std::nullopt;
    }
    const std::string mode = value.at ("mode").get<std::string> ();
    if (!one_of (AUTH_MODES, mode) || (collection && mode == "inherit")) {
        return std::nullopt;
    }
    const auto config = value.find ("config");
    if (config != value.end () && !config->is_object ()) {
        return std::nullopt;
    }
    return std::make_optional (value);
}

std::optional<Json> variables_of (const Json& value) {
    if (!value.is_object ()) {
        return std::nullopt;
    }
    Json out = Json::object ();
    for (auto entry = value.begin (); entry != value.end (); ++entry) {
        const Json& variable = entry.value ();
        if (!variable.is_object () || !is_string_member (variable, "value")) {
            return std::nullopt;
        }
        const auto enabled = variable.find ("enabled");
        if (enabled != variable.end () && !enabled->is_boolean ()) {
            return std::nullopt;
        }
        Json kept{ { "value", variable.at ("value") },
            { "enabled", enabled == variable.end () ? true : enabled->get<bool> () } };
        if (const auto secret = variable.find ("secret");
        secret != variable.end () && secret->is_boolean ()) {
            kept["secret"] = *secret;
        }
        if (is_string_member (variable, "type")) {
            kept["type"] = variable.at ("type");
        }
        out[entry.key ()] = std::move (kept);
    }
    return std::make_optional (std::move (out));
}

std::optional<Json> settings_of (const Json& value) {
    if (!value.is_object ()) {
        return std::nullopt;
    }
    Json out = Json::object ();
    for (const char* key : { "followRedirects", "verifySSL", "stream" }) {
        if (const auto found = value.find (key); found != value.end ()) {
            if (!found->is_boolean ()) {
                return std::nullopt;
            }
            out[key] = *found;
        }
    }
    if (const auto found = value.find ("maxRedirects"); found != value.end ()) {
        if (!found->is_number_integer ()) {
            return std::nullopt;
        }
        out["maxRedirects"] = *found;
    }
    if (const auto found = value.find ("httpVersion"); found != value.end ()) {
        if (!found->is_string () || !one_of (HTTP_VERSIONS, found->get<std::string> ())) {
            return std::nullopt;
        }
        out["httpVersion"] = *found;
    }
    return std::make_optional (std::move (out));
}

namespace {

/// One saved example as `POST /import/apply` takes it, or nothing.
std::optional<Json> example_of (const Json& example) {
    if (!example.is_object () || !is_string_member (example, "name")) {
        return std::nullopt;
    }
    const auto status = example.find ("status");
    if (status == example.end () || !status->is_number_integer () ||
    status->get<int> () < 100 || status->get<int> () > 599) {
        return std::nullopt;
    }
    Json kept{ { "name", example.at ("name") }, { "status", *status } };
    for (const char* key : { "body", "contentType" }) {
        if (const auto found = example.find (key); found != example.end ()) {
            if (!found->is_string ()) {
                return std::nullopt;
            }
            kept[key] = *found;
        }
    }
    if (const auto headers = example.find ("headers"); headers != example.end ()) {
        std::optional<Json> rows = rows_of (*headers);
        if (!rows) {
            return std::nullopt;
        }
        kept["headers"] = std::move (*rows);
    }
    if (const auto truncated = example.find ("bodyTruncated");
    truncated != example.end ()) {
        if (!truncated->is_boolean ()) {
            return std::nullopt;
        }
        kept["bodyTruncated"] = *truncated;
    }
    return std::make_optional (std::move (kept));
}

} // namespace

std::optional<Json> examples_of (const Json& value) {
    if (!value.is_array ()) {
        return std::nullopt;
    }
    Json out = Json::array ();
    for (const Json& example : value) {
        std::optional<Json> kept = example_of (example);
        if (!kept) {
            return std::nullopt;
        }
        out.push_back (std::move (*kept));
    }
    return std::make_optional (std::move (out));
}

std::optional<Json> data_schema_of (const Json& value) {
    if (!value.is_object ()) {
        return std::nullopt;
    }
    Json out = Json::object ();
    if (const auto columns = value.find ("columns"); columns != value.end ()) {
        if (!columns->is_array () || columns->size () > constants::data_schema::MAX_COLUMNS) {
            return std::nullopt;
        }
        std::unordered_set<std::string> seen;
        for (const Json& column : *columns) {
            if (!column.is_string () || column.get_ref<const std::string&> ().empty () ||
            column.get_ref<const std::string&> ().size () > constants::data_schema::MAX_COLUMN_CHARS ||
            !seen.insert (column.get<std::string> ()).second) {
                return std::nullopt;
            }
        }
        out["columns"] = *columns;
    }
    if (const auto declared = value.find ("declaredAt"); declared != value.end ()) {
        if (!declared->is_number ()) {
            return std::nullopt;
        }
        out["declaredAt"] = *declared;
    }
    if (is_string_member (value, "fileName")) {
        out["fileName"] = value.at ("fileName");
    }
    return std::make_optional (std::move (out));
}

std::optional<Json> folder_path_of (const Json& value) {
    if (!value.is_array () || value.empty ()) {
        return std::nullopt;
    }
    for (const Json& segment : value) {
        if (!segment.is_string () || segment.get_ref<const std::string&> ().empty ()) {
            return std::nullopt;
        }
    }
    return std::make_optional (value);
}

} // namespace vayu::core::vayu_ext
