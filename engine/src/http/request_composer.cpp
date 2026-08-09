/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/request_composer.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <ctime>
#include <random>
#include <regex>
#include <unordered_set>

#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::http {

namespace {

// --- Dynamic variables -------------------------------------------------------
//
// The C++ twin of the renderer's `lib/dynamic-variables.ts` table. The *names*
// are a contract (the renderer's autocomplete offers them and the conformance
// fixture pins the set on both sides); the values are random by design, so only
// their shape has to agree. Each generator runs once per `{{...}}` occurrence -
// two `{{$guid}}` in one payload are two different ids, which is the reason to
// write them.

thread_local std::mt19937 rng{ std::random_device{}() };

int random_int (int min_inclusive, int max_inclusive) {
    std::uniform_int_distribution<int> dist (min_inclusive, max_inclusive);
    return dist (rng);
}

template <size_t N> const char* pick (const std::array<const char*, N>& items) {
    return items[static_cast<size_t> (random_int (0, static_cast<int> (N) - 1))];
}

std::string random_string (size_t length, const std::string& alphabet) {
    std::string out;
    out.reserve (length);
    for (size_t i = 0; i < length; ++i) {
        out.push_back (
        alphabet[static_cast<size_t> (random_int (0, static_cast<int> (alphabet.size ()) - 1))]);
    }
    return out;
}

const std::string ALPHANUMERIC =
"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const std::string PASSWORD_CHARS = ALPHANUMERIC + "!@#$%^&*_-+=";

constexpr std::array<const char*, 10> FIRST_NAMES = { "Ada", "Ravi", "Mina",
    "Jonas", "Priya", "Elena", "Omar", "Sofia", "Kenji", "Nora" };
constexpr std::array<const char*, 10> LAST_NAMES = { "Lovelace", "Iyer", "Kowalski",
    "Okafor", "Rossi", "Nakamura", "Haddad", "Silva", "Novak", "Petrov" };
constexpr std::array<const char*, 6> COMPANY_WORDS    = { "Northwind", "Acme",
       "Umbra", "Lumen", "Kestrel", "Basalt" };
constexpr std::array<const char*, 5> COMPANY_SUFFIXES = { "Inc", "LLC", "Group",
    "Labs", "Systems" };
constexpr std::array<const char*, 4> DOMAINS = { "example.com", "example.org",
    "example.net", "test.dev" };

std::string lower (std::string s) {
    std::transform (s.begin (), s.end (), s.begin (),
    [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
    return s;
}

std::string iso_timestamp () {
    using namespace std::chrono;
    const auto now = system_clock::now ();
    const auto ms = duration_cast<milliseconds> (now.time_since_epoch ()) % 1000;
    const std::time_t t = system_clock::to_time_t (now);
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s (&utc, &t);
#else
    gmtime_r (&t, &utc);
#endif
    // Sized for snprintf's worst case over full-range ints, so -Wformat-
    // truncation has nothing to warn about; real output is 24 characters.
    char buf[96];
    std::snprintf (buf, sizeof (buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
    utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min,
    utc.tm_sec, static_cast<int> (ms.count ()));
    return buf;
}

struct DynamicVariable {
    const char* name;
    std::string (*generate) ();
};

// Same names, same order as the renderer table.
const std::array<DynamicVariable, 15> DYNAMIC_VARIABLES = { {
{ "$guid", [] { return vayu::utils::generate_id (""); } },
{ "$randomUUID", [] { return vayu::utils::generate_id (""); } },
{ "$timestamp",
[] {
    return std::to_string (std::chrono::duration_cast<std::chrono::seconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                           .count ());
} },
{ "$isoTimestamp", [] { return iso_timestamp (); } },
{ "$randomInt", [] { return std::to_string (random_int (0, 1000)); } },
{ "$randomAlphaNumeric", [] { return random_string (1, ALPHANUMERIC); } },
{ "$randomBoolean",
[] { return std::string (random_int (0, 1) == 1 ? "true" : "false"); } },
{ "$randomEmail",
[] {
    return lower (pick (FIRST_NAMES)) + "." + lower (pick (LAST_NAMES)) + "@" +
    pick (DOMAINS);
} },
{ "$randomFirstName", [] { return std::string (pick (FIRST_NAMES)); } },
{ "$randomLastName", [] { return std::string (pick (LAST_NAMES)); } },
{ "$randomFullName",
[] { return std::string (pick (FIRST_NAMES)) + " " + pick (LAST_NAMES); } },
{ "$randomCompanyName",
[] { return std::string (pick (COMPANY_WORDS)) + " " + pick (COMPANY_SUFFIXES); } },
{ "$randomUrl",
[] { return "https://" + lower (pick (COMPANY_WORDS)) + "." + pick (DOMAINS); } },
{ "$randomIP",
[] {
    return std::to_string (random_int (0, 255)) + "." +
    std::to_string (random_int (0, 255)) + "." +
    std::to_string (random_int (0, 255)) + "." + std::to_string (random_int (0, 255));
} },
{ "$randomPassword", [] { return random_string (15, PASSWORD_CHARS); } },
} };

std::string trim (const std::string& s) {
    const auto begin = s.find_first_not_of (" \t\r\n");
    if (begin == std::string::npos) {
        return {};
    }
    const auto end = s.find_last_not_of (" \t\r\n");
    return s.substr (begin, end - begin + 1);
}

} // namespace

bool is_dynamic_variable_name (const std::string& name) {
    return !name.empty () && name.front () == '$';
}

std::optional<std::string> resolve_dynamic_variable (const std::string& name) {
    for (const auto& v : DYNAMIC_VARIABLES) {
        if (name == v.name) {
            return v.generate ();
        }
    }
    return std::nullopt;
}

const std::vector<std::string>& dynamic_variable_names () {
    static const std::vector<std::string> names = [] {
        std::vector<std::string> out;
        out.reserve (DYNAMIC_VARIABLES.size ());
        for (const auto& v : DYNAMIC_VARIABLES) {
            out.emplace_back (v.name);
        }
        return out;
    }();
    return names;
}

VariableValues build_variable_values (const vayu::Environment& globals,
const std::vector<vayu::Environment>& chain,
const vayu::Environment& environment) {
    VariableValues values;
    const auto collect = [&values] (const vayu::Environment& scope) {
        for (const auto& [name, var] : scope) {
            if (var.enabled) {
                values[name] = var.value;
            }
        }
    };
    collect (globals);              // 1. globals (lowest)
    for (const auto& col : chain) { // 2. chain root->leaf
        collect (col);
    }
    collect (environment); // 3. environment (highest)
    return values;
}

std::string resolve_template (const std::string& input, const VariableValues& vars) {
    if (input.empty ()) {
        return input;
    }
    // Same pattern as the clients' VARIABLE_PATTERN: no nested braces, no
    // escape hatch. Matches are consumed left to right over the *original*
    // string only, which is what makes this a single pass - a replacement is
    // never rescanned, so `{{a}}` whose value contains `{{b}}` stays literal.
    static const std::regex pattern (R"(\{\{([^{}]+)\}\})");

    std::string out;
    out.reserve (input.size ());
    auto it = std::sregex_iterator (input.begin (), input.end (), pattern);
    const auto end = std::sregex_iterator ();
    size_t last    = 0;
    for (; it != end; ++it) {
        const auto& match = *it;
        out.append (input, last, static_cast<size_t> (match.position ()) - last);
        const std::string name = trim (match[1].str ());
        if (auto defined = vars.find (name); defined != vars.end ()) {
            out += defined->second;
        } else if (is_dynamic_variable_name (name)) {
            if (auto generated = resolve_dynamic_variable (name)) {
                out += *generated;
            } else {
                out += match.str (); // unknown $name keeps its braces (#186)
            }
        }
        // Ordinary unknown name: append nothing (resolves to "").
        last = static_cast<size_t> (match.position () + match.length ());
    }
    out.append (input, last, input.size () - last);
    return out;
}

nlohmann::json resolve_json_strings (const nlohmann::json& value, const VariableValues& vars) {
    if (value.is_string ()) {
        return resolve_template (value.get<std::string> (), vars);
    }
    if (value.is_array ()) {
        nlohmann::json out = nlohmann::json::array ();
        for (const auto& item : value) {
            out.push_back (resolve_json_strings (item, vars));
        }
        return out;
    }
    if (value.is_object ()) {
        nlohmann::json out = nlohmann::json::object ();
        for (const auto& [key, item] : value.items ()) {
            out[key] = resolve_json_strings (item, vars);
        }
        return out;
    }
    return value;
}

std::vector<vayu::db::Collection>
collection_chain (vayu::db::Database& db, const std::string& leaf_id) {
    std::vector<vayu::db::Collection> chain;
    std::unordered_set<std::string> seen;
    std::string current = leaf_id;
    while (!current.empty () && seen.insert (current).second) {
        auto col = db.get_collection (current);
        if (!col) {
            break;
        }
        current = col->parent_id.value_or ("");
        chain.insert (chain.begin (), std::move (*col)); // root ends up first
    }
    return chain;
}

namespace {

// Fetch the "mode" of an auth JSON, "" when absent or not a string.
std::string auth_mode (const nlohmann::json& auth) {
    if (auth.is_object ()) {
        if (auto it = auth.find ("mode"); it != auth.end () && it->is_string ()) {
            return it->get<std::string> ();
        }
    }
    return {};
}

// True for auth blocks that carry no credential (nothing to forward).
bool is_empty_auth (const nlohmann::json& auth) {
    const std::string mode = auth_mode (auth);
    return mode.empty () || mode == "none" || mode == "noauth";
}

nlohmann::json parse_auth_blob (const std::string& blob) {
    if (blob.empty ()) {
        return nlohmann::json ();
    }
    auto parsed = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    return parsed.is_discarded () ? nlohmann::json () : parsed;
}

} // namespace

nlohmann::json resolve_inherited_auth (const std::vector<vayu::db::Collection>& chain) {
    for (auto it = chain.rbegin (); it != chain.rend (); ++it) {
        const nlohmann::json auth = parse_auth_blob (it->auth);
        if (auth_mode (auth) == "noauth") {
            return nlohmann::json (); // explicit "send nothing" ends the walk
        }
        if (!is_empty_auth (auth)) {
            return auth;
        }
    }
    return nlohmann::json ();
}

namespace {

// Builds through routes.hpp's error_body so /compose carries the same nested
// shape as every other route (issue #173 landed while #226 was in flight).
std::pair<int, nlohmann::json>
compose_error (int status, const char* code, const std::string& message) {
    return { status, routes::error_body (status, message, code) };
}

// Append one script part, skipping blanks - the same rule the clients'
// scriptParts helpers and the engine's read_script apply.
void push_script_part (nlohmann::json& parts,
const char* origin,
const std::string& id,
const std::string& name,
const std::string& script) {
    if (script.find_first_not_of (" \t\r\n") == std::string::npos) {
        return;
    }
    nlohmann::json part = { { "origin", origin }, { "script", script } };
    if (!id.empty ()) {
        part["id"] = id;
    }
    if (!name.empty ()) {
        part["name"] = name;
    }
    parts.push_back (part);
}

// The ordered script-part list for a saved request: the collection chain's
// scripts root->leaf, then the request's own - the order the renderer sends,
// so parent-collection setup runs before the request's script.
nlohmann::json compose_script_parts (const std::vector<vayu::db::Collection>& chain,
const vayu::db::Request& request,
bool pre) {
    nlohmann::json parts = nlohmann::json::array ();
    for (const auto& col : chain) {
        push_script_part (parts, "collection", col.id, col.name,
        pre ? col.pre_request_script : col.post_request_script);
    }
    push_script_part (parts, "request", request.id, "",
    pre ? request.pre_request_script : request.post_request_script);
    return parts;
}

// Flatten a stored KeyValueEntry[] headers blob into the object map /execute
// expects: enabled-only, non-empty keys, later duplicates win.
nlohmann::json flatten_stored_headers (const std::string& blob) {
    nlohmann::json out = nlohmann::json::object ();
    if (blob.empty ()) {
        return out;
    }
    auto rows = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!rows.is_array ()) {
        return out;
    }
    for (const auto& row : rows) {
        if (!row.is_object ()) {
            continue;
        }
        const auto key = row.find ("key");
        if (key == row.end () || !key->is_string () || key->get<std::string> ().empty ()) {
            continue;
        }
        if (auto enabled = row.find ("enabled"); enabled != row.end () &&
            enabled->is_boolean () && !enabled->get<bool> ()) {
            continue;
        }
        const auto value = row.find ("value");
        out[key->get<std::string> ()] =
        (value != row.end () && value->is_string ()) ? value->get<std::string> () : "";
    }
    return out;
}

// The stored body blob as an /execute body, or null for "no body".
nlohmann::json stored_body (const std::string& blob) {
    if (blob.empty ()) {
        return nlohmann::json ();
    }
    auto body = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!body.is_object ()) {
        return nlohmann::json ();
    }
    const auto mode = body.find ("mode");
    if (mode == body.end () || !mode->is_string () || mode->get<std::string> () == "none") {
        return nlohmann::json ();
    }
    return body;
}

// Build the unresolved execute-ready payload for a saved request - the by-id
// half of composition. Everything here is raw; resolution happens afterwards,
// through the same code the inline path uses.
nlohmann::json payload_from_stored (const vayu::db::Request& request,
const std::vector<vayu::db::Collection>& chain) {
    nlohmann::json payload;
    payload["method"] = to_string (request.method);
    payload["url"]    = request.url;

    nlohmann::json headers = flatten_stored_headers (request.headers);
    if (!headers.empty ()) {
        payload["headers"] = headers;
    }
    nlohmann::json body = stored_body (request.body);
    if (!body.is_null ()) {
        payload["body"] = body;
    }

    // A saved request with no auth blob defaults to inherit (the CRUD layer's
    // own default for the column).
    nlohmann::json auth = parse_auth_blob (request.auth);
    payload["auth"] = auth.is_object () ? auth : nlohmann::json{ { "mode", "inherit" } };

    nlohmann::json pre = compose_script_parts (chain, request, /*pre=*/true);
    if (!pre.empty ()) {
        payload["preRequestScripts"] = pre;
    }
    nlohmann::json post = compose_script_parts (chain, request, /*pre=*/false);
    if (!post.empty ()) {
        payload["postRequestScripts"] = post;
    }

    // Always emitted, never elided - the same rule both clients follow: the
    // engine's execute default is to follow redirects at "auto", so omitting a
    // stored `false` or a stored protocol would silently hand the decision
    // back to the default.
    payload["followRedirects"] = request.follow_redirects;
    payload["maxRedirects"]    = request.max_redirects;
    payload["httpVersion"]     = request.http_version;
    payload["requestId"]       = request.id;

    // Identity for the script sandbox (`pm.info.requestName`), not an HTTP
    // field. Only the by-id path has a row to read it from; the inline path's
    // client sends its own, because editor state may be unsaved. Omitted when
    // empty so a script reads `undefined` rather than "".
    if (!request.name.empty ()) {
        payload["requestName"] = request.name;
    }
    return payload;
}

} // namespace

std::pair<int, nlohmann::json>
compose_request_core (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return compose_error (
        400, "invalid_compose_request", "Request body must be a JSON object");
    }

    const bool has_request_id =
    body.contains ("requestId") && !body["requestId"].is_null ();
    const bool has_inline = body.contains ("request") && !body["request"].is_null ();
    if (has_request_id && !body["requestId"].is_string ()) {
        return compose_error (400, "invalid_compose_request", "'requestId' must be a string");
    }
    if (has_inline && !body["request"].is_object ()) {
        return compose_error (400, "invalid_compose_request", "'request' must be a JSON object");
    }
    if (!has_request_id && !has_inline) {
        return compose_error (400, "invalid_compose_request",
        "Provide 'requestId' (compose a saved request) and/or 'request' (an "
        "inline request to compose)");
    }

    std::optional<vayu::db::Request> stored;
    if (has_request_id) {
        stored = db.get_request (body["requestId"].get<std::string> ());
        if (!stored) {
            return compose_error (404, "request_not_found",
            "No saved request with id '" + body["requestId"].get<std::string> () + "'");
        }
    }

    // Scope: the saved request's own collection wins; an explicit collectionId
    // is the inline path's scope (and a fallback for a stored request without
    // one). Unknown ids degrade to an empty scope, the same tolerance the
    // clients had - composition must still work with no collection at all.
    std::string scope_collection_id;
    if (stored && !stored->collection_id.empty ()) {
        scope_collection_id = stored->collection_id;
    } else if (body.contains ("collectionId") && body["collectionId"].is_string ()) {
        scope_collection_id = body["collectionId"].get<std::string> ();
    }
    const auto chain = collection_chain (db, scope_collection_id);

    vayu::Environment globals, environment;
    if (auto db_globals = db.get_globals ()) {
        globals = vayu::json::parse_variables (db_globals->variables);
    }
    std::string environment_id;
    if (body.contains ("environmentId") && body["environmentId"].is_string ()) {
        environment_id = body["environmentId"].get<std::string> ();
        if (auto db_env = db.get_environment (environment_id)) {
            environment = vayu::json::parse_variables (db_env->variables);
        }
    }
    std::vector<vayu::Environment> chain_variables;
    chain_variables.reserve (chain.size ());
    for (const auto& col : chain) {
        chain_variables.push_back (vayu::json::parse_variables (col.variables));
    }
    const VariableValues vars =
    build_variable_values (globals, chain_variables, environment);

    // Base payload from the stored request (raw), then the inline request laid
    // over it field by field - so a `start_load_run { requestId, url }` style
    // override replaces the stored URL but keeps everything else. Inline-only
    // composition starts from an empty object. Both paths then resolve through
    // the same code below, so overrides and stored fields follow one rule.
    nlohmann::json payload =
    stored ? payload_from_stored (*stored, chain) : nlohmann::json::object ();
    if (has_inline) {
        for (const auto& [key, value] : body["request"].items ()) {
            payload[key] = value;
        }
    }

    if (auto method = payload.find ("method");
        method != payload.end () && method->is_string ()) {
        std::string verb = method->get<std::string> ();
        std::transform (verb.begin (), verb.end (), verb.begin (),
        [] (unsigned char c) { return static_cast<char> (std::toupper (c)); });
        *method = verb;
    }

    if (auto url = payload.find ("url"); url != payload.end () && url->is_string ()) {
        *url = resolve_template (url->get<std::string> (), vars);
    }

    if (auto headers = payload.find ("headers");
        headers != payload.end () && headers->is_object ()) {
        nlohmann::json resolved = nlohmann::json::object ();
        for (const auto& [key, value] : headers->items ()) {
            resolved[resolve_template (key, vars)] = value.is_string () ?
            nlohmann::json (resolve_template (value.get<std::string> (), vars)) :
            value;
        }
        *headers = resolved;
    }

    if (auto it = payload.find ("body"); it != payload.end ()) {
        if (!it->is_object ()) {
            payload.erase ("body");
        } else {
            const auto mode = it->find ("mode");
            if (mode == it->end () || !mode->is_string () ||
            mode->get<std::string> () == "none") {
                payload.erase ("body");
            } else {
                if (auto content = it->find ("content");
                    content != it->end () && content->is_string ()) {
                    *content = resolve_template (content->get<std::string> (), vars);
                }
                if (auto fields = it->find ("fields");
                    fields != it->end () && fields->is_array ()) {
                    for (auto& field : *fields) {
                        if (!field.is_object ()) {
                            continue;
                        }
                        // Every string a form field carries, including a file
                        // part's path: a fixture directory is exactly the kind
                        // of thing an environment variable holds, and an
                        // unresolved `{{...}}` reaching the transfer would be
                        // opened as a literal filename.
                        for (const char* name :
                        { "key", "value", "src", "fileName", "contentType" }) {
                            if (auto entry = field.find (name);
                                entry != field.end () && entry->is_string ()) {
                                *entry =
                                resolve_template (entry->get<std::string> (), vars);
                            }
                        }
                    }
                }
            }
        }
    }

    // Auth: resolve `inherit` through the chain first, then `{{vars}}` inside
    // whatever concrete block won - strictly before any OAuth 2.0 cache key can
    // be computed from it (D10). An empty result means "send nothing", which is
    // an absent field, not a null.
    if (auto it = payload.find ("auth"); it != payload.end ()) {
        nlohmann::json auth = *it;
        if (auth_mode (auth) == "inherit") {
            auth = resolve_inherited_auth (chain);
        }
        if (is_empty_auth (auth) || auth_mode (auth) == "inherit") {
            payload.erase ("auth");
        } else {
            *it = resolve_json_strings (auth, vars);
        }
    }

    // Scripts are never interpolated (D16): a `{{...}}` inside script text is
    // user JavaScript, and rewriting it cannot tell a string literal from
    // code. They pass through exactly as supplied/stored.

    if (!environment_id.empty ()) {
        payload["environmentId"] = environment_id;
    }

    return { 200, payload };
}

} // namespace vayu::http
