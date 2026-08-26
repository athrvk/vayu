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

#include "vayu/core/openapi_document.hpp"
#include "vayu/core/path_template.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using json = nlohmann::ordered_json;

// The JavaScript the renderer's parsers are written in - `prop`, truthiness,
// `JSON.stringify`, `encodeURIComponent`, `appendParamsToUrl`. Shared with the
// draft builder (`openapi_drafts.cpp`) rather than copied.
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

/// `mapKeyValues(rows)`: a Postman/Insomnia row array as table rows, disabled
/// rows and duplicates intact. A row with no truthy `key` names nothing.
json map_key_values (const json* rows) {
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
        out.push_back (std::move (entry));
    }
    return out;
}

/// `toVarRecord(vars)`: a variable array as Vayu's `{name: {value, enabled}}`.
/// `type: "secret"` is the one Postman per-variable kind Vayu stores - the rest
/// describe a value type it does not have, since every value is a string.
json to_var_record (const json* vars) {
    json out = json::object ();
    if (vars == nullptr || !vars->is_array ()) {
        return out;
    }
    for (const json& row : *vars) {
        const json* record = as_record (&row);
        if (record == nullptr || !truthy (prop (record, "key"))) {
            continue;
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
        if (const std::string* type = as_str (prop (record, "type"));
        type != nullptr && *type == "secret") {
            value["secret"] = true;
        }
        out[as_string (prop (record, "key"))] = std::move (value);
    }
    return out;
}

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
 */
json imported_file_part (json entry, const std::string& src, const std::string* content_type) {
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
 * declaring one, since it is not sent.
 */
json with_required_content_type (json headers, const json& body) {
    const std::string required =
    required_content_type (body.at ("mode").get<std::string> ());
    if (required.empty ()) {
        return headers;
    }
    for (const json& header : headers) {
        const std::string key = walk::lower (header.at ("key").get<std::string> ());
        const size_t begin        = key.find_first_not_of (" \t\n\r\f\v");
        const std::string trimmed = begin == std::string::npos ?
        std::string () :
        key.substr (begin, key.find_last_not_of (" \t\n\r\f\v") - begin + 1);
        if (trimmed == "content-type" && truthy (prop (&header, "enabled"))) {
            return headers;
        }
    }
    headers.push_back (
    { { "key", "Content-Type" }, { "value", required }, { "enabled", true } });
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
        { "clientId", "" }, { "clientSecret", "" }, { "scope", "" },
        { "credentialsPlacement", "basic_auth_header" }, { "tokenPlacement", "header" },
        { "headerPrefix", "Bearer" }, { "pkce", true }, { "autoFetchToken", true },
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
 * bearer token, which is immediately executable.
 */
json map_postman_oauth2 (const std::map<std::string, std::string>& detail) {
    // Truthiness on all four, so a key present and empty is as good as absent.
    const auto stated = [&detail] (const char* key) {
        const std::string* value = detail_of (detail, key);
        return value != nullptr && !value->empty ();
    };
    if (!stated ("grant_type") && !stated ("accessTokenUrl") &&
    !stated ("authUrl") && stated ("accessToken")) {
        return json{ { "mode", "bearer" }, { "token", detail_text (detail, "accessToken") } };
    }

    std::string grant_type = "client_credentials";
    bool pkce              = false;
    if (const std::string* declared = detail_of (detail, "grant_type")) {
        if (*declared == "authorization_code") {
            grant_type = "authorization_code";
        } else if (*declared == "authorization_code_with_pkce" || *declared == "implicit") {
            // Two spellings, one outcome: PKCE is what the first asks for, and
            // Vayu has no implicit grant to offer the second - auth code with
            // PKCE is the nearest thing it can actually run.
            grant_type = "authorization_code";
            pkce       = true;
        } else if (*declared == "password_credentials") {
            grant_type = "password";
        } else if (*declared == "client_credentials") {
            grant_type = "client_credentials";
        }
    }
    if (stated ("challengeAlgorithm")) {
        pkce = true;
    }

    json config                = default_oauth2_config ();
    config["grantType"]        = grant_type;
    config["pkce"]             = pkce;
    config["authorizationUrl"] = detail_text (detail, "authUrl");
    config["accessTokenUrl"]   = detail_text (detail, "accessTokenUrl");
    config["refreshTokenUrl"]  = detail_text (detail, "refreshTokenUrl");
    config["callbackUrl"]      = detail_text (detail, "redirect_uri");
    config["clientId"]         = detail_text (detail, "clientId");
    config["clientSecret"]     = detail_text (detail, "clientSecret");
    config["scope"]            = detail_text (detail, "scope");
    config["username"]         = detail_text (detail, "username");
    config["password"]         = detail_text (detail, "password");
    config["credentialsPlacement"] =
    detail_is (detail, "client_authentication", "body") ? "body" : "basic_auth_header";
    config["tokenPlacement"] =
    detail_is (detail, "addTokenTo", "queryParams") ? "query" : "header";
    config["headerPrefix"] =
    stated ("headerPrefix") ? detail_text (detail, "headerPrefix") : "Bearer";
    // Postman's "useBrowser" is authorize-via-system-browser; embedded is the
    // inverse of it.
    config["useEmbeddedBrowser"] = detail_is (detail, "useBrowser", "false");
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
        json config              = openapi_oauth2_base ();
        config["grantType"]      = "client_credentials";
        config["accessTokenUrl"] = nv (prop (flow, "tokenUrl"));
        config["scope"]          = scope_string (prop (flow, "scopes"));
        return oauth2_auth (std::move (config));
    }
    if (const json* flow = as_record (prop (flows, "authorizationCode"))) {
        json config                = openapi_oauth2_base ();
        config["grantType"]        = "authorization_code";
        config["pkce"]             = true;
        config["authorizationUrl"] = nv (prop (flow, "authorizationUrl"));
        config["accessTokenUrl"]   = nv (prop (flow, "tokenUrl"));
        config["scope"]            = scope_string (prop (flow, "scopes"));
        return oauth2_auth (std::move (config));
    }
    if (const json* flow = as_record (prop (flows, "password"))) {
        json config              = openapi_oauth2_base ();
        config["grantType"]      = "password";
        config["accessTokenUrl"] = nv (prop (flow, "tokenUrl"));
        config["scope"]          = scope_string (prop (flow, "scopes"));
        return oauth2_auth (std::move (config));
    }
    if (const json* flow = as_record (prop (flows, "implicit"))) {
        json config                = openapi_oauth2_base ();
        config["grantType"]        = "authorization_code";
        config["pkce"]             = true;
        config["authorizationUrl"] = nv (prop (flow, "authorizationUrl"));
        config["scope"]            = scope_string (prop (flow, "scopes"));
        return oauth2_auth (std::move (config));
    }
    return oauth2_auth (openapi_oauth2_base ());
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
        return oauth2_auth (openapi_oauth2_base ());
    }
    return oauth2_auth (std::move (config));
}

/// `mapPostmanAuth(auth)`: a Postman `auth` object (collection, folder or
/// request) as a Vayu auth.
json map_postman_auth (const json* auth) {
    const json* node = as_record (auth);
    if (node == nullptr || !truthy (prop (node, "type"))) {
        return json{ { "mode", "inherit" } };
    }
    const std::string* type = as_str (prop (node, "type"));
    if (type == nullptr) {
        // A `type` that is not a string names no scheme, so nothing can be sent.
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
        return map_postman_oauth2 (detail);
    }
    // AWS Signature is `awsv4` on the wire (the v2.1.0/v2.0.0 schema's enum) and
    // `aws` internally; the two names diverge, so matching on `"aws"` here is
    // what silently dropped every real SigV4 export.
    if (*type == "awsv4" || *type == "digest" || *type == "ntlm") {
        json config = json::object ();
        for (const auto& [key, value] : detail) {
            config[key] = value;
        }
        return json{ { "mode", *type == "awsv4" ? "aws" : *type },
            { "config", std::move (config) } };
    }
    if (*type == "inherit") {
        return json{ { "mode", "inherit" } };
    }
    return json{ { "mode", "none" } };
}

// ---------------------------------------------------------------------------
// `postman.ts`
// ---------------------------------------------------------------------------

/// The seven methods Vayu executes. Anything else - Postman lets a user type a
/// verb - imports as `GET`, which is the renderer's answer too.
std::string to_method (const json* declared) {
    static constexpr std::array<const char*, 7> METHODS = { "GET", "POST",
        "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS" };
    const std::string upper                             = walk::upper (
    declared == nullptr || declared->is_null () ? std::string ("GET") : as_string (declared));
    return std::any_of (METHODS.begin (), METHODS.end (),
           [&upper] (const char* method) { return upper == method; }) ?
    upper :
    std::string ("GET");
}

/// What a Postman parse accumulates across its recursive walk.
struct PostmanCounts {
    ImportOptions options;
    int requests          = 0;
    int folders           = 0;
    int non_executable    = 0;
    int skipped_file_body = 0;
    int skipped_malformed = 0;
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

/// `rawBody(content, language)`: Postman's raw body.
json raw_body (const std::string& content, const std::string* language) {
    if (language != nullptr) {
        // `xml` is what gets an imported SOAP request its `application/xml`:
        // `text` requires no Content-Type, so before this the envelope went out
        // as libcurl's `x-www-form-urlencoded`.
        for (const char* mode : { "json", "text", "xml" }) {
            if (*language == mode) {
                return json{ { "mode", mode }, { "content", content } };
            }
        }
    }
    // No explicit language: sniff JSON.
    const json parsed = json::parse (content, nullptr, false);
    return json{ { "mode", parsed.is_discarded () ? "text" : "json" },
        { "content", content } };
}

json pm_body (const json* body, PostmanCounts& counts) {
    const json* node = as_record (body);
    if (node == nullptr || !truthy (prop (node, "mode"))) {
        return json{ { "mode", "none" } };
    }
    const std::string* mode = as_str (prop (node, "mode"));
    const std::string named = mode == nullptr ? std::string () : *mode;
    if (named == "raw") {
        const std::string* text = as_str (prop (node, "raw"));
        return raw_body (text == nullptr ? std::string () : *text,
        as_str (prop (prop (prop (node, "options"), "raw"), "language")));
    }
    if (named == "urlencoded") {
        return json{ { "mode", "x-www-form-urlencoded" },
            { "fields", map_key_values (prop (node, "urlencoded")) } };
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

/// Whether @p text is valid UTF-8, which is the half of `decodeURIComponent`
/// that is not about escapes: a percent sequence decoding to a broken sequence
/// is a `URIError` there.
bool is_valid_utf8 (const std::string& text) {
    for (size_t at = 0; at < text.size ();) {
        const auto lead = static_cast<unsigned char> (text[at]);
        size_t extra    = 0;
        if (lead < 0x80U) {
            extra = 0;
        } else if ((lead & 0xE0U) == 0xC0U) {
            extra = 1;
        } else if ((lead & 0xF0U) == 0xE0U) {
            extra = 2;
        } else if ((lead & 0xF8U) == 0xF0U) {
            extra = 3;
        } else {
            return false;
        }
        if (at + extra >= text.size ()) {
            return false;
        }
        for (size_t step = 1; step <= extra; ++step) {
            if ((static_cast<unsigned char> (text[at + step]) & 0xC0U) != 0x80U) {
                return false;
            }
        }
        at += extra + 1;
    }
    return true;
}

/**
 * `safeDecode(text)`: `decodeURIComponent` that degrades instead of throwing.
 *
 * A `%` not followed by two hex digits (`?discount=50%`, a LIKE pattern) is a
 * `URIError`, and Postman does not percent-validate a typed URL - so one such
 * character used to abort the whole file with "URI malformed" and no pointer to
 * the offending request. The still-encoded text is imported instead:
 * unreadable is recoverable, absent is not.
 */
std::string safe_decode (const std::string& text) {
    std::string out;
    out.reserve (text.size ());
    for (size_t at = 0; at < text.size (); ++at) {
        if (text[at] != '%') {
            out += text[at];
            continue;
        }
        if (at + 2 >= text.size () ||
        std::isxdigit (static_cast<unsigned char> (text[at + 1])) == 0 ||
        std::isxdigit (static_cast<unsigned char> (text[at + 2])) == 0) {
            return text;
        }
        out += static_cast<char> (std::stoi (text.substr (at + 1, 2), nullptr, 16));
        at += 2;
    }
    return is_valid_utf8 (out) ? out : text;
}

/// `queryEntries(query)`: a `k=v&k2=v2` string as rows, decoded and normalized.
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
        out.push_back ({ { "key", safe_decode (key) },
        { "value", normalize_vars (safe_decode (value)) }, { "enabled", true } });
    }
    return out;
}

/// A Postman `url`, which is a string in v2.0 and either shape in v2.1.
std::pair<std::string, json> pm_url (const json* url) {
    if (url != nullptr && url->is_string ()) {
        const std::string text = url->get<std::string> ();
        const size_t question  = text.find ('?');
        if (question == std::string::npos) {
            return { normalize_vars (text), json::array () };
        }
        return { normalize_vars (text.substr (0, question)),
            query_entries (text.substr (question + 1)) };
    }
    const std::string* declared = as_str (prop (url, "raw"));
    const std::string raw = declared == nullptr ? std::string () : *declared;
    const size_t question = raw.find ('?');
    const std::string base = question == std::string::npos ? raw : raw.substr (0, question);
    json structured = map_key_values (prop (url, "query"));
    // `query[]` wins when it has anything - it carries disabled state and
    // descriptions that `raw` cannot. Falling back to `raw` matters for
    // hand-written or script-generated collections that populate only `raw`.
    json params = (!structured.empty () || question == std::string::npos) ?
    std::move (structured) :
    query_entries (raw.substr (question + 1));
    return { normalize_vars (base), std::move (params) };
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

/// The first event listening on @p listen, or nothing.
const json* pm_event (const std::vector<const json*>& events, const char* listen) {
    for (const json* event : events) {
        const json* declared = prop (event, "listen");
        if (declared != nullptr && *declared == listen) {
            return event;
        }
    }
    return nullptr;
}

/**
 * `pmRedirects(item)`: the item-level `protocolProfileBehavior`.
 *
 * Postman writes it exactly when the user overrides redirect handling, and the
 * engine's `followRedirects` defaults to **true** - so an omitted `false`
 * silently follows the 3xx the request exists to inspect. Only well-typed
 * values are read: a coerced `"false"` would read as the user's setting while
 * being the opposite of it.
 */
void pm_redirects (const json* item, json& request) {
    const json* behavior = as_record (prop (item, "protocolProfileBehavior"));
    if (behavior == nullptr) {
        return;
    }
    if (const json* follow = prop (behavior, "followRedirects");
    follow != nullptr && follow->is_boolean ()) {
        request["followRedirects"] = follow->get<bool> ();
    }
    if (const json* limit = prop (behavior, "maxRedirects"); limit != nullptr &&
    limit->is_number () && std::isfinite (limit->get<double> ())) {
        request["maxRedirects"] = *limit;
    }
}

/**
 * `pmExamples(item)`: Postman's saved responses (`item.response[]`).
 *
 * Read by nothing until the engine had a table to hold them, so importing a
 * collection whose whole value was its documented responses produced one with
 * none. A saved response with no `code` documents a 200, which is what Postman
 * shows for one.
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
            if (walk::lower (header.at ("key").get<std::string> ()) == "content-type") {
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

json pm_request (const json* item, PostmanCounts& counts) {
    const json* declared   = as_record (prop (item, "request"));
    const json empty       = json::object ();
    const json* rq         = declared == nullptr ? &empty : declared;
    auto [url, params]     = pm_url (prop (rq, "url"));
    json auth              = map_postman_auth (prop (rq, "auth"));
    const std::string mode = auth.at ("mode").get<std::string> ();
    if (mode == "digest" || mode == "aws" || mode == "ntlm") {
        counts.non_executable += 1;
    }
    counts.requests += 1;
    const std::vector<const json*> events = pm_events (item);
    json body                             = pm_body (prop (rq, "body"), counts);
    json examples                         = pm_examples (item, counts);

    const std::string* description = as_str (prop (rq, "description"));
    const std::string* nested = as_str (prop (prop (rq, "description"), "content"));
    const json* name = prop (item, "name");

    json request;
    request["name"] = name == nullptr || name->is_null () ? "Untitled" : as_string (name);
    request["description"] = pm_description_text (description, nested);
    request["method"]      = to_method (prop (rq, "method"));
    request["url"]         = url;
    request["params"]      = params;
    request["headers"] =
    with_required_content_type (map_key_values (prop (rq, "header")), body);
    request["body"] = std::move (body);
    request["auth"] = std::move (auth);
    request["preRequestScript"] =
    counts.options.import_scripts ? join_exec (pm_event (events, "prerequest")) : "";
    request["postRequestScript"] =
    counts.options.import_scripts ? join_exec (pm_event (events, "test")) : "";
    pm_redirects (item, request);
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
json collection_auth (const json* auth) {
    if (const json* type = prop (auth, "type"); type != nullptr && *type == "noauth") {
        return json{ { "mode", "noauth" } };
    }
    json mapped = map_postman_auth (auth);
    return mapped.at ("mode") == "inherit" ? json{ { "mode", "none" } } : mapped;
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
                requests.push_back (pm_request (entry, counts));
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
    collection["variables"]   = to_var_record (prop (node, "variable"));
    collection["auth"]        = collection_auth (prop (node, "auth"));
    collection["preRequestScript"] =
    counts.options.import_scripts ? join_exec (pm_event (events, "prerequest")) : "";
    collection["postRequestScript"] =
    counts.options.import_scripts ? join_exec (pm_event (events, "test")) : "";
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

    json meta;
    meta["format"]              = format;
    meta["requestCount"]        = counts.requests;
    meta["folderCount"]         = counts.folders;
    meta["environmentCount"]    = 0;
    meta["globalCount"]         = 0;
    meta["exampleCount"]        = count_examples (collections);
    meta["skipped"]             = tally.items ();
    meta["nonExecutableAuth"]   = counts.non_executable;
    meta["unattachedFileParts"] = unattached_file_parts (collections);

    return json{ { "collections", std::move (collections) },
        // Collection files embed neither environments nor globals - both are
        // separate exports, which `parse_postman_variables` reads.
        { "environments", json::array () }, { "globals", json::object () },
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
    const json variables = options.import_environments ?
    to_var_record (prop (&parsed, "values")) :
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
    meta["exampleCount"]        = 0;
    meta["skipped"]             = json::array ();
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
    if (!prefix.empty () && walk::lower (prefix) != "bearer") {
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
        const json* description = prop (resource, "description");

        json request;
        request["name"] = resource_name (resource, "Untitled");
        request["description"] =
        description == nullptr || description->is_null () ? json ("") : *description;
        request["method"] = to_method (prop (resource, "method"));
        request["url"]    = normalize_vars (as_string (prop (resource, "url")));
        request["params"] = map_key_values (&params);
        request["headers"] = with_required_content_type (map_key_values (&headers), body);
        request["body"] = std::move (body);
        request["auth"] = insomnia_auth (prop (resource, "authentication"), counts_);
        request["preRequestScript"]  = counts_.options.import_scripts ?
         as_string (prop (resource, "preRequestScript")) :
         "";
        request["postRequestScript"] = counts_.options.import_scripts ?
        as_string (prop (resource, "afterResponseScript")) :
        "";
        insomnia_redirects (resource, request);
        return request;
    }

    /** One child of a folder, by the resource type it declares. */
    void add_child (const json* child, json& children, json& requests) {
        if (type_is (child, "request_group")) {
            counts_.folders += 1;
            children.push_back (build_collection (child, /*workspace=*/false));
        } else if (type_is (child, "request")) {
            requests.push_back (build_request (child));
        } else if (type_is (child, "grpc_request")) {
            tally_.add ("grpc");
        } else if (type_is (child, "websocket_request")) {
            tally_.add ("websocket");
        } else if (type_is (child, "api_spec")) {
            tally_.add ("api_spec");
        } else if (type_is (child, "unit_test") || type_is (child, "unit_test_suite")) {
            tally_.add ("unit_test");
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
        collection["preRequestScript"]  = counts_.options.import_scripts ?
         as_string (prop (node, "preRequestScript")) :
         "";
        collection["postRequestScript"] = counts_.options.import_scripts ?
        as_string (prop (node, "afterResponseScript")) :
        "";
        collection["children"]          = std::move (children);
        collection["requests"]          = std::move (requests);
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

    json meta;
    meta["format"]           = "Insomnia Export v4";
    meta["requestCount"]     = tree.counts ().requests;
    meta["folderCount"]      = tree.counts ().folders;
    meta["environmentCount"] = static_cast<int> (environments.size ());
    meta["globalCount"]      = 0;
    // Insomnia v4 exports carry no saved responses - the format has no concept
    // of one, so this is 0 by absence rather than by drop.
    meta["exampleCount"]        = 0;
    meta["skipped"]             = tree.tally ().items ();
    meta["nonExecutableAuth"]   = tree.counts ().non_executable;
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
        const std::string* name = as_str (prop (node, "name"));
        const json* in          = prop (node, "in");
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

/// The scheme a collection's auth is built from: the one the document's
/// top-level `security` requires, else the first one it defines.
const json* primary_scheme (const json* schemes, const json* security) {
    const json* required = as_record (array_at (security, 0));
    if (required != nullptr && !required->empty () && schemes != nullptr) {
        const json* named = prop (schemes, required->begin ().key ());
        if (truthy (named)) {
            return named;
        }
    }
    if (schemes == nullptr || !schemes->is_object () || schemes->empty ()) {
        return nullptr;
    }
    return &schemes->begin ().value ();
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

json draft_request (const SpecRequestDraft& entry) {
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
        examples.push_back ({ { "name", example.name },
        { "status", example.status }, { "headers", std::move (rows) },
        { "body", example.body }, { "contentType", example.content_type } });
    }

    json request;
    request["name"]              = draft.name;
    request["description"]       = draft.description;
    request["method"]            = draft.method;
    request["url"]               = draft.url;
    request["params"]            = std::move (params);
    request["headers"]           = std::move (headers);
    request["body"]              = draft_body (draft.body);
    request["auth"]              = json{ { "mode", "inherit" } };
    request["preRequestScript"]  = "";
    request["postRequestScript"] = "";
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
            folder["name"]              = name;
            folder["description"]       = from_tag ? describe (name) : "";
            folder["variables"]         = json::object ();
            folder["auth"]              = json{ { "mode", "none" } };
            folder["preRequestScript"]  = "";
            folder["postRequestScript"] = "";
            folder["children"]          = json::array ();
            folder["requests"]          = json::array ();
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

json parse_openapi (const json& document,
const std::string& raw,
const ImportSource& source,
walk::Dialect dialect) {
    ImportTally tally;
    const bool v3 = dialect == walk::Dialect::V3;

    std::string base_url;
    const json* schemes = nullptr;
    if (v3) {
        base_url = resolve_server_url (
        array_at (prop (&document, "servers"), 0), source.source_url, tally);
        schemes = as_record (
        prop (as_record (prop (&document, "components")), "securitySchemes"));
    } else {
        // 2.0 states its base as three fields rather than a server URL. A
        // `basePath` of exactly `/` adds nothing, and a document with no `host`
        // has no base at all - `{{baseUrl}}` is then simply not a variable, and
        // every request's URL starts with the token unresolved, which is what
        // the renderer did too.
        const std::string* wire_scheme =
        as_str (array_at (prop (&document, "schemes"), 0));
        const std::string* declared_base = as_str (prop (&document, "basePath"));
        const std::string base_path =
        declared_base != nullptr && *declared_base != "/" ? *declared_base :
                                                            std::string ();
        if (const std::string* host = as_str (prop (&document, "host"));
        host != nullptr && !host->empty ()) {
            base_url = (wire_scheme == nullptr ? "https" : *wire_scheme) +
            "://" + *host + base_path;
        }
        schemes = as_record (prop (&document, "securityDefinitions"));
    }

    OperationFolders folders (prop (&document, "tags"));
    const std::vector<SpecRequestDraft> drafts = import_drafts_of (document, tally);
    for (const SpecRequestDraft& entry : drafts) {
        folders.place (draft_request (entry), entry.folder, entry.folder_from_tag);
    }

    const json* info         = as_record (prop (&document, "info"));
    const std::string* title = as_str (prop (info, "title"));
    const std::string* about = as_str (prop (info, "description"));
    const json* scheme = primary_scheme (schemes, prop (&document, "security"));

    json root;
    root["name"]        = title == nullptr ? "Imported API" : *title;
    root["description"] = about == nullptr ? "" : *about;
    root["variables"]   = base_url.empty () ?
      json::object () :
      json{ { "baseUrl", { { "value", base_url }, { "enabled", true } } } };
    root["auth"] = v3 ? scheme_to_auth_v3 (scheme) : scheme_to_auth_v2 (scheme);
    root["preRequestScript"]  = "";
    root["postRequestScript"] = "";
    root["children"]          = folders.children ();
    root["requests"]          = folders.root_requests ();
    // The document itself, so the import can store it and bind this collection
    // to it in the same atomic call (#637). `raw` and not a re-serialization:
    // the engine hashes the bytes it stores, and a sync compares against that
    // hash. Neither index is beside it - the engine derives both from the very
    // bytes it stores (#853, #860).
    root["spec"] = json{ { "content", raw } };

    json collections = json::array ();
    collections.push_back (std::move (root));

    json meta;
    meta["format"]       = v3 ? "OpenAPI 3.0" : "OpenAPI 2.0 (Swagger)";
    meta["requestCount"] = static_cast<int> (drafts.size ());
    meta["folderCount"]  = static_cast<int> (folders.count ());
    if (const std::string strategy = folders.strategy (); !strategy.empty ()) {
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
 */
void join_params_into_urls (json& collections) {
    for (json& collection : collections) {
        for (json& request : collection.at ("requests")) {
            std::vector<DraftField> rows;
            for (const json& row : request.at ("params")) {
                DraftField field;
                field.key     = row.at ("key").get<std::string> ();
                field.value   = row.at ("value").get<std::string> ();
                field.enabled = row.at ("enabled").get<bool> ();
                rows.push_back (std::move (field));
            }
            request["url"] = append_params (request.at ("url").get<std::string> (), rows);
        }
        join_params_into_urls (collection.at ("children"));
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
    item["auth"]              = draft.at ("auth");
    item["preRequestScript"]  = draft.at ("preRequestScript");
    item["postRequestScript"] = draft.at ("postRequestScript");
    for (const char* optional :
    { "followRedirects", "maxRedirects", "examples", "specOperation" }) {
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
    collection["variables"]         = draft.at ("variables");
    collection["auth"]              = draft.at ("auth");
    collection["preRequestScript"]  = draft.at ("preRequestScript");
    collection["postRequestScript"] = draft.at ("postRequestScript");
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

ImportParse parse_import (const std::string& text,
const ImportOptions& options,
const ImportSource& source) {
    ImportParse parsed;

    // One read, through the engine's one reader: JSON first and YAML second,
    // which is the order `parse-raw.ts` read the same bytes in.
    const DocumentRead read = read_document (text);
    if (!read.ok ()) {
        parsed.error = "Could not read the document: " + read.error;
        return parsed;
    }
    const nlohmann::ordered_json& document = read.root;

    // Whether the parse already wrote each request's enabled query into its
    // `url`. Only the OpenAPI path does - `SpecRequestDraft` promises a joined
    // URL, because that is what the sync diff compares a stored request against
    // - and running the join over one would append the same rows twice. Stated
    // rather than derived from the format name, which would make a renamed
    // dialect a silently doubled query.
    bool query_joined = false;

    try {
        // Detection order is `factory.ts`'s `PARSERS`, most specific first, so
        // a document carrying two formats' keys is claimed by the same one on
        // both sides.
        if (is_postman_v21 (document)) {
            parsed.result = parse_postman (document, options, "Postman Collection v2.1");
        } else if (is_postman_v20 (document)) {
            parsed.result = parse_postman (document, options, "Postman Collection v2.0");
        } else if (const std::optional<bool> globals = postman_variable_scope (document)) {
            parsed.result = parse_postman_variables (document, options, *globals);
        } else if (is_insomnia_v4 (document)) {
            parsed.result = parse_insomnia (document, options);
        } else if (const walk::Dialect dialect = walk::spec_dialect (document);
        dialect != walk::Dialect::None) {
            parsed.result = parse_openapi (document, text, source, dialect);
            query_joined  = true;
        } else {
            parsed.error        = "Unrecognised format";
            parsed.unrecognised = true;
            return parsed;
        }
    } catch (const MalformedImport& malformed) {
        parsed.error = malformed.what ();
        return parsed;
    }

    if (!query_joined) {
        join_params_into_urls (parsed.result.at ("collections"));
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

    return nlohmann::ordered_json{ { "collections", std::move (collections) },
        { "requests", std::move (requests) },
        { "environments", std::move (environments) }, { "specs", std::move (specs) } };
}

} // namespace vayu::core
