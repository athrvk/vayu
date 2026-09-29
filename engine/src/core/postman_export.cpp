/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/postman_export.cpp
 * @brief The Postman v2.1.0 exporter. See the header for the contract.
 *
 * Shapes follow what current Postman (v11) writes, read off its own exports:
 * key order per object, `"type": "text"` on every request-side row,
 * `disabled` only when true, `response: []` on every request, an event
 * script's `packages` / `requests` placeholders (and their key order, which
 * differs between a request's script and a folder's or the collection's), and
 * `JSON.stringify(document, null, "\t")` with no trailing newline.
 */

#include "vayu/core/postman_export.hpp"

#include "js_json.hpp"

#include "vayu/core/elements.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/postman_format.hpp"
#include "vayu/core/vayu_extensions.hpp"
#include "vayu/http/status.hpp"
#include "vayu/utils/ascii_case.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <format>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using json = nlohmann::ordered_json;

/// Every `notCarried` code, in the order the notes list them.
enum class Loss : std::uint8_t {
    VayuElements,
    ScriptSettings,
    JsonRpcBodies,
    UnsupportedBodies,
    UnsupportedAuth,
    OAuth2Settings,
    FormFileNames,
    HttpVersion,
    EventStream,
    MockResponseMode,
    TruncatedExamples,
    ExampleContentTypes,
    VariableTypes,
    DataContracts,
    SpecBindings,
    SpecOperations,
    RowsWithoutKey,
    Count_,
};

struct LossText {
    std::string_view code;
    std::string_view message;
};

/// A message is a short standalone phrase: the export dialog shows it as
/// "message (count)", keyed on the code.
constexpr auto LOSS_TEXT = std::to_array<LossText> ({
{ "vayu_elements", "Assertions, extractors, timers, controllers, metrics and setup or teardown scripts have no Postman equivalent" },
{ "script_settings", "Script names and the run-inline setting have no Postman equivalent" },
{ "jsonrpc_bodies", "JSON-RPC bodies were written as raw JSON" },
{ "unsupported_bodies", "Bodies in a mode Postman lacks were left out" },
{ "unsupported_auth", "Auth in a mode Postman lacks was left out" },
{ "oauth2_settings", "Some OAuth 2.0 settings have no Postman equivalent" },
{ "form_file_names", "Custom file names on form-data files were left out" },
{ "http_version", "HTTP version choices have no Postman equivalent" },
{ "event_stream", "Event-stream (SSE) settings have no Postman equivalent" },
{ "mock_response_mode", "Mock response choices have no Postman equivalent" },
{ "truncated_examples", "Examples saved from a cut-off response were written partial" },
{ "example_content_types", "Example content types without a Content-Type header were left out" },
{ "variable_types", "JSON variable types have no Postman equivalent" },
{ "data_contracts", "Data-file contracts have no Postman equivalent" },
{ "spec_bindings", "OpenAPI bindings have no Postman equivalent" },
{ "spec_operations", "Links to OpenAPI operations have no Postman equivalent" },
{ "rows_without_key", "Rows with a value but no name were left out" },
});

static_assert (LOSS_TEXT.size () == static_cast<std::size_t> (Loss::Count_),
"every Loss has its code and message");

/// What one export accumulates as it walks the tree.
struct Walk {
    bool include_secrets = false;
    int requests         = 0;
    int folders          = 0;
    int secrets_omitted  = 0;
    std::array<int, static_cast<std::size_t> (Loss::Count_)> losses{};

    void lose (Loss loss, int count = 1) {
        losses.at (static_cast<std::size_t> (loss)) += count;
    }
};

// ---------------------------------------------------------------------------
// Reading stored columns
// ---------------------------------------------------------------------------

/// A string member, or "" when absent or not a string.
std::string text_of (const json& node, const char* key) {
    if (!node.is_object ()) {
        return {};
    }
    const auto found = node.find (key);
    return found != node.end () && found->is_string () ? found->get<std::string> () :
                                                         std::string ();
}

/// A boolean member, or @p fallback when absent or not a boolean.
bool flag_of (const json& node, const char* key, bool fallback) {
    if (!node.is_object ()) {
        return fallback;
    }
    const auto found = node.find (key);
    return found != node.end () && found->is_boolean () ? found->get<bool> () : fallback;
}

/// Absent or non-boolean `enabled` is enabled (D17).
bool row_enabled (const json& row) {
    return flag_of (row, "enabled", true);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// Which Postman row shape a Vayu row becomes.
enum class RowShape : std::uint8_t {
    /// `header`, `urlencoded`, `formdata` text: `type: "text"` after the
    /// description.
    Typed,
    /// `url.query` and a response's `header`: no `type` at all.
    Plain,
};

/// Whether @p row names nothing. A named row is written; an unnamed one is
/// dropped, and counted when it carried a value (an editor's trailing blank
/// row carries none).
bool skip_unnamed (const json& row, Walk& walk) {
    if (!text_of (row, "key").empty ()) {
        return false;
    }
    if (!text_of (row, "value").empty ()) {
        walk.lose (Loss::RowsWithoutKey);
    }
    return true;
}

json postman_row (const json& row, RowShape shape) {
    json out;
    out["key"]   = text_of (row, "key");
    out["value"] = text_of (row, "value");
    if (const auto equals = row.find ("equals");
    shape == RowShape::Plain && equals != row.end () && equals->is_boolean ()) {
        // A query row's `equals`, as an import kept it.
        out["equals"] = *equals;
    }
    if (const std::string description = text_of (row, "description");
    !description.empty ()) {
        out["description"] = description;
    }
    if (shape == RowShape::Typed) {
        // `text` unless an import kept another (`default`, which recent
        // Postman writes on a header row).
        const std::string type = text_of (row, "type");
        out["type"]            = type.empty () ? std::string ("text") : type;
    }
    if (!row_enabled (row)) {
        out["disabled"] = true;
    }
    return out;
}

json postman_rows (const json& rows, RowShape shape, Walk& walk) {
    json out = json::array ();
    if (!rows.is_array ()) {
        return out;
    }
    for (const json& row : rows) {
        if (row.is_object () && !skip_unnamed (row, walk)) {
            out.push_back (postman_row (row, shape));
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/// The characters that split a URL into parts. A `{{variable}}` holding one
/// of them is kept whole, as Postman's parser keeps it.
constexpr std::string_view URL_SEPARATORS = ".:/?#@&]";

/// A byte no URL separator is, standing in for a protected variable.
constexpr char PLACEHOLDER = '\x01';

/// @p raw with every separator-holding `{{variable}}` swapped for a
/// placeholder byte, and the variables in order.
std::pair<std::string, std::vector<std::string>> protect_variables (const std::string& raw) {
    std::string out;
    std::vector<std::string> held;
    std::size_t at = 0;
    while (at < raw.size ()) {
        const std::size_t open = raw.find ("{{", at);
        const std::size_t close =
        open == std::string::npos ? open : raw.find ("}}", open + 2);
        if (close == std::string::npos) {
            out += raw.substr (at);
            break;
        }
        const std::string inner = raw.substr (open + 2, close - open - 2);
        out += raw.substr (at, open - at);
        if (inner.find_first_of ("{}") == std::string::npos &&
        inner.find_first_of (URL_SEPARATORS) != std::string::npos) {
            held.push_back (raw.substr (open, close + 2 - open));
            out += PLACEHOLDER;
        } else {
            out += raw.substr (open, close + 2 - open);
        }
        at = close + 2;
    }
    return { out, held };
}

/// @p part with its placeholders restored, in order, from @p held.
std::string
restore (const std::string& part, const std::vector<std::string>& held, std::size_t& next) {
    std::string out;
    for (const char ch : part) {
        if (ch == PLACEHOLDER && next < held.size ()) {
            out += held.at (next++);
        } else {
            out += ch;
        }
    }
    return out;
}

json split_on (const std::string& text, char separator) {
    json parts        = json::array ();
    std::size_t start = 0;
    while (true) {
        const std::size_t cut = text.find (separator, start);
        parts.push_back (text.substr (start, cut == std::string::npos ? cut : cut - start));
        if (cut == std::string::npos) {
            return parts;
        }
        start = cut + 1;
    }
}

bool all_digits (const std::string& text) {
    return !text.empty () && std::all_of (text.begin (), text.end (), [] (char ch) {
        return ch >= '0' && ch <= '9';
    });
}

/// Each placeholder in a split part array restored, left to right.
json restore_all (const json& parts, const std::vector<std::string>& held, std::size_t& next) {
    json out = json::array ();
    for (const json& part : parts) {
        out.push_back (restore (part.get<std::string> (), held, next));
    }
    return out;
}

} // namespace

json postman_url_parts (const std::string& raw) {
    json url;
    url["raw"]        = raw;
    auto [rest, held] = protect_variables (raw);
    std::string hash;
    bool has_hash = false;
    if (const std::size_t cut = rest.find ('#'); cut != std::string::npos) {
        hash     = rest.substr (cut + 1);
        has_hash = true;
        rest     = rest.substr (0, cut);
    }
    if (const std::size_t cut = rest.find ('?'); cut != std::string::npos) {
        rest = rest.substr (0, cut);
    }
    std::replace (rest.begin (), rest.end (), '\\', '/');

    // Placeholders are restored in document order, so each part is restored
    // in the order it appears in @p raw: protocol, host, port, path.
    std::size_t next = 0;
    if (const std::size_t cut = rest.find ("://"); cut != std::string::npos) {
        url["protocol"] = restore (rest.substr (0, cut), held, next);
        rest            = rest.substr (cut + 3);
    }
    std::string path;
    bool has_path = false;
    if (const std::size_t cut = rest.find ('/'); cut != std::string::npos) {
        path     = rest.substr (cut + 1);
        has_path = true;
        rest     = rest.substr (0, cut);
    }
    if (const std::size_t cut = rest.rfind ('@'); cut != std::string::npos) {
        // Credentials in the authority are not a member of the v2.1 url
        // object; `raw` keeps them.
        for (const char ch : rest.substr (0, cut)) {
            next += ch == PLACEHOLDER ? 1 : 0;
        }
        rest = rest.substr (cut + 1);
    }
    std::string port;
    if (const std::size_t cut = rest.rfind (':');
    cut != std::string::npos && all_digits (rest.substr (cut + 1))) {
        port = rest.substr (cut + 1);
        rest = rest.substr (0, cut);
    }
    if (!rest.empty ()) {
        url["host"] = restore_all (split_on (rest, '.'), held, next);
    }
    if (!port.empty ()) {
        url["port"] = port;
    }
    if (has_path) {
        url["path"] = restore_all (split_on (path, '/'), held, next);
    }
    if (has_hash) {
        // Everything between the path and the hash (the query) held its own
        // placeholders; the hash's are the last ones.
        std::size_t tail = held.size ();
        for (const char ch : hash) {
            tail -= ch == PLACEHOLDER ? 1 : 0;
        }
        url["hash"] = restore (hash, held, tail);
    }
    return url;
}

namespace {

/// The url object with the query rows, which come from Params rather than
/// from `raw` so a turned-off row survives.
json postman_url (const std::string& raw, const json& params, Walk& walk) {
    json url         = postman_url_parts (raw);
    const json query = postman_rows (params, RowShape::Plain, walk);
    if (query.empty ()) {
        return url;
    }
    // `query` sits after `path` and before `hash`, where Postman writes it.
    json ordered;
    for (auto member = url.begin (); member != url.end (); ++member) {
        if (member.key () == "hash") {
            ordered["query"] = query;
        }
        ordered[member.key ()] = member.value ();
    }
    if (!ordered.contains ("query")) {
        ordered["query"] = query;
    }
    return ordered;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// Where an auth sits, which decides what "nothing" is written as.
enum class AuthLevel : std::uint8_t { Request, Collection };

/// Attributes Postman's auth helpers declare boolean, which an import stores
/// as the text `"true"` / `"false"`.
constexpr auto BOOLEAN_ATTRIBUTES = std::to_array<std::string_view> (
{ "disableRetryRequest", "addAuthDataToQuery", "showPassword", "useBrowser" });

json attribute (const std::string& key, const json& value) {
    json out;
    out["key"] = key;
    const bool declared_boolean =
    std::find (BOOLEAN_ATTRIBUTES.begin (), BOOLEAN_ATTRIBUTES.end (), key) !=
    BOOLEAN_ATTRIBUTES.end ();
    if (declared_boolean && value.is_string () && (value == "true" || value == "false")) {
        out["value"] = value == "true";
        out["type"]  = "boolean";
    } else if (value.is_boolean ()) {
        out["value"] = value;
        out["type"]  = "boolean";
    } else {
        out["value"] = value;
        out["type"]  = value.is_string () ? "string" : "any";
    }
    return out;
}

json typed_auth (const std::string& type, json attributes) {
    json out;
    out["type"] = type;
    out[type]   = std::move (attributes);
    return out;
}

/// The Postman `grant_type` for a stored config.
std::string grant_type_of (const json& config) {
    const std::string grant = text_of (config, "grantType");
    const bool pkce = grant == "authorization_code" && flag_of (config, "pkce", false);
    for (const postman::OAuth2Grant& row : postman::OAUTH2_GRANTS) {
        if (row.vayu == grant && row.pkce == pkce) {
            return std::string (row.postman);
        }
    }
    return grant.empty () ? std::string ("client_credentials") : grant;
}

/// The Postman name of a Vayu `OAuth2Config` string field.
std::optional<std::string_view> oauth2_vayu_field (std::string_view postman_key) {
    for (const postman::OAuth2Field& field : postman::OAUTH2_STRING_FIELDS) {
        if (field.postman == postman_key) {
            return field.vayu;
        }
    }
    return std::nullopt;
}

/// Whether @p config holds a setting the Postman attributes cannot state.
bool oauth2_loses_settings (const json& config) {
    const std::string query_name = text_of (config, "queryParamName");
    const auto prefix            = config.find ("headerPrefix");
    const bool empty_prefix = prefix != config.end () && prefix->is_string () &&
    prefix->get_ref<const std::string&> ().empty ();
    return !text_of (config, "audience").empty () ||
    !text_of (config, "resource").empty () || !flag_of (config, "autoFetchToken", true) ||
    !flag_of (config, "autoRefreshToken", true) ||
    (!query_name.empty () && query_name != "access_token") || empty_prefix;
}

/// The value of one derived `oauth2` attribute, or nothing when it is not
/// written for this config.
std::optional<json>
oauth2_derived (std::string_view key, const json& config, const std::string& grant) {
    if (key == "grant_type") {
        return std::make_optional (json (grant));
    }
    if (key == "tokenName") {
        const std::string token = text_of (config, "credentialsId");
        return token.empty () ? std::nullopt : std::make_optional (json (token));
    }
    if (key == "useBrowser") {
        return text_of (config, "grantType") == "authorization_code" ?
        std::make_optional (json (!flag_of (config, "useEmbeddedBrowser", false))) :
        std::nullopt;
    }
    if (key == "challengeAlgorithm") {
        return grant == "authorization_code_with_pkce" ?
        std::make_optional (json ("S256")) :
        std::nullopt;
    }
    if (key == "headerPrefix") {
        const std::string prefix = text_of (config, "headerPrefix");
        return prefix.empty () || prefix == "Bearer" ?
        std::nullopt :
        std::make_optional (json (prefix));
    }
    if (key == "addTokenTo") {
        return std::make_optional (json (
        text_of (config, "tokenPlacement") == "query" ? "queryParams" : "header"));
    }
    return std::make_optional (
    json (text_of (config, "credentialsPlacement") == "body" ? "body" : "header"));
}

/**
 * An `oauth2` attribute list. Postman lists attributes in the order a user
 * last edited them, so no one order is canonical; this is the one its most
 * complete recent exports show.
 */
json oauth2_attributes (const json& config, const json& original, Walk& walk) {
    const std::string grant = grant_type_of (config);
    json out                = json::array ();
    for (const std::string_view key : { "accessTokenUrl", "refreshTokenUrl",
         "scope", "grant_type", "authUrl", "tokenName", "useBrowser",
         "challengeAlgorithm", "redirect_uri", "clientSecret", "clientId", "username",
         "password", "headerPrefix", "addTokenTo", "client_authentication" }) {
        if (const std::optional<std::string_view> field = oauth2_vayu_field (key)) {
            // Written when the stored config has a value, blanked or not.
            const std::string stored (*field);
            if (!text_of (original, stored.c_str ()).empty ()) {
                out.push_back (
                attribute (std::string (key), text_of (config, stored.c_str ())));
            }
        } else if (std::optional<json> value = oauth2_derived (key, config, grant)) {
            out.push_back (attribute (std::string (key), *value));
        }
    }
    if (oauth2_loses_settings (config)) {
        walk.lose (Loss::OAuth2Settings);
    }
    return out;
}

/**
 * The attribute order Postman's exports show for each `{mode, config}` type.
 * An import keeps the attributes in a sorted map, so the order is restored
 * here; a key not listed follows in stored order.
 */
std::vector<std::string_view> config_attribute_order (std::string_view type) {
    if (type == "awsv4") {
        return { "service", "sessionToken", "region", "secretKey", "accessKey",
            "addAuthDataToQuery" };
    }
    if (type == "digest") {
        return { "algorithm", "username", "realm", "password", "nonce",
            "nonceCount", "clientNonce", "opaque", "qop", "disableRetryRequest" };
    }
    return { "password", "username", "domain", "workstation", "disableRetryRequest" };
}

/// `{mode, config}` auth as its Postman type, the config written key for key.
std::optional<json> config_auth (const std::string& mode, const json& config) {
    for (const postman::ConfigAuthType& named : postman::CONFIG_AUTH_TYPES) {
        if (mode != named.vayu) {
            continue;
        }
        json attributes = json::array ();
        const std::vector<std::string_view> order =
        config_attribute_order (named.postman);
        for (const std::string_view key : order) {
            if (const auto found = config.find (std::string (key));
            found != config.end ()) {
                attributes.push_back (attribute (std::string (key), *found));
            }
        }
        for (auto member = config.begin (); member != config.end (); ++member) {
            if (std::find (order.begin (), order.end (), member.key ()) == order.end ()) {
                attributes.push_back (attribute (member.key (), member.value ()));
            }
        }
        return std::make_optional (
        typed_auth (std::string (named.postman), std::move (attributes)));
    }
    return std::nullopt;
}

/// A credential-bearing mode as its Postman object, from the (possibly
/// blanked) @p auth; @p original is the stored one.
std::optional<json> credential_auth (const json& auth, const json& original, Walk& walk) {
    const std::string mode = text_of (auth, "mode");
    if (mode == "bearer") {
        return std::make_optional (typed_auth ("bearer",
        json::array ({ attribute ("token", text_of (auth, "token")) })));
    }
    if (mode == "basic") {
        return std::make_optional (typed_auth ("basic",
        json::array ({ attribute ("username", text_of (auth, "username")),
        attribute ("password", text_of (auth, "password")) })));
    }
    if (mode == "apikey") {
        json attributes = json::array ({ attribute ("value", text_of (auth, "value")),
        attribute ("key", text_of (auth, "key")) });
        if (text_of (auth, "in") == "query") {
            attributes.push_back (attribute ("in", "query"));
        }
        return std::make_optional (typed_auth ("apikey", std::move (attributes)));
    }
    const json empty = json::object ();
    const auto found = auth.find ("config");
    const json& config = found != auth.end () && found->is_object () ? *found : empty;
    if (mode == "oauth2") {
        const auto stored = original.find ("config");
        const json& stored_config =
        stored != original.end () && stored->is_object () ? *stored : empty;
        return std::make_optional (
        typed_auth ("oauth2", oauth2_attributes (config, stored_config, walk)));
    }
    return config_auth (mode, config);
}

/// A stored auth as Postman's `auth`, or nothing to write - an inheriting
/// request, a collection or folder configuring none, or a mode Postman lacks.
std::optional<json> postman_auth (const json& stored, AuthLevel level, Walk& walk) {
    const std::string mode = text_of (stored, "mode");
    if (mode.empty () || mode == "inherit") {
        return std::nullopt;
    }
    // On a request `none` sends nothing, which is Postman's No Auth; on a
    // collection it configures nothing, which is Postman's absent `auth`.
    // `noauth` is No Auth on both, ending inheritance on a folder.
    if (mode == "noauth" || (mode == "none" && level == AuthLevel::Request)) {
        return std::make_optional (json{ { "type", "noauth" } });
    }
    if (mode == "none") {
        return std::nullopt;
    }
    const json auth =
    walk.include_secrets ? stored : vayu_ext::redact_auth (stored, walk.secrets_omitted);
    std::optional<json> mapped = credential_auth (auth, stored, walk);
    if (!mapped) {
        walk.lose (Loss::UnsupportedAuth);
    }
    return mapped;
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/// `graphql`: Postman's variables are the text of its Variables pane.
json graphql_body (const std::string& content) {
    const json parsed = json::parse (content, nullptr, /*allow_exceptions=*/false);
    json graphql;
    if (!parsed.is_object ()) {
        graphql["query"]     = content;
        graphql["variables"] = "";
        return json{ { "mode", "graphql" }, { "graphql", std::move (graphql) } };
    }
    graphql["query"] = text_of (parsed, "query");
    if (const auto variables = parsed.find ("variables");
    variables == parsed.end () || variables->is_null ()) {
        graphql["variables"] = "";
    } else {
        // As Postman's editor lays the pane out: four-space indentation.
        std::string text;
        if (variables->is_string ()) {
            text = variables->get<std::string> ();
        } else {
            js::append_json_text (*variables, 0, 4, text);
        }
        graphql["variables"] = text;
    }
    // Anything else the envelope holds (`operationName`) rides along; the
    // importer keeps every key it does not rewrite.
    for (auto member = parsed.begin (); member != parsed.end (); ++member) {
        if (member.key () != "query" && member.key () != "variables") {
            graphql[member.key ()] = member.value ();
        }
    }
    return json{ { "mode", "graphql" }, { "graphql", std::move (graphql) } };
}

/// A raw body; an empty @p language writes no `options`, as Postman does for a
/// body whose language was never chosen.
json raw_body (const std::string& content, std::string_view language) {
    json body;
    body["mode"] = "raw";
    body["raw"]  = content;
    if (!language.empty ()) {
        body["options"] =
        json{ { "raw", json{ { "language", std::string (language) } } } };
    }
    return body;
}

/**
 * The language a stored raw body is written with: the `rawLanguage` an import
 * kept (`""` for none declared) while importing it again would still give the
 * stored mode, else the mode's own name. The check is what keeps a body edited
 * into another mode since from being labelled as what it was.
 */
std::string raw_language (const json& body, const std::string& mode, const std::string& content) {
    const auto kept = body.find ("rawLanguage");
    if (kept == body.end () || !kept->is_string ()) {
        return mode;
    }
    const std::string declared = kept->get<std::string> ();
    const json reimported =
    postman_raw_body (content, declared.empty () ? nullptr : &declared);
    return text_of (reimported, "mode") == mode ? declared : mode;
}

/// One form-data part. A file part names the path it uploads.
json form_part (const json& field, Walk& walk) {
    if (text_of (field, "type") != "file") {
        return postman_row (field, RowShape::Typed);
    }
    json out;
    out["key"] = text_of (field, "key");
    if (const std::string description = text_of (field, "description");
    !description.empty ()) {
        out["description"] = description;
    }
    out["type"]           = "file";
    const std::string src = text_of (field, "src");
    out["src"]            = src.empty () ? json::array () : json (src);
    if (const std::string content_type = text_of (field, "contentType");
    !content_type.empty ()) {
        out["contentType"] = content_type;
    }
    if (!row_enabled (field)) {
        out["disabled"] = true;
    }
    const std::string file_name = text_of (field, "fileName");
    if (!file_name.empty () && file_name != file_base_name (src)) {
        walk.lose (Loss::FormFileNames);
    }
    return out;
}

json form_body (const json& fields, Walk& walk) {
    json parts = json::array ();
    if (fields.is_array ()) {
        for (const json& field : fields) {
            if (field.is_object () && !skip_unnamed (field, walk)) {
                parts.push_back (form_part (field, walk));
            }
        }
    }
    return json{ { "mode", "formdata" }, { "formdata", std::move (parts) } };
}

std::optional<json> postman_body (const json& body, Walk& walk) {
    const std::string mode    = text_of (body, "mode");
    const std::string content = text_of (body, "content");
    if (mode.empty () || mode == "none") {
        return std::nullopt;
    }
    for (const std::string_view language : postman::RAW_LANGUAGES) {
        if (mode == language) {
            return std::make_optional (
            raw_body (content, raw_language (body, mode, content)));
        }
    }
    if (mode == "jsonrpc") {
        walk.lose (Loss::JsonRpcBodies);
        return std::make_optional (raw_body (content, "json"));
    }
    if (mode == "graphql") {
        return std::make_optional (graphql_body (content));
    }
    const auto fields = body.find ("fields");
    const json none   = json::array ();
    if (mode == "x-www-form-urlencoded") {
        return std::make_optional (json{ { "mode", "urlencoded" },
        { "urlencoded",
        postman_rows (fields == body.end () ? none : *fields, RowShape::Typed, walk) } });
    }
    if (mode == "form-data") {
        return std::make_optional (form_body (fields == body.end () ? none : *fields, walk));
    }
    walk.lose (Loss::UnsupportedBodies);
    return std::nullopt;
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/// Where an `event` sits: a request's script lists `exec` first, a folder's
/// or the collection's lists it last.
enum class EventOwner : std::uint8_t { Request, Container };

json script_exec (const std::string& script) {
    return split_on (script, '\n');
}

json postman_event (const char* listen, const std::string& script, EventOwner owner, bool enabled) {
    json body;
    if (owner == EventOwner::Request) {
        body["exec"]     = script_exec (script);
        body["type"]     = "text/javascript";
        body["packages"] = json::object ();
        body["requests"] = json::object ();
    } else {
        body["type"]     = "text/javascript";
        body["packages"] = json::object ();
        body["requests"] = json::object ();
        body["exec"]     = script_exec (script);
    }
    json event{ { "listen", listen }, { "script", std::move (body) } };
    if (!enabled) {
        // Postman's runtime skips a disabled event, as Vayu skips a turned-off
        // element; the importer reads it back the same way.
        event["disabled"] = true;
    }
    return event;
}

/// One element as its event, or nothing when it is not a step script (counted)
/// or holds no text.
std::optional<json> element_event (const json& element, EventOwner owner, Walk& walk) {
    const std::string kind = text_of (element, "kind");
    const json empty       = json::object ();
    const auto found       = element.find ("config");
    const json& config = found != element.end () && found->is_object () ? *found : empty;
    const std::string script  = text_of (config, "script");
    const bool is_step_script = kind == "script.pre" || kind == "script.post";
    if (!is_step_script) {
        // A run-boundary script with no text is an empty slot, not a loss.
        if (!kind.starts_with ("script.") || !is_blank_script_text (script)) {
            walk.lose (Loss::VayuElements);
        }
        return std::nullopt;
    }
    if (is_blank_script_text (script)) {
        return std::nullopt;
    }
    if (!text_of (element, "name").empty () || flag_of (config, "inline", false)) {
        walk.lose (Loss::ScriptSettings);
    }
    return std::make_optional (
    postman_event (kind == "script.pre" ? "prerequest" : "test", script, owner,
    flag_of (element, "enabled", true)));
}

/**
 * A level's `event` array, or nothing when it has no script: one event per
 * script element, in element order. Postman runs every event of a listen in
 * the order listed, which is how Vayu runs several script elements of one
 * phase, so nothing is joined; the importer reads each back as its own
 * element.
 */
std::optional<json> postman_events (const json& elements, EventOwner owner, Walk& walk) {
    json events = json::array ();
    if (elements.is_array ()) {
        for (const json& element : elements) {
            if (!element.is_object ()) {
                continue;
            }
            if (std::optional<json> event = element_event (element, owner, walk)) {
                events.push_back (std::move (*event));
            }
        }
    }
    return events.empty () ? std::nullopt : std::make_optional (std::move (events));
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

std::optional<json> postman_variables (const json& stored, Walk& walk) {
    if (!stored.is_object () || stored.empty ()) {
        return std::nullopt;
    }
    const json variables = walk.include_secrets ?
    stored :
    vayu_ext::redact_variables (stored, walk.secrets_omitted);
    json out             = json::array ();
    for (auto entry = variables.begin (); entry != variables.end (); ++entry) {
        const json& variable = entry.value ();
        if (!variable.is_object ()) {
            continue;
        }
        json row;
        row["key"]             = entry.key ();
        const auto value       = variable.find ("value");
        row["value"]           = value == variable.end () || value->is_null () ?
                  std::string () :
                  js::js_string_of (*value);
        const std::string type = text_of (variable, "type");
        if (flag_of (variable, "secret", false)) {
            row["type"] = "secret";
        } else if (type == "string" || type == "number" || type == "boolean") {
            row["type"] = type;
        }
        if (type == "json") {
            walk.lose (Loss::VariableTypes);
        }
        if (const std::string description = text_of (variable, "description");
        !description.empty ()) {
            row["description"] = description;
        }
        if (!row_enabled (variable)) {
            row["disabled"] = true;
        }
        out.push_back (std::move (row));
    }
    return out.empty () ? std::nullopt : std::make_optional (std::move (out));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// The request half a saved example records, and the request itself.
json request_core (const PostmanExportRequest& request,
const std::optional<json>& body,
Walk& walk) {
    json out;
    out["method"] = request.method;
    out["header"] = postman_rows (request.headers, RowShape::Typed, walk);
    if (body) {
        out["body"] = *body;
    }
    out["url"] = postman_url (request.url, request.params, walk);
    return out;
}

/// `_postman_previewlanguage`: the editor mode Postman shows the body in.
std::string preview_language (const std::string& content_type) {
    const std::string lowered = vayu::utils::ascii_lower (content_type);
    for (const char* language : { "json", "xml", "html", "javascript" }) {
        if (lowered.find (language) != std::string::npos) {
            return language;
        }
    }
    return "Text";
}

/// The first Content-Type header of an example's rows, as the importer reads it.
std::optional<std::string> declared_content_type (const json& headers) {
    if (!headers.is_array ()) {
        return std::nullopt;
    }
    for (const json& header : headers) {
        if (vayu::utils::ascii_lower (text_of (header, "key")) == "content-type") {
            return text_of (header, "value");
        }
    }
    return std::nullopt;
}

json postman_response (const PostmanExportExample& example,
const json& original_request,
Walk& walk) {
    if (example.body_truncated) {
        walk.lose (Loss::TruncatedExamples);
    }
    const std::optional<std::string> declared = declared_content_type (example.headers);
    if (!example.content_type.empty () && (!declared || *declared != example.content_type)) {
        walk.lose (Loss::ExampleContentTypes);
    }
    json out;
    out["name"]                     = example.name;
    out["originalRequest"]          = original_request;
    out["status"]                   = vayu::http::status_text (example.status);
    out["code"]                     = example.status;
    out["_postman_previewlanguage"] = preview_language (declared.value_or (""));
    out["header"] = postman_rows (example.headers, RowShape::Plain, walk);
    out["cookie"] = json::array ();
    out["body"]   = example.body;
    return out;
}

/// The request-level behaviours Postman keeps beside the request.
/// Whether @p body would put bytes on the wire.
bool body_has_content (const std::optional<json>& body) {
    if (!body) {
        return false;
    }
    const std::string mode = text_of (*body, "mode");
    if (mode == "raw") {
        return !text_of (*body, "raw").empty ();
    }
    if (mode == "graphql") {
        return !text_of (body->at ("graphql"), "query").empty ();
    }
    const auto rows = body->find (mode);
    return rows != body->end () && rows->is_array () && !rows->empty ();
}

std::optional<json> protocol_profile (const PostmanExportRequest& request, bool has_body) {
    json out = json::object ();
    // Postman strips a GET's body unless told not to, and sets this itself
    // when one is given a body. Vayu sends it, so the export says so.
    if (has_body && (request.method == "GET" || request.method == "HEAD")) {
        out["disableBodyPruning"] = true;
    }
    if (!request.verify_ssl) {
        out["strictSSL"] = false;
    }
    if (!request.follow_redirects) {
        out["followRedirects"] = false;
    }
    if (request.max_redirects != 10) {
        out["maxRedirects"] = request.max_redirects;
    }
    return out.empty () ? std::nullopt : std::make_optional (std::move (out));
}

void note_request_losses (const PostmanExportRequest& request, Walk& walk) {
    if (request.http_version != "auto" && !request.http_version.empty ()) {
        walk.lose (Loss::HttpVersion);
    }
    if (request.stream) {
        walk.lose (Loss::EventStream);
    }
    if (request.mock_response_mode != "first" && !request.mock_response_mode.empty ()) {
        walk.lose (Loss::MockResponseMode);
    }
    if (request.has_spec_operation) {
        walk.lose (Loss::SpecOperations);
    }
}

json postman_request_item (const PostmanExportRequest& request, Walk& walk) {
    walk.requests += 1;
    note_request_losses (request, walk);
    const std::optional<json> body = postman_body (request.body, walk);

    json inner;
    if (std::optional<json> auth = postman_auth (request.auth, AuthLevel::Request, walk)) {
        inner["auth"] = std::move (*auth);
    }
    const json core = request_core (request, body, walk);
    for (auto member = core.begin (); member != core.end (); ++member) {
        inner[member.key ()] = member.value ();
    }
    if (!request.description.empty ()) {
        inner["description"] = request.description;
    }

    json item;
    item["name"] = request.name;
    if (std::optional<json> events =
        postman_events (request.elements, EventOwner::Request, walk)) {
        item["event"] = std::move (*events);
    }
    if (std::optional<json> profile = protocol_profile (request, body_has_content (body))) {
        item["protocolProfileBehavior"] = std::move (*profile);
    }
    item["request"] = std::move (inner);

    json responses = json::array ();
    if (!request.examples.empty ()) {
        // Counted once per request rather than once per example: the rows
        // are the request's own and were already counted above.
        Walk scratch;
        const json original = request_core (request, body, scratch);
        for (const PostmanExportExample& example : request.examples) {
            responses.push_back (postman_response (example, original, walk));
        }
    }
    item["response"] = std::move (responses);
    return item;
}

// ---------------------------------------------------------------------------
// Folders and the collection
// ---------------------------------------------------------------------------

void note_container_losses (const PostmanExportFolder& folder, Walk& walk) {
    if (folder.data_schema.is_object () && !folder.data_schema.empty ()) {
        walk.lose (Loss::DataContracts);
    }
    if (folder.spec_bound) {
        walk.lose (Loss::SpecBindings);
    }
}

json postman_items (const PostmanExportFolder& folder, Walk& walk);

json postman_folder_item (const PostmanExportFolder& folder, Walk& walk) {
    walk.folders += 1;
    note_container_losses (folder, walk);
    json item;
    item["name"] = folder.name;
    item["item"] = postman_items (folder, walk);
    if (!folder.description.empty ()) {
        item["description"] = folder.description;
    }
    if (std::optional<json> auth = postman_auth (folder.auth, AuthLevel::Collection, walk)) {
        item["auth"] = std::move (*auth);
    }
    if (std::optional<json> events =
        postman_events (folder.elements, EventOwner::Container, walk)) {
        item["event"] = std::move (*events);
    }
    if (std::optional<json> variables = postman_variables (folder.variables, walk)) {
        item["variable"] = std::move (*variables);
    }
    return item;
}

/// Folders first, then requests: the order the sidebar lists them in, and
/// the one an import reads back into the same `order` values.
json postman_items (const PostmanExportFolder& folder, Walk& walk) {
    json items = json::array ();
    for (const PostmanExportFolder& child : folder.folders) {
        items.push_back (postman_folder_item (child, walk));
    }
    for (const PostmanExportRequest& request : folder.requests) {
        items.push_back (postman_request_item (request, walk));
    }
    return items;
}

/// A file name with every character a filesystem refuses replaced.
std::string safe_file_stem (const std::string& name) {
    std::string stem;
    for (const char ch : name) {
        const auto byte   = static_cast<unsigned char> (ch);
        const bool unsafe = byte < 0x20 ||
        std::string_view ("<>:\"/\\|?*").find (ch) != std::string_view::npos;
        stem += unsafe ? '_' : ch;
    }
    // Windows refuses a name ending in a dot or a space.
    while (!stem.empty () && (stem.back () == '.' || stem.back () == ' ')) {
        stem.pop_back ();
    }
    const std::size_t begin = stem.find_first_not_of (' ');
    return begin == std::string::npos ? std::string ("collection") : stem.substr (begin);
}

bool is_uuid (std::string_view text) {
    if (text.size () != 36) {
        return false;
    }
    for (std::size_t at = 0; at < text.size (); ++at) {
        const char ch     = text.at (at);
        const bool dashed = at == 8 || at == 13 || at == 18 || at == 23;
        const bool hex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') ||
        (ch >= 'A' && ch <= 'F');
        if (dashed ? ch != '-' : !hex) {
            return false;
        }
    }
    return true;
}

/// FNV-1a over @p text from @p basis.
std::uint64_t fnv1a (std::string_view text, std::uint64_t basis) {
    std::uint64_t hash = basis;
    for (const char ch : text) {
        hash ^= static_cast<unsigned char> (ch);
        hash *= 0x100000001b3ULL;
    }
    return hash;
}

} // namespace

std::string postman_collection_uuid (const std::string& collection_id) {
    if (is_uuid (collection_id)) {
        return vayu::utils::ascii_lower (collection_id);
    }
    if (collection_id.size () > 36 &&
    is_uuid (std::string_view (collection_id).substr (collection_id.size () - 36))) {
        return vayu::utils::ascii_lower (
        collection_id.substr (collection_id.size () - 36));
    }
    // An RFC 9562 version-8 UUID: custom bits, so nothing mistakes the
    // derivation for a random or a name-based one.
    std::uint64_t high    = fnv1a (collection_id, 0xcbf29ce484222325ULL);
    std::uint64_t low     = fnv1a (collection_id, high ^ 0x9e3779b97f4a7c15ULL);
    high                  = (high & ~0xF000ULL) | 0x8000ULL;
    low                   = (low & ~(0x3ULL << 62U)) | (0x2ULL << 62U);
    const std::string hex = std::format ("{:016x}{:016x}", high, low);
    return hex.substr (0, 8) + "-" + hex.substr (8, 4) + "-" +
    hex.substr (12, 4) + "-" + hex.substr (16, 4) + "-" + hex.substr (20);
}

PostmanExportOutcome export_postman (const PostmanExportFolder& root,
const PostmanExportOptions& options) {
    Walk walk;
    walk.include_secrets = options.include_secrets;
    note_container_losses (root, walk);

    json info;
    info["_postman_id"] = postman_collection_uuid (options.collection_id);
    info["name"]        = root.name;
    if (!root.description.empty ()) {
        info["description"] = root.description;
    }
    info["schema"] = std::string (postman::SCHEMA_V21);

    json document;
    document["info"] = std::move (info);
    document["item"] = postman_items (root, walk);
    if (std::optional<json> auth = postman_auth (root.auth, AuthLevel::Collection, walk)) {
        document["auth"] = std::move (*auth);
    }
    if (std::optional<json> events =
        postman_events (root.elements, EventOwner::Container, walk)) {
        document["event"] = std::move (*events);
    }
    if (std::optional<json> variables = postman_variables (root.variables, walk)) {
        document["variable"] = std::move (*variables);
    }

    PostmanExportOutcome outcome;
    outcome.text      = js::js_json_tabbed (document);
    outcome.file_name = safe_file_stem (root.name) + ".postman_collection.json";
    outcome.notes.requests_exported = walk.requests;
    outcome.notes.folders_exported  = walk.folders;
    outcome.notes.secrets_omitted   = walk.secrets_omitted;
    for (std::size_t at = 0; at < LOSS_TEXT.size (); ++at) {
        if (const int count = walk.losses.at (at); count > 0) {
            outcome.notes.not_carried.push_back (
            { std::string (LOSS_TEXT.at (at).code), count,
            std::string (LOSS_TEXT.at (at).message) });
        }
    }
    return outcome;
}

nlohmann::json postman_export_notes_json (const PostmanExportNotes& notes) {
    nlohmann::json not_carried = nlohmann::json::array ();
    for (const PostmanNotCarried& entry : notes.not_carried) {
        not_carried.push_back (nlohmann::json{ { "code", entry.code },
        { "count", entry.count }, { "message", entry.message } });
    }
    return nlohmann::json{ { "requestsExported", notes.requests_exported },
        { "foldersExported", notes.folders_exported },
        { "secretsOmitted", notes.secrets_omitted },
        { "notCarried", std::move (not_carried) } };
}

} // namespace vayu::core
