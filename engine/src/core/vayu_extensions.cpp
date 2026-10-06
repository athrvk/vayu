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
#include "vayu/core/postman_format.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/log_redact.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

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
"sessionToken", "accessToken", "refreshToken", "idToken", "secret",
// Postman's names for the credentials of the auth types Vayu keeps as data
// only: Hawk's key, OAuth 1.0's consumer and token secrets, EdgeGrid's
// client token, a JWT's private key.
"authKey", "consumerSecret", "tokenSecret", "clientToken", "privateKey",
// A Postman OAuth 2.0 block's PKCE verifier.
"code_verifier" });

/**
 * The wire names a credential goes by in a Postman OAuth 2.0 block's extra
 * request parameters (`tokenRequestParams`, `authRequestParams`,
 * `refreshRequestParams`: arrays of `{key, value, enabled, send_as}` rows),
 * beside the attribute names above.
 */
constexpr auto SECRET_PARAM_KEYS =
std::to_array<std::string_view> ({ "client_secret", "client_assertion", "code_verifier",
"refresh_token", "access_token", "id_token", "password", "assertion" });

/**
 * The members of a `config` bag that say how to authenticate rather than carry
 * a credential, across every mode stored as `{mode, config}`: an OAuth 2.0
 * config's own fields, AWS (Postman `awsv4`, Insomnia `iam`), digest, NTLM,
 * Hawk, OAuth 1.0, EdgeGrid and JWT. A bag is redacted by *this* list, not by
 * `SECRET_AUTH_KEYS`: the names a bag can hold are open (Insomnia writes
 * `secretAccessKey` and `accessKeyId`, Postman `authKey`, a future type
 * something else), so a name list that has to know every credential misses
 * the first one it did not hear of, and an unlisted member is blanked instead.
 * Identifiers (`username`, `clientId`, `consumerKey`, `authId`) stay, as they
 * do in the named `basic` and `oauth2` blocks.
 */
constexpr auto NON_SECRET_CONFIG_KEYS = std::to_array<std::string_view> (
{ // OAuth 2.0 (`OAuth2Config` in the app's `domain.ts`), less `clientSecret`
// and `password`.
"grantType", "authorizationUrl", "accessTokenUrl", "refreshTokenUrl",
"callbackUrl", "clientId", "credentialsPlacement", "username", "pkce", "scope",
"audience", "resource", "tokenPlacement", "headerPrefix", "queryParamName",
"autoFetchToken", "autoRefreshToken", "useEmbeddedBrowser", "credentialsId",
// AWS Signature.
"region", "service", "addAuthDataToQuery",
// Digest and NTLM.
"realm", "algorithm", "nonce", "nonceCount", "clientNonce", "opaque", "qop",
"domain", "workstation", "disableRetryRequest",
// Hawk.
"authId", "user", "extraData", "appId", "delegation", "timestamp", "includePayloadHash",
// OAuth 1.0.
"consumerKey", "signatureMethod", "version", "addParamsToHeader",
"addEmptyParamsToSign", "includeBodyHash", "disableHeaderEncoding",
// EdgeGrid.
"baseURi", "headersToSign",
// JWT.
"payload", "header", "addTokenTo", "queryParamKey", "isSecretBase64Encoded" });

/// Query-parameter names that are credentials on top of the shared set
/// (`utils::is_secret_field_name`, less `code`): spellings that set leaves out
/// because a log field is never a URL, and the signature a presigned URL
/// carries. `key` is absent on purpose: `?key=` is as often a cache or sort
/// key as a Google API key, and an API key a request's auth names is added per
/// request instead (`apikey_param_names`).
constexpr auto EXTRA_SECRET_PARAM_NAMES =
std::to_array<std::string_view> ({ "api-key", "secret", "auth_token", "signature",
"sig", "x-amz-signature", "x-amz-security-token", "client_assertion", "assertion" });

/// Vayu's body modes (`RequestBody["mode"]` in the app's `domain.ts`).
constexpr auto BODY_MODES = std::to_array<std::string_view> ({ "none", "json", "text",
"graphql", "jsonrpc", "xml", "form-data", "x-www-form-urlencoded", "binary" });

/// Vayu's auth modes (`AuthMode` in `domain.ts`).
constexpr auto AUTH_MODES =
std::to_array<std::string_view> ({ "none", "noauth", "inherit", "bearer", "basic",
"apikey", "oauth2", "digest", "aws", "ntlm", "hawk", "oauth1", "edgegrid", "jwt" });

/// The `httpVersion` values the request routes accept.
constexpr auto HTTP_VERSIONS =
std::to_array<std::string_view> ({ "auto", "http1.1", "http2" });

/// A form-data part's optional members besides the row's own. `src` is kept
/// only on a file part, and always as unresolved - see `body_of`.
constexpr auto FORM_PART_KEYS =
std::to_array<std::string_view> ({ "type", "src", "fileName", "contentType" });

/// A Params row's optional members besides the row's own.
constexpr auto PARAM_ROW_KEYS = std::to_array<std::string_view> ({ "in", "type" });

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

/// Blanks @p value when it is a non-empty string that is not one
/// `{{variable}}` reference, counting it in @p omitted.
void blank_secret (Json& value, int& omitted) {
    if (!value.is_string ()) {
        return;
    }
    const auto& text = value.get_ref<const std::string&> ();
    if (text.empty () || is_variable_reference (text)) {
        return;
    }
    value = "";
    omitted += 1;
}

/// Blanks the value of each `{key, value, ...}` row of @p rows whose key
/// satisfies @p names_credential, counting each in @p omitted.
template <typename NamesCredential>
void blank_rows_where (Json& rows, int& omitted, NamesCredential names_credential) {
    if (!rows.is_array ()) {
        return;
    }
    for (Json& row : rows) {
        if (!row.is_object ()) {
            continue;
        }
        const auto key   = row.find ("key");
        const auto value = row.find ("value");
        if (key == row.end () || !key->is_string () || value == row.end ()) {
            continue;
        }
        if (names_credential (key->get_ref<const std::string&> ())) {
            blank_secret (*value, omitted);
        }
    }
}

/// An OAuth 2.0 block's extra request parameters (`tokenRequestParams`, ...).
void redact_param_rows (Json& rows, int& omitted) {
    blank_rows_where (rows, omitted, [] (std::string_view name) {
        return one_of (SECRET_AUTH_KEYS, name) || one_of (SECRET_PARAM_KEYS, name);
    });
}

/// Blanks every string under @p value: a member the allowlist did not name has
/// no known meaning, so it is treated as a credential wherever it nests.
void blank_unlisted_value (Json& value, int& omitted) {
    if (value.is_string ()) {
        blank_secret (value, omitted);
        return;
    }
    if (!value.is_structured ()) {
        return;
    }
    for (Json& child : value) {
        blank_unlisted_value (child, omitted);
    }
}

/// Which rule one Postman auth type's attributes are redacted by: the types
/// Vayu keeps as a `config` bag take the allowlist (their attribute names are
/// open, see `NON_SECRET_CONFIG_KEYS`); `bearer`, `basic`, `apikey` and
/// `oauth2` have a closed, known set of credential names.
enum class AttributeRule : std::uint8_t { NamedCredentials, Allowlist };

AttributeRule attribute_rule_of (std::string_view postman_type) {
    const bool config_type = std::any_of (postman::CONFIG_AUTH_TYPES.begin (),
    postman::CONFIG_AUTH_TYPES.end (),
    [postman_type] (const postman::ConfigAuthType& named) {
        return named.postman == postman_type;
    });
    return config_type ? AttributeRule::Allowlist : AttributeRule::NamedCredentials;
}

/// One attribute of a Postman auth type: a credential is blanked, and an
/// array of parameter rows is walked for the credentials it carries.
void redact_postman_attribute (const std::string& name, Json& value, AttributeRule rule, int& omitted) {
    if (rule == AttributeRule::Allowlist) {
        if (!one_of (NON_SECRET_CONFIG_KEYS, name)) {
            blank_unlisted_value (value, omitted);
        }
        return;
    }
    if (one_of (SECRET_AUTH_KEYS, name)) {
        blank_secret (value, omitted);
    } else {
        redact_param_rows (value, omitted);
    }
}

/// One Postman auth type's detail: v2.1's `[{key, value, type}]` attribute
/// array, or v2.0's `{name: value}` object.
void redact_postman_detail (Json& detail, AttributeRule rule, int& omitted) {
    if (detail.is_object ()) {
        for (auto field = detail.begin (); field != detail.end (); ++field) {
            redact_postman_attribute (field.key (), field.value (), rule, omitted);
        }
        return;
    }
    if (!detail.is_array ()) {
        return;
    }
    for (Json& attribute : detail) {
        if (!attribute.is_object ()) {
            continue;
        }
        const auto key   = attribute.find ("key");
        const auto value = attribute.find ("value");
        if (key != attribute.end () && key->is_string () && value != attribute.end ()) {
            redact_postman_attribute (key->get<std::string> (), *value, rule, omitted);
        }
    }
}

/// A stored `config` bag with every member the allowlist does not name
/// blanked. A bag that is not an object holds nothing the list can vouch for,
/// so it is treated as one credential.
void redact_config_bag (Json& bag, int& omitted) {
    if (!bag.is_object ()) {
        blank_unlisted_value (bag, omitted);
        return;
    }
    for (auto member = bag.begin (); member != bag.end (); ++member) {
        if (!one_of (NON_SECRET_CONFIG_KEYS, member.key ())) {
            blank_unlisted_value (member.value (), omitted);
        }
    }
}

/// Blanks every secret member of one auth level: its named credentials, its
/// `config` bag by allowlist, and a Postman import's `postman` source.
void redact_level (Json& node, int& omitted) {
    if (!node.is_object ()) {
        return;
    }
    for (auto member = node.begin (); member != node.end (); ++member) {
        if (member.key () == "config") {
            redact_config_bag (member.value (), omitted);
        } else if (member.key () == "postman") {
            redact_postman_auth (member.value (), omitted);
        } else if (one_of (SECRET_AUTH_KEYS, member.key ())) {
            blank_secret (member.value (), omitted);
        }
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

bool names_extra (std::string_view name, const std::vector<std::string>& extra) {
    return std::any_of (extra.begin (), extra.end (), [name] (const std::string& named) {
        return utils::ascii_lower_equal (name, named);
    });
}

/// Whether a query parameter or a Params row named @p name carries a
/// credential: a name the request's auth claims, or the shared set less
/// `code`, plus `EXTRA_SECRET_PARAM_NAMES`.
bool is_secret_param_name (std::string_view name, const std::vector<std::string>& extra) {
    if (names_extra (name, extra)) {
        return true;
    }
    if (utils::ascii_lower_equal (name, "code")) {
        return false;
    }
    return utils::is_secret_field_name (name) ||
    std::any_of (EXTRA_SECRET_PARAM_NAMES.begin (),
    EXTRA_SECRET_PARAM_NAMES.end (), [name] (std::string_view secret) {
        return utils::ascii_lower_equal (name, secret);
    });
}

/// `name=value` with the value emptied when @p name is a credential and the
/// value is neither empty nor one `{{variable}}` reference. A bare `name` has
/// no value to blank.
std::string redact_query_pair (std::string_view pair,
const std::vector<std::string>& extra,
int& omitted) {
    const auto equals = pair.find ('=');
    if (equals == std::string_view::npos || equals + 1 == pair.size ()) {
        return std::string (pair);
    }
    if (!is_secret_param_name (pair.substr (0, equals), extra) ||
    is_variable_reference (pair.substr (equals + 1))) {
        return std::string (pair);
    }
    omitted += 1;
    return std::string (pair.substr (0, equals + 1));
}

/// A `&`-separated query (or a fragment written as one, `#access_token=...`)
/// with each credential pair redacted and every other byte kept.
std::string
redact_query (std::string_view query, const std::vector<std::string>& extra, int& omitted) {
    std::string out;
    std::size_t start = 0;
    while (true) {
        const auto ampersand = query.find ('&', start);
        const auto length =
        ampersand == std::string_view::npos ? std::string_view::npos : ampersand - start;
        out += redact_query_pair (query.substr (start, length), extra, omitted);
        if (ampersand == std::string_view::npos) {
            return out;
        }
        out += '&';
        start = ampersand + 1;
    }
}

/// The scheme-and-authority-and-path part of a URL with the password of its
/// userinfo dropped (`user:pass@host` becomes `user@host`). A first segment
/// holding spaces or nothing is a path, not an authority; the userinfo ends at
/// the *last* `@`, so a password containing one is still wholly dropped.
std::string drop_userinfo_password (std::string_view head, int& omitted) {
    const auto scheme_end = head.find ("://");
    const bool has_scheme = scheme_end != std::string_view::npos &&
    head.substr (0, scheme_end).find_first_of ("/ \t") == std::string_view::npos;
    const std::size_t authority_start = has_scheme ? scheme_end + 3 : 0;
    const auto authority_end          = head.find ('/', authority_start);
    const std::string_view authority  = head.substr (authority_start,
    authority_end == std::string_view::npos ? std::string_view::npos :
                                               authority_end - authority_start);
    const auto at                     = authority.rfind ('@');
    if (at == std::string_view::npos ||
    (!has_scheme && authority.find_first_of (" \t") != std::string_view::npos)) {
        return std::string (head);
    }
    const std::string_view userinfo = authority.substr (0, at);
    const auto colon                = userinfo.find (':');
    if (colon == std::string_view::npos || colon + 1 == userinfo.size () ||
    is_variable_reference (userinfo.substr (colon + 1))) {
        return std::string (head);
    }
    omitted += 1;
    return std::string (head.substr (0, authority_start)) +
    std::string (userinfo.substr (0, colon)) +
    std::string (head.substr (authority_start + at));
}

/// The names an API-key auth sends its key under, in the query or in a header.
std::vector<std::string> apikey_names (const Json& auth, bool in_query) {
    if (!auth.is_object () || !is_string_member (auth, "mode") ||
    auth.at ("mode") != "apikey" || !is_string_member (auth, "key") ||
    auth.at ("key").get_ref<const std::string&> ().empty ()) {
        return {};
    }
    const bool placed_in_query = is_string_member (auth, "in") && auth.at ("in") == "query";
    if (placed_in_query != in_query) {
        return {};
    }
    return { auth.at ("key").get<std::string> () };
}

} // namespace

void redact_postman_auth (Json& source, int& omitted) {
    if (!source.is_object ()) {
        return;
    }
    for (auto member = source.begin (); member != source.end (); ++member) {
        if (member.key () != "type") {
            redact_postman_detail (
            member.value (), attribute_rule_of (member.key ()), omitted);
        }
    }
}

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

std::vector<std::string> apikey_header_names (const Json& auth) {
    return apikey_names (auth, false);
}

std::vector<std::string> apikey_param_names (const Json& auth) {
    return apikey_names (auth, true);
}

void blank_credential_rows (Json& rows,
const std::vector<std::string>& extra_header_names,
int& omitted) {
    blank_rows_where (rows, omitted, [&extra_header_names] (std::string_view name) {
        return utils::is_secret_header_name (name, extra_header_names);
    });
}

void blank_credential_param_rows (Json& rows,
const std::vector<std::string>& extra_param_names,
int& omitted) {
    blank_rows_where (rows, omitted, [&extra_param_names] (std::string_view name) {
        return is_secret_param_name (name, extra_param_names);
    });
}

void blank_cookie_values (Json& cookies, int& omitted) {
    blank_rows_where (cookies, omitted, [] (std::string_view) { return true; });
}

std::string redact_url_credentials (std::string_view url,
const std::vector<std::string>& extra_param_names,
int& omitted) {
    const auto fragment_at        = url.find ('#');
    const std::string_view before = url.substr (0, fragment_at);
    const auto query_at           = before.find ('?');
    std::string out = drop_userinfo_password (before.substr (0, query_at), omitted);
    if (query_at != std::string_view::npos) {
        out += '?';
        out += redact_query (before.substr (query_at + 1), extra_param_names, omitted);
    }
    if (fragment_at != std::string_view::npos) {
        out += '#';
        out += redact_query (url.substr (fragment_at + 1), extra_param_names, omitted);
    }
    return out;
}

Json portable_body (const Json& body) {
    Json out = body;
    if (const auto file = out.find ("file"); file != out.end () && file->is_object ()) {
        file->erase ("src");
        file->erase ("unresolved");
    }
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

namespace {

/// @p ref (a form file part, or a binary body's `file`) as an import may store
/// it: a path is one nobody chose in this editor, so it is marked unresolved.
void mark_imported_path (Json& ref) {
    const auto src = ref.find ("src");
    if (src != ref.end () && src->is_string () &&
    !src->get_ref<const std::string&> ().empty ()) {
        ref["unresolved"] = true;
    }
}

/// A `binary` body: its `file` object's string members (`src`, `fileName`,
/// `contentType`), `src` marked as an import's. A missing `file` is a body with
/// no file chosen; a `file` of another type, or a member that is not a string,
/// is refused.
std::optional<Json> file_body_of (const Json& value) {
    const auto stated = value.find ("file");
    Json file{ { "src", "" } };
    if (stated != value.end ()) {
        if (!stated->is_object ()) {
            return std::nullopt;
        }
        for (const char* key : { "src", "fileName", "contentType" }) {
            const auto member = stated->find (key);
            if (member == stated->end ()) {
                continue;
            }
            if (!member->is_string ()) {
                return std::nullopt;
            }
            file[key] = *member;
        }
    }
    mark_imported_path (file);
    return std::make_optional (Json{ { "mode", "binary" }, { "file", std::move (file) } });
}

} // namespace

std::optional<Json> param_rows_of (const Json& value) {
    std::optional<Json> rows = rows_with (value, PARAM_ROW_KEYS);
    if (!rows) {
        return rows;
    }
    // A query row's `valueless` is the one boolean a Params row adds: it is
    // what writes the row as a bare `key` rather than `key=`.
    for (size_t at = 0; at < rows->size (); ++at) {
        const auto flag = value[at].find ("valueless");
        if (flag != value[at].end () && flag->is_boolean () && flag->get<bool> ()) {
            (*rows)[at]["valueless"] = true;
        }
    }
    return rows;
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
    if (mode == "binary") {
        return file_body_of (value);
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
        for (Json& row : *rows) {
            // A text part never carries a path: the write routes refuse one.
            if (row.value ("type", "") == "file") {
                mark_imported_path (row);
            } else {
                row.erase ("src");
            }
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
