/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/import_document.cpp
 * @brief The four import parsers, engine-side (issue #877). See the header for
 *        what moved and why.
 *
 * A port of `app/src/services/importers/` - `postman.ts`, `insomnia-v4.ts`,
 * `postman-environment.ts`, their shared half (`shared.ts`,
 * `oauth2-import.ts`, `var-normalize.ts`) and the factory that dispatches
 * between them - kept to the *same answers* rather than to the same code. The
 * OpenAPI half is deliberately not here: it is `core::import_drafts_of`, the
 * #865 builder, with this file composing the collection around it.
 */

#include "vayu/core/import_document.hpp"

#include "js_json.hpp"
#include "openapi_walk.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/jmeter_import.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/path_template.hpp"
#include "vayu/core/postman_export.hpp"
#include "vayu/core/postman_format.hpp"
#include "vayu/core/vayu_extensions.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/parse.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::core {

/// `fileBaseName(path)`: the last segment, for either platform's separator -
/// the path comes from whoever's machine produced the export.
std::string file_base_name (const std::string& path) {
    const size_t begin = path.find_first_not_of (" \t\n\r\f\v");
    if (begin == std::string::npos) {
        return {};
    }
    const std::string trimmed =
    path.substr (begin, path.find_last_not_of (" \t\n\r\f\v") - begin + 1);
    const size_t cut = trimmed.find_last_of ("/\\");
    return cut == std::string::npos ? trimmed : trimmed.substr (cut + 1);
}

nlohmann::ordered_json
postman_raw_body (const std::string& content, const std::string* language) {
    if (language != nullptr) {
        // `xml` is what gets an imported SOAP request its `application/xml`:
        // `text` requires no Content-Type, so before this the envelope went out
        // as libcurl's `x-www-form-urlencoded`.
        for (const std::string_view mode : postman::RAW_LANGUAGES) {
            if (*language == mode) {
                return nlohmann::ordered_json{ { "mode", std::string (mode) },
                    { "content", content } };
            }
        }
    }
    // No language Vayu has a mode for: sniff JSON, and keep what was declared
    // so the export can say it again rather than the mode's own name.
    const nlohmann::ordered_json parsed =
    nlohmann::ordered_json::parse (content, nullptr, false);
    return nlohmann::ordered_json{ { "mode", parsed.is_discarded () ? "text" : "json" },
        { "content", content },
        { "rawLanguage", language == nullptr ? std::string () : *language } };
}

/**
 * `importedFilePart(entry, src, contentType?)`: a multipart part that uploads a
 * file.
 *
 * The path is kept exactly as the source wrote it and a row that has one is
 * marked **unresolved**, because it names a file on the exporting machine.
 * A part declared *without* a path - an OpenAPI document names the upload,
 * never the file (#425) - is not unresolved: the flag warns that something
 * which looks filled in cannot be sent, and a row showing "Choose file" makes
 * no such claim.
 *
 * Not anonymous-namespace-local: `jmeter_import.cpp` reuses this shape
 * verbatim for `HTTPsampler.Files` (#1657) rather than building a second one.
 */
nlohmann::ordered_json imported_file_part (nlohmann::ordered_json entry,
const std::string& src,
const std::string* content_type) {
    entry["value"] = "";
    entry["type"]  = "file";
    entry["src"]   = src;
    if (const std::string base = file_base_name (src); !base.empty ()) {
        entry["fileName"] = base;
    }
    if (content_type != nullptr) {
        entry["contentType"] = *content_type;
    }
    if (!src.empty ()) {
        entry["unresolved"] = true;
    }
    return entry;
}

namespace {

using json = nlohmann::ordered_json;

// The JavaScript semantics the format readers are written in - `prop`,
// truthiness, `JSON.stringify`, `encodeURIComponent` - and the query join
// `append_params`. Shared with the draft builder (`openapi_drafts.cpp`) rather
// than copied.
using namespace js;

/**
 * A document that claimed a format and then contradicted it.
 *
 * Only the Insomnia parser raises one: it is the one format whose export is a
 * flat resource list, so a `resources` that is not an array or a row that is
 * not an object leaves nothing to walk, where every other parser can step over
 * a malformed member and count it. The message is shown to the user verbatim,
 * so it names the format and the field.
 */
class MalformedImport : public std::runtime_error {
    public:
    explicit MalformedImport (const std::string& detail)
    : std::runtime_error ("Malformed Insomnia export: " + detail) {
    }
};

// ---------------------------------------------------------------------------
// `shared.ts`
// ---------------------------------------------------------------------------

/// `asString(v)`: coerce any scalar to its string form - Vayu stores every
/// value as a string. An object or an array is its compact JSON, which is what
/// `JSON.stringify` returns for one.
std::string as_string (const json* value) {
    if (value == nullptr || value->is_null ()) {
        return {};
    }
    if (value->is_string ()) {
        return value->get<std::string> ();
    }
    if (value->is_structured ()) {
        return js_json_compact (*value);
    }
    return js_string_of (*value);
}

/// `normalizeVars(text)` with `pathTemplates` off - the `{{ x }}` / `{{ _.x }}`
/// tightening alone. Postman and Insomnia template with `{{x}}`, so a single
/// brace there is literal text (`fields=friends{name}`) and rewriting it would
/// invent a variable reference that resolves to nothing.
std::string normalize_vars (const std::string& text) {
    return normalize_template_vars (text);
}

/**
 * What a Postman row carries beyond `key`/`value`/`description`/`disabled`
 * that Vayu keeps for the export to write back - nothing reads either at send
 * time. `Typed` is a header or urlencoded row's `type` other than `"text"`
 * (Postman's default, and what the exporter writes for a row with none);
 * `Query` is a query row's boolean `equals`, and `valueless: true` for a row
 * whose `value` is null or absent (Postman writes that row as a bare `key`,
 * and an empty string as `key=`); `Path` is a `url.variable[]`
 * entry's `type` whatever it says (Postman writes `"string"` or `"any"` there
 * and has no default to leave out).
 */
enum class RowExtras : std::uint8_t { None, Typed, Query, Path };

/// `mapKeyValues(rows)`: a Postman/Insomnia row array as table rows, disabled
/// rows and duplicates intact. A row with no truthy `key` names nothing.
json map_key_values (const json* rows, RowExtras extras = RowExtras::None) {
    json out = json::array ();
    if (rows == nullptr || !rows->is_array ()) {
        return out;
    }
    for (const json& row : *rows) {
        const json* record = as_record (&row);
        if (record == nullptr || !truthy (prop (record, "key"))) {
            continue;
        }
        json entry;
        entry["key"]   = as_string (prop (record, "key"));
        entry["value"] = normalize_vars (as_string (prop (record, "value")));
        const json* disabled = prop (record, "disabled");
        entry["enabled"] = disabled == nullptr || !disabled->is_boolean () ||
        !disabled->get<bool> ();
        if (const json* description = prop (record, "description"); truthy (description)) {
            entry["description"] = as_string (description);
        }
        if (const std::string* type = as_str (prop (record, "type"));
        type != nullptr && !type->empty () &&
        ((extras == RowExtras::Typed && *type != "text") || extras == RowExtras::Path)) {
            entry["type"] = *type;
        }
        if (const json* equals = prop (record, "equals");
        extras == RowExtras::Query && equals != nullptr && equals->is_boolean ()) {
            entry["equals"] = *equals;
        }
        if (const json* value = prop (record, "value");
        extras == RowExtras::Query && (value == nullptr || value->is_null ())) {
            entry["valueless"] = true;
        }
        out.push_back (std::move (entry));
    }
    return out;
}

/// A Postman variable `type` that is one of Vayu's own variable types, cast
/// the same way at read time (`castByType`).
bool is_vayu_variable_type (const std::string& type) {
    return type == "string" || type == "number" || type == "boolean";
}

/**
 * `toVarRecord(vars)`: a variable array as Vayu's `{name: {value, enabled}}`.
 *
 * `type: "secret"` is `secret: true`; `string`, `number` and `boolean` are
 * Vayu's own variable types of the same name and stored as `type`, which
 * casts the value for a script exactly as Postman's typed variable does.
 * `"default"` is Postman's own unset marker - every environment and globals
 * export the app can produce stamps it on every ordinary variable - so it
 * stores nothing and counts no more than an absent `type` does.
 *
 * @p keep_description is set for a collection's or folder's variables, which
 * the Postman exporter writes back with their `description`; an environment
 * or globals file has no exporter to read one, so there it is dropped.
 * @p skipped_variable_metadata counts a row whose `description` (when not
 * kept) or a declared `type` Vayu has no counterpart for (`"any"`, a custom
 * string) was read and discarded, once per row however many it carried.
 */
json to_var_record (const json* vars, int& skipped_variable_metadata, bool keep_description) {
    json out = json::object ();
    if (vars == nullptr || !vars->is_array ()) {
        return out;
    }
    for (const json& row : *vars) {
        const json* record = as_record (&row);
        if (record == nullptr || !truthy (prop (record, "key"))) {
            continue;
        }
        const std::string* declared_type = as_str (prop (record, "type"));
        const json* description          = prop (record, "description");
        if ((truthy (description) && !keep_description) ||
        (declared_type != nullptr && *declared_type != "secret" &&
        *declared_type != "default" && !is_vayu_variable_type (*declared_type))) {
            skipped_variable_metadata += 1;
        }
        // `disabled != null ? !disabled : enabled != null ? !!enabled : true` -
        // JavaScript truthiness on both, not a boolean test.
        bool enabled = true;
        if (const json* disabled = prop (record, "disabled");
        disabled != nullptr && !disabled->is_null ()) {
            enabled = !truthy (disabled);
        } else if (const json* declared = prop (record, "enabled");
        declared != nullptr && !declared->is_null ()) {
            enabled = truthy (declared);
        }
        json value;
        value["value"]   = normalize_vars (as_string (prop (record, "value")));
        value["enabled"] = enabled;
        if (declared_type != nullptr && *declared_type == "secret") {
            value["secret"] = true;
        } else if (declared_type != nullptr && is_vayu_variable_type (*declared_type)) {
            value["type"] = *declared_type;
        }
        if (keep_description && truthy (description)) {
            value["description"] = as_string (description);
        }
        out[as_string (prop (record, "key"))] = std::move (value);
    }
    return out;
}

/// Depth-first over a draft tree's requests, for the two counts the preview
/// promises - read off the drafts rather than tallied as they are built, so the
/// number and the rows cannot disagree.
template <typename Visit>
void walk_requests (const json& collections, Visit visit) {
    for (const json& collection : collections) {
        for (const json& request : collection.at ("requests")) {
            visit (request);
        }
        walk_requests (collection.at ("children"), visit);
    }
}

/// `unattachedFileParts(collections)`: file parts that name no file yet.
int unattached_file_parts (const json& collections) {
    int count = 0;
    walk_requests (collections, [&count] (const json& request) {
        const json& body = request.at ("body");
        if (body.at ("mode") != "form-data") {
            return;
        }
        for (const json& field : body.at ("fields")) {
            const json* type       = prop (&field, "type");
            const std::string* src = as_str (prop (&field, "src"));
            if (type != nullptr && *type == "file" && (src == nullptr || src->empty ())) {
                count += 1;
            }
        }
    });
    return count;
}

/// `countExamples(collections)`: saved example responses across the tree.
int count_examples (const json& collections) {
    int count = 0;
    walk_requests (collections, [&count] (const json& request) {
        if (const json* examples = prop (&request, "examples");
        examples != nullptr && examples->is_array ()) {
            count += static_cast<int> (examples->size ());
        }
    });
    return count;
}

/// The Content-Type a body mode must be sent with, or "" when it needs none.
///
/// The app-side half of the engine's own `implied_content_type`
/// (`http/form_body.cpp`), which is what actually reaches the wire; this one
/// writes the header *row* an imported request carries, so the user can see it.
/// `json` and `text` are deliberately absent - they are the modes a user writes
/// the header for themselves.
std::string required_content_type (const std::string& mode) {
    if (mode == "graphql" || mode == "jsonrpc") {
        return "application/json";
    }
    return mode == "xml" ? "application/xml" : std::string ();
}

/**
 * `withRequiredContentType(headers, body)`: the imported headers plus the
 * Content-Type this body cannot go without.
 *
 * An imported GraphQL request had none at all and went out under libcurl's
 * default `x-www-form-urlencoded`, which most GraphQL servers answer with a
 * 400. A request that already declares the header keeps what it has, including
 * a deliberate `application/graphql`; a disabled row does not count as
 * declaring one, since it is not sent. A request that refuses Content-Type
 * (@p refused: Postman's `disabledSystemHeaders`, issue #1765) is sent with
 * none, so none is added.
 */
json with_required_content_type (json headers, const json& body, bool refused = false) {
    const std::string required =
    required_content_type (body.at ("mode").get<std::string> ());
    if (required.empty () || refused) {
        return headers;
    }
    for (const json& header : headers) {
        const std::string key =
        vayu::utils::ascii_lower (header.at ("key").get<std::string> ());
        const size_t begin        = key.find_first_not_of (" \t\n\r\f\v");
        const std::string trimmed = begin == std::string::npos ?
        std::string () :
        key.substr (begin, key.find_last_not_of (" \t\n\r\f\v") - begin + 1);
        if (trimmed == "content-type" && truthy (prop (&header, "enabled"))) {
            return headers;
        }
    }
    // Marked as the body mode's own row, as the Body panel marks the one it
    // writes: the mode implies it, so a stored `content-type` opt-out refuses
    // it (issue #1765) and a mode switch in the app takes it back.
    headers.push_back ({ { "key", "Content-Type" }, { "value", required },
    { "enabled", true }, { "source", "body-mode" } });
    return headers;
}

/// `joinExec(event)`: a Postman `event` entry's script lines, joined.
std::string join_exec (const json* event) {
    const json* exec = prop (prop (event, "script"), "exec");
    if (exec != nullptr && exec->is_array ()) {
        std::string out;
        for (size_t at = 0; at < exec->size (); ++at) {
            if (at > 0) {
                out += '\n';
            }
            const json& line = (*exec)[at];
            // `Array.prototype.join` writes "" for null and undefined.
            if (!line.is_null ()) {
                out += line.is_string () ? line.get<std::string> () : js_string_of (line);
            }
        }
        return out;
    }
    const std::string* text = as_str (exec);
    return text == nullptr ? std::string () : *text;
}

/**
 * Writes @p pre / @p post as `script.pre` / `script.post` elements on
 * @p item['elements'] (issue #1514's cut-over: `elements` is the only script
 * source an import payload can carry now - `preRequestScript` /
 * `postRequestScript` are refused on the write routes `POST /import/apply`
 * shares with `PUT /requests/:id` and `PUT /collections/:id`). A blank
 * script contributes no entry, matching the old fields' "" default reading
 * as "no script".
 */
void set_script_elements (json& item, const std::string& pre, const std::string& post) {
    json elements = json::array ();
    if (pre.find_first_not_of (" \t\r\n") != std::string::npos) {
        elements.push_back (
        { { "kind", "script.pre" }, { "config", { { "script", pre } } } });
    }
    if (post.find_first_not_of (" \t\r\n") != std::string::npos) {
        elements.push_back (
        { { "kind", "script.post" }, { "config", { { "script", post } } } });
    }
    if (!elements.empty ()) {
        item["elements"] = std::move (elements);
    }
}

// ---------------------------------------------------------------------------
// `oauth2-import.ts`
// ---------------------------------------------------------------------------

/// `nv(value)`: `normalizeVars(String(value ?? ""))`.
std::string nv (const json* value) {
    if (value == nullptr || value->is_null ()) {
        return {};
    }
    return normalize_vars (
    value->is_string () ? value->get<std::string> () : js_string_of (*value));
}

std::string nv (const std::string& value) {
    return normalize_vars (value);
}

/// `defaultOAuth2Config()` - client credentials, token in the Authorization
/// header as Bearer, auto-fetch and auto-refresh on.
json default_oauth2_config () {
    return json{ { "grantType", "client_credentials" }, { "accessTokenUrl", "" },
        { "refreshTokenUrl", "" }, { "clientId", "" }, { "clientSecret", "" },
        { "scope", "" }, { "credentialsPlacement", "basic_auth_header" },
        { "tokenPlacement", "header" }, { "headerPrefix", "Bearer" },
        { "pkce", true }, { "autoFetchToken", true },
        { "autoRefreshToken", true }, { "useEmbeddedBrowser", false } };
}

/// Client credentials are never in an OpenAPI document; seed placeholders.
json openapi_oauth2_base () {
    json config            = default_oauth2_config ();
    config["clientId"]     = "{{clientId}}";
    config["clientSecret"] = "{{clientSecret}}";
    return config;
}

json oauth2_auth (json config) {
    return json{ { "mode", "oauth2" }, { "config", std::move (config) } };
}

/// One flat `{key: value}` view of a Postman auth detail block, which the
/// v2.1 schema writes as an array and v2.0 as an object.
std::map<std::string, std::string> auth_detail (const json* node) {
    std::map<std::string, std::string> detail;
    if (node == nullptr) {
        return detail;
    }
    if (node->is_array ()) {
        for (const json& entry : *node) {
            const json* key = prop (&entry, "key");
            if (!truthy (key)) {
                continue;
            }
            detail[js_string_of (*key)] = as_string (prop (&entry, "value"));
        }
        return detail;
    }
    if (node->is_object ()) {
        for (auto entry = node->begin (); entry != node->end (); ++entry) {
            detail[entry.key ()] = as_string (&entry.value ());
        }
    }
    return detail;
}

/// `d.key` with JavaScript's "absent is undefined", which `nv` reads as "".
const std::string*
detail_of (const std::map<std::string, std::string>& detail, const char* key) {
    const auto found = detail.find (key);
    return found == detail.end () ? nullptr : &found->second;
}

bool detail_is (const std::map<std::string, std::string>& detail,
const char* key,
const char* value) {
    const std::string* found = detail_of (detail, key);
    return found != nullptr && *found == value;
}

std::string detail_text (const std::map<std::string, std::string>& detail, const char* key) {
    const std::string* found = detail_of (detail, key);
    return found == nullptr ? std::string () : nv (*found);
}

/**
 * `mapPostmanOAuth2(d)`: a Postman v2.1 `oauth2` block.
 *
 * A minimal export carrying only a pre-fetched `accessToken` imports as a
 * bearer token, which is immediately executable. @p dropped_field counts an
 * oauth2 detail Vayu has nowhere to carry (issue #1460): `state`, which Vayu
 * always generates and validates itself per authorization attempt rather than
 * storing (`app/src/types/domain.ts`'s `OAuth2Config`, where a fixed imported
 * value would undermine the CSRF check it exists for), and a pre-fetched
 * `accessToken` that arrives *alongside* an explicit grant config, where the
 * general shape below always drives a fresh fetch through that grant and a
 * seed token has no field to ride in. `tokenName` is not counted here - it
 * lands in `credentialsId` below, the field Vayu's own token cache already
 * reads to keep otherwise-identical configs apart.
 */
json map_postman_oauth2 (const std::map<std::string, std::string>& detail, int& dropped_field) {
    // Truthiness on all four, so a key present and empty is as good as absent.
    const auto stated = [&detail] (const char* key) {
        const std::string* value = detail_of (detail, key);
        return value != nullptr && !value->empty ();
    };
    const bool has_grant_config =
    stated ("grant_type") || stated ("accessTokenUrl") || stated ("authUrl");
    if (!has_grant_config && stated ("accessToken")) {
        // A seeded token Postman sends as is, with no grant to fetch another:
        // what Vayu sends it as, placed and prefixed the way Postman would.
        // The oauth2 block itself rides beside it as the auth's `postman`
        // source (`with_postman_source`), so an export gives it back.
        const std::string token = detail_text (detail, "accessToken");
        if (detail_is (detail, "addTokenTo", "queryParams")) {
            return json{ { "mode", "apikey" }, { "key", "access_token" },
                { "value", token }, { "in", "query" } };
        }
        const std::string prefix = detail_text (detail, "headerPrefix");
        if (stated ("headerPrefix") && prefix != "Bearer") {
            return json{ { "mode", "apikey" }, { "key", "Authorization" },
                { "value", prefix + " " + token }, { "in", "header" } };
        }
        return json{ { "mode", "bearer" }, { "token", token } };
    }
    if (has_grant_config && stated ("accessToken")) {
        dropped_field += 1;
    }
    if (stated ("state")) {
        dropped_field += 1;
    }

    std::string grant_type = "client_credentials";
    bool pkce              = false;
    if (const std::string* declared = detail_of (detail, "grant_type")) {
        for (const postman::OAuth2Grant& grant : postman::OAUTH2_GRANTS) {
            if (*declared == grant.postman) {
                grant_type = grant.vayu;
                pkce       = grant.pkce;
                break;
            }
        }
    }
    if (stated ("challengeAlgorithm")) {
        pkce = true;
    }

    json config         = default_oauth2_config ();
    config["grantType"] = grant_type;
    config["pkce"]      = pkce;
    for (const postman::OAuth2Field& field : postman::OAUTH2_STRING_FIELDS) {
        config[std::string (field.vayu)] =
        detail_text (detail, std::string (field.postman).c_str ());
    }
    config["credentialsPlacement"] =
    detail_is (detail, "client_authentication", "body") ? "body" : "basic_auth_header";
    config["tokenPlacement"] =
    detail_is (detail, "addTokenTo", "queryParams") ? "query" : "header";
    config["headerPrefix"] =
    stated ("headerPrefix") ? detail_text (detail, "headerPrefix") : "Bearer";
    // Postman's "useBrowser" is authorize-via-system-browser; embedded is the
    // inverse of it.
    config["useEmbeddedBrowser"] = detail_is (detail, "useBrowser", "false");
    if (stated ("tokenName")) {
        // Postman's `tokenName` labels a saved token; `credentialsId` is
        // Vayu's analogous field, already read by the token cache key to
        // keep otherwise-identical configs apart (issue #1460).
        config["credentialsId"] = detail_text (detail, "tokenName");
    }
    return oauth2_auth (std::move (config));
}

/// `mapInsomniaOAuth2(auth)`: Insomnia v4's camelCase oauth2 object.
json map_insomnia_oauth2 (const json* auth) {
    std::string grant_type = "client_credentials";
    const json* use_pkce   = prop (auth, "usePkce");
    bool pkce = use_pkce != nullptr && use_pkce->is_boolean () && use_pkce->get<bool> ();
    if (const std::string* declared = as_str (prop (auth, "grantType"))) {
        if (*declared == "authorization_code") {
            grant_type = "authorization_code";
        } else if (*declared == "password") {
            grant_type = "password";
        } else if (*declared == "client_credentials") {
            grant_type = "client_credentials";
        } else if (*declared == "implicit") {
            grant_type = "authorization_code";
            pkce       = true;
        }
    }

    json config                = default_oauth2_config ();
    config["grantType"]        = grant_type;
    config["pkce"]             = pkce;
    config["authorizationUrl"] = nv (prop (auth, "authorizationUrl"));
    config["accessTokenUrl"]   = nv (prop (auth, "accessTokenUrl"));
    config["callbackUrl"]      = nv (prop (auth, "redirectUrl"));
    config["clientId"]         = nv (prop (auth, "clientId"));
    config["clientSecret"]     = nv (prop (auth, "clientSecret"));
    config["scope"]            = nv (prop (auth, "scope"));
    config["username"]         = nv (prop (auth, "username"));
    config["password"]         = nv (prop (auth, "password"));
    config["audience"]         = nv (prop (auth, "audience"));
    config["resource"]         = nv (prop (auth, "resource"));
    const json* in_body        = prop (auth, "credentialsInBody");
    config["credentialsPlacement"] =
    (in_body != nullptr && in_body->is_boolean () && in_body->get<bool> ()) ?
    "body" :
    "basic_auth_header";
    // Insomnia's "Token Prefix". Vayu executes OAuth2, so an unread prefix
    // would send "Bearer" and 401.
    const json* token_prefix = prop (auth, "tokenPrefix");
    config["headerPrefix"] = truthy (token_prefix) ? nv (token_prefix) : "Bearer";
    return oauth2_auth (std::move (config));
}

/// `scopeString(scopes)`: an OpenAPI flow's scope map as a space-joined list.
std::string scope_string (const json* scopes) {
    if (scopes == nullptr || !scopes->is_structured ()) {
        return {};
    }
    std::string out;
    if (scopes->is_array ()) {
        // `Object.keys` of an array is its indices, which is what a document
        // writing a list here would produce on the renderer side too.
        for (size_t at = 0; at < scopes->size (); ++at) {
            if (at > 0) {
                out += ' ';
            }
            out += std::to_string (at);
        }
        return out;
    }
    for (auto entry = scopes->begin (); entry != scopes->end (); ++entry) {
        if (!out.empty ()) {
            out += ' ';
        }
        out += entry.key ();
    }
    return out;
}

/// `mapOpenApiV3OAuth2(scheme)`: the first usable flow of a 3.x oauth2 scheme.
json map_openapi_v3_oauth2 (const json* scheme) {
    const json* flows = as_record (prop (scheme, "flows"));
    if (const json* flow = as_record (prop (flows, "clientCredentials"))) {
        json config               = openapi_oauth2_base ();
        config["grantType"]       = "client_credentials";
        config["accessTokenUrl"]  = nv (prop (flow, "tokenUrl"));
        config["refreshTokenUrl"] = nv (prop (flow, "refreshUrl"));
        config["scope"]           = scope_string (prop (flow, "scopes"));
        return oauth2_auth (std::move (config));
    }
    if (const json* flow = as_record (prop (flows, "authorizationCode"))) {
        json config                = openapi_oauth2_base ();
        config["grantType"]        = "authorization_code";
        config["pkce"]             = true;
        config["authorizationUrl"] = nv (prop (flow, "authorizationUrl"));
        config["accessTokenUrl"]   = nv (prop (flow, "tokenUrl"));
        config["refreshTokenUrl"]  = nv (prop (flow, "refreshUrl"));
        config["scope"]            = scope_string (prop (flow, "scopes"));
        return oauth2_auth (std::move (config));
    }
    if (const json* flow = as_record (prop (flows, "password"))) {
        json config               = openapi_oauth2_base ();
        config["grantType"]       = "password";
        config["accessTokenUrl"]  = nv (prop (flow, "tokenUrl"));
        config["refreshTokenUrl"] = nv (prop (flow, "refreshUrl"));
        config["scope"]           = scope_string (prop (flow, "scopes"));
        return oauth2_auth (std::move (config));
    }
    if (const json* flow = as_record (prop (flows, "implicit"))) {
        json config                = openapi_oauth2_base ();
        config["grantType"]        = "authorization_code";
        config["pkce"]             = true;
        config["authorizationUrl"] = nv (prop (flow, "authorizationUrl"));
        // The Implicit flow has no token endpoint of its own, so no
        // `refreshUrl` either per the specification - nothing to read.
        config["scope"] = scope_string (prop (flow, "scopes"));
        return oauth2_auth (std::move (config));
    }
    // A `flows` object naming none of the four the specification defines - a
    // malformed document, since the specification requires at least one. A
    // fabricated client_credentials config with blank URLs would be
    // indistinguishable from a genuinely declared one; `none` is left for the
    // caller to tally the same way any other unmapped scheme is.
    return json{ { "mode", "none" } };
}

/// `mapSwaggerOAuth2(scheme)`: 2.0's single `flow` field.
json map_swagger_oauth2 (const json* scheme) {
    const std::string scope = scope_string (prop (scheme, "scopes"));
    const std::string* flow = as_str (prop (scheme, "flow"));
    const std::string named = flow == nullptr ? std::string () : *flow;
    json config             = openapi_oauth2_base ();
    config["scope"]         = scope;
    if (named == "application") {
        config["grantType"]      = "client_credentials";
        config["accessTokenUrl"] = nv (prop (scheme, "tokenUrl"));
    } else if (named == "accessCode") {
        config["grantType"]        = "authorization_code";
        config["pkce"]             = true;
        config["authorizationUrl"] = nv (prop (scheme, "authorizationUrl"));
        config["accessTokenUrl"]   = nv (prop (scheme, "tokenUrl"));
    } else if (named == "password") {
        config["grantType"]      = "password";
        config["accessTokenUrl"] = nv (prop (scheme, "tokenUrl"));
    } else if (named == "implicit") {
        config["grantType"]        = "authorization_code";
        config["pkce"]             = true;
        config["authorizationUrl"] = nv (prop (scheme, "authorizationUrl"));
    } else {
        // `flow` missing, misspelled, or of the wrong type - the
        // specification's four values are the only ones defined. A
        // fabricated client_credentials config with blank URLs would be
        // indistinguishable from a genuinely declared one; `none` is left
        // for the caller to tally the same way any other unmapped scheme is.
        return json{ { "mode", "none" } };
    }
    return oauth2_auth (std::move (config));
}

/// `mapPostmanAuth(auth)`: a Postman `auth` object (collection, folder or
/// request) as a Vayu auth. @p skipped_unsupported_auth counts a scheme Vayu
/// has no config shape for (a type the schema does not define, or a
/// non-string `type`) - not `noauth`, whose `{mode: "none"}` answer is
/// the correct mapping rather than a loss. @p oauth2_dropped_field is
/// `map_postman_oauth2`'s counter, threaded through (issue #1460).
json map_postman_auth (const json* auth, int& skipped_unsupported_auth, int& oauth2_dropped_field) {
    const json* node = as_record (auth);
    if (node == nullptr || !truthy (prop (node, "type"))) {
        return json{ { "mode", "inherit" } };
    }
    const std::string* type = as_str (prop (node, "type"));
    if (type == nullptr) {
        // A `type` that is not a string names no scheme, so nothing can be sent.
        skipped_unsupported_auth += 1;
        return json{ { "mode", "none" } };
    }
    const std::map<std::string, std::string> detail = auth_detail (prop (node, *type));

    if (*type == "bearer") {
        return json{ { "mode", "bearer" }, { "token", detail_text (detail, "token") } };
    }
    if (*type == "basic") {
        return json{ { "mode", "basic" }, { "username", detail_text (detail, "username") },
            { "password", detail_text (detail, "password") } };
    }
    if (*type == "apikey") {
        return json{ { "mode", "apikey" }, { "key", detail_text (detail, "key") },
            { "value", detail_text (detail, "value") },
            { "in", detail_is (detail, "in", "query") ? "query" : "header" } };
    }
    if (*type == "oauth2") {
        return map_postman_oauth2 (detail, oauth2_dropped_field);
    }
    // AWS Signature is `awsv4` on the wire (the v2.1.0/v2.0.0 schema's enum) and
    // `aws` internally; the two names diverge, so matching on `"aws"` here is
    // what silently dropped every real SigV4 export.
    for (const postman::ConfigAuthType& named : postman::CONFIG_AUTH_TYPES) {
        if (*type != named.postman) {
            continue;
        }
        json config = json::object ();
        for (const auto& [key, value] : detail) {
            config[key] = value;
        }
        return json{ { "mode", std::string (named.vayu) },
            { "config", std::move (config) } };
    }
    if (*type == "inherit") {
        return json{ { "mode", "inherit" } };
    }
    if (*type == "noauth") {
        return json{ { "mode", "none" } };
    }
    // A type Postman's schema does not define (the table above holds every
    // one it does bar `apikey`, `basic`, `bearer`, `oauth2` and `noauth`).
    skipped_unsupported_auth += 1;
    return json{ { "mode", "none" } };
}

/// The attribute `type` Postman's v2.0-to-v2.1 conversion gives a value.
const char* attribute_type_of (const json& value) {
    if (value.is_string ()) {
        return "string";
    }
    return value.is_boolean () ? "boolean" : "any";
}

/**
 * A Postman `auth` object in the v2.1 shape: `{type, <type>: [{key, value,
 * type}]}`. A v2.0 detail object becomes that attribute array the way
 * Postman's own v2.0-to-v2.1 conversion writes it (a string `string`, a
 * boolean `boolean`, anything else `any`); a v2.1 array is kept verbatim.
 */
json postman_auth_source (const json& node, const std::string& type) {
    json source;
    source["type"]       = type;
    json attributes      = json::array ();
    const json* declared = prop (&node, type);
    if (declared != nullptr && declared->is_array ()) {
        attributes = *declared;
    } else if (declared != nullptr && declared->is_object ()) {
        for (auto entry = declared->begin (); entry != declared->end (); ++entry) {
            const json& value = entry.value ();
            attributes.push_back ({ { "key", entry.key () }, { "value", value },
            { "type", attribute_type_of (value) } });
        }
    }
    source[type] = std::move (attributes);
    return source;
}

/**
 * @p mapped with the Postman `auth` it came from as its `postman` member,
 * when the exporter would not write that block back from @p mapped alone:
 * attributes Vayu has no field for (`tokenType`, `state`, a seeded
 * `accessToken` beside a grant, `authRequestParams`), a type Vayu stores as
 * another mode (an `oauth2` block holding only a seeded token, sent as a
 * bearer token), attribute order and types, or `{{ x }}` spacing the
 * importer tightened. Nothing sends it: the exporter writes it verbatim
 * while mapping it again still gives the stored auth, and falls back to
 * the stored auth once the user has changed it (`postman_export.cpp`).
 */
json with_postman_source (json mapped, const json* auth) {
    const json* node = as_record (auth);
    const std::string* type = node == nullptr ? nullptr : as_str (prop (node, "type"));
    const std::string& mode = mapped.at ("mode").get_ref<const std::string&> ();
    if (type == nullptr || mode == "inherit" || mode == "none" || mode == "noauth") {
        return mapped;
    }
    json source                        = postman_auth_source (*node, *type);
    const std::optional<json> exported = postman_auth_written (mapped);
    if (!exported || *exported != source) {
        mapped["postman"] = std::move (source);
    }
    return mapped;
}

// ---------------------------------------------------------------------------
// `postman.ts`
// ---------------------------------------------------------------------------

/// The seven methods Vayu executes. Anything else - Postman lets a user type a
/// verb - imports as `GET`, which is the renderer's answer too. @p unsupported,
/// when given, reports whether the declared method fell back rather than
/// matched, so a caller that counts drops (Postman) can and one that does not
/// need to (Insomnia) is unaffected.
std::string to_method (const json* declared, bool* unsupported = nullptr) {
    static constexpr std::array<const char*, 7> METHODS = { "GET", "POST",
        "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS" };
    const std::string upper                             = walk::upper (
    declared == nullptr || declared->is_null () ? std::string ("GET") : as_string (declared));
    const bool matched = std::any_of (METHODS.begin (), METHODS.end (),
    [&upper] (const char* method) { return upper == method; });
    if (unsupported != nullptr) {
        *unsupported = !matched;
    }
    return matched ? upper : std::string ("GET");
}

/// What a Postman parse accumulates across its recursive walk.
struct PostmanCounts {
    ImportOptions options;
    int requests                   = 0;
    int folders                    = 0;
    int non_executable             = 0;
    int skipped_file_body          = 0;
    int skipped_malformed          = 0;
    int skipped_unsupported_method = 0;
    int skipped_unsupported_auth   = 0;
    int skipped_url_without_raw    = 0;
    int skipped_variable_metadata  = 0;
    int disabled_body              = 0;
    int skipped_certificate        = 0;
    int skipped_proxy              = 0;
    // An item-level `protocolProfileBehavior` setting Vayu stores for the
    // export but does not apply - see `names_unapplied_protocol_behavior`.
    int skipped_protocol_behavior = 0;
    // A Postman oauth2 detail carrying `state` (never stored) or a pre-fetched
    // `accessToken` alongside an explicit grant config (nowhere to seed it) -
    // see `map_postman_oauth2` (issue #1460).
    int oauth2_dropped_field = 0;
    // `client_certificates` registry candidates built from a request's own
    // `certificate` (issue #1656), one per distinct (host, port) this import
    // resolved a usable candidate for - see `pm_certificate`. Deduped by
    // `client_certificate_signatures` so two requests naming the same host
    // and cert do not double-write, keyed on the same pair `port.value_or
    // (-1)` stands in for "every port".
    json client_certificates = json::array ();
    std::map<std::pair<std::string, int>, std::string> client_certificate_signatures;
    // The requests each per-request counter grew on, by tally kind - see
    // `pm_request_named`.
    std::map<std::string, std::vector<std::string>> named;
};

/**
 * `graphqlContent(graphql)`: Postman keeps a GraphQL body as
 * `{query, variables}` where `variables` is the *text* of the Variables pane.
 *
 * GraphQL-over-HTTP wants a map and Vayu's own serializer writes one, so the
 * string is parsed here; embedding it verbatim put
 * `"variables": "{\"limit\": 10}"` on the wire. A variables string that is not
 * valid JSON is kept as-is rather than dropped - the text is the only copy of
 * the user's work - and every other key rides along untouched for the same
 * reason.
 */
std::string graphql_content (const json* graphql) {
    if (graphql == nullptr || !graphql->is_object ()) {
        return "{}";
    }
    json out = *graphql;
    if (const json* declared = prop (&out, "variables");
    declared != nullptr && declared->is_string ()) {
        const std::string text = declared->get<std::string> ();
        const size_t begin     = text.find_first_not_of (" \t\n\r\f\v");
        if (begin == std::string::npos) {
            // Postman writes "" for an empty pane; Vayu omits the key entirely.
            out.erase ("variables");
        } else {
            json parsed = json::parse (text, nullptr, false);
            if (!parsed.is_discarded ()) {
                out["variables"] = std::move (parsed);
            }
        }
    }
    return js_json_compact (out);
}

/**
 * `formdataFields(rows)`: Postman's `formdata`, files included.
 *
 * A file row names its path in `src`, which is **either a string or an array** -
 * Postman lets one field carry several files, and a multipart body repeats the
 * field name rather than nesting, which is what Postman itself sends. A file
 * row with no usable `src` has nothing to point at, so it is counted as skipped
 * rather than imported as a part that could never be sent.
 */
/** The file paths a `file` row points at, in either shape Postman writes them. */
std::vector<std::string> file_part_paths (const json* src) {
    std::vector<std::string> paths;
    if (src == nullptr) {
        return paths;
    }
    if (src->is_array ()) {
        for (const json& entry : *src) {
            if (entry.is_string () && !entry.get_ref<const std::string&> ().empty ()) {
                paths.push_back (entry.get<std::string> ());
            }
        }
        return paths;
    }
    if (src->is_string () && !src->get_ref<const std::string&> ().empty ()) {
        paths.push_back (src->get<std::string> ());
    }
    return paths;
}

json formdata_fields (const json* rows, PostmanCounts& counts) {
    json out = json::array ();
    if (rows == nullptr || !rows->is_array ()) {
        return out;
    }
    for (const json& row : *rows) {
        const json single = json::array ({ row });
        const json mapped = map_key_values (&single);
        const json* type  = prop (&row, "type");
        if (type == nullptr || *type != "file") {
            for (const json& entry : mapped) {
                out.push_back (entry);
            }
            continue;
        }
        const std::vector<std::string> paths = file_part_paths (prop (&row, "src"));
        if (mapped.empty () || paths.empty ()) {
            counts.skipped_file_body += 1;
            continue;
        }
        const std::string* content_type = as_str (prop (&row, "contentType"));
        for (const std::string& path : paths) {
            out.push_back (imported_file_part (mapped[0], path, content_type));
        }
    }
    return out;
}

json pm_body (const json* body, PostmanCounts& counts) {
    const json* node = as_record (body);
    if (node == nullptr || !truthy (prop (node, "mode"))) {
        return json{ { "mode", "none" } };
    }
    if (const json* disabled = prop (node, "disabled");
    disabled != nullptr && disabled->is_boolean () && disabled->get<bool> ()) {
        // Postman's own "prevent request body from being sent" toggle. Vayu
        // has no disabled-body concept to preserve the switch itself, but
        // sending the body anyway - the request-time effect the user turned
        // off - is the one outcome importing it active can never be worth.
        counts.disabled_body += 1;
        return json{ { "mode", "none" } };
    }
    const std::string* mode = as_str (prop (node, "mode"));
    const std::string named = mode == nullptr ? std::string () : *mode;
    if (named == "raw") {
        const std::string* text = as_str (prop (node, "raw"));
        return postman_raw_body (text == nullptr ? std::string () : *text,
        as_str (prop (prop (prop (node, "options"), "raw"), "language")));
    }
    if (named == "urlencoded") {
        return json{ { "mode", "x-www-form-urlencoded" },
            { "fields", map_key_values (prop (node, "urlencoded"), RowExtras::Typed) } };
    }
    if (named == "formdata") {
        return json{ { "mode", "form-data" },
            { "fields", formdata_fields (prop (node, "formdata"), counts) } };
    }
    if (named == "graphql") {
        return json{ { "mode", "graphql" },
            { "content", graphql_content (as_record (prop (node, "graphql"))) } };
    }
    if (named == "file") {
        counts.skipped_file_body += 1;
    }
    return json{ { "mode", "none" } };
}

/// `queryEntries(query)`: a `k=v&k2=v2` string as rows, split on `&` and the
/// first `=` and never decoded, as Postman's `QueryParam.parse` reads it
/// (issue #1771): a pair with no `=` is `valueless`, one ending in `=` holds
/// an empty value. A row holds raw query text, so the join writes it back
/// byte for byte; decoding first would turn `%2B` into a `+` a server reads
/// as a space, and `%2541` into `%41`.
json query_entries (const std::string& query) {
    json out     = json::array ();
    size_t start = 0;
    while (start <= query.size ()) {
        const size_t amp       = query.find ('&', start);
        const std::string pair = query.substr (
        start, amp == std::string::npos ? std::string::npos : amp - start);
        start = amp == std::string::npos ? query.size () + 1 : amp + 1;
        if (pair.empty ()) {
            continue; // `.filter(Boolean)`
        }
        const size_t equals = pair.find ('=');
        const std::string key =
        equals == std::string::npos ? pair : pair.substr (0, equals);
        const std::string value =
        equals == std::string::npos ? std::string () : pair.substr (equals + 1);
        json row = { { "key", key }, { "value", normalize_vars (value) },
            { "enabled", true } };
        if (equals == std::string::npos) {
            row["valueless"] = true;
        }
        out.push_back (std::move (row));
    }
    return out;
}

/// `host` as a single string - Postman's `host[]` array joined with `.`, or
/// the bare string some exports use instead.
std::string postman_host (const json* url) {
    const json* declared = prop (url, "host");
    if (declared == nullptr) {
        return {};
    }
    if (!declared->is_array ()) {
        const std::string* text = as_str (declared);
        return text == nullptr ? std::string () : *text;
    }
    std::string host;
    for (const json& part : *declared) {
        const std::string* text = as_str (&part);
        if (text == nullptr || text->empty ()) {
            continue;
        }
        if (!host.empty ()) {
            host += '.';
        }
        host += *text;
    }
    return host;
}

/// Appends `path[]` segments to @p out as `/segment`, returning whether any
/// segment was appended. A segment may be a plain string or a `{value}`
/// variable object.
bool append_postman_path (const json* url, std::string& out) {
    const json* declared = prop (url, "path");
    if (declared == nullptr || !declared->is_array ()) {
        return false;
    }
    bool appended = false;
    for (const json& part : *declared) {
        const std::string* text = as_str (&part);
        const std::string segment =
        text != nullptr ? *text : as_string (prop (&part, "value"));
        if (segment.empty ()) {
            continue;
        }
        out += '/';
        out += segment;
        appended = true;
    }
    return appended;
}

/// `hostPathUrl(url)`: assembles a raw URL from Postman's `protocol` +
/// `host[]` + `port` + `path[]`, for the schema-legal shape that gives no
/// `raw` at all.
std::string host_path_url (const json* url) {
    const std::string* protocol = as_str (prop (url, "protocol"));
    std::string out =
    (protocol == nullptr || protocol->empty () ? "https" : *protocol) + "://";

    const std::string host = postman_host (url);
    out += host;

    if (const std::string* port = as_str (prop (url, "port"));
    port != nullptr && !port->empty ()) {
        out += ':';
        out += *port;
    }

    const bool has_path = append_postman_path (url, out);
    // Neither part contributed anything: there is no URL to assemble, the same
    // answer an absent `raw` used to give.
    return host.empty () && !has_path ? std::string () : out;
}

/**
 * A request's path variables as Params rows (issue #1764): @p declared -
 * already table rows, in the order the source lists them - each marked
 * `in: "path"`. Only what the source declares: a `:name` the URL spells with
 * no declared entry gets no row here, because the Params tab shows one for it
 * without a stored row (`displayPathRows`), and a synthesised row would be
 * exported back as a `url.variable` entry the source never had. The URL keeps
 * its `:name` segments verbatim; composition writes each row's value into its
 * segment at send time, so two requests on the same name keep their own
 * values rather than sharing one variable.
 */
json path_variable_rows (json declared) {
    for (json& row : declared) {
        row["in"] = "path";
    }
    return declared;
}

/// Postman's `url.variable[]`, with a v2.0 entry that names itself by `id`
/// alone read by that name - `Url`'s own `v.key = v.key || v.id`.
json postman_path_variables (const json* declared) {
    json rows = json::array ();
    if (declared == nullptr || !declared->is_array ()) {
        return rows;
    }
    for (const json& row : *declared) {
        const json* record = as_record (&row);
        if (record != nullptr && !truthy (prop (record, "key")) &&
        truthy (prop (record, "id"))) {
            json named   = *record;
            named["key"] = *prop (record, "id");
            rows.push_back (std::move (named));
        } else {
            rows.push_back (row);
        }
    }
    return map_key_values (&rows, RowExtras::Path);
}

/// A Postman `url`, which is a string in v2.0 and either shape in v2.1.
std::pair<std::string, json> pm_url (const json* url, PostmanCounts& counts) {
    if (url != nullptr && url->is_string ()) {
        const std::string text = url->get<std::string> ();
        const size_t question  = text.find ('?');
        const std::string base = normalize_vars (
        question == std::string::npos ? text : text.substr (0, question));
        json params = question == std::string::npos ?
        json::array () :
        query_entries (text.substr (question + 1));
        // A string URL has no `url.variable[]`, so it declares no path row.
        return { base, std::move (params) };
    }
    const std::string* declared = as_str (prop (url, "raw"));
    std::string raw;
    if (declared != nullptr) {
        raw = *declared;
    } else {
        counts.skipped_url_without_raw += 1;
        raw = host_path_url (url);
    }
    const size_t question = raw.find ('?');
    const std::string base_raw =
    question == std::string::npos ? raw : raw.substr (0, question);
    const std::string base = normalize_vars (base_raw);
    json structured = map_key_values (prop (url, "query"), RowExtras::Query);
    // `query[]` wins when it has anything - it carries disabled state and
    // descriptions that `raw` cannot. Falling back to `raw` matters for
    // hand-written or script-generated collections that populate only `raw`.
    json params = (!structured.empty () || question == std::string::npos) ?
    std::move (structured) :
    query_entries (raw.substr (question + 1));
    for (json& row : path_variable_rows (postman_path_variables (prop (url, "variable")))) {
        params.push_back (std::move (row));
    }
    return { base, std::move (params) };
}

/// `pmEvents(node)`: the `event[]` entries that are objects. A `null` in that
/// array used to throw on `e.listen`.
std::vector<const json*> pm_events (const json* node) {
    std::vector<const json*> events;
    const json* declared = prop (node, "event");
    if (declared == nullptr || !declared->is_array ()) {
        return events;
    }
    for (const json& entry : *declared) {
        if (const json* record = as_record (&entry)) {
            events.push_back (record);
        }
    }
    return events;
}

/// The element kind a Postman `listen` runs as, or nothing for a listen Vayu
/// has no phase for.
const char* script_kind_of (const std::string* listen) {
    if (listen != nullptr && *listen == "prerequest") {
        return "script.pre";
    }
    if (listen != nullptr && *listen == "test") {
        return "script.post";
    }
    return nullptr;
}

/**
 * @p events as `script.pre` / `script.post` elements on @p item, one element
 * per event and in the order the document lists them - Postman runs every
 * event of a listen, and a level whose `test` precedes its `prerequest`
 * exports back in that order. An event Postman marks `disabled: true` is one
 * its runtime skips, so it imports turned off rather than running; a blank
 * script contributes nothing, and a `listen` other than the two Vayu runs
 * is not a script Vayu has a phase for.
 */
void set_event_elements (json& item, const std::vector<const json*>& events) {
    json elements = json::array ();
    for (const json* event : events) {
        const char* kind = script_kind_of (as_str (prop (event, "listen")));
        const std::string script = join_exec (event);
        if (kind == nullptr || script.find_first_not_of (" \t\r\n") == std::string::npos) {
            continue;
        }
        json element = { { "kind", kind }, { "config", { { "script", script } } } };
        if (const json* disabled = prop (event, "disabled");
        disabled != nullptr && disabled->is_boolean () && disabled->get<bool> ()) {
            element["enabled"] = false;
        }
        elements.push_back (std::move (element));
    }
    if (!elements.empty ()) {
        item["elements"] = std::move (elements);
    }
}

/**
 * Whether a `protocolProfileBehavior` names something Vayu stores but does not
 * apply (issue #1765): a key outside the set the engine honours, with a value
 * that is not Postman's default, or a `disabledSystemHeaders` entry for a
 * header whose removal would break HTTP/1.1 framing (`host`,
 * `content-length`). Counted once per request as `protocol_behavior`.
 */
bool names_unapplied_protocol_behavior (const json& behavior) {
    for (auto member = behavior.begin (); member != behavior.end (); ++member) {
        const std::string& key = member.key ();
        const json& value      = member.value ();
        if (key == "disabledSystemHeaders") {
            if (!value.is_object ()) {
                continue;
            }
            for (auto header = value.begin (); header != value.end (); ++header) {
                const std::string name = vayu::utils::ascii_lower (header.key ());
                if ((name == "host" || name == "content-length") &&
                truthy (&header.value ())) {
                    return true;
                }
            }
            continue;
        }
        if (key == "followRedirects" || key == "maxRedirects" ||
        key == "strictSSL" || key == "disableBodyPruning" ||
        key == "disableCookies" || key == "disableUrlEncoding") {
            continue;
        }
        // Postman's default for every boolean it defines is `false`, and an
        // empty object or array states nothing.
        const bool is_default = value.is_null () ||
        (value.is_boolean () && !value.get<bool> ()) ||
        ((value.is_object () || value.is_array ()) && value.empty ());
        if (!is_default) {
            return true;
        }
    }
    return false;
}

/**
 * `pmRedirects(item)`: the item-level `protocolProfileBehavior`.
 *
 * Postman writes it exactly when the user overrides redirect handling, and the
 * engine's `followRedirects` defaults to **true** - so an omitted `false`
 * silently follows the 3xx the request exists to inspect. Only well-typed
 * values are read: a coerced `"false"` would read as the user's setting while
 * being the opposite of it. `strictSSL` follows the same rule onto
 * `verifySSL`, which likewise defaults to `true`.
 *
 * Issue #1765 adds the three settings Vayu now applies per request -
 * `disableCookies`, `disableUrlEncoding` and `disabledSystemHeaders` (the
 * names set to `true`, lowercased, in source order) - and keeps the whole
 * object as `postmanProtocolBehavior`, JSON text in source member order, for
 * the export to write back.
 */
void pm_redirects (const json* item, json& request, int& skipped_protocol_behavior) {
    const json* behavior = as_record (prop (item, "protocolProfileBehavior"));
    if (behavior == nullptr) {
        return;
    }
    if (names_unapplied_protocol_behavior (*behavior)) {
        skipped_protocol_behavior += 1;
    }
    if (const json* follow = prop (behavior, "followRedirects");
    follow != nullptr && follow->is_boolean ()) {
        request["followRedirects"] = follow->get<bool> ();
    }
    if (const json* limit = prop (behavior, "maxRedirects"); limit != nullptr &&
    limit->is_number () && std::isfinite (limit->get<double> ())) {
        request["maxRedirects"] = *limit;
    }
    if (const json* strict = prop (behavior, "strictSSL");
    strict != nullptr && strict->is_boolean ()) {
        request["verifySSL"] = strict->get<bool> ();
    }
    for (const char* flag : { "disableCookies", "disableUrlEncoding" }) {
        if (const json* value = prop (behavior, flag);
        value != nullptr && value->is_boolean ()) {
            request[flag] = value->get<bool> ();
        }
    }
    if (const json* headers = prop (behavior, "disabledSystemHeaders");
    headers != nullptr && headers->is_object ()) {
        json names = json::array ();
        for (std::string& name : postman_disabled_system_headers (*headers)) {
            names.push_back (std::move (name));
        }
        request["disabledSystemHeaders"] = std::move (names);
    }
    // Text, not an object, on the `postmanResponse` precedent: an object would
    // lose its member order the moment it crossed the engine's JSON reader
    // between the parse and the apply.
    // Over the field cap it is dropped rather than failing the whole apply;
    // the export then regenerates what the typed columns say.
    std::string carrier = behavior->dump (-1, ' ', false, json::error_handler_t::replace);
    if (carrier.size () <= vayu::core::constants::json::MAX_FIELD_SIZE) {
        request["postmanProtocolBehavior"] = std::move (carrier);
    }
}

/**
 * The saved response @p saved as `request_examples.postman_response` holds it
 * (schema version 2): every member verbatim, in the source's order, except
 * `name` and `body`, which keep only their position (`null`) because the
 * example's own columns are their values. Nothing when the text would be over
 * `MAX_POSTMAN_RESPONSE_BYTES` - the export regenerates what it would have
 * carried, which beats refusing the whole import over one recorded request.
 */
std::optional<std::string> pm_stored_response (const json& saved) {
    json kept = saved;
    for (const char* member : { "name", "body" }) {
        if (kept.contains (member)) {
            kept[member] = nullptr;
        }
    }
    std::string text = kept.dump (-1, ' ', false, json::error_handler_t::replace);
    if (text.size () > vayu::core::constants::request_example::MAX_POSTMAN_RESPONSE_BYTES) {
        return std::nullopt;
    }
    return std::make_optional (std::move (text));
}

/**
 * `pmExamples(item)`: Postman's saved responses (`item.response[]`).
 *
 * Read by nothing until the engine had a table to hold them, so importing a
 * collection whose whole value was its documented responses produced one with
 * none. A saved response with no `code` documents a 200, which is what Postman
 * shows for one. What no column models - the request it was recorded against,
 * the status text, preview settings, cookies, response time, the header rows
 * as written - rides along as `postmanResponse` for the Postman export.
 */
json pm_examples (const json* item, PostmanCounts& counts) {
    json out              = json::array ();
    const json* responses = prop (item, "response");
    if (responses == nullptr || !responses->is_array ()) {
        return out;
    }
    for (const json& entry : *responses) {
        const json* saved = as_record (&entry);
        if (saved == nullptr) {
            counts.skipped_malformed += 1;
            continue;
        }
        json headers     = map_key_values (prop (saved, "header"));
        const json* code = prop (saved, "code");
        const json* name = prop (saved, "name");
        std::string content_type;
        for (const json& header : headers) {
            if (vayu::utils::ascii_lower (header.at ("key").get<std::string> ()) == "content-type") {
                content_type = header.at ("value").get<std::string> ();
                break;
            }
        }
        const std::string* body = as_str (prop (saved, "body"));
        out.push_back (
        { { "name", name == nullptr || name->is_null () ? "Example" : as_string (name) },
        { "status",
        code != nullptr && code->is_number () && std::isfinite (code->get<double> ()) ?
        *code :
        json (200) },
        { "headers", std::move (headers) }, { "body", body == nullptr ? "" : *body },
        // Only from the recorded header. Postman also writes
        // `_postman_previewlanguage`, but that is an editor mode rather
        // than a media type.
        { "contentType", content_type } });
        if (std::optional<std::string> stored = pm_stored_response (*saved)) {
            out.back ()["postmanResponse"] = std::move (*stored);
        }
    }
    return out;
}

/// Postman's `description` is either a string or `{ content: "..." }` - the
/// declared text, "" when neither shape carries one.
std::string pm_description_text (const std::string* text, const std::string* nested) {
    if (text != nullptr) {
        return *text;
    }
    if (nested != nullptr) {
        return *nested;
    }
    return {};
}

/**
 * A Postman request's own `certificate`, mapped to a `client_certificates`
 * registry candidate keyed on the request's own resolved host (issue #1656) -
 * Vayu certificates belong to a host, not a request (`engine/CLAUDE.md`), so
 * this cannot become a request field.
 *
 * The candidate is added to @p counts only when it would pass the same check
 * `POST /client-certificates` runs (`vayu::http::client_cert_rejection`):
 * `pm_request`'s own `url` still carrying an unresolved `{{var}}` host (the
 * common case - most Postman collections name `{{baseUrl}}`, not a literal
 * host), an unreadable `cert.src` (a path from the exporting machine, which is
 * the common case for a real-world export) or a second request naming a
 * different certificate for a (host, port) this import already claimed all
 * fall back to the existing `skipped_certificate` tally instead - "cannot
 * resolve", per the issue's own acceptance criteria, is not limited to "no
 * host to key on". `POST /import/apply` reuses the exact same check-and-write
 * `POST /client-certificates` uses, best-effort, so a candidate that passes
 * here needs no new registry semantics to actually land.
 */
void pm_certificate (const json* cert, const std::string& url, PostmanCounts& counts) {
    if (!truthy (cert)) {
        return;
    }
    const std::string* cert_src = as_str (prop (prop (cert, "cert"), "src"));
    if (cert_src == nullptr || cert_src->empty ()) {
        counts.skipped_certificate += 1;
        return;
    }
    const vayu::http::UrlParts parts = vayu::http::parse_url_parts (url);
    const std::string host =
    vayu::utils::ascii_lower (vayu::http::join_host (parts.host));
    // `{{baseUrl}}`-style hosts are the common Postman shape.
    // `client_cert_rejection` has no rule against a `{`/`}` byte in a host -
    // nothing hand-typed into the Settings card would ever carry one - so this
    // is a Postman-specific check with no primitive to reuse, catching what
    // would otherwise become a bogus host for `POST /client-certificates`'s
    // own check below to pass or reject on unpredictable grounds.
    if (!parts.parsed || host.empty () || host.find ('{') != std::string::npos ||
    host.find ('}') != std::string::npos) {
        counts.skipped_certificate += 1;
        return;
    }
    std::optional<int> port;
    if (!parts.port.empty ()) {
        if (const auto value = vayu::utils::parse_number<int> (parts.port);
        value && *value > 0) {
            port = value;
        }
    }
    const std::string* key_src = as_str (prop (prop (cert, "key"), "src"));
    const std::string key      = key_src == nullptr ? std::string () : *key_src;
    const auto sniffed = vayu::http::sniff_client_cert_format (*cert_src);
    const vayu::http::ClientCertFormat format =
    sniffed ? *sniffed : vayu::http::ClientCertFormat::Pem;
    if (vayu::http::client_cert_rejection (host, port, format, *cert_src, key)) {
        counts.skipped_certificate += 1;
        return;
    }

    const std::string signature = *cert_src + "\n" + key;
    const auto target           = std::make_pair (host, port.value_or (-1));
    const auto existing = counts.client_certificate_signatures.find (target);
    if (existing != counts.client_certificate_signatures.end ()) {
        if (existing->second != signature) {
            // A second, different certificate for a (host, port) this import
            // already claimed - the first one seen wins, the rest tally.
            counts.skipped_certificate += 1;
        }
        return;
    }
    counts.client_certificate_signatures.emplace (target, signature);

    json entry = json{ { "host", host }, { "certPath", *cert_src },
        { "certFormat", vayu::http::to_string (format) } };
    if (port) {
        entry["port"] = *port;
    }
    if (!key.empty ()) {
        entry["keyPath"] = key;
    }
    if (const std::string* passphrase = as_str (prop (cert, "passphrase"));
    passphrase != nullptr && !passphrase->empty ()) {
        entry["passphrase"] = *passphrase;
    }
    counts.client_certificates.push_back (std::move (entry));
}

/// The counters `pm_request` can grow for one request, by tally kind.
constexpr auto PM_REQUEST_COUNTERS =
std::to_array<std::pair<const char*, int PostmanCounts::*>> ({
{ "file_body", &PostmanCounts::skipped_file_body },
{ "unsupported_method", &PostmanCounts::skipped_unsupported_method },
{ "unsupported_auth", &PostmanCounts::skipped_unsupported_auth },
{ "oauth2_dropped_field", &PostmanCounts::oauth2_dropped_field },
{ "url_without_raw", &PostmanCounts::skipped_url_without_raw },
{ "disabled_body", &PostmanCounts::disabled_body },
{ "certificate", &PostmanCounts::skipped_certificate },
{ "proxy_config", &PostmanCounts::skipped_proxy },
{ "protocol_behavior", &PostmanCounts::skipped_protocol_behavior },
{ "non_executable_auth", &PostmanCounts::non_executable },
});

json pm_request (const json* item, PostmanCounts& counts);

/// Whether @p auth is a mode Vayu stores but does not send
/// (`CONFIG_AUTH_TYPES`), at any level: a collection's or folder's reaches
/// every request inheriting it, so it is counted where it is declared.
bool is_data_only_auth (const json& auth) {
    const std::string mode = as_string (prop (&auth, "mode"));
    return std::any_of (postman::CONFIG_AUTH_TYPES.begin (),
    postman::CONFIG_AUTH_TYPES.end (),
    [&mode] (const postman::ConfigAuthType& named) { return mode == named.vayu; });
}

/**
 * `pm_request`, noting the request's name against every counter it grew, so
 * the preview can say which request to finish by hand. A diff of the counters
 * around the call rather than a name threaded into every helper that counts.
 */
json pm_request_named (const json* item, PostmanCounts& counts) {
    std::array<int, PM_REQUEST_COUNTERS.size ()> before{};
    for (std::size_t i = 0; i < PM_REQUEST_COUNTERS.size (); ++i) {
        before.at (i) = counts.*(PM_REQUEST_COUNTERS.at (i).second);
    }
    json request           = pm_request (item, counts);
    const std::string name = as_string (&request.at ("name"));
    for (std::size_t i = 0; i < PM_REQUEST_COUNTERS.size (); ++i) {
        const auto& [kind, counter] = PM_REQUEST_COUNTERS.at (i);
        if (counts.*counter > before.at (i)) {
            counts.named[kind].push_back (name);
        }
    }
    return request;
}

json pm_request (const json* item, PostmanCounts& counts) {
    const json* declared = as_record (prop (item, "request"));
    const json empty     = json::object ();
    const json* rq       = declared == nullptr ? &empty : declared;
    auto [url, params]   = pm_url (prop (rq, "url"), counts);
    json auth            = with_postman_source (
    map_postman_auth (prop (rq, "auth"), counts.skipped_unsupported_auth, counts.oauth2_dropped_field),
    prop (rq, "auth"));
    if (is_data_only_auth (auth)) {
        counts.non_executable += 1;
    }
    counts.requests += 1;
    pm_certificate (prop (rq, "certificate"), url, counts);
    if (truthy (prop (rq, "proxy"))) {
        // Vayu's proxy config is workspace/run-scoped (`TransportPolicy`,
        // `engine/CLAUDE.md`), not per-request - unlike `certificate`, there is
        // no per-request field this could ever land in, so this stays a
        // permanent tally rather than a deferred mapping (issue #1656).
        counts.skipped_proxy += 1;
    }
    const std::vector<const json*> events = pm_events (item);
    json body                             = pm_body (prop (rq, "body"), counts);
    json examples                         = pm_examples (item, counts);

    // The request's own description, else the item's: the schema allows
    // either, generated collections write the item's, and Postman's own export
    // writes the request's - which is where the exporter puts it back.
    const json* declared_description = truthy (prop (rq, "description")) ?
    prop (rq, "description") :
    prop (item, "description");
    const std::string* description   = as_str (declared_description);
    const std::string* nested = as_str (prop (declared_description, "content"));
    const json* name          = prop (item, "name");

    bool unsupported_method = false;
    json request;
    request["name"] = name == nullptr || name->is_null () ? "Untitled" : as_string (name);
    request["description"] = pm_description_text (description, nested);
    request["method"] = to_method (prop (rq, "method"), &unsupported_method);
    if (unsupported_method) {
        counts.skipped_unsupported_method += 1;
    }
    request["url"]       = url;
    request["params"]    = params;
    const json* behavior = as_record (prop (item, "protocolProfileBehavior"));
    const json* system_headers =
    behavior == nullptr ? nullptr : prop (behavior, "disabledSystemHeaders");
    const bool content_type_refused = system_headers != nullptr &&
    std::ranges::contains (postman_disabled_system_headers (*system_headers),
    std::string ("content-type"));
    request["headers"] = with_required_content_type (
    map_key_values (prop (rq, "header"), RowExtras::Typed), body, content_type_refused);
    request["body"] = std::move (body);
    request["auth"] = std::move (auth);
    if (counts.options.import_scripts) {
        set_event_elements (request, events);
    }
    pm_redirects (item, request, counts.skipped_protocol_behavior);
    if (!examples.empty ()) {
        request["examples"] = std::move (examples);
    }
    return request;
}

/**
 * A folder set to No Auth terminates inheritance in Postman, and Vayu's
 * `noauth` is what `resolveAuthSource` stops at - so an *explicit* `noauth`
 * must not collapse into `none`, which a descendant's `inherit` walks past.
 * Collections never inherit, so `inherit` and absent both become `none`.
 */
json collection_auth (const json* auth, int& skipped_unsupported_auth, int& oauth2_dropped_field) {
    if (const json* type = prop (auth, "type"); type != nullptr && *type == "noauth") {
        return json{ { "mode", "noauth" } };
    }
    json mapped = map_postman_auth (auth, skipped_unsupported_auth, oauth2_dropped_field);
    return mapped.at ("mode") == "inherit" ?
    json{ { "mode", "none" } } :
    with_postman_source (std::move (mapped), auth);
}

json pm_folder (const json* node, PostmanCounts& counts) {
    json children = json::array ();
    json requests = json::array ();
    if (const json* items = prop (node, "item"); items != nullptr && items->is_array ()) {
        for (const json& child : *items) {
            // A `null` or scalar entry - hand-edited or script-filtered JSON,
            // which the v2.0 detector's permissive fallback happily accepts -
            // used to throw a bare TypeError naming no item and no format,
            // failing an otherwise well-formed file whole.
            const json* entry = as_record (&child);
            if (entry == nullptr) {
                counts.skipped_malformed += 1;
                continue;
            }
            if (const json* nested = prop (entry, "item");
            nested != nullptr && nested->is_array ()) {
                counts.folders += 1;
                children.push_back (pm_folder (entry, counts));
            } else if (truthy (prop (entry, "request"))) {
                requests.push_back (pm_request_named (entry, counts));
            }
        }
    }

    const json* info        = as_record (prop (node, "info"));
    const json* description = prop (info, "description");
    if (description == nullptr || description->is_null ()) {
        description = prop (node, "description");
    }
    const json* name = prop (info, "name");
    if (name == nullptr || name->is_null ()) {
        name = prop (node, "name");
    }
    const std::string* text   = as_str (description);
    const std::string* nested = as_str (prop (description, "content"));
    const std::vector<const json*> events = pm_events (node);

    json collection;
    collection["name"] =
    name == nullptr || name->is_null () ? "Imported Collection" : as_string (name);
    collection["description"] = pm_description_text (text, nested);
    collection["variables"] =
    to_var_record (prop (node, "variable"), counts.skipped_variable_metadata, true);
    collection["auth"] = collection_auth (prop (node, "auth"),
    counts.skipped_unsupported_auth, counts.oauth2_dropped_field);
    if (is_data_only_auth (collection["auth"])) {
        counts.non_executable += 1;
        counts.named["non_executable_auth"].push_back (
        collection["name"].get<std::string> ());
    }
    if (counts.options.import_scripts) {
        set_event_elements (collection, events);
    }
    collection["children"] = std::move (children);
    collection["requests"] = std::move (requests);
    return collection;
}

json parse_postman (const json& parsed, const ImportOptions& options, const char* format) {
    PostmanCounts counts;
    counts.options   = options;
    const json empty = json::object ();
    json collections = json::array ();
    collections.push_back (
    pm_folder (as_record (&parsed) == nullptr ? &empty : &parsed, counts));

    ImportTally tally;
    tally.add ("file_body", counts.skipped_file_body);
    tally.add ("malformed_item", counts.skipped_malformed);
    tally.add ("unsupported_method", counts.skipped_unsupported_method);
    tally.add ("unsupported_auth", counts.skipped_unsupported_auth);
    tally.add ("oauth2_dropped_field", counts.oauth2_dropped_field);
    tally.add ("url_without_raw", counts.skipped_url_without_raw);
    tally.add ("variable_metadata", counts.skipped_variable_metadata);
    tally.add ("disabled_body", counts.disabled_body);
    tally.add ("certificate", counts.skipped_certificate);
    tally.add ("proxy_config", counts.skipped_proxy);
    tally.add ("protocol_behavior", counts.skipped_protocol_behavior);
    for (const auto& [kind, names] : counts.named) {
        tally.name_requests (kind, names);
    }

    json meta;
    meta["format"]            = format;
    meta["requestCount"]      = counts.requests;
    meta["folderCount"]       = counts.folders;
    meta["environmentCount"]  = 0;
    meta["globalCount"]       = 0;
    meta["exampleCount"]      = count_examples (collections);
    meta["skipped"]           = tally.items ();
    meta["nonExecutableAuth"] = counts.non_executable;
    if (const auto named = counts.named.find ("non_executable_auth");
    named != counts.named.end ()) {
        meta["nonExecutableAuthRequests"] = named->second;
    }
    meta["unattachedFileParts"] = unattached_file_parts (collections);

    return json{ { "collections", std::move (collections) },
        // Collection files embed neither environments nor globals - both are
        // separate exports, which `parse_postman_variables` reads.
        { "environments", json::array () }, { "globals", json::object () },
        { "clientCertificates", std::move (counts.client_certificates) },
        { "meta", std::move (meta) } };
}

// ---------------------------------------------------------------------------
// `postman-environment.ts`
// ---------------------------------------------------------------------------

/**
 * Postman exports an environment as its own file, separate from the collection
 * export - which is why the collection parser correctly returns no
 * environments. This reads that separate file, and the *globals* file too:
 * they share a document shape and therefore a parser, so the mapping rules
 * (secret flag, enabled precedence, `{{ var }}` normalisation) cannot drift
 * between them. Only the destination differs.
 *
 * Either way the result has no collections at all, the only parser that
 * produces that.
 */
json parse_postman_variables (const json& parsed, const ImportOptions& options, bool globals) {
    // Gated at parse time, matching the Insomnia parser: with the option off
    // the draft carries nothing and the counts report 0, so the preview shows
    // what will actually be created. The one toggle covers both scopes - it
    // reads "Import environments & variables", and globals are variables.
    int skipped_variable_metadata = 0;
    const json variables          = options.import_environments ?
             to_var_record (prop (&parsed, "values"), skipped_variable_metadata, false) :
             json::object ();

    json environments = json::array ();
    if (!globals && options.import_environments) {
        environments.push_back ({ { "name",
                                  as_string (prop (&parsed, "name")).empty () ?
                                  "Imported Environment" :
                                  as_string (prop (&parsed, "name")) },
        { "description", "" }, { "variables", variables } });
    }
    // A globals export carries a `name` too (the workspace's), but Vayu's
    // globals scope is a singleton with nowhere to put it, so it is dropped
    // rather than invented into an environment name.
    const json scope = globals ? variables : json::object ();

    json meta;
    meta["format"]       = globals ? "Postman Globals" : "Postman Environment";
    meta["requestCount"] = 0;
    meta["folderCount"]  = 0;
    meta["environmentCount"] = static_cast<int> (environments.size ());
    meta["globalCount"]      = static_cast<int> (scope.size ());
    // An environment or globals export has no requests, so no examples and no
    // file parts either.
    meta["exampleCount"] = 0;
    ImportTally tally;
    tally.add ("variable_metadata", skipped_variable_metadata);
    meta["skipped"]             = tally.items ();
    meta["nonExecutableAuth"]   = 0;
    meta["unattachedFileParts"] = 0;

    return json{ { "collections", json::array () },
        { "environments", std::move (environments) }, { "globals", scope },
        { "meta", std::move (meta) } };
}

// ---------------------------------------------------------------------------
// `insomnia-v4.ts`
// ---------------------------------------------------------------------------

/// What an Insomnia parse accumulates. `file_body` is the one loss it counts
/// from inside a body: a binary body and a file part with no path are the two
/// things Vayu genuinely cannot store.
struct InsomniaCounts {
    ImportOptions options;
    int non_executable = 0;
    int file_body      = 0;
    int requests       = 0;
    int folders        = 0;
};

/// A row array that may be absent but must not be another type.
const json* rows_or_throw (const json* value, const std::string& what) {
    if (value == nullptr || value->is_null ()) {
        return nullptr;
    }
    if (!value->is_array ()) {
        throw MalformedImport (what + " must be an array");
    }
    return value;
}

/// `kvRow(row)`: Insomnia's `{name, value, disabled, description}` in the shape
/// `map_key_values` reads.
json kv_row (const json& row) {
    const json* record = as_record (&row);
    json mapped        = json::object ();
    if (const json* name = prop (record, "name")) {
        mapped["key"] = *name;
    }
    if (const json* value = prop (record, "value")) {
        mapped["value"] = *value;
    }
    if (const json* disabled = prop (record, "disabled")) {
        mapped["disabled"] = *disabled;
    }
    if (const std::string* description = as_str (prop (record, "description"));
    description != nullptr && !description->empty ()) {
        mapped["description"] = *description;
    }
    return mapped;
}

json kv_rows (const json* rows) {
    json mapped = json::array ();
    if (rows != nullptr) {
        for (const json& row : *rows) {
            mapped.push_back (kv_row (row));
        }
    }
    return mapped;
}

/// Insomnia's `pathParameters[]` (`{name, value}`) as table rows - the same
/// `name` -> `key` conversion `kv_row` already does for query/header rows.
/// Insomnia keeps them per request and writes each into its `/:name` segment
/// at send time (`applyPathParametersToUrl`), the model a path row is.
json insomnia_path_variables (const json* rows) {
    const json named = kv_rows (rows);
    return map_key_values (&named);
}

/**
 * Insomnia sends `Authorization: <prefix> <token>`, where an empty PREFIX field
 * means "Bearer". Vayu's bearer mode always writes "Bearer", so a different
 * scheme (`Token`, `JWT`) is preserved as an explicit Authorization header
 * instead of being silently rewritten - the engine sends an `apikey` header
 * value verbatim, so the wire bytes match what Insomnia would have sent. A
 * prefix differing only in case stays on the native bearer mode: HTTP auth
 * schemes are case-insensitive (RFC 7235 s2.1).
 */
json insomnia_bearer (const json* auth) {
    const std::string token = nv (as_string (prop (auth, "token")));
    std::string prefix      = nv (as_string (prop (auth, "prefix")));
    const size_t begin      = prefix.find_first_not_of (" \t\n\r\f\v");
    prefix                  = begin == std::string::npos ?
                     std::string () :
                     prefix.substr (begin, prefix.find_last_not_of (" \t\n\r\f\v") - begin + 1);
    if (!prefix.empty () && vayu::utils::ascii_lower (prefix) != "bearer") {
        std::string value = prefix + " " + token;
        const size_t last = value.find_last_not_of (" \t\n\r\f\v");
        value = last == std::string::npos ? std::string () : value.substr (0, last + 1);
        return json{ { "mode", "apikey" }, { "key", "Authorization" },
            { "value", value }, { "in", "header" } };
    }
    return json{ { "mode", "bearer" }, { "token", token } };
}

/// The auth node minus the two members that are not configuration.
json insomnia_config (const json* node) {
    json config = json::object ();
    for (auto entry = node->begin (); entry != node->end (); ++entry) {
        if (entry.key () != "type" && entry.key () != "disabled") {
            config[entry.key ()] = entry.value ();
        }
    }
    return config;
}

json insomnia_auth (const json* auth, InsomniaCounts& counts) {
    const json* node     = as_record (auth);
    const json* disabled = prop (node, "disabled");
    const bool off =
    disabled != nullptr && disabled->is_boolean () && disabled->get<bool> ();
    if (node == nullptr || !truthy (prop (node, "type")) || off) {
        return off ? json{ { "mode", "none" } } : json{ { "mode", "inherit" } };
    }
    const std::string* type = as_str (prop (node, "type"));
    const std::string named = type == nullptr ? std::string () : *type;
    if (named == "bearer") {
        return insomnia_bearer (node);
    }
    if (named == "basic") {
        return json{ { "mode", "basic" },
            { "username", nv (as_string (prop (node, "username"))) },
            { "password", nv (as_string (prop (node, "password"))) } };
    }
    if (named == "apikey") {
        const json* add_to = prop (node, "addTo");
        return json{ { "mode", "apikey" }, { "key", nv (as_string (prop (node, "key"))) },
            { "value", nv (as_string (prop (node, "value"))) },
            { "in", add_to != nullptr && *add_to == "queryParams" ? "query" : "header" } };
    }
    if (named == "oauth2") {
        return map_insomnia_oauth2 (node);
    }
    if (named == "digest" || named == "ntlm") {
        counts.non_executable += 1;
        return json{ { "mode", named }, { "config", insomnia_config (node) } };
    }
    if (named == "iam") {
        // Insomnia names AWS IAM auth "iam"; Vayu stores it as the "aws" config
        // bag (stored, not executed).
        counts.non_executable += 1;
        return json{ { "mode", "aws" }, { "config", insomnia_config (node) } };
    }
    if (named == "none") {
        // Insomnia's own explicit "No Auth" - distinct from an absent
        // `authentication` object, which means "inherit". An explicit `none`
        // must terminate inheritance the same way Postman's own `noauth`
        // does in `map_postman_auth`: falling through to `inherit` here would
        // send a folder's credentials to a request the user explicitly opted
        // out of them for.
        return json{ { "mode", "none" } };
    }
    return json{ { "mode", "inherit" } };
}

/**
 * Insomnia's multipart params, files included. A file param keeps its path in
 * `fileName` - the field is the *path* on the exporting machine, not a declared
 * part name - and its `value` is empty. One with no path names no file, so it
 * is counted as skipped rather than imported as a part that could never be
 * sent.
 */
json multipart_fields (const json* rows, InsomniaCounts& counts) {
    json out = json::array ();
    if (rows == nullptr) {
        return out;
    }
    for (const json& row : *rows) {
        const json single = json::array ({ kv_row (row) });
        const json mapped = map_key_values (&single);
        const json* type  = prop (&row, "type");
        if (type == nullptr || *type != "file") {
            for (const json& entry : mapped) {
                out.push_back (entry);
            }
            continue;
        }
        const std::string* path = as_str (prop (&row, "fileName"));
        if (mapped.empty () || path == nullptr || path->empty ()) {
            counts.file_body += 1;
            continue;
        }
        out.push_back (imported_file_part (mapped[0], *path, nullptr));
    }
    return out;
}

/**
 * A GraphQL body for a document that arrived without an envelope
 * (`toGraphQLEnvelope`).
 *
 * Insomnia's `application/graphql` body is usually the envelope, but it may be
 * the bare query document - and a bare document stored verbatim went on the
 * wire as the whole HTTP body, which is not JSON and carries no `query` a
 * GraphQL server can read. Nothing showed it: the editor's raw-string fallback
 * renders a bare document exactly as it renders a healthy one.
 */
std::string to_graphql_envelope (const std::string& body) {
    const size_t begin = body.find_first_not_of (" \t\n\r\f\v");
    if (begin == std::string::npos) {
        return js_json_compact (json{ { "query", "" } });
    }
    std::string trimmed =
    body.substr (begin, body.find_last_not_of (" \t\n\r\f\v") - begin + 1);
    const json parsed = json::parse (trimmed, nullptr, false);
    if (!parsed.is_discarded () && parsed.is_object () &&
    as_str (prop (&parsed, "query")) != nullptr) {
        return trimmed; // Already an envelope; do not double-wrap it.
    }
    return js_json_compact (json{ { "query", body } });
}

/**
 * Any mime outside the seven Insomnia body modes. Its YAML/CSV/"Other" bodies
 * are plain text in `body.text`, so they import as `text` rather than being
 * dropped (the Postman parser's raw fallback does the same). A binary body
 * carries a `fileName` and no text - that one Vayu genuinely cannot store, so
 * it is dropped and counted instead of vanishing.
 */
json unlisted_body (const json* body, InsomniaCounts& counts) {
    if (const std::string* text = as_str (prop (body, "text"));
    text != nullptr && !text->empty ()) {
        return json{ { "mode", "text" }, { "content", normalize_vars (*text) } };
    }
    if (const std::string* name = as_str (prop (body, "fileName"));
    name != nullptr && !name->empty ()) {
        counts.file_body += 1;
    }
    return json{ { "mode", "none" } };
}

json insomnia_body (const json* body, InsomniaCounts& counts) {
    if (body == nullptr || body->is_null ()) {
        return json{ { "mode", "none" } };
    }
    const json* node = as_record (body);
    if (node == nullptr) {
        throw MalformedImport ("a request `body` must be an object");
    }
    const json* declared = prop (node, "mimeType");
    if (declared != nullptr && !declared->is_null () && !declared->is_string ()) {
        throw MalformedImport ("`body.mimeType` must be a string");
    }
    std::string mime =
    declared != nullptr && declared->is_string () ? declared->get<std::string> () : "";
    if (const size_t semicolon = mime.find (';'); semicolon != std::string::npos) {
        mime = mime.substr (0, semicolon);
    }
    if (const size_t begin = mime.find_first_not_of (" \t\n\r\f\v");
    begin == std::string::npos) {
        mime.clear ();
    } else {
        mime = mime.substr (begin, mime.find_last_not_of (" \t\n\r\f\v") - begin + 1);
    }
    const std::string text = normalize_vars (as_string (prop (node, "text")));

    if (mime == "application/json") {
        return json{ { "mode", "json" }, { "content", text } };
    }
    if (mime == "text/plain") {
        return json{ { "mode", "text" }, { "content", text } };
    }
    if (mime == "application/graphql") {
        return json{ { "mode", "graphql" }, { "content", to_graphql_envelope (text) } };
    }
    // Both spellings a client sends XML under. They used to fall through to the
    // unlisted branch, which keeps the text as `text` - readable, but a mode
    // that requires no Content-Type, so the imported request sent its SOAP
    // envelope as `x-www-form-urlencoded`.
    if (mime == "application/xml" || mime == "text/xml") {
        return json{ { "mode", "xml" }, { "content", text } };
    }
    if (mime == "application/x-www-form-urlencoded") {
        const json rows =
        kv_rows (rows_or_throw (prop (node, "params"), "`body.params`"));
        return json{ { "mode", "x-www-form-urlencoded" },
            { "fields", map_key_values (&rows) } };
    }
    if (mime == "multipart/form-data") {
        const json* rows = rows_or_throw (prop (node, "params"), "`body.params`");
        return json{ { "mode", "form-data" }, { "fields", multipart_fields (rows, counts) } };
    }
    return unlisted_body (node, counts);
}

/**
 * Insomnia's per-request redirect choice is `"global" | "on" | "off"`, where
 * `"global"` defers to an app-level setting that follows redirects. Only an
 * explicit `"on"`/`"off"` is imported: the field stays absent otherwise,
 * because the engine's default is `true` and an omitted `false` would silently
 * follow a 3xx the user disabled. Insomnia has no per-request redirect *limit*,
 * so `maxRedirects` is never imported.
 */
void insomnia_redirects (const json* resource, json& request) {
    const json* setting = prop (resource, "settingFollowRedirects");
    if (setting == nullptr) {
        return;
    }
    if (*setting == "off") {
        request["followRedirects"] = false;
    } else if (*setting == "on") {
        request["followRedirects"] = true;
    }
}

/// Insomnia env `data` (which may hold non-string values) as Vayu variables.
json to_env_vars (const json* data) {
    json out = json::object ();
    if (data == nullptr || !data->is_object ()) {
        return out;
    }
    for (auto entry = data->begin (); entry != data->end (); ++entry) {
        out[entry.key ()] =
        json{ { "value", normalize_vars (as_string (&entry.value ())) },
            { "enabled", true } };
    }
    return out;
}

/// A resource's identity as a map key. Insomnia writes strings; a mangled file
/// may not, and a key coerced the way JavaScript coerces one keeps the two
/// sides answering alike.
std::string resource_key (const json* value) {
    if (value == nullptr || value->is_null ()) {
        return {};
    }
    return value->is_string () ? value->get<std::string> () : js_string_of (*value);
}

/// The resource's own name, or @p fallback - taken verbatim rather than
/// coerced, exactly as the renderer's `r.name ?? "Untitled"` does.
json resource_name (const json* resource, const char* fallback) {
    const json* name = prop (resource, "name");
    return name == nullptr || name->is_null () ? json (fallback) : *name;
}

/**
 * One Insomnia v4 export's resource tree, indexed by parent.
 *
 * The walk is a member function rather than a recursive lambda so each step of
 * it - a request, a folder, the environments - reads as its own thing; the
 * counts and the skipped-feature tally are the state every step writes into.
 */
class InsomniaTree {
    public:
    InsomniaTree (const json& resources, const ImportOptions& options) {
        counts_.options = options;
        for (size_t at = 0; at < resources.size (); ++at) {
            if (!resources[at].is_object ()) {
                throw MalformedImport (
                "`resources[" + std::to_string (at) + "]` must be an object");
            }
            by_parent_[resource_key (prop (&resources[at], "parentId"))].push_back (
            &resources[at]);
        }
        for (const json& resource : resources) {
            if (type_is (&resource, "workspace")) {
                workspaces_.push_back (&resource);
            }
        }
    }

    /// Every workspace, as a collection tree.
    json collections () {
        json out = json::array ();
        for (const json* workspace : workspaces_) {
            out.push_back (build_collection (workspace, /*workspace=*/true));
        }
        return out;
    }

    /**
     * Environments: a base env (parentId = workspace) plus its sub-envs
     * (parentId = base env), flattened - a sub-env is the base with its own
     * values written over it.
     */
    json environments () {
        json out = json::array ();
        if (!counts_.options.import_environments) {
            return out;
        }
        for (const json* workspace : workspaces_) {
            for (const json* base : children_of (workspace)) {
                if (type_is (base, "environment")) {
                    add_environment (workspace, base, out);
                }
            }
        }
        return out;
    }

    InsomniaCounts& counts () {
        return counts_;
    }

    ImportTally& tally () {
        return tally_;
    }

    private:
    static bool type_is (const json* node, const char* type) {
        const json* declared_type = prop (node, "_type");
        return declared_type != nullptr && *declared_type == type;
    }

    const std::vector<const json*>& children_of (const json* node) const {
        static const std::vector<const json*> NONE;
        const auto found = by_parent_.find (resource_key (prop (node, "_id")));
        return found == by_parent_.end () ? NONE : found->second;
    }

    json build_request (const json* resource) {
        counts_.requests += 1;
        json body = insomnia_body (prop (resource, "body"), counts_);
        const json params =
        kv_rows (rows_or_throw (prop (resource, "parameters"), "`parameters`"));
        const json headers =
        kv_rows (rows_or_throw (prop (resource, "headers"), "`headers`"));
        const json* description       = prop (resource, "description");
        const json declared_path_rows = insomnia_path_variables (
        rows_or_throw (prop (resource, "pathParameters"), "`pathParameters`"));

        json request;
        request["name"] = resource_name (resource, "Untitled");
        request["description"] =
        description == nullptr || description->is_null () ? json ("") : *description;
        request["method"] = to_method (prop (resource, "method"));
        const std::string url = normalize_vars (as_string (prop (resource, "url")));
        request["url"]    = url;
        request["params"] = map_key_values (&params);
        for (json& row : path_variable_rows (declared_path_rows)) {
            request["params"].push_back (std::move (row));
        }
        request["headers"] = with_required_content_type (map_key_values (&headers), body);
        request["body"] = std::move (body);
        request["auth"] = insomnia_auth (prop (resource, "authentication"), counts_);
        if (counts_.options.import_scripts) {
            set_script_elements (request, as_string (prop (resource, "preRequestScript")),
            as_string (prop (resource, "afterResponseScript")));
        }
        insomnia_redirects (resource, request);
        return request;
    }

    /** One child of a folder, by the resource type it declares. */
    void add_child (const json* child, json& children, json& requests) {
        if (type_is (child, "request_group")) {
            counts_.folders += 1;
            children.push_back (build_collection (child, /*workspace=*/false));
        } else if (type_is (child, "request")) {
            const int file_bodies           = counts_.file_body;
            const int non_executable_before = counts_.non_executable;
            json request                    = build_request (child);
            const std::string name          = as_string (&request.at ("name"));
            if (counts_.file_body > file_bodies) {
                named_["file_body"].push_back (name);
            }
            if (counts_.non_executable > non_executable_before) {
                named_["non_executable_auth"].push_back (name);
            }
            requests.push_back (std::move (request));
        } else {
            // What Vayu has no request shape for is still named, so the
            // preview can say which one did not come across.
            const json name = resource_name (child, "Untitled");
            tally_.set_subject (as_string (&name));
            if (type_is (child, "grpc_request")) {
                tally_.add ("grpc");
            } else if (type_is (child, "websocket_request")) {
                tally_.add ("websocket");
            } else if (type_is (child, "api_spec")) {
                tally_.add ("api_spec");
            } else if (type_is (child, "unit_test") || type_is (child, "unit_test_suite")) {
                tally_.add ("unit_test");
            }
            tally_.set_subject ({});
        }
    }

    json build_collection (const json* node, bool workspace) {
        // Insomnia cannot emit a cycle (`parentId` is a single edge), but a
        // mangled file can - and an unguarded walk answers that with a stack
        // overflow.
        const std::string id = resource_key (prop (node, "_id"));
        if (!visited_.insert (id).second) {
            throw MalformedImport ("resource \"" + id + "\" appears twice in the folder tree");
        }
        json children = json::array ();
        json requests = json::array ();
        for (const json* child : children_of (node)) {
            add_child (child, children, requests);
        }
        json auth = insomnia_auth (prop (node, "authentication"), counts_);
        const json* description = prop (node, "description");

        json collection;
        collection["name"] = resource_name (node, "Imported");
        collection["description"] =
        description == nullptr || description->is_null () ? json ("") : *description;
        collection["variables"] = workspace ?
        to_env_vars (as_record (prop (node, "environment"))) :
        json::object ();
        // Collections never inherit.
        collection["auth"] =
        auth.at ("mode") == "inherit" ? json{ { "mode", "none" } } : auth;
        // Insomnia 9.3+ lets a folder carry scripts, and its v4 export writes
        // model fields verbatim - so these are the request-level key names. An
        // export that spells them differently reads as absent.
        if (counts_.options.import_scripts) {
            set_script_elements (collection, as_string (prop (node, "preRequestScript")),
            as_string (prop (node, "afterResponseScript")));
        }
        collection["children"] = std::move (children);
        collection["requests"] = std::move (requests);
        return collection;
    }

    /** One base environment, flattened with its sub-environments. */
    void add_environment (const json* workspace, const json* base, json& out) {
        const json base_vars = to_env_vars (as_record (prop (base, "data")));
        std::vector<const json*> subs;
        for (const json* sub : children_of (base)) {
            if (type_is (sub, "environment")) {
                subs.push_back (sub);
            }
        }
        if (subs.empty ()) {
            // `base.name ?? workspace.name ?? "Environment"` - absence, not
            // emptiness: an environment deliberately named "" keeps that name
            // on both sides.
            const json* named = prop (base, "name");
            const json name   = named == nullptr || named->is_null () ?
              resource_name (workspace, "Environment") :
              *named;
            out.push_back (
            { { "name", name }, { "description", "" }, { "variables", base_vars } });
            return;
        }
        for (const json* sub : subs) {
            // `{...baseVars, ...subVars}`: a key the sub-env restates keeps the
            // base's position and takes the sub's value.
            json merged         = base_vars;
            const json sub_vars = to_env_vars (as_record (prop (sub, "data")));
            for (auto entry = sub_vars.begin (); entry != sub_vars.end (); ++entry) {
                merged[entry.key ()] = entry.value ();
            }
            out.push_back ({ { "name", resource_name (sub, "Environment") },
            { "description", "" }, { "variables", std::move (merged) } });
        }
    }

    std::map<std::string, std::vector<const json*>> by_parent_;
    std::vector<const json*> workspaces_;
    InsomniaCounts counts_;
    ImportTally tally_;
    std::set<std::string> visited_;
    // The requests a per-request counter grew on, by tally kind.
    std::map<std::string, std::vector<std::string>> named_;

    public:
    /// Names the counted kinds after the walk - see `ImportTally::name_requests`.
    void name_counted () {
        for (const auto& [kind, names] : named_) {
            tally_.name_requests (kind, names);
        }
    }

    /// The requests whose auth is stored but not sent, by name.
    [[nodiscard]] std::vector<std::string> non_executable_named () const {
        const auto named = named_.find ("non_executable_auth");
        return named == named_.end () ? std::vector<std::string>{} : named->second;
    }
};

json parse_insomnia (const json& parsed, const ImportOptions& options) {
    const json* declared = prop (&parsed, "resources");
    if (declared != nullptr && !declared->is_null () && !declared->is_array ()) {
        throw MalformedImport ("`resources` must be an array");
    }
    const json empty = json::array ();
    const json& resources = declared == nullptr || declared->is_null () ? empty : *declared;

    InsomniaTree tree (resources, options);
    json collections  = tree.collections ();
    json environments = tree.environments ();

    tree.tally ().add ("file_body", tree.counts ().file_body);
    tree.name_counted ();

    json meta;
    meta["format"]           = "Insomnia Export v4";
    meta["requestCount"]     = tree.counts ().requests;
    meta["folderCount"]      = tree.counts ().folders;
    meta["environmentCount"] = static_cast<int> (environments.size ());
    meta["globalCount"]      = 0;
    // Insomnia v4 exports carry no saved responses - the format has no concept
    // of one, so this is 0 by absence rather than by drop.
    meta["exampleCount"]      = 0;
    meta["skipped"]           = tree.tally ().items ();
    meta["nonExecutableAuth"] = tree.counts ().non_executable;
    if (std::vector<std::string> named = tree.non_executable_named (); !named.empty ()) {
        meta["nonExecutableAuthRequests"] = std::move (named);
    }
    meta["unattachedFileParts"] = unattached_file_parts (collections);

    return json{ { "collections", std::move (collections) },
        { "environments", std::move (environments) },
        // Insomnia has no globals scope; workspace envs map to environments.
        { "globals", json::object () }, { "meta", std::move (meta) } };
}

// ---------------------------------------------------------------------------
// OpenAPI 2.0 / 3.x - the collection around `core::import_drafts_of`
// ---------------------------------------------------------------------------

/// A URL that already names its own scheme - `https:`, and any other.
bool has_scheme (const std::string& url) {
    if (url.empty () || std::isalpha (static_cast<unsigned char> (url[0])) == 0) {
        return false;
    }
    for (size_t at = 1; at < url.size (); ++at) {
        const char ch = url[at];
        if (ch == ':') {
            return true;
        }
        if (std::isalnum (static_cast<unsigned char> (ch)) == 0 && ch != '+' &&
        ch != '.' && ch != '-') {
            return false;
        }
    }
    return false;
}

/**
 * RFC 3986's `remove_dot_segments`, which is what `new URL` applies to the path
 * it resolves.
 *
 * Segment-wise rather than character-wise, which is the same answer with one
 * thing to say out loud: a path whose *last* segment is `.` or `..` keeps its
 * trailing slash (`/a/b/..` is `/a/`, not `/a`), so the removed segment leaves
 * an empty one behind rather than nothing.
 */
std::string remove_dot_segments (const std::string& path) {
    std::vector<std::string> segments;
    size_t start = 0;
    while (start <= path.size ()) {
        const size_t slash        = path.find ('/', start);
        const std::string segment = path.substr (
        start, slash == std::string::npos ? std::string::npos : slash - start);
        const bool last = slash == std::string::npos;
        start           = last ? path.size () + 1 : slash + 1;

        if (segment == "." || segment == "..") {
            if (segment == ".." && segments.size () > 1) {
                segments.pop_back ();
            }
            if (last) {
                segments.emplace_back ();
            }
            continue;
        }
        segments.push_back (segment);
    }

    std::string out;
    for (size_t at = 0; at < segments.size (); ++at) {
        if (at > 0) {
            out += '/';
        }
        out += segments[at];
    }
    return out;
}

/**
 * `new URL(reference, base).toString()`, for the one place an import needs it:
 * a relative `servers[0].url` against the URL the document was fetched from.
 *
 * Reference resolution only - no percent-normalization, no IDNA - because the
 * two inputs are a document's own server URL and a URL the app fetched from,
 * both of which arrive as text a user typed or a server wrote. Returns nothing
 * when @p base is not absolute, which is `new URL`'s `TypeError` and which the
 * caller reports as an unresolved base rather than guessing a host.
 */
std::optional<std::string>
resolve_url (const std::string& reference, const std::string& base) {
    if (!has_scheme (base)) {
        return std::nullopt;
    }
    const size_t colon       = base.find (':');
    const std::string scheme = base.substr (0, colon + 1);
    std::string authority;
    std::string base_path = base.substr (colon + 1);
    if (base_path.rfind ("//", 0) == 0) {
        const size_t end = base_path.find_first_of ("/?#", 2);
        authority =
        base_path.substr (0, end == std::string::npos ? std::string::npos : end);
        base_path = end == std::string::npos ? std::string () : base_path.substr (end);
    }
    // The base's query and fragment take no part in resolving a reference.
    if (const size_t cut = base_path.find_first_of ("?#"); cut != std::string::npos) {
        base_path = base_path.substr (0, cut);
    }

    if (reference.rfind ("//", 0) == 0) {
        return scheme + reference;
    }
    if (reference.empty ()) {
        return scheme + authority + (base_path.empty () ? "/" : base_path);
    }
    std::string path;
    if (reference[0] == '/') {
        path = reference;
    } else if (reference[0] == '?' || reference[0] == '#') {
        return scheme + authority + (base_path.empty () ? "/" : base_path) + reference;
    } else {
        const size_t slash = base_path.find_last_of ('/');
        path               = (slash == std::string::npos ? std::string ("/") :
                                                           base_path.substr (0, slash + 1)) +
        reference;
    }
    // A query or fragment on the reference rides along untouched.
    std::string tail;
    if (const size_t cut = path.find_first_of ("?#"); cut != std::string::npos) {
        tail = path.substr (cut);
        path = path.substr (0, cut);
    }
    const std::string resolved = remove_dot_segments (path);
    return scheme + authority + (resolved.empty () ? "/" : resolved) + tail;
}

/// What is left of a `{token}` after substitution, which is what cannot resolve.
bool has_unresolved_template (const std::string& url) {
    for (size_t at = url.find ('{'); at != std::string::npos; at = url.find ('{', at + 1)) {
        const size_t close = url.find_first_of ("{}/", at + 1);
        if (close != std::string::npos && url[close] == '}' && close > at + 1) {
            return true;
        }
    }
    return false;
}

/**
 * `resolveServerUrl(server, sourceUrl, tally)`: `servers[0]` as the
 * `{{baseUrl}}` every imported request is written against (issue #719).
 *
 * Taken verbatim, that field produces a URL a request can never reach in two
 * ways, both silently. A Server Object may template its URL -
 * `{protocol}://{hostname}/api/v3` - and those single braces are **not** Vayu
 * variables (only the path is rewritten), so the literal survived into every
 * request line and failed at connect with nothing said. And a server URL may be
 * relative, in which case OpenAPI says it is relative to where the document
 * itself lives.
 *
 * So: substitute the defaults the document declares (the specification
 * *requires* a default on every server variable, so a complete document always
 * resolves), then resolve what is left against the source URL when it needs
 * one. Anything still unresolvable is kept exactly as written and counted - a
 * base the user can see is unfinished beats a host Vayu invented.
 */
std::string
resolve_server_url (const json* server, const std::string& source_url, ImportTally& tally) {
    const std::string* declared = as_str (prop (server, "url"));
    if (declared == nullptr || declared->empty ()) {
        return {};
    }
    const json* variables = as_record (prop (server, "variables"));

    std::string substituted;
    for (size_t at = 0; at < declared->size ();) {
        if ((*declared)[at] != '{') {
            substituted += (*declared)[at];
            ++at;
            continue;
        }
        const size_t close = declared->find_first_of ("{}/", at + 1);
        if (close == std::string::npos || (*declared)[close] != '}' || close == at + 1) {
            substituted += (*declared)[at];
            ++at;
            continue;
        }
        const std::string name = declared->substr (at + 1, close - at - 1);
        const json* value = prop (as_record (prop (variables, name)), "default");
        // A default is `string` per the specification; a number or boolean is
        // what a hand-written document produces and reads the same on the wire.
        if (value == nullptr || value->is_structured () || value->is_null ()) {
            substituted += declared->substr (at, close - at + 1);
        } else {
            substituted += value->is_string () ? value->get<std::string> () :
                                                 js_string_of (*value);
        }
        at = close + 1;
    }

    if (has_unresolved_template (substituted)) {
        tally.add ("unresolved_base_url");
        return substituted;
    }
    if (has_scheme (substituted)) {
        return substituted;
    }
    if (source_url.empty ()) {
        // A pasted or file-picked document: there is no location to be relative
        // to, so the URL stays as written rather than being guessed at.
        tally.add ("unresolved_base_url");
        return substituted;
    }
    if (const std::optional<std::string> resolved = resolve_url (substituted, source_url)) {
        return *resolved;
    }
    tally.add ("unresolved_base_url");
    return substituted;
}

/// A 3.x `securityScheme` as a concrete collection-level auth, secrets empty.
json scheme_to_auth_v3 (const json* scheme) {
    const json* node = as_record (scheme);
    if (node == nullptr || !truthy (prop (node, "type"))) {
        return json{ { "mode", "none" } };
    }
    const json* type        = prop (node, "type");
    const json* scheme_name = prop (node, "scheme");
    if (*type == "http" && scheme_name != nullptr && *scheme_name == "bearer") {
        return json{ { "mode", "bearer" }, { "token", "" } };
    }
    if (*type == "http" && scheme_name != nullptr && *scheme_name == "basic") {
        return json{ { "mode", "basic" }, { "username", "" }, { "password", "" } };
    }
    if (*type == "apiKey") {
        const json* in = prop (node, "in");
        // 3.x's apiKey has a third placement `cookie`, which Vayu's apikey
        // mode has no slot for (only header/query) - reinterpreting it as a
        // header would send the credential somewhere the document never
        // named, so this is left unmapped like any other scheme Vayu cannot
        // execute, not silently misplaced.
        if (in != nullptr && *in == "cookie") {
            return json{ { "mode", "none" } };
        }
        const std::string* name = as_str (prop (node, "name"));
        return json{ { "mode", "apikey" },
            { "key", name == nullptr ? "" : *name }, { "value", "" },
            { "in", in != nullptr && *in == "query" ? "query" : "header" } };
    }
    if (*type == "oauth2") {
        return map_openapi_v3_oauth2 (node);
    }
    return json{ { "mode", "none" } };
}

/// The same for 2.0, whose `securityDefinitions` spell basic auth as a type.
json scheme_to_auth_v2 (const json* scheme) {
    const json* node = as_record (scheme);
    if (node == nullptr || !truthy (prop (node, "type"))) {
        return json{ { "mode", "none" } };
    }
    const json* type = prop (node, "type");
    if (*type == "basic") {
        return json{ { "mode", "basic" }, { "username", "" }, { "password", "" } };
    }
    if (*type == "apiKey") {
        const std::string* name = as_str (prop (node, "name"));
        const json* in          = prop (node, "in");
        return json{ { "mode", "apikey" },
            { "key", name == nullptr ? "" : *name }, { "value", "" },
            { "in", in != nullptr && *in == "query" ? "query" : "header" } };
    }
    if (*type == "oauth2") {
        return map_swagger_oauth2 (node);
    }
    return json{ { "mode", "none" } };
}

/// The scheme name and node a collection's auth is built from: the one the
/// document's top-level `security` requires, else the first one it defines.
/// Carrying the name too (not only the node) is what lets a per-operation
/// `security` entry recognise "this names the same scheme the collection
/// already took" and answer `inherit` rather than a redundant explicit mode.
struct PrimaryScheme {
    std::string name;
    const json* node = nullptr;
};

PrimaryScheme primary_scheme (const json* schemes, const json* security) {
    const json* required = as_record (array_at (security, 0));
    if (required != nullptr && !required->empty () && schemes != nullptr) {
        const std::string key = required->begin ().key ();
        if (const json* named = prop (schemes, key); truthy (named)) {
            return { key, named };
        }
    }
    if (schemes == nullptr || !schemes->is_object () || schemes->empty ()) {
        return {};
    }
    return { schemes->begin ().key (), &schemes->begin ().value () };
}

/**
 * The tally kind for a declared scheme `scheme_to_auth_*` mapped to no mode -
 * named by its OpenAPI `type` where the type alone says why (`mutualTLS`,
 * `openIdConnect`), and by a shared catch-all otherwise (an `http` scheme
 * other than bearer/basic, an `apiKey` case `scheme_to_auth_*` still refuses,
 * or a scheme with no readable `type` at all).
 */
std::string_view unmapped_security_kind (const json* scheme) {
    const json* node = as_record (scheme);
    const json* type = node != nullptr ? prop (node, "type") : nullptr;
    if (type != nullptr && *type == "mutualTLS") {
        return "security_unmapped_mutualtls";
    }
    if (type != nullptr && *type == "openIdConnect") {
        return "security_unmapped_openidconnect";
    }
    if (type != nullptr && *type == "apiKey") {
        const json* in = prop (node, "in");
        if (in != nullptr && *in == "cookie") {
            return "security_unmapped_apikey_cookie";
        }
    }
    return "security_unmapped_type";
}

/**
 * A per-operation `security` requirement as an override onto the collection's
 * auth (issue #1444), or `nullopt` when the operation names no override and
 * the request should keep today's answer, `inherit`.
 *
 * `security: []` is OpenAPI's explicit "this operation takes no auth" and is
 * the one case that must never fall back to `inherit` - that is exactly the
 * defect this issue fixes. A requirement naming the scheme the collection
 * already took is answered as `inherit` too, since the two modes would be
 * identical and `inherit` keeps following the collection if its auth is later
 * edited. Anything Vayu cannot resolve to one concrete mode - more than one
 * requirement (an OR of alternatives), a requirement naming more than one
 * scheme (an AND), a requirement naming a scheme the document never declares,
 * or a scheme type Vayu has no mode for (`mutualTLS`, `openIdConnect`, an
 * unrecognised `type`) - is left on `inherit`, the safe default that sends
 * what the collection already sends rather than guessing, and counted under
 * its own `security_unmapped_*` kind rather than one shared bucket, so the
 * import summary says which of the four reasons applied.
 *
 * Every non-`nullopt` return is `std::make_optional`, never a bare `json`:
 * copy-initializing an `optional<json>` from a `json` puts nlohmann's
 * `operator ValueType()` up against `optional`'s converting constructor,
 * which GCC's release build reports as an ambiguity under `-Werror` (the same
 * reason `scalar_stub` in `openapi_drafts.cpp` does).
 */
std::optional<json> operation_auth_override (const json* op_security,
const json* schemes,
const PrimaryScheme& collection_scheme,
bool v3,
ImportTally& tally) {
    if (op_security == nullptr || !op_security->is_array ()) {
        return std::nullopt;
    }
    if (op_security->empty ()) {
        return std::make_optional (json{ { "mode", "none" } });
    }
    if (op_security->size () > 1) {
        // An OR of alternative schemes - Vayu sends one mode per request and
        // has no way to pick which alternative the caller meant.
        tally.add ("security_unmapped_or");
        return std::nullopt;
    }
    const json* requirement = as_record (&op_security->front ());
    if (requirement == nullptr || requirement->empty ()) {
        // `[{}]` - OpenAPI's spelling for "security is optional here". Vayu
        // has no optional mode; sending none is the closer of the two guesses.
        return std::make_optional (json{ { "mode", "none" } });
    }
    if (requirement->size () > 1) {
        // An AND of multiple schemes at once - Vayu has no combined mode.
        tally.add ("security_unmapped_and");
        return std::nullopt;
    }
    const std::string scheme_name = requirement->begin ().key ();
    if (scheme_name == collection_scheme.name) {
        return std::nullopt;
    }
    const json* named = prop (schemes, scheme_name);
    if (!truthy (named)) {
        tally.add ("security_unmapped_scheme");
        return std::nullopt;
    }
    json mapped = v3 ? scheme_to_auth_v3 (named) : scheme_to_auth_v2 (named);
    if (mapped.at ("mode") == "none") {
        // A declared scheme of a type `scheme_to_auth_*` has no mode for
        // (`mutualTLS`, `openIdConnect`, an `apiKey` outside header/query).
        tally.add (unmapped_security_kind (named));
        return std::nullopt;
    }
    return std::make_optional (std::move (mapped));
}

/// One draft table row as a request stores it.
json draft_row (const DraftField& field, bool with_description) {
    json row;
    row["key"]     = field.key;
    row["value"]   = field.value;
    row["enabled"] = field.enabled;
    if (with_description && !field.description.empty ()) {
        row["description"] = field.description;
    }
    return row;
}

json draft_body (const DraftBody& body) {
    if (body.mode == "none") {
        return json{ { "mode", "none" } };
    }
    if (body.mode == "form-data" || body.mode == "x-www-form-urlencoded") {
        json fields = json::array ();
        for (const DraftField& field : body.fields) {
            json row = draft_row (field, /*with_description=*/false);
            // A document names the upload, never the file, so the part imports
            // with no path and the user attaches one (#425).
            fields.push_back (
            field.file ? imported_file_part (std::move (row), "", nullptr) : row);
        }
        return json{ { "mode", body.mode }, { "fields", std::move (fields) } };
    }
    return json{ { "mode", body.mode }, { "content", body.content } };
}

/**
 * `x-vayu-mock` (issue #1649) onto @p request - which saved example a mock
 * server answers with. `"random"` needs no target; `"fixed"` names the
 * `examples` map key the exporter wrote it under (`spec_example_key`, issue
 * #1457, is exactly that key), resolved here to a position in @p examples
 * rather than an id - no id exists yet for a row this import has not
 * created. A key the document no longer carries an example for degrades the
 * way `elements_invalid` does: counted, and the request keeps
 * `pick_example`'s own "first" default rather than naming a target that is
 * not there.
 */
void apply_mock_extension (const std::optional<nlohmann::ordered_json>& mock,
const std::vector<DraftExample>& examples,
json& request,
ImportTally& tally) {
    if (!mock || !mock->is_object ()) {
        return;
    }
    const std::string mode = mock->value ("mode", "");
    if (mode == "random") {
        request["mockResponseMode"] = "random";
        return;
    }
    if (mode != "fixed") {
        return;
    }
    const std::string key = mock->value ("example", "");
    const auto found      = std::find_if (
    examples.begin (), examples.end (), [&key] (const DraftExample& example) {
        return example.spec_example_key && *example.spec_example_key == key;
    });
    if (found == examples.end ()) {
        tally.add ("mock_example_missing");
        return;
    }
    request["mockResponseMode"] = "fixed";
    request["mockExampleIndex"] =
    static_cast<size_t> (std::distance (examples.begin (), found));
}

json draft_request (const SpecRequestDraft& entry, ImportTally& tally) {
    const DraftRequest& draft = entry.draft;
    json params               = json::array ();
    for (const DraftField& field : draft.params) {
        params.push_back (draft_row (field, /*with_description=*/true));
    }
    json headers = json::array ();
    for (const DraftField& field : draft.headers) {
        // No description: the Headers table has no column for one.
        headers.push_back (draft_row (field, /*with_description=*/false));
    }
    json examples = json::array ();
    for (const DraftExample& example : draft.examples) {
        json rows = json::array ();
        if (example.documented) {
            rows.push_back ({ { "key", "Content-Type" },
            { "value", example.content_type }, { "enabled", true } });
        }
        json row = { { "name", example.name }, { "status", example.status },
            { "headers", std::move (rows) }, { "body", example.body },
            { "contentType", example.content_type } };
        // Engine-side provenance only (issue #1457): the renderer never reads
        // it, but `POST /import/apply` must carry it through to the stored
        // row so the bound export can find its way back to this entry.
        if (example.spec_example_key) {
            row["specExampleKey"] = *example.spec_example_key;
        }
        examples.push_back (std::move (row));
    }

    json request;
    request["name"]        = draft.name;
    request["description"] = draft.description;
    request["method"]      = draft.method;
    request["url"]         = draft.url;
    request["params"]      = std::move (params);
    request["headers"]     = std::move (headers);
    request["body"]        = draft_body (draft.body);
    request["auth"]        = json{ { "mode", "inherit" } };
    // `x-vayu-elements` (issue #1518): a document a Vayu export wrote may
    // carry elements (scripts included) back. Validated here, against the
    // same registry a stored request's own write goes through, so a document
    // hand-edited into an invalid array degrades the same way any other
    // dropped import content does - counted, never silently applied - rather
    // than failing the whole document at parse time.
    if (entry.elements && entry.elements->is_array () && !entry.elements->empty ()) {
        if (Registry::instance ().validate (*entry.elements, ElementOwner::Request)) {
            tally.add ("elements_invalid");
        } else {
            request["elements"] = *entry.elements;
        }
    }
    apply_mock_extension (entry.mock, draft.examples, request, tally);
    if (!examples.empty ()) {
        request["examples"] = std::move (examples);
    }
    if (entry.identified) {
        json operation;
        if (!entry.operation.operation_id.empty ()) {
            operation["operationId"] = entry.operation.operation_id;
        }
        operation["method"]      = entry.operation.method;
        operation["path"]        = entry.operation.path;
        request["specOperation"] = std::move (operation);
    }
    return request;
}

/**
 * `OperationFolders`: where each operation's request goes - a folder named by
 * its first tag, a folder named by its path (issue #710), or the root.
 *
 * Only the first tag groups an operation, unchanged: one tagged `["a", "b"]`
 * lands in `a` alone, because a request duplicated into two folders is two
 * requests to edit.
 */
class OperationFolders {
    public:
    explicit OperationFolders (const json* declared_tags)
    : declared_tags_ (declared_tags) {
    }

    void place (json request, const std::string& name, bool from_tag) {
        if (name.empty ()) {
            root_.push_back (std::move (request));
            return;
        }
        (from_tag ? tagged_ : pathed_) = true;
        const auto found = std::find (order_.begin (), order_.end (), name);
        if (found == order_.end ()) {
            order_.push_back (name);
            json folder;
            folder["name"]        = name;
            folder["description"] = from_tag ? describe (name) : "";
            folder["variables"]   = json::object ();
            folder["auth"]        = json{ { "mode", "none" } };
            folder["children"]    = json::array ();
            folder["requests"]    = json::array ();
            folders_.emplace (name, std::move (folder));
        } else if (from_tag &&
        folders_.at (name).at ("description").get_ref<const std::string&> ().empty ()) {
            // A path segment can be spelled exactly like a tag, in which case
            // the folder already exists with no description. The tag's
            // description still describes what is in it.
            folders_.at (name)["description"] = describe (name);
        }
        folders_.at (name)["requests"].push_back (std::move (request));
    }

    /// The folders, in first-encounter order.
    [[nodiscard]] json children () const {
        json out = json::array ();
        for (const std::string& name : order_) {
            out.push_back (folders_.at (name));
        }
        return out;
    }

    [[nodiscard]] const json& root_requests () const {
        return root_;
    }

    [[nodiscard]] size_t count () const {
        return order_.size ();
    }

    /// Which rule produced the folders, so the preview can say so - a document
    /// that declares no operation tags gets a folder tree it never spelled out,
    /// and that must not be a surprise. Empty when there are none to explain.
    [[nodiscard]] std::string strategy () const {
        if (tagged_ && pathed_) {
            return "mixed";
        }
        if (tagged_) {
            return "tags";
        }
        return pathed_ ? "paths" : std::string ();
    }

    private:
    [[nodiscard]] std::string describe (const std::string& tag) const {
        if (declared_tags_ == nullptr || !declared_tags_->is_array ()) {
            return {};
        }
        for (const json& declared : *declared_tags_) {
            const json* name = prop (&declared, "name");
            if (name != nullptr && *name == tag) {
                const std::string* description = as_str (prop (&declared, "description"));
                return description == nullptr ? std::string () : *description;
            }
        }
        return {};
    }

    const json* declared_tags_;
    std::vector<std::string> order_;
    std::map<std::string, json> folders_;
    json root_   = json::array ();
    bool tagged_ = false;
    bool pathed_ = false;
};

/// The collection's own auth, built from its primary scheme - and tallied
/// when that scheme is one Vayu cannot map, the same way an operation-level
/// override tallies the identical scheme (`operation_auth_override`). Not
/// tallied when `scheme.node` is null: that is "the document declares no
/// security" (`scheme_to_auth_v3 (nullptr)` also answers `none`), which has
/// nothing to report - only a *declared* scheme Vayu could not map is a loss.
json collection_primary_auth (const PrimaryScheme& scheme, bool v3, ImportTally& tally) {
    json auth = v3 ? scheme_to_auth_v3 (scheme.node) : scheme_to_auth_v2 (scheme.node);
    if (scheme.node != nullptr && auth.at ("mode") == "none") {
        tally.add (unmapped_security_kind (scheme.node));
    }
    return auth;
}

// ---------------------------------------------------------------------------
// `x-vayu-request` / `x-vayu-collection` (core/vayu_extensions.hpp)
// ---------------------------------------------------------------------------

namespace ext = vayu::core::vayu_ext;

/// A form body's file parts as an import writes one: named, no file attached
/// yet - the export never carries the path it was read from.
json with_unattached_files (json body) {
    const auto fields = body.find ("fields");
    if (fields == body.end () || !fields->is_array ()) {
        return body;
    }
    for (json& field : *fields) {
        if (field.value ("type", "") == "file") {
            // `imported_file_part` spells "no file" as `src: ""`; a part the
            // export wrote had no `src` at all, which says the same thing.
            const bool had_src = field.contains ("src");
            field              = imported_file_part (field, "", nullptr);
            if (!had_src) {
                field.erase ("src");
            }
        }
    }
    return body;
}

/**
 * One piece of an `x-vayu-request` object applied to @p request when it
 * passes @p check, counted as `vayu_extension_invalid` when it does not - the
 * standard reading stays in place either way.
 */
template <typename Check, typename Apply>
void apply_piece (const json& object, const char* key, ImportTally& tally, Check check, Apply apply) {
    const auto found = object.find (key);
    if (found == object.end ()) {
        return;
    }
    if (std::optional<json> checked = check (*found)) {
        apply (std::move (*checked));
    } else {
        tally.add (ext::INVALID_KIND);
    }
}

/// A non-empty string, for `name` / `url` / `description`.
std::optional<json> string_piece (const json& value) {
    if (!value.is_string () || value.get_ref<const std::string&> ().empty ()) {
        return std::nullopt;
    }
    return std::make_optional (value);
}

/// A method `POST /import/apply` accepts - upper case, as an export writes it.
std::optional<json> method_piece (const json& value) {
    if (!value.is_string () || !vayu::parse_method (value.get<std::string> ())) {
        return std::nullopt;
    }
    return std::make_optional (value);
}

/**
 * Which saved example a mock answers with, applied only once the examples it
 * indexes are settled: `fixed` needs a `mockExample` that names one of them.
 */
void apply_vayu_mock (const json& object, json& request, ImportTally& tally) {
    const auto mode = object.find ("mockResponseMode");
    if (mode == object.end ()) {
        return;
    }
    request.erase ("mockResponseMode");
    request.erase ("mockExampleIndex");
    if (*mode == "random") {
        request["mockResponseMode"] = "random";
        return;
    }
    if (*mode != "fixed") {
        if (*mode != "first") {
            tally.add (ext::INVALID_KIND);
        }
        return;
    }
    const auto index     = object.find ("mockExample");
    const json* examples = prop (&request, "examples");
    if (index == object.end () || !index->is_number_unsigned () ||
    examples == nullptr || index->get<size_t> () >= examples->size ()) {
        tally.add ("mock_example_missing");
        return;
    }
    request["mockResponseMode"] = "fixed";
    request["mockExampleIndex"] = *index;
}

/**
 * Everything an `x-vayu-request` object states, applied over the request the
 * standard members produced - each piece checked first (`vayu_extensions.hpp`).
 * Examples replace the documented responses wholesale: the stored rows are
 * what the UI showed, and a response the document documents besides them was
 * written *from* them.
 */
void apply_vayu_request (const json& object, json& request, ImportTally& tally) {
    const auto set = [&request] (const char* key) {
        return [&request, key] (json value) { request[key] = std::move (value); };
    };
    apply_piece (object, "name", tally, string_piece, set ("name"));
    apply_piece (object, "description", tally, string_piece, set ("description"));
    apply_piece (object, "method", tally, method_piece, set ("method"));
    apply_piece (object, "url", tally, string_piece, set ("url"));
    apply_piece (object, "params", tally, ext::param_rows_of, set ("params"));
    apply_piece (object, "headers", tally, ext::rows_of, set ("headers"));
    apply_piece (object, "body", tally, ext::body_of, [&request] (json body) {
        request["body"] = with_unattached_files (std::move (body));
    });
    apply_piece (
    object, "auth", tally,
    [] (const json& value) { return ext::auth_of (value, /*collection=*/false); },
    set ("auth"));
    apply_piece (object, "settings", tally, ext::settings_of, [&request] (json settings) {
        for (auto& [key, value] : settings.items ()) {
            request[key] = value;
        }
    });
    apply_piece (object, "examples", tally, ext::examples_of, [&request] (json examples) {
        request.erase ("mockResponseMode");
        request.erase ("mockExampleIndex");
        if (examples.empty ()) {
            request.erase ("examples");
        } else {
            request["examples"] = std::move (examples);
        }
    });
    apply_vayu_mock (object, request, tally);
}

/// The folder path an `x-vayu-request` files its request under, `[]` for the
/// root. A path that fails its check files it on the root, counted.
json vayu_folder_of (const std::optional<json>& object, ImportTally& tally) {
    json folder = json::array ();
    if (!object) {
        return folder;
    }
    apply_piece (*object, "folder", tally, ext::folder_path_of,
    [&folder] (json path) { folder = std::move (path); });
    return folder;
}

/// The request's position among its folder's, from `x-vayu-request.order`.
int vayu_order_of (const std::optional<json>& object) {
    if (!object) {
        return 0;
    }
    const auto order = object->find ("order");
    return order != object->end () && order->is_number_integer () ? order->get<int> () : 0;
}

/**
 * A request `x-vayu-collection.requests` carries whole - one no operation could
 * hold - or nothing when it states no method or URL to build one from.
 */
std::optional<json> standalone_request (const json& object, ImportTally& tally) {
    if (!object.is_object () || !method_piece (object.value ("method", json ())) ||
    !string_piece (object.value ("url", json ()))) {
        tally.add (ext::INVALID_KIND);
        return std::nullopt;
    }
    json request{ { "name", object.value ("name", json ("")) }, { "description", "" },
        { "method", "GET" }, { "url", "" }, { "params", json::array () },
        { "headers", json::array () }, { "body", json{ { "mode", "none" } } },
        { "auth", json{ { "mode", "inherit" } } } };
    if (!request.at ("name").is_string () ||
    request.at ("name").get_ref<const std::string&> ().empty ()) {
        request["name"] = object.at ("url");
    }
    apply_vayu_request (object, request, tally);
    if (const json* elements = prop (&object, "elements");
    elements != nullptr && elements->is_array () && !elements->empty ()) {
        if (Registry::instance ().validate (*elements, ElementOwner::Request)) {
            tally.add ("elements_invalid");
        } else {
            request["elements"] = *elements;
        }
    }
    return std::make_optional (std::move (request));
}

/**
 * The folder tree `x-vayu-collection.folders` states, with every request filed
 * where its `x-vayu-request.folder` says - the collection's own nesting, where
 * the standard members can only say one flat tag per operation. A request
 * naming a folder the list lacks gets that folder made for it.
 */
class VayuFolderTree {
    public:
    VayuFolderTree (const json& folders, ImportTally& tally) : tally_ (tally) {
        if (!folders.is_array ()) {
            tally_.add (ext::INVALID_KIND);
            return;
        }
        for (const json& folder : folders) {
            const std::optional<json> path = folder.is_object () ?
            ext::folder_path_of (folder.value ("path", json ())) :
            std::nullopt;
            if (!path) {
                tally_.add (ext::INVALID_KIND);
                continue;
            }
            json& node = ensure (*path);
            read_folder (folder, node);
        }
    }

    /// Files @p request under @p path (`[]` is the root), at @p order.
    void place (json request, const json& path, int order) {
        auto& list = path.empty () ? root_requests_ : requests_[key_of (path)];
        if (!path.empty ()) {
            ensure (path);
        }
        list.emplace_back (order, std::move (request));
    }

    /// The root's own requests, in their stored order.
    [[nodiscard]] json root_requests () {
        return sorted (root_requests_);
    }

    /// The folders directly under the root, each with its whole subtree.
    [[nodiscard]] json children () {
        // Deepest first, so a folder's children are complete before it is
        // moved into its parent.
        std::vector<std::string> by_depth = order_;
        std::stable_sort (by_depth.begin (), by_depth.end (),
        [this] (const std::string& a, const std::string& b) {
            return depth_.at (a) > depth_.at (b);
        });
        for (const std::string& key : by_depth) {
            json& node               = nodes_.at (key);
            node["requests"]         = sorted (requests_[key]);
            const std::string parent = parent_.at (key);
            if (!parent.empty ()) {
                child_lists_[parent].push_back (key);
            }
        }
        json roots = json::array ();
        for (const std::string& key : order_) {
            json& node = nodes_.at (key);
            for (const std::string& child : child_lists_[key]) {
                node["children"].push_back (std::move (nodes_.at (child)));
            }
        }
        for (const std::string& key : order_) {
            if (parent_.at (key).empty ()) {
                roots.push_back (std::move (nodes_.at (key)));
            }
        }
        return roots;
    }

    [[nodiscard]] size_t count () const {
        return order_.size ();
    }

    private:
    static std::string key_of (const json& path) {
        std::string key;
        for (const json& segment : path) {
            key += segment.get<std::string> ();
            key += '\0';
        }
        return key;
    }

    /// The node for @p path, made - parents first - when it does not exist yet.
    json& ensure (const json& path) {
        const std::string key = key_of (path);
        if (const auto found = nodes_.find (key); found != nodes_.end ()) {
            return found->second;
        }
        std::string parent;
        if (path.size () > 1) {
            json parent_path = path;
            parent_path.erase (parent_path.size () - 1);
            ensure (parent_path);
            parent = key_of (parent_path);
        }
        json node;
        node["name"]        = path.back ();
        node["description"] = "";
        node["variables"]   = json::object ();
        node["auth"]        = json{ { "mode", "none" } };
        node["children"]    = json::array ();
        node["requests"]    = json::array ();
        order_.push_back (key);
        parent_[key] = parent;
        depth_[key]  = path.size ();
        return nodes_.emplace (key, std::move (node)).first->second;
    }

    void read_folder (const json& folder, json& node) {
        apply_piece (folder, "description", tally_, string_piece,
        [&node] (json value) { node["description"] = std::move (value); });
        apply_piece (folder, "variables", tally_, ext::variables_of,
        [&node] (json value) { node["variables"] = std::move (value); });
        apply_piece (
        folder, "auth", tally_,
        [] (
        const json& value) { return ext::auth_of (value, /*collection=*/true); },
        [&node] (json value) { node["auth"] = std::move (value); });
        if (const json* elements = prop (&folder, "elements");
        elements != nullptr && elements->is_array () && !elements->empty ()) {
            if (Registry::instance ().validate (*elements, ElementOwner::Collection)) {
                tally_.add ("elements_invalid");
            } else {
                node["elements"] = *elements;
            }
        }
    }

    static json sorted (std::vector<std::pair<int, json>>& list) {
        std::stable_sort (list.begin (), list.end (),
        [] (const auto& a, const auto& b) { return a.first < b.first; });
        json out = json::array ();
        for (auto& [order, request] : list) {
            out.push_back (std::move (request));
        }
        return out;
    }

    ImportTally& tally_;
    std::vector<std::string> order_;
    std::map<std::string, json> nodes_;
    std::map<std::string, std::string> parent_;
    std::map<std::string, size_t> depth_;
    std::map<std::string, std::vector<std::string>> child_lists_;
    std::map<std::string, std::vector<std::pair<int, json>>> requests_;
    std::vector<std::pair<int, json>> root_requests_;
};

/**
 * The collection-level half of `x-vayu-collection` applied to the imported
 * root: its variables (which already hold `baseUrl`), auth and data contract.
 */
void apply_vayu_collection (const json& object, json& root, ImportTally& tally) {
    apply_piece (object, "variables", tally, ext::variables_of,
    [&root] (json value) { root["variables"] = std::move (value); });
    apply_piece (
    object, "auth", tally,
    [] (const json& value) { return ext::auth_of (value, /*collection=*/true); },
    [&root] (json value) { root["auth"] = std::move (value); });
    apply_piece (object, "dataSchema", tally, ext::data_schema_of,
    [&root] (json value) { root["dataSchema"] = std::move (value); });
}

/**
 * The collection's own `x-vayu-elements` (issue #1518), which a skeleton
 * export writes at the document root - validated the way an operation's are
 * in `draft_request`, against the collection owner's rules, and counted as
 * `elements_invalid` rather than applied when it fails.
 */
std::optional<json> collection_elements (const json& document, ImportTally& tally) {
    const json* elements = prop (&document, "x-vayu-elements");
    if (elements == nullptr || !elements->is_array () || elements->empty ()) {
        return std::nullopt;
    }
    if (Registry::instance ().validate (*elements, ElementOwner::Collection)) {
        tally.add ("elements_invalid");
        return std::nullopt;
    }
    return std::make_optional (*elements);
}

/// Where a document's requests are based, and the schemes its auth is built
/// from - the half of `parse_openapi` the two dialects state differently.
struct DocumentBase {
    std::string base_url;
    const json* schemes = nullptr;
};

DocumentBase
document_base (const json& document, bool v3, const ImportSource& source, ImportTally& tally) {
    DocumentBase base;
    if (v3) {
        const json* servers = prop (&document, "servers");
        if (servers != nullptr && servers->is_array () && servers->size () > 1) {
            // Only `servers[0]` becomes `{{baseUrl}}`; the rest name no
            // environment an import can create (issue #1444).
            tally.add ("servers_dropped", static_cast<int> (servers->size () - 1));
        }
        base.base_url =
        resolve_server_url (array_at (servers, 0), source.source_url, tally);
        base.schemes = as_record (
        prop (as_record (prop (&document, "components")), "securitySchemes"));
        return base;
    }
    // 2.0 states its base as three fields rather than a server URL. A
    // `basePath` of exactly `/` adds nothing, and a document with no `host`
    // has no base at all - `{{baseUrl}}` is then simply not a variable, and
    // every request's URL starts with the token unresolved, which is what
    // the renderer did too.
    const std::string* wire_scheme = as_str (array_at (prop (&document, "schemes"), 0));
    const std::string* declared_base = as_str (prop (&document, "basePath"));
    const std::string base_path =
    declared_base != nullptr && *declared_base != "/" ? *declared_base : std::string ();
    if (const std::string* host = as_str (prop (&document, "host"));
    host != nullptr && !host->empty ()) {
        base.base_url =
        (wire_scheme == nullptr ? "https" : *wire_scheme) + "://" + *host + base_path;
    }
    base.schemes = as_record (prop (&document, "securityDefinitions"));
    return base;
}

/**
 * Where an OpenAPI import files its requests. A document a Vayu export wrote
 * states its own tree (`x-vayu-collection`); any other is grouped by tag, then
 * by path (issue #710).
 */
class ImportTree {
    public:
    ImportTree (const json& document, ImportTally& tally)
    : vayu_collection_ (as_record (prop (&document, ext::COLLECTION_KEY))),
      folders_ (prop (&document, "tags")), tally_ (tally) {
        if (vayu_collection_ != nullptr) {
            vayu_tree_.emplace (vayu_collection_->value ("folders", json::array ()), tally);
        }
    }

    void place (json request, const SpecRequestDraft& entry) {
        if (vayu_tree_) {
            vayu_tree_->place (std::move (request),
            vayu_folder_of (entry.vayu_request, tally_),
            vayu_order_of (entry.vayu_request));
        } else {
            folders_.place (std::move (request), entry.folder, entry.folder_from_tag);
        }
    }

    /// The requests `x-vayu-collection` carries whole - the ones no
    /// operation could hold (no path, or a method and path another request
    /// claimed first).
    void place_carried_requests () {
        const json* extra =
        vayu_collection_ == nullptr ? nullptr : prop (vayu_collection_, "requests");
        if (!vayu_tree_ || extra == nullptr) {
            return;
        }
        if (!extra->is_array ()) {
            tally_.add (ext::INVALID_KIND);
            return;
        }
        for (const json& object : *extra) {
            if (std::optional<json> request = standalone_request (object, tally_)) {
                vayu_tree_->place (std::move (*request),
                vayu_folder_of (std::make_optional (object), tally_),
                vayu_order_of (std::make_optional (object)));
            }
        }
    }

    /// The root's folders and own requests, and - for a Vayu-written
    /// document - its variables, auth and data contract.
    void fill_root (json& root) {
        if (vayu_tree_) {
            apply_vayu_collection (*vayu_collection_, root, tally_);
            root["children"] = vayu_tree_->children ();
            root["requests"] = vayu_tree_->root_requests ();
            return;
        }
        root["children"] = folders_.children ();
        root["requests"] = folders_.root_requests ();
    }

    [[nodiscard]] int count () const {
        return static_cast<int> (vayu_tree_ ? vayu_tree_->count () : folders_.count ());
    }

    /// Which rule produced the folders - empty for a tree the document
    /// states itself, which needs no explaining.
    [[nodiscard]] std::string strategy () const {
        return vayu_tree_ ? std::string () : folders_.strategy ();
    }

    private:
    const json* vayu_collection_;
    OperationFolders folders_;
    std::optional<VayuFolderTree> vayu_tree_;
    ImportTally& tally_;
};

json parse_openapi (const json& document,
const std::string& raw,
const ImportSource& source,
walk::Dialect dialect) {
    ImportTally tally;
    const bool v3           = dialect == walk::Dialect::V3;
    const DocumentBase base = document_base (document, v3, source, tally);
    const PrimaryScheme scheme =
    primary_scheme (base.schemes, prop (&document, "security"));

    ImportTree tree (document, tally);
    const std::vector<SpecRequestDraft> drafts = import_drafts_of (document, tally);
    for (const SpecRequestDraft& entry : drafts) {
        tally.set_subject (entry.draft.name);
        json request = draft_request (entry, tally);
        if (std::optional<json> auth = operation_auth_override (
            entry.security.has_value () ? &*entry.security : nullptr,
            base.schemes, scheme, v3, tally);
        auth.has_value ()) {
            // Overrides `draft_request`'s default `inherit` - the request's
            // own `security` named something the collection's does not.
            request["auth"] = std::move (*auth);
        }
        if (entry.vayu_request) {
            apply_vayu_request (*entry.vayu_request, request, tally);
        }
        tree.place (std::move (request), entry);
    }
    tally.set_subject ({});
    tree.place_carried_requests ();

    const json* info         = as_record (prop (&document, "info"));
    const std::string* title = as_str (prop (info, "title"));
    const std::string* about = as_str (prop (info, "description"));

    json root;
    root["name"]        = title == nullptr ? "Imported API" : *title;
    root["description"] = about == nullptr ? "" : *about;
    root["variables"]   = base.base_url.empty () ?
      json::object () :
      json{ { "baseUrl", { { "value", base.base_url }, { "enabled", true } } } };
    root["auth"]        = collection_primary_auth (scheme, v3, tally);
    if (std::optional<json> elements = collection_elements (document, tally)) {
        root["elements"] = std::move (*elements);
    }
    tree.fill_root (root);
    // The document itself, so the import can store it and bind this collection
    // to it in the same atomic call (#637). `raw` and not a re-serialization:
    // the engine hashes the bytes it stores, and a sync compares against that
    // hash. Neither index is beside it - the engine derives both from the very
    // bytes it stores (#853, #860).
    root["spec"] = json{ { "content", raw } };

    json collections = json::array ();
    collections.push_back (std::move (root));

    json meta;
    meta["format"]       = walk::dialect_format_name (document, dialect);
    meta["requestCount"] = static_cast<int> (drafts.size ());
    meta["folderCount"]  = tree.count ();
    if (const std::string strategy = tree.strategy (); !strategy.empty ()) {
        meta["folderStrategy"] = strategy;
    }
    // A document has no environment or globals concept.
    meta["environmentCount"]    = 0;
    meta["globalCount"]         = 0;
    meta["exampleCount"]        = count_examples (collections);
    meta["skipped"]             = tally.items ();
    meta["nonExecutableAuth"]   = 0;
    meta["unattachedFileParts"] = unattached_file_parts (collections);

    return json{ { "collections", std::move (collections) },
        { "environments", json::array () }, { "globals", json::object () },
        { "meta", std::move (meta) } };
}

// ---------------------------------------------------------------------------
// `factory.ts`
// ---------------------------------------------------------------------------

bool is_postman_v21 (const json& parsed) {
    const std::string* schema =
    as_str (prop (as_record (prop (&parsed, "info")), "schema"));
    return schema != nullptr && schema->find ("v2.1.0") != std::string::npos;
}

bool is_postman_v20 (const json& parsed) {
    const json* info   = prop (&parsed, "info");
    const json* schema = prop (info, "schema");
    if (schema != nullptr && schema->is_string () &&
    schema->get_ref<const std::string&> ().find ("v2.0.0") != std::string::npos) {
        return true;
    }
    // `info` and `item[]` present with no `schema` at all: treat as v2.0.
    const json* items = prop (&parsed, "item");
    return truthy (info) && items != nullptr && items->is_array () &&
    (schema == nullptr || schema->is_null ());
}

/// A Postman variable-scope export, and which of the two scopes it is.
std::optional<bool> postman_variable_scope (const json& parsed) {
    const json* scope  = prop (&parsed, "_postman_variable_scope");
    const json* values = prop (&parsed, "values");
    if (scope == nullptr || values == nullptr || !values->is_array ()) {
        return std::nullopt;
    }
    if (*scope == "globals") {
        return true;
    }
    return *scope == "environment" ? std::optional<bool> (false) : std::nullopt;
}

bool is_insomnia_v4 (const json& parsed) {
    const json* type   = prop (&parsed, "_type");
    const json* format = prop (&parsed, "__export_format");
    return type != nullptr && *type == "export" && format != nullptr &&
    format->is_number () && format->get<double> () == 4.0;
}

/// One params row as `js::query_string` joins it.
struct JoinedRow {
    std::string key;
    std::string value;
    bool enabled   = true;
    bool valueless = false;
};

/**
 * `joinParamsIntoUrls(result)`: restore the app's url/params invariant on every
 * request a parser produced.
 *
 * A request built in the app carries its enabled query **inside `url`**, and
 * every execution path sends `url` verbatim while `params[]` stays editor state
 * (issue #590). The parsers write the other shape - Postman splits the query
 * out of the URL, Insomnia carries a `parameters[]` beside it - so an imported
 * request went on the wire with its query missing, silently, until the user
 * happened to edit the table once.
 *
 * The OpenAPI path does **not** come through here: `SpecRequestDraft` already
 * promises a URL with its query joined in, because that is the URL the sync
 * diff compares a stored request against. Running this over one would append
 * the same rows twice.
 *
 * @p encoding is the source format's rule (issue #1771): `Postman` for a
 * Postman collection, `UriComponent` for Insomnia and JMeter.
 */
void join_params_into_urls (json& collections, QueryEncoding encoding) {
    for (json& collection : collections) {
        for (json& request : collection.at ("requests")) {
            std::vector<JoinedRow> rows;
            for (const json& row : request.at ("params")) {
                // A path row is sent in its `:name` segment, never the query.
                if (vayu::core::is_path_variable_row (row)) {
                    continue;
                }
                const json* valueless = prop (&row, "valueless");
                rows.push_back ({ row.at ("key").get<std::string> (),
                row.at ("value").get<std::string> (), row.at ("enabled").get<bool> (),
                valueless != nullptr && valueless->is_boolean () &&
                valueless->get<bool> () });
            }
            // A request whose item says `disableUrlEncoding` joins its rows as
            // written (issue #1765), as the app's Params table does for it.
            const json* raw = prop (&request, "disableUrlEncoding");
            const bool as_typed =
            raw != nullptr && raw->is_boolean () && raw->get<bool> ();
            request["url"] = append_params (request.at ("url").get<std::string> (),
            rows, as_typed ? QueryEncoding::AsTyped : encoding);
        }
        join_params_into_urls (collection.at ("children"), encoding);
    }
}

// ---------------------------------------------------------------------------
// `assign-ids.ts` + `orchestrator.ts` - the tree as the apply's payload
// ---------------------------------------------------------------------------

/// Counters for the four temp-id namespaces, which share one map on the engine
/// side - a `tempId` reused between two sections would make `idMap` ambiguous.
struct TempIds {
    int collection  = 0;
    int request     = 0;
    int environment = 0;
    int spec        = 0;
};

/// Copy @p key from @p from to @p to when the source stated it. "Absent" is the
/// state the engine's field appliers read, so a draft that says nothing must not
/// send `null`, which reads as "clear it".
void carry (const json& from, json& to, const char* key) {
    if (const json* value = prop (&from, key)) {
        to[key] = *value;
    }
}

/**
 * One request draft as the fields a write carries
 * (`requestFieldsFromDraft`), plus where it lands.
 */
json apply_request (const json& draft,
const std::string& temp_id,
const std::string& collection_temp_id,
int order) {
    json item;
    item["tempId"]           = temp_id;
    item["collectionTempId"] = collection_temp_id;
    item["name"]             = draft.at ("name");
    item["description"]      = draft.at ("description");
    item["method"]           = draft.at ("method");
    item["url"]              = draft.at ("url");
    item["params"]           = draft.at ("params");
    item["headers"]          = draft.at ("headers");
    item["body"]             = draft.at ("body");
    item["bodyType"] = draft.at ("body").at ("mode"); // the engine never derives this
    item["auth"] = draft.at ("auth");
    for (const char* optional : { "followRedirects", "maxRedirects", "verifySSL",
         "httpVersion", "stream", "disableCookies", "disabledSystemHeaders",
         "disableUrlEncoding", "postmanProtocolBehavior", "examples",
         "specOperation", "elements", "mockResponseMode", "mockExampleIndex" }) {
        carry (draft, item, optional);
    }
    item["order"] = order;
    return item;
}

/**
 * Depth-first, parents before their requests before their children - the tree
 * order the preview shows.
 *
 * A root states no `order`: it is joining a list that already has occupants, and
 * the engine's create path appends after the stored roots. Sending the payload
 * index instead collided head-on with the existing roots' 0, 1, 2..., so an
 * import into a non-empty workspace interleaved itself through the user's tree
 * by tie lottery. Everything below a root keeps its explicit index - those
 * parents are new in this payload, so there is nothing to collide with.
 */
void flatten (const json& draft,
const std::string* parent_temp_id,
const int* order,
TempIds& ids,
json& collections,
json& requests,
json& specs) {
    const std::string temp_id = "c" + std::to_string (++ids.collection);

    // The spec document, when this collection was parsed from one, as its own
    // payload section - it is a resource several collections may bind, not a
    // field of this one, so it gets a temp id the binding references (#637).
    std::string spec_temp_id;
    if (const json* spec = as_record (prop (&draft, "spec"))) {
        spec_temp_id = "s" + std::to_string (++ids.spec);
        json item;
        item["tempId"]  = spec_temp_id;
        item["content"] = spec->at ("content");
        carry (*spec, item, "sourceUrl");
        // Neither index is sent: the engine reads the document as it stores it
        // and derives both from those very bytes (#853, #860).
        specs.push_back (std::move (item));
    }

    json collection;
    collection["tempId"] = temp_id;
    collection["parentTempId"] =
    parent_temp_id == nullptr ? json (nullptr) : json (*parent_temp_id);
    collection["name"]        = draft.at ("name");
    collection["description"] = draft.at ("description");
    if (order != nullptr) {
        collection["order"] = *order;
    }
    collection["variables"] = draft.at ("variables");
    collection["auth"]      = draft.at ("auth");
    carry (draft, collection, "elements");
    carry (draft, collection, "dataSchema");
    if (!spec_temp_id.empty ()) {
        collection["openapi"] = json{ { "specTempId", spec_temp_id } };
    }
    collections.push_back (std::move (collection));

    const json& own = draft.at ("requests");
    for (size_t at = 0; at < own.size (); ++at) {
        requests.push_back (apply_request (own[at],
        "r" + std::to_string (++ids.request), temp_id, static_cast<int> (at)));
    }
    const json& children = draft.at ("children");
    for (size_t at = 0; at < children.size (); ++at) {
        const int child_order = static_cast<int> (at);
        flatten (children[at], &temp_id, &child_order, ids, collections, requests, specs);
    }
}

} // namespace

nlohmann::ordered_json postman_auth_mapping (const nlohmann::ordered_json& auth) {
    int unsupported = 0;
    int dropped     = 0;
    return map_postman_auth (&auth, unsupported, dropped);
}

std::vector<std::string> postman_disabled_system_headers (
const nlohmann::ordered_json& headers) {
    std::vector<std::string> names;
    if (!headers.is_object ()) {
        return names;
    }
    for (auto header = headers.begin (); header != headers.end (); ++header) {
        if (!js::truthy (&header.value ()) ||
        vayu::http::invalid_header_token (header.key ()).has_value ()) {
            continue;
        }
        std::string name = vayu::utils::ascii_lower (header.key ());
        if (std::ranges::find (names, name) == names.end ()) {
            names.push_back (std::move (name));
        }
    }
    return names;
}

bool postman_source_stands (const nlohmann::json& auth) {
    if (!auth.is_object ()) {
        return false;
    }
    const auto found = auth.find ("postman");
    if (found == auth.end () || !found->is_object ()) {
        return false;
    }
    const auto type = found->find ("type");
    if (type == found->end () || !type->is_string () ||
    type->get_ref<const std::string&> ().empty ()) {
        return false;
    }
    nlohmann::json own = auth;
    own.erase ("postman");
    // Key order aside: both sides compare as sorted-key documents, the shape
    // the stored column and a route's parsed body already have.
    const nlohmann::json remapped = nlohmann::json::parse (
    postman_auth_mapping (nlohmann::ordered_json::parse (found->dump ())).dump ());
    return remapped == own;
}

std::string without_stale_postman_source (std::string stored) {
    if (stored.find ("\"postman\"") == std::string::npos) {
        return stored;
    }
    nlohmann::json auth =
    nlohmann::json::parse (stored, nullptr, /*allow_exceptions=*/false);
    if (!auth.is_object () || !auth.contains ("postman") || postman_source_stands (auth)) {
        return stored;
    }
    auth.erase ("postman");
    return auth.dump ();
}

ImportParse parse_import (const std::string& text,
const ImportOptions& options,
const ImportSource& source) {
    ImportParse parsed;

    // How the parse's query rows join into each request's `url`, or nothing
    // when the parse already wrote them. Only the OpenAPI path does -
    // `SpecRequestDraft` promises a joined URL, because that is what the sync
    // diff compares a stored request against - and running the join over one
    // would append the same rows twice. Stated rather than derived from the
    // format name, which would make a renamed dialect a silently doubled query.
    std::optional<QueryEncoding> join_encoding = QueryEncoding::UriComponent;

    // A `.jmx` test plan is XML, and would only fail both of `read_document`'s
    // readers (JSON then YAML) the same way genuinely unrecognised bytes do -
    // checked first, on the raw text, so a `.jmx` upload gets this parser
    // rather than "Unrecognised format".
    if (is_jmeter_document (text)) {
        ImportTally tally;
        try {
            parsed.result = parse_jmeter (text, options, tally);
        } catch (const MalformedJmeter& malformed) {
            parsed.error = malformed.what ();
            return parsed;
        }
        if (!source.file_name.empty ()) {
            parsed.result["meta"]["fileName"] = source.file_name;
        }
        join_params_into_urls (parsed.result.at ("collections"), QueryEncoding::UriComponent);
        return parsed;
    }

    // One read, through the engine's one reader: JSON first and YAML second,
    // which is the order `parse-raw.ts` read the same bytes in.
    const DocumentRead read = read_document (text);
    if (!read.ok ()) {
        parsed.error = "Could not read the document: " + read.error;
        return parsed;
    }
    const nlohmann::ordered_json& document = read.root;

    try {
        // Detection order is `factory.ts`'s `PARSERS`, most specific first, so
        // a document carrying two formats' keys is claimed by the same one on
        // both sides.
        if (is_postman_v21 (document)) {
            parsed.result = parse_postman (document, options, "Postman Collection v2.1");
            join_encoding = QueryEncoding::Postman;
        } else if (is_postman_v20 (document)) {
            parsed.result = parse_postman (document, options, "Postman Collection v2.0");
            join_encoding = QueryEncoding::Postman;
        } else if (const std::optional<bool> globals = postman_variable_scope (document)) {
            parsed.result = parse_postman_variables (document, options, *globals);
        } else if (is_insomnia_v4 (document)) {
            parsed.result = parse_insomnia (document, options);
        } else if (const walk::Dialect dialect = walk::spec_dialect (document);
        dialect != walk::Dialect::None) {
            parsed.result = parse_openapi (document, text, source, dialect);
            join_encoding.reset ();
        } else {
            parsed.error        = "Unrecognised format";
            parsed.unrecognised = true;
            return parsed;
        }
    } catch (const MalformedImport& malformed) {
        parsed.error = malformed.what ();
        return parsed;
    }

    if (join_encoding) {
        join_params_into_urls (parsed.result.at ("collections"), *join_encoding);
    }

    // The three facts the caller knows and no parser can read out of the bytes.
    if (!source.file_name.empty ()) {
        parsed.result["meta"]["fileName"] = source.file_name;
    }
    if (!source.source_url.empty ()) {
        // What a spec document records about its own origin. A format that
        // produced none has nowhere to put it, so this is a no-op for one.
        for (nlohmann::ordered_json& collection :
        parsed.result.at ("collections")) {
            if (collection.contains ("spec")) {
                collection["spec"]["sourceUrl"] = source.source_url;
            }
        }
    }
    if (source.unresolved_refs > 0) {
        parsed.result["meta"]["skipped"].push_back (
        { { "kind", "external_ref" }, { "count", source.unresolved_refs } });
    }
    return parsed;
}

nlohmann::ordered_json postman_header_rows (const nlohmann::ordered_json& rows) {
    return map_key_values (&rows);
}

nlohmann::ordered_json import_apply_payload (const nlohmann::ordered_json& result) {
    TempIds ids;
    nlohmann::ordered_json collections = nlohmann::ordered_json::array ();
    nlohmann::ordered_json requests    = nlohmann::ordered_json::array ();
    nlohmann::ordered_json specs       = nlohmann::ordered_json::array ();
    for (const nlohmann::ordered_json& root : result.at ("collections")) {
        flatten (root, nullptr, nullptr, ids, collections, requests, specs);
    }

    nlohmann::ordered_json environments = nlohmann::ordered_json::array ();
    for (const nlohmann::ordered_json& draft : result.at ("environments")) {
        nlohmann::ordered_json item;
        item["tempId"]      = "e" + std::to_string (++ids.environment);
        item["name"]        = draft.at ("name");
        item["description"] = draft.at ("description");
        item["variables"]   = draft.at ("variables");
        environments.push_back (std::move (item));
    }

    // Pass-through, no temp id: nothing else in the tree references a
    // certificate candidate by one, and a format that never sets this key
    // (every parser but Postman) gets the empty array `import_apply_response`
    // already treats as "nothing to apply" (issue #1656).
    nlohmann::ordered_json client_certificates =
    result.value ("clientCertificates", nlohmann::ordered_json::array ());

    return nlohmann::ordered_json{ { "collections", std::move (collections) },
        { "requests", std::move (requests) },
        { "environments", std::move (environments) }, { "specs", std::move (specs) },
        { "clientCertificates", std::move (client_certificates) } };
}

} // namespace vayu::core
