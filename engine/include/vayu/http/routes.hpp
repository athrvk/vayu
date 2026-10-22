#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <httplib.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <expected>
#include <format>
#include <functional>
#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/schema_validation.hpp"
#include "vayu/core/spec_diff.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/grant_secret.hpp"
#include "vayu/http/request_builder.hpp"
// The `POST /execute` core - `ScriptVariableScopes`, the exchange itself - now
// shared with the scenario runner and therefore declared where `vayu_core` can
// see it. Included here so route TUs keep naming it through routes.hpp.
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {
// One documented response of a draft request; defined in
// core/openapi_document.hpp. Forward-declared so the whole OpenAPI reader is not
// pulled into every route TU for one signature - a `const std::vector<T>&`
// parameter needs no more than the name.
struct DraftExample;
} // namespace vayu::core

namespace vayu::http {
// Owns interactive OAuth 2.0 authorization attempts; defined in
// oauth_authorize.hpp. Forward-declared here so RouteContext can carry a
// reference without every route TU pulling in the loopback listener machinery.
class OAuth2AuthorizeManager;
// Owns the local OAuth 2.0 mock issuers; defined in mock_issuer.hpp. Forward-
// declared for the same reason as the manager above.
class MockIssuerManager;
// Owns the webhook inbox listeners; defined in inbox.hpp. Forward-declared for
// the same reason as the two managers above - a route TU that never touches an
// inbox does not pull in the listener machinery.
class InboxManager;
// Owns the collection mock servers; defined in mock_server.hpp. Forward-
// declared for the same reason as the three managers above.
class MockServerManager;
// Owns the streaming consumers; defined in sse_stream.hpp. Forward-declared for
// the same reason as the four managers above.
class SseStreamManager;
} // namespace vayu::http

namespace vayu::http::routes {

/**
 * @brief Common utilities for route handlers
 */
inline int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/**
 * @brief The error code an error body carries when its call site does not name one.
 *
 * Codes are per-status rather than per-message so a caller can branch on the
 * class of failure without string-matching the message, and so the ~50 existing
 * call sites needed no per-site invention. A route that has a more specific code
 * (`invalid_config`, the `oauth2_*` family) passes it explicitly.
 */
inline const char* default_error_code (int status) {
    switch (status) {
    case 400: return "bad_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 502: return "bad_gateway";
    case 503: return "unavailable";
    default: return status >= 500 ? "internal_error" : "error";
    }
}

/**
 * @brief The one error body shape the engine emits: `{"error": {"code", "message"}}`.
 *
 * The engine used to emit two shapes - this nested one from `/config` and
 * `/oauth2`, and a flat `{"error": "<message>"}` from `send_error` and the
 * testable-core route helpers. The app's shared http-client reads
 * `errorData.error.message`, and on a flat body that is `undefined` (a string
 * carries no `.message`), so every validation message the CRUD routes built was
 * dropped and surfaced as a bare "HTTP 400" (issue #173). Build error bodies
 * here rather than inline, so a new route cannot reintroduce the split.
 *
 * Extra per-error detail belongs *inside* the nested object (see `item_error`
 * in import.cpp), which keeps `error` the single place a client has to look.
 */
inline nlohmann::json
error_body (int status, const std::string& message, std::string_view code = {}) {
    const std::string error_code =
    code.empty () ? default_error_code (status) : std::string (code);
    return nlohmann::json{ { "error", { { "code", error_code }, { "message", message } } } };
}

/**
 * The response a refusal produces: the HTTP status, and the body to send with
 * it.
 *
 * Named fields rather than a `std::pair`, because `error->first` at a call site
 * says nothing about which half is the status - and a helper that builds the
 * pair by hand can put a 400 in one half and a 500-shaped body in the other.
 * `route_error` below builds both from one status, so they cannot disagree.
 */
struct RouteError {
    int status = 500;
    nlohmann::json body;
};

/**
 * "Did what it was asked, or here is the response to send instead."
 *
 * Every field applier and every guard below returns this. It used to be
 * `std::optional<std::pair<int, nlohmann::json>>`, where an *empty* optional
 * meant success - a shape that reads backwards at every call site (`if (err)`
 * on the failure path, `return std::nullopt` to mean "fine") and that lets a
 * dropped return value pass silently for "no error". With `std::expected` the
 * type carries which way is up: `if (!result) return result;` propagates, and
 * `result.error()` is the only way to reach the response.
 */
using RouteResult = std::expected<void, RouteError>;

/**
 * Build the refusal. One status in, and both halves of the error come out of
 * it - the duplication that used to spell the status twice
 * (`std::make_pair (400, error_body (400, ...))`) is gone with it.
 */
[[nodiscard]] inline std::unexpected<RouteError>
route_error (int status, const std::string& message, std::string_view code = {}) {
    return std::unexpected (
    RouteError{ .status = status, .body = error_body (status, message, code) });
}

/**
 * The `{status, body}` pair a testable route core answers with, built from a
 * refusal one of the helpers produced.
 *
 * The cores return the *response* - success or failure, both are something to
 * send - so they keep the pair; only the helpers that mean "nothing to report
 * unless it went wrong" carry `RouteResult`. This is the one seam between the
 * two, spelled out rather than left as `{ e.status, e.body }` at thirty sites.
 */
[[nodiscard]] inline std::pair<int, nlohmann::json> as_response (const RouteError& error) {
    return { error.status, error.body };
}

/**
 * The refusal a core answers with directly, without a helper in between - the
 * pair-shaped counterpart of `route_error`, and here for the same reason:
 * `{ 400, error_body (400, ...) }` spells the status twice and the two halves
 * can drift.
 */
[[nodiscard]] inline std::pair<int, nlohmann::json>
error_response (int status, const std::string& message, std::string_view code = {}) {
    return { status, error_body (status, message, code) };
}

/**
 * A request body as JSON, or the 400 to answer instead: text that does not
 * parse (`Invalid JSON: ...`, the default code), or a value nested deeper than
 * `constants::request_body::MAX_JSON_DEPTH` levels (@p depth_code, #2417).
 *
 * nlohmann parses iteratively but `dump ()` and the copy constructor recurse,
 * so a tree this returns is one that both are safe on, and a refused one has
 * been probed only by `vayu::json::exceeds_depth`.
 *
 * @p field_bounds runs between the parse and the body's bound, for a field
 * whose own bound is tighter and named (a data cell, #2362), so that refusal
 * keeps its words. It must probe only with `exceeds_depth`, and a field that
 * passes it must fit under the body's bound (`MAX_JSON_DEPTH`'s assert).
 */
[[nodiscard]] inline std::expected<nlohmann::json, RouteError>
parse_request_json (const std::string& body,
std::string_view depth_code                                            = {},
const std::function<RouteResult (const nlohmann::json&)>& field_bounds = {}) {
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse (body);
    } catch (const nlohmann::json::exception& e) {
        return route_error (400, "Invalid JSON: " + std::string (e.what ()));
    }
    if (field_bounds) {
        if (auto refused = field_bounds (parsed); !refused) {
            return std::unexpected (std::move (refused.error ()));
        }
    }
    constexpr size_t max_depth = vayu::core::constants::request_body::MAX_JSON_DEPTH;
    if (vayu::json::exceeds_depth (parsed, max_depth)) {
        return route_error (400,
        std::format ("request body is nested deeper than {} levels", max_depth), depth_code);
    }
    return parsed;
}

/**
 * @brief Read the human-readable message out of an error body.
 *
 * Route handlers log the message of the response their testable core returned,
 * and a raw `body["error"].get<std::string>()` throws once that value is an
 * object - turning a 404 log line into a 500. Tolerates the legacy flat shape
 * so this is also safe against a body built elsewhere.
 */
inline std::string error_message_of (const nlohmann::json& body) {
    const auto error = body.find ("error");
    if (error == body.end ()) {
        return {};
    }
    if (error->is_string ()) {
        return error->get<std::string> ();
    }
    if (error->is_object () && error->contains ("message") &&
    (*error)["message"].is_string ()) {
        return (*error)["message"].get<std::string> ();
    }
    return error->dump ();
}

/**
 * @brief Send a JSON error response
 *
 * Dumped with `replace`: a message can quote bytes off the wire or out of an
 * exception, and a strict dump throwing here would turn the error answer itself
 * into httplib's bodiless 500 (#2458).
 */
inline void send_error (httplib::Response& res,
int status,
const std::string& message,
std::string_view code = {}) {
    res.status = status;
    res.set_content (
    error_body (status, message, code).dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
    "application/json");
}

/**
 * Answer the refusal `parse_request_json` returned, logged under @p route
 * (`"POST /collections"`). Dumped with `replace` for `send_error`'s reason: a
 * parse error quotes the bytes it stopped at.
 */
inline void refuse_request_body (httplib::Response& res,
std::string_view route,
const RouteError& refusal) {
    vayu::utils::log_warning (
    "http", std::string (route) + " - " + error_message_of (refusal.body));
    res.status = refusal.status;
    res.set_content (
    refusal.body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
    "application/json");
}

/**
 * @brief Admit a write to file trust (`/file-grants`, `/file-roots`) only
 * when @p req carries the grant secret (`grant_secret.hpp`, #2356); otherwise
 * answer it 403 and return false.
 *
 * Runs before the body is parsed, so a refused write changes nothing. Neither
 * message names the secret or echoes the header.
 */
[[nodiscard]] inline bool admit_file_trust_write (const vayu::http::GrantSecret& secret,
const httplib::Request& req,
httplib::Response& res) {
    if (!secret.configured ()) {
        send_error (res, 403,
        "Refused: this engine was started without a grant secret, so picked "
        "files and allowed folders can be changed only by the Vayu app that "
        "starts the engine",
        "grant_secret_required");
        return false;
    }
    if (!secret.admits (
        req.get_header_value (std::string (vayu::http::GRANT_SECRET_HEADER)))) {
        send_error (res, 403,
        "Refused: a missing or wrong " + std::string (vayu::http::GRANT_SECRET_HEADER) +
        " header. Picked files and allowed folders are changed only by the "
        "Vayu app that starts the engine",
        "grant_secret_required");
        return false;
    }
    return true;
}

/**
 * @brief Send a JSON success response
 */
inline void send_json (httplib::Response& res, const nlohmann::json& data) {
    res.set_content (data.dump (), "application/json");
}

/**
 * @brief Which browser origins a mock server or a webhook inbox grants CORS
 *        access to (#2367). Built once when the listener starts and never
 *        written again, so a handler reads it with no lock.
 *
 * An empty list - the default - is the anonymous answer: every page may read
 * a response, and none may read one its cookies were sent with. A non-empty
 * list grants credentialed access to the origins it names and nothing to any
 * other page.
 */
struct CorsPolicy {
    /// `canonical_origin` spellings, in the order they were configured.
    std::vector<std::string> allowed_origins;

    /// Whether @p origin, an inbound `Origin` value, names a listed origin.
    /// Compared canonical to canonical, so `HTTPS://App.Example:443` matches
    /// `https://app.example`; a value that is not an origin (`null`, empty,
    /// a path) matches nothing.
    [[nodiscard]] bool allows (std::string_view origin) const {
        const auto canonical = canonical_origin (origin);
        return canonical &&
        std::ranges::find (allowed_origins, *canonical) != allowed_origins.end ();
    }
};

/**
 * @brief The origin half of `apply_cors_headers`: false when @p policy grants
 *        this request nothing, in which case nothing was written but `Vary`.
 */
inline bool apply_cors_origin (const httplib::Request& req,
httplib::Response& res,
const CorsPolicy& policy) {
    if (policy.allowed_origins.empty ()) {
        res.set_header ("Access-Control-Allow-Origin", "*");
        return true;
    }
    // Under a list, whether the CORS headers are present at all depends on
    // the Origin, granted or not, so a shared cache must key on it.
    res.set_header ("Vary", "Origin");
    const auto origin = req.get_header_value ("Origin");
    if (!policy.allows (origin)) {
        return false;
    }
    res.set_header ("Access-Control-Allow-Origin", origin);
    res.set_header ("Access-Control-Allow-Credentials", "true");
    return true;
}

/**
 * @brief CORS headers for a listener a browser page may call directly - a
 *        mock server or a webhook inbox, never the management API, which
 *        serves no browser and sends no CORS header (`server.cpp`).
 *
 * The origin follows @p policy. Under the default empty list every response
 * is `Access-Control-Allow-Origin: *` and the request's `Origin` is never
 * read, so no credentials are ever granted: `*` cannot pair with
 * `Allow-Credentials`. Under a list, a listed `Origin` is echoed with
 * `Allow-Credentials: true`, and anything else - an unlisted origin, the
 * literal `null`, no `Origin` at all - gets no `Access-Control-*` header,
 * a preflight included, so the browser keeps the response from the page.
 *
 * Methods and headers reflect the request's own asks rather than a fixed
 * list, since a mock or inbox stands in for an arbitrary real endpoint. A
 * preflight is detected by `Access-Control-Request-Method`, not `method ==
 * "OPTIONS"`: a bare OPTIONS carrying neither is not one and gets no
 * synthesized answer here.
 */
inline void apply_cors_headers (const httplib::Request& req,
httplib::Response& res,
const CorsPolicy& policy) {
    if (!apply_cors_origin (req, res, policy)) {
        return;
    }
    res.set_header ("Access-Control-Expose-Headers", "*");
    if (!req.has_header ("Access-Control-Request-Method")) {
        return;
    }
    res.set_header ("Access-Control-Allow-Methods",
    req.get_header_value ("Access-Control-Request-Method"));
    if (req.has_header ("Access-Control-Request-Headers")) {
        res.set_header ("Access-Control-Allow-Headers",
        req.get_header_value ("Access-Control-Request-Headers"));
    }
    res.set_header ("Access-Control-Max-Age", "600");
}

/**
 * @brief A start payload's optional `allowedOrigins` (#2367) as the list a
 *        `CorsPolicy` holds, or the message to refuse the payload with.
 *
 * Absent and `null` are the default empty list. Anything else must be an
 * array of at most @p max_count strings, each at most @p max_length bytes and
 * an origin by `canonical_origin`, which is the spelling stored. The first
 * entry that is not is named in the refusal rather than skipped: a dropped
 * entry is a page the caller meant to admit, refused without a word.
 */
inline std::expected<std::vector<std::string>, std::string>
parse_allowed_origins (const nlohmann::json& body, std::size_t max_count, std::size_t max_length) {
    const auto field = body.find ("allowedOrigins");
    if (field == body.end () || field->is_null ()) {
        return std::vector<std::string>{};
    }
    if (!field->is_array ()) {
        return std::unexpected (std::string (
        "Invalid 'allowedOrigins': must be an array of origin strings"));
    }
    if (field->size () > max_count) {
        return std::unexpected (std::format (
        "Invalid 'allowedOrigins': at most {} origins may be listed", max_count));
    }
    std::vector<std::string> origins;
    origins.reserve (field->size ());
    for (const auto& entry : *field) {
        const std::string name = std::format ("allowedOrigins[{}]", origins.size ());
        if (!entry.is_string ()) {
            return std::unexpected (
            std::format ("Invalid '{}': must be a string", name));
        }
        const auto& text = entry.get_ref<const std::string&> ();
        if (text.size () > max_length) {
            return std::unexpected (
            std::format ("Invalid '{}': longer than {} bytes", name, max_length));
        }
        auto canonical = canonical_origin (text);
        if (!canonical) {
            return std::unexpected (
            std::format ("Invalid '{}': '{}' {}", name, text, canonical.error ()));
        }
        origins.push_back (std::move (*canonical));
    }
    return origins;
}

/**
 * @brief Whether a replayed example/canned header must be dropped rather
 *        than echoed - `Access-Control-*` or `Vary`.
 *
 * `apply_cors_headers` above already wrote the listener's own CORS answer,
 * and `set_header` / `headers.emplace` both append rather than replace, so a
 * captured or stored header of the same name becomes a duplicate on the wire
 * - which Fetch rejects outright, not merely ignores.
 */
inline bool is_cors_response_header (std::string_view name) {
    static constexpr std::string_view kPrefix = "access-control-";
    if (name.size () >= kPrefix.size () &&
    vayu::utils::ascii_lower_equal (name.substr (0, kPrefix.size ()), kPrefix)) {
        return true;
    }
    return vayu::utils::ascii_lower_equal (name, "vary");
}

/**
 * @brief Rewrite a wildcard `Access-Control-Expose-Headers` for a
 *        credentialed response.
 *
 * Per the Fetch spec, `*` there is the literal header name `*`, not a
 * wildcard, whenever the request's credentials mode is `include`. Only a
 * listed origin under a non-empty `CorsPolicy` can be answered with
 * credentials, and `apply_cors_headers` marks exactly that case with
 * `Access-Control-Allow-Credentials`, which is what this keys on; the default
 * policy's `*` and an unlisted origin's empty answer pass through untouched.
 * Call this as the last statement on every path that writes response
 * headers, so a credentialed page can still read a header an example or
 * canned response set.
 */
inline void finalize_cors_expose_headers (httplib::Response& res) {
    if (!res.has_header ("Access-Control-Allow-Credentials")) {
        return;
    }
    static const std::unordered_set<std::string> kSafelisted{
        "cache-control",
        "content-language",
        "content-length",
        "content-type",
        "expires",
        "last-modified",
        "pragma",
    };
    std::vector<std::string> names;
    std::unordered_set<std::string> seen;
    for (const auto& [name, value] : res.headers) {
        (void)value;
        if (is_cors_response_header (name)) {
            continue;
        }
        const std::string lowered = vayu::utils::ascii_lower (name);
        if (kSafelisted.count (lowered) || !seen.insert (lowered).second) {
            continue;
        }
        names.push_back (name);
    }
    std::string joined;
    for (const auto& name : names) {
        if (!joined.empty ()) {
            joined += ", ";
        }
        joined += name;
    }
    res.headers.erase ("Access-Control-Expose-Headers");
    res.set_header ("Access-Control-Expose-Headers", joined);
}

/**
 * The one null-vs-absent rule for resource writes (POST create / PUT update).
 *
 * Before issue #95 each resource - and in places each *field* - invented its
 * own reading of a null: `collections.variables: null` reset to `{}`,
 * `collections.name: null` meant "keep", and `environments.variables: null`
 * stored the literal four-character string `null` because that handler had no
 * guard at all. The rule below replaces all of that, is identical across
 * collections, requests and environments, and is stated once in
 * `docs/engine/api-reference.md`:
 *
 *   - On create (POST): absent and `null` both mean "use the default".
 *   - On update (PUT): absent means "keep the current value"; `null` means
 *     "reset to the default".
 *   - A field that has no default (a collection's `name`; a request's
 *     `collectionId` / `name` / `method` / `url`) cannot be reset, so `null` is
 *     a 400 on either verb rather than a silently ignored write.
 *
 * The helpers take `is_create` rather than reading it off the request so the
 * cores stay unit-testable without an in-process HTTP server.
 */
inline void apply_string_field (const nlohmann::json& json,
const char* key,
std::string& out,
const std::string& default_value,
bool is_create) {
    if (json.contains (key)) {
        out = json[key].is_null () ? default_value : json[key].get<std::string> ();
    } else if (is_create) {
        out = default_value;
    }
}

/**
 * Same rule for a field stored as a dumped JSON blob (variables, auth, body).
 * `null` resets to `default_value`, which is the blob's canonical default text
 * (e.g. `{}` for variables, `{"mode":"none"}` for a collection's auth).
 *
 * Every field routed through here is **object-shaped**, and the helper rejects
 * anything else with a 400 naming the field. It used to dump whatever it was
 * handed, so `{"variables": 42}` stored `42` and `{"auth": "bearer"}` stored
 * `"bearer"` - blobs that parse as JSON but are not the object each reader
 * expects, and every reader degrades quietly (`parse_variables` yields no
 * variables, `parse_auth` yields no auth, so the request goes out bare). The
 * write returned 200 and the user found out from the wire. That is the same
 * defect the `"null"`-string fix closed, one level up: it removed a bad
 * *value*, this removes a bad *shape*. Array-shaped fields have their own
 * validating helper (`apply_key_value_field` for `params` / `headers`).
 *
 * `[[nodiscard]]` because dropping the returned error is exactly the silent
 * acceptance this helper exists to prevent.
 *
 * A serialized value over `json::MAX_FIELD_SIZE` is refused with a `413`
 * naming the field, its size and the cap, rather than stored (issue #1485):
 * the list route substitutes a default for a column this large when it reads
 * it back, so a write this helper let through could never be read back whole
 * except by id - refusing it here is the one place that keeps the two reads
 * from disagreeing about the same row.
 */
[[nodiscard]] inline RouteResult apply_json_field (const nlohmann::json& json,
const char* key,
std::string& out,
const char* default_value,
bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            out = default_value;
        }
        return {};
    }
    const auto& value = json[key];
    if (value.is_null ()) {
        out = default_value;
        return {};
    }
    if (!value.is_object ()) {
        return route_error (400, std::format ("Invalid '{}': must be a JSON object", key));
    }
    std::string dumped = value.dump ();
    if (dumped.size () > vayu::core::constants::json::MAX_FIELD_SIZE) {
        return route_error (413,
        std::format ("'{}' is {} bytes, over the limit of {}", key,
        dumped.size (), vayu::core::constants::json::MAX_FIELD_SIZE));
    }
    out = std::move (dumped);
    return {};
}

/**
 * Same rule for a field stored as a dumped **array** of KeyValueEntry
 * (`params` / `headers` on a request, `headers` on a saved example). A null
 * resets to `[]`; a present value must be an array whose every entry carries
 * string `key`/`value` and boolean `enabled`. Returns the 400 on a malformed
 * entry.
 *
 * Here rather than in requests.cpp because saved examples store the same shape
 * and must validate it the same way - a second copy would drift the moment the
 * entry shape gains a field.
 */
[[nodiscard]] inline RouteResult
apply_key_value_field (const nlohmann::json& json, const char* key, std::string& out, bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            out = "[]";
        }
        return {};
    }
    const auto& value = json[key];
    if (value.is_null ()) {
        out = "[]";
        return {};
    }
    if (!value.is_array ()) {
        return route_error (
        400, std::format ("Invalid '{}': must be an array of {{key, value, enabled}}", key));
    }
    for (size_t i = 0; i < value.size (); ++i) {
        const auto& entry = value[i];
        if (!entry.contains ("key") || !entry["key"].is_string () ||
        !entry.contains ("value") || !entry["value"].is_string () ||
        !entry.contains ("enabled") || !entry["enabled"].is_boolean ()) {
            return route_error (400,
            std::format ("Invalid {} entry at index {}: missing required field "
                         "(key, value, or enabled)",
            key, i));
        }
    }
    std::string dumped = value.dump ();
    if (dumped.size () > vayu::core::constants::json::MAX_FIELD_SIZE) {
        return route_error (413,
        std::format ("'{}' is {} bytes, over the limit of {}", key,
        dumped.size (), vayu::core::constants::json::MAX_FIELD_SIZE));
    }
    out = std::move (dumped);
    return {};
}

/**
 * Same null-vs-absent rule for `elements` (issue #1513): a null resets to
 * `[]`; a present value must be an array the registry accepts -
 * `vayu::core::Registry::validate` carries the shape check, the kind lookup
 * and each entry's config-schema validation, so this stays a thin wrapper
 * rather than a second copy of any of that.
 */
[[nodiscard]] inline RouteResult apply_elements_field (const nlohmann::json& json,
const char* key,
std::string& out,
bool is_create,
vayu::core::ElementOwner owner = vayu::core::ElementOwner::Request) {
    if (!json.contains (key)) {
        if (is_create) {
            out = "[]";
        }
        return {};
    }
    const auto& value = json[key];
    if (value.is_null ()) {
        out = "[]";
        return {};
    }
    // The engine assigns an `el_` id when the caller sends none (issue #1513's
    // storage contract), validated *after* - a client that names no id at all
    // gets one rather than a 400 asking it to invent one itself. A non-array
    // `value` is left alone; `validate` below is what names that refusal.
    nlohmann::json with_ids = value;
    vayu::core::stamp_default_element_ids (with_ids);
    if (auto reason = vayu::core::Registry::instance ().validate (with_ids, owner)) {
        return route_error (400, *reason);
    }
    out = with_ids.dump ();
    return {};
}

/**
 * Refuse `preRequestScript`, `postRequestScript` and `tests` (issue #1514's
 * cut-over): the owner's decision was a clean cut, not a transitional read/
 * write alias, so every route that used to accept a script as one of these
 * keys now refuses it outright, naming its own replacement field. Checked
 * against every spelling `script_parts.hpp` used to accept (`preRequestScripts`
 * / `postRequestScripts` included), so a caller cannot dodge the refusal by
 * sending the list form instead of the singular one.
 *
 * @p replacement names the field this route actually reads a script.pre/
 * script.post from now - `elements` for every route but a single-target
 * `POST /runs`, whose own script slot is `requestElements` instead (issue
 * #1594): that endpoint's `elements` key means the run-level timers/scripts
 * override, not a script source, so pointing the message at it would send a
 * caller who follows it straight into a second refusal.
 *
 * A plain message rather than a `RouteResult`: callers answer with it two
 * different ways (`route_error` here, a bare 400 in `read_execute_payload`),
 * and the check itself is the same three lines either way.
 */
[[nodiscard]] inline std::optional<std::string>
refuse_legacy_script_fields (const nlohmann::json& json, const char* replacement = "elements") {
    for (const char* key : { "preRequestScript", "preRequestScripts",
         "postRequestScript", "postRequestScripts", "tests" }) {
        if (json.contains (key) && !json[key].is_null ()) {
            return std::format ("'{}' is no longer accepted - scripts are '{}' "
                                "now (a 'script.pre' or 'script.post' entry)",
            key, replacement);
        }
    }
    return std::nullopt;
}

/** Same rule for a boolean field. A non-boolean, non-null value is ignored. */
inline void apply_bool_field (const nlohmann::json& json,
const char* key,
bool& out,
bool default_value,
bool is_create) {
    if (json.contains (key)) {
        if (json[key].is_null ()) {
            out = default_value;
        } else if (json[key].is_boolean ()) {
            out = json[key].get<bool> ();
        }
    } else if (is_create) {
        out = default_value;
    }
}

/** Same rule for an integer field. A non-integer, non-null value is ignored. */
inline void
apply_int_field (const nlohmann::json& json, const char* key, int& out, int default_value, bool is_create) {
    if (json.contains (key)) {
        if (json[key].is_null ()) {
            out = default_value;
        } else if (json[key].is_number_integer ()) {
            out = json[key].get<int> ();
        }
    } else if (is_create) {
        out = default_value;
    }
}

/**
 * The domain's wire values as quoted, comma-separated text, for the "Valid
 * values: ..." tail of a rejection. Built from `all_http_versions()` so the
 * message can never list a different set than the one actually accepted.
 */
inline std::string http_version_valid_list () {
    std::string list;
    for (const auto version : vayu::all_http_versions ()) {
        if (!list.empty ()) {
            list += ", ";
        }
        list += "'" + vayu::to_string (version) + "'";
    }
    return list;
}

/**
 * Same null-vs-absent rule for a field validated against `all_http_versions()`
 * (currently only `httpVersion`, but written generically since the pattern -
 * "a string that must be one of an enumerated set" - is not itself
 * HTTP-version-specific).
 *
 * Unlike `apply_bool_field` / `apply_int_field`, a value that fails validation
 * is a 400, never a silent ignore: a typo'd protocol name quietly running as
 * something else is worse than a rejected write. @p seed is the value used for
 * "absent on create" and "null" on either verb - the caller reads it from the
 * live `defaultHttpVersion` config entry, not a compiled-in constant, so a
 * user-configured global takes effect for new/reset requests.
 *
 * Acceptance goes through `http_version_from_string`, and the 400's
 * valid-values text through `http_version_valid_list()`. Both resolve to
 * `all_http_versions()`, so the set accepted and the set advertised cannot
 * drift apart - a hand-written accept-list here would be exactly the risk
 * `all_http_versions()` exists to prevent.
 */
inline RouteResult apply_http_version_field (const nlohmann::json& json,
const char* key,
std::string& out,
const std::string& seed,
bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            out = seed;
        }
        return {};
    }
    if (json[key].is_null ()) {
        out = seed;
        return {};
    }

    if (json[key].is_string ()) {
        const std::string candidate = json[key].get<std::string> ();
        // Acceptance goes through the domain's own parser rather than a
        // hand-rolled comparison, so this cannot come to disagree with what
        // deserialize_request and the config seed accept.
        if (vayu::http_version_from_string (candidate).has_value ()) {
            out = candidate;
            return {};
        }
        return route_error (400,
        std::format (
        "Invalid '{}': '{}' is not a valid HTTP version. Valid values: {}", key,
        candidate, http_version_valid_list ()));
    }

    return route_error (400,
    std::format ("Invalid '{}': must be a string. Valid values: {}", key,
    http_version_valid_list ()));
}

/**
 * A field with no default: absent on create and `null` on either verb are both
 * 400s, because there is nothing to fall back to. Succeeds when the value is
 * acceptable, "absent on update" (which keeps the stored value) included.
 */
inline RouteResult apply_required_string_field (const nlohmann::json& json,
const char* key,
std::string& out,
bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            return route_error (400, std::format ("Missing required field: {}", key));
        }
        return {}; // Absent on update -> keep.
    }
    if (json[key].is_null ()) {
        return route_error (400,
        std::format (
        "Invalid '{}': null is not allowed (this field has no default)", key));
    }
    out = json[key].get<std::string> ();
    return {};
}

/**
 * `id` is engine-owned (issue #97): every id in the database comes from
 * `generate_id`, so a create that carries one is a 400 rather than a silently
 * honoured - or silently ignored - field. `POST /import/apply` already rejects
 * a per-item `id` the same way (`claim_temp_id` in import.cpp), so neither
 * route lets a client mint ids and the two cannot drift on the answer.
 *
 * Presence alone is the trigger, `null` included. This is the one place the
 * null-vs-absent rule does not apply, because `id` is not a settable field with
 * a default: a payload builder that spreads a whole record into a create body
 * is exactly the caller this catches, and accepting `{"id": null}` would leave
 * it believing the field is honoured.
 */
inline RouteResult reject_client_supplied_id (const nlohmann::json& json) {
    if (!json.contains ("id")) {
        return {};
    }
    return route_error (400,
    "id is assigned by the engine; omit it "
    "(bulk import: POST /import/apply)");
}

/**
 * On update the path parameter is the identity, so a body `id` is at best
 * redundant. A body `id` that disagrees with it is a 400 rather than a silently
 * ignored field: the payload describes a write to two different records, and
 * guessing which one the caller meant is how a PUT to one id carrying another
 * id's body quietly rewrites the wrong record (issue #97).
 *
 * Runs before the record lookup, so the answer to a malformed body does not
 * depend on whether the target happens to exist.
 */
inline RouteResult reject_mismatched_body_id (const nlohmann::json& json,
const std::string& path_id) {
    if (!json.contains ("id")) {
        return {};
    }
    if (json["id"].is_string () && json["id"].get<std::string> () == path_id) {
        return {};
    }
    return route_error (400,
    std::format ("Body 'id' must match the id in the path ('{}') or be omitted", path_id));
}

/**
 * The per-resource field appliers, shared by the single-resource create/update
 * cores and by `POST /import/apply` (issue #96). Bulk import must store exactly
 * what `POST /<resource>` would store, so it calls these rather than
 * re-deriving the null-vs-absent rule or the per-field validation - a second
 * copy would drift the moment a field is added.
 *
 * Each fails with the response to send when a no-default field is missing or
 * null (or, for collections, when the proposed parent would form a cycle).
 * `is_create` selects the absent-field behaviour; see the rule above. Defined
 * in collections.cpp / requests.cpp / environments.cpp.
 */
RouteResult apply_collection_fields (vayu::db::Database& db,
vayu::db::Collection& c,
const nlohmann::json& json,
bool is_create);
RouteResult apply_request_fields (vayu::db::Database& db,
vayu::db::Request& r,
const nlohmann::json& json,
bool is_create);
RouteResult apply_environment_fields (vayu::db::Environment& e,
const nlohmann::json& json,
bool is_create);
/**
 * Saved example responses (issue #481) follow the same rule, and the same
 * shared-applier reason: `POST /import/apply` writes examples nested under
 * their request item, so both paths must agree on what a field means and where
 * the body cap sits. Defined in examples.cpp.
 */
RouteResult apply_request_example_fields (vayu::db::RequestExample& x,
const nlohmann::json& json,
bool is_create);

/**
 * Consecutive `order`s for the rows a batch writer (`POST /import/apply`,
 * `POST /specs/sync`) creates without stating one. The single-row default,
 * `Database::next_sibling_order`, reads rows that are stored, and none of a
 * batch's own are yet, so every sibling would land on one number. Each parent
 * starts at that append point and counts up across both kinds (#2535): rows
 * taken in the order the batch builds them, folders before requests.
 */
class SiblingSlots {
    public:
    /// The next slot under @p parent (`std::nullopt` for the roots).
    int take (vayu::db::Database& db, const std::optional<std::string>& parent) {
        auto slot = next_.find (parent);
        if (slot == next_.end ()) {
            slot = next_.emplace (parent, db.next_sibling_order (parent)).first;
        }
        return slot->second++;
    }

    private:
    std::map<std::optional<std::string>, int> next_;
};

/**
 * Hex-encoded SHA-256 of an OpenAPI document's text (issue #637) - what
 * `spec_documents.hash` stores and what a run's snapshot is stamped with.
 * Defined in specs.cpp.
 */
std::string spec_content_hash (const std::string& content);

/**
 * The live `maxSpecDocumentBytes` cap, read fresh per write. Shared by
 * `POST /specs` and `POST /import/apply` so the two cannot enforce different
 * limits. Defined in specs.cpp.
 */
size_t spec_size_cap (vayu::db::Database& db);

/**
 * Pre-routing guard for the three import routes that carry a whole document in
 * their body (`POST /import`, `/import/parse`, `/import/document`): answers 413
 * from the `Content-Length` header, before cpp-httplib buffers the body, when it
 * exceeds the live `maxSpecDocumentBytes` plus JSON-escaping headroom. The
 * route's own exact check on the document still runs after the parse (#1782).
 * Defined in import.cpp.
 */
httplib::Server::HandlerResponse reject_oversized_import (vayu::db::Database& db,
const httplib::Request& req,
httplib::Response& res);

/**
 * Puts a spec write's two indexes onto @p spec - `operations` (issue #629) and
 * `responseSchemas` (issue #628) - **both derived here from `spec.content`**
 * (issues #853 and #860), returning the caller-facing error when the document
 * cannot be read or its schema index is over the cap. A caller that sends
 * either gets a `400`: they are the engine's to compute, like `hash`.
 *
 * One copy for all three writers - `POST /specs`, `POST /import/apply`'s spec
 * section and `POST /specs/sync` - because a document stored through one path
 * and re-stored through another must carry the same indexes, or a run's
 * coverage and its verdicts would depend on how the document arrived. A
 * document declaring no operation leaves the column empty, which is "no index",
 * not "declares nothing". Requires `spec.content` to be set already, which every
 * caller does before the hash. Defined in specs.cpp.
 *
 * @param index_cap Bytes the serialized `responseSchemas` index may occupy -
 *        `spec_size_cap(db)`, the document's own cap rather than a second knob.
 * @param document_out Optional: the DOM the indexes were derived from, moved out
 *        for a caller that needs the document itself as well. `POST /specs/sync`
 *        does - it writes the example rows the stored document documents (issue
 *        #869) - and taking the DOM from here rather than reading the same bytes
 *        again is what keeps one read behind everything one write says about a
 *        document. Untouched when the read fails.
 */
std::optional<std::string> read_spec_indexes (const nlohmann::json& item,
vayu::db::SpecDocument& spec,
size_t index_cap,
nlohmann::ordered_json* document_out = nullptr);

/**
 * The example rows one draft request's documented responses become, in the shape
 * a write of them takes (issue #869).
 *
 * Shared by `POST /specs/diff`, which reports what an apply would write, and
 * `POST /specs/sync`, which writes it - so the rows a caller is shown and the
 * rows the engine stores are one answer rather than two. Defined in specs.cpp.
 */
nlohmann::json draft_example_rows (const std::vector<vayu::core::DraftExample>& examples);

/**
 * Every collection at or beneath @p root, from one read of the table.
 *
 * One walk for the three routes that answer for a collection's whole contract -
 * `POST /specs/sync`, which refuses to touch anything outside it,
 * `POST /specs/match`, which has to gather the requests inside it, and
 * `POST /specs/export`, which assembles them into a document. An OpenAPI import
 * binds the root and files its requests under one sub-collection per tag, so
 * "the collection" means the subtree to all of them, and three walks would be
 * three chances to disagree about where a contract stops. Defined in
 * spec_sync.cpp.
 *
 * @param descend_into Optional boundary: a child it refuses is left out with its
 *        own descendants. The export passes one, because a collection bound to a
 *        *different* document is where this contract stops (issue #721); the
 *        other two take the whole subtree and pass nothing.
 */
std::unordered_set<std::string> collection_subtree_ids (
const std::vector<vayu::db::Collection>& all,
const std::string& root,
const std::function<bool (const vayu::db::Collection&)>& descend_into = {});

/**
 * Every request stored beneath @p subtree, in one canonical order.
 *
 * Shared by `POST /specs/match`, `POST /specs/bind` (issue #862) and
 * `POST /specs/diff` (issue #854) because a preview and the write it previews
 * must consider the same requests in the same order - each of those routes
 * reports indices into this list, and a write that walked its own would act on a
 * pairing the preview never showed. Defined in spec_sync.cpp, beside the subtree
 * walk it completes.
 */
std::vector<vayu::db::Request> collection_subtree_requests (vayu::db::Database& db,
const std::vector<vayu::db::Collection>& all,
const std::unordered_set<std::string>& subtree);

/**
 * The `specId` a collection's own binding names, or "" when it binds nothing.
 *
 * Shared by `POST /specs/sync` and `POST /specs/diff`, which have to agree about
 * which collections can be synced at all. Defined in spec_sync.cpp.
 */
std::string bound_spec_id (const std::string& openapi);

/**
 * The identity as `requests.spec_operation` stores it, and as every spec route
 * answers with it.
 *
 * `operationId` is **absent** rather than `""` for an operation that declares
 * none: an operation with no id is not one whose id is empty. Defined in
 * spec_diff.cpp.
 */
nlohmann::json spec_operation_json (const vayu::core::DeclaredOperation& operation);

/**
 * The request an import of a document would build, in the shape a write of it
 * takes - `{name, description, method, url, params, headers, body}`.
 *
 * Shared by `POST /specs/diff`, which reports it as the `draft` behind every
 * `next` value, and by a `"safe"` `POST /specs/sync`, which creates the
 * operations a document added and must build exactly the request the diff said
 * it would. `examples` is not here: a sync derives those rows from the document
 * it stores (issue #869) and the diff adds them to its own answer. Defined in
 * spec_diff.cpp.
 */
nlohmann::json draft_request_fields_json (const vayu::core::DraftRequest& draft);

/**
 * The three-way comparison behind both `POST /specs/diff` and a `"safe"`
 * `POST /specs/sync` (issue #871).
 *
 * Its members are what a caller has to hold together to read a
 * `vayu::core::SpecDiff` at all: the diff indexes into the fetched drafts and
 * into the subtree's requests, so the two lists travel with it. Defined in
 * spec_diff.cpp.
 */
struct SpecComparison {
    /// The re-fetched document as drafts - the values an apply writes.
    std::vector<vayu::core::SpecRequestDraft> fetched;
    /**
     * The subtree's requests as the comparison read them, in
     * `collection_subtree_requests` order - which is the order `SpecDiff`'s
     * indices are into.
     */
    std::vector<vayu::core::ComparableRequest> requests;
    /// The stored bytes the comparison was made against.
    std::string bound_content;
    vayu::core::SpecDiff diff;
};

/**
 * Compares @p fetched_document against the document @p spec_id names and against
 * every request beneath @p subtree, filling @p out.
 *
 * One function for the route that says what would change and the route that
 * changes it, for the reason every other shared spec helper exists: a sync
 * applying a comparison it made differently from the one it previewed would
 * write rows nobody was shown. The caller has already established that the
 * collection exists, that it binds something, and that the document reads - so
 * the only failure left here is a binding naming a document the store no longer
 * holds, returned as the `409` both routes give it. Defined in spec_diff.cpp.
 */
RouteResult compare_bound_spec (vayu::db::Database& db,
const std::vector<vayu::db::Collection>& collections,
const std::unordered_set<std::string>& subtree,
const std::string& spec_id,
const nlohmann::ordered_json& fetched_document,
SpecComparison& out);

/**
 * What a design-mode response should be checked against (issue #628).
 *
 * `bound == false` is the one state that means **no verdict node at all**: the
 * request's collection ancestry binds no document, so nothing here was ever
 * measured against a contract. When `bound`, exactly one of `index` and
 * `reason` is set.
 */
struct DesignSchemaResolution {
    bool bound = false;
    std::optional<vayu::core::UncheckedReason> reason;
    std::optional<vayu::core::ResponseSchemaIndex> index;
    /// The request's stored `spec_operation` text, `""` when it carries none.
    std::string spec_operation;
};

/**
 * Resolves the bound document's response-schema index for one stored request,
 * walking its collection ancestry for the nearest binding. Defined in specs.cpp.
 */
DesignSchemaResolution resolve_design_schema_index (vayu::db::Database& db,
const std::optional<std::string>& request_id);

/**
 * The verdict one design-mode response gets (issue #628), or `std::nullopt`
 * when the request's collection ancestry binds no document - the state that
 * means no verdict node at all. Defined in specs.cpp.
 */
std::optional<vayu::core::ValidationVerdict> validate_design_response (vayu::db::Database& db,
const std::optional<std::string>& request_id,
const vayu::Response& response);

/**
 * Rejects a collection write whose `openapi` binding names a spec that will not
 * exist once the write lands (issue #637).
 *
 * Outside `apply_collection_fields` for the same reason `reject_missing_collection`
 * is outside `apply_request_fields`: `POST /import/apply` runs the applier over
 * rows whose spec section is still unwritten, so an existence check inside it
 * would refuse a legal bulk import. @p pending names what the caller is about to
 * write in the same transaction; every path but import passes an empty set.
 * Defined in specs.cpp.
 */
RouteResult reject_unbindable_spec (vayu::db::Database& db,
const std::string& openapi,
const std::unordered_set<std::string>& pending);

/**
 * Fills in the `specHash` / `syncedAt` a binding was written without, from the
 * stored document it names (issue #709). Rewrites @p openapi in place; a
 * binding that is unbound, complete, or names a document this database does not
 * hold is left exactly as it was.
 *
 * Called by every collection write path immediately after
 * `reject_unbindable_spec` and inside the same lock scope, because the two ask
 * about the same row and the stamp must not be taken from a document a
 * concurrent `DELETE /specs/:id` is about to remove. A client sends the
 * `specId` - the only half it can know without a round trip whose answer would
 * be stale by the time it wrote it - and the engine supplies the version, the
 * same division `spec_documents.hash` draws. Defined in specs.cpp.
 */
void stamp_binding_from_store (vayu::db::Database& db, std::string& openapi);

/**
 * The outcome of resolving `pm.info.requestName` for a `POST /execute` payload.
 *
 * `name` absent is a normal answer, not a failure: an ad-hoc request has no
 * name, and a script must read `undefined` rather than `""`. `ok == false` is
 * the loud path - the payload carried a `requestName` of the wrong type, which
 * is a client bug and answers `400` instead of being silently dropped.
 */
struct RequestNameResolution {
    bool ok = true;
    std::string error;
    std::optional<std::string> name;
};

/**
 * Resolve the name for @p request_id / @p json's `requestName` field.
 *
 * Extracted from the `POST /execute` handler (execution.cpp) so
 * script_info_test.cpp can drive it against a real database, matching the
 * suite's other route-core tests.
 */
RequestNameResolution resolve_script_request_name (vayu::db::Database& db,
const nlohmann::json& json,
const std::optional<std::string>& request_id);

/**
 * The outcome of reading one of `POST /execute`'s boolean opt-outs:
 * `transient` (issue #382), `persistVariables` (#1904) or `includeParsedBody`
 * (#2544).
 *
 * `value` is what the payload asked for, or the flag's default when it is
 * absent or `null`; `ok == false` means the field was present with a
 * non-boolean type, which is a `400` rather than a silent default.
 */
struct ExecuteFlag {
    bool ok = true;
    std::string error;
    bool value = false;
};

/**
 * Read the `transient` flag off a `POST /execute` payload (default `false`).
 *
 * Extracted from the handler (execution.cpp) so transient_execute_test.cpp can
 * drive it directly, matching the suite's other route-core tests.
 */
ExecuteFlag read_transient_flag (const nlohmann::json& json);

/**
 * Read the `persistVariables` flag off a `POST /execute` payload (default
 * `true`). `false` runs every script and extractor as usual but writes none of
 * the variables they set back to the environment, the collection or the
 * globals (#1904); the MCP server sends it while write access is off.
 */
ExecuteFlag read_persist_variables_flag (const nlohmann::json& json);

/**
 * Read the `includeParsedBody` flag off a `POST /execute` payload (default
 * `true`). `false` answers `body: null` and skips the parse that builds it
 * (issue #2544); `bodyRaw`, the stored trace and the scripts are unchanged.
 */
ExecuteFlag read_include_parsed_body_flag (const nlohmann::json& json);

/**
 * The outcome of reading a payload's `stream` flag and its caps (issue #573;
 * `POST /runs` reads it through here too since #576).
 *
 * `ok == false` carries the 400 the route answers with. Every rejection here is
 * loud rather than a fallback, because the flag changes the *execution model* -
 * a caller that believed it asked for a stream and got a buffered send would
 * wait for a response that never comes, and one that believed its cap applied
 * would get an unbounded run.
 */
struct StreamFlag {
    bool ok = true;
    std::string error;
    bool value = false;
    /// Present only when the payload named one; absent means the configured
    /// default. Kept as absent-vs-value rather than pre-resolved so the run
    /// records which caps the *caller* chose.
    std::optional<int64_t> max_duration_ms;
    std::optional<int64_t> max_events;
};

/**
 * Read `stream`, `maxStreamDurationMs` and `maxStreamEvents` off a
 * `POST /execute` or `POST /runs` payload, and refuse the combinations that
 * cannot mean anything.
 *
 * **Both endpoints read through this one function** (issue #576), so the two
 * cannot drift on what a cap is called, what type it takes or what range it
 * accepts - a load run declares a stream in exactly the spelling a send does.
 * What differs is downstream and not here: `POST /execute` hands the transfer
 * to `SseStreamManager` and relays its events live, while `POST /runs` turns
 * the caps into `Request::stream_bounds` and lets the load event loop end the
 * transfer by them.
 *
 * One combination is refused, because a stream **is** its run row:
 * `transient: true` asks for no row at all - there would be nothing for
 * `eventsUrl` to name, nothing to carry the status, and nothing for
 * `POST /runs/:id/stop` to find. (`POST /runs` never reaches that check: it
 * rejects `transient` before this runs.)
 *
 * Scripts were refused here too until phase 3 (issue #575). They now run: the
 * pre-request script before the transfer starts, exactly as on a buffered send,
 * and the post-request script once the stream has terminated, reading the
 * bounded event list as `pm.response.events`.
 *
 * Extracted from the handler so sse_stream_test.cpp can drive it directly,
 * matching the suite's other route-core tests.
 */
StreamFlag read_stream_flag (const nlohmann::json& json);

/**
 * Who started a run, as the starting client asserted it (#1817).
 *
 * Metadata, not identity: any caller of the API can claim any kind, so nothing
 * may authorise on it. History reads it to say which runs an agent made.
 */
struct RunOrigin {
    std::string kind = "other";
    /// The MCP client's `clientInfo.name`; only ever set for kind `mcp`.
    std::optional<std::string> client;
};

/// What `origin.kind` may be. `other` is also what a payload that names no
/// origin, and a run stored before the field existed, reads as.
inline constexpr std::array<std::string_view, 3> RUN_ORIGIN_KINDS{ "app", "mcp", "other" };

/// The longest `origin.client` kept, in characters (code points, so the cut
/// never splits a UTF-8 sequence).
inline constexpr std::size_t MAX_RUN_ORIGIN_CLIENT_CHARS = 128;

[[nodiscard]] inline bool is_run_origin_kind (std::string_view kind) {
    return std::ranges::find (RUN_ORIGIN_KINDS, kind) != RUN_ORIGIN_KINDS.end ();
}

/**
 * Read the optional `origin` object off a `POST /execute` or `POST /runs`
 * payload, before any run row exists.
 *
 * Absent or `null` is `{other, no client}`. A non-object, a `kind` outside
 * `RUN_ORIGIN_KINDS` (missing included) or a non-string `client` is the 400's
 * message, naming the field. `client` is kept for `mcp` only, trimmed and cut
 * to `MAX_RUN_ORIGIN_CLIENT_CHARS`, and an empty one is no client; otherwise it
 * is stored exactly as sent, because the display name is the renderer's job.
 *
 * Non-static so run_origin_test.cpp can drive it directly.
 */
std::expected<RunOrigin, std::string> read_run_origin (const nlohmann::json& json);

/**
 * Read an optional string member off a `POST /execute` or `POST /runs` payload
 * (`requestId`, `environmentId`), before any run row exists.
 *
 * Absent or `null` is no value. Any other type is the 400's message, naming the
 * field: nlohmann's `get<std::string>` would otherwise throw a `type_error` that
 * the server answers as a 500 with an empty body.
 *
 * Non-static so transient_execute_test.cpp can drive it directly.
 */
std::expected<std::optional<std::string>, std::string>
read_optional_string_field (const nlohmann::json& json, const char* key);

/**
 * The outcome of reading `POST /execute`'s `data` row (issue #601).
 *
 * `value` is the row itself when the payload carried one, and `nullopt` when it
 * did not - which is the ordinary send and must stay distinguishable from a row
 * that happens to be empty, since `pm.iterationData` reads `undefined` for one
 * and an empty scope for the other.
 *
 * `ok == false` carries the 400 the route answers with, and every rejection is
 * loud for the reason the whole `{{data.column}}` namespace exists: a token says
 * the value came from the file, so a row the engine could not read must never
 * become a send with the token still written in it.
 */
struct DataRow {
    bool ok = true;
    std::string error;
    std::optional<nlohmann::json> value;
};

/**
 * Read the `data` row off a `POST /execute` payload, bounded by @p max_bytes
 * (the `maxScenarioDataBytes` setting - one row here, where a run's whole set is
 * measured against it).
 *
 * The row must be a JSON object of name/value pairs, exactly as a
 * `scenario.data` row must be (`parse_scenario_request`): anything else has no
 * column a `{{data.column}}` token or `pm.iterationData.get` could name.
 *
 * Extracted from the handler (execution.cpp) so send_with_row_test.cpp can drive
 * it directly, matching the suite's other route-core tests.
 */
DataRow read_data_row (const nlohmann::json& json, size_t max_bytes);

/**
 * How a send-with-row's credentials are resolved (issue #642).
 *
 * `resolution` is what `build_request` must be told, and it is `Defer` exactly
 * when `credentials` is non-empty or `after_scripts` is set: a `{{data.column}}`
 * inside a credential has to carry the row's value *before* `apply_auth`
 * collapses a username and a password into one base64 `Authorization` value,
 * since after that the token is unreadable and goes out as base64 of its own
 * literal text (issue #591), and a name the pre-request script may define has
 * to wait for that script for the same reason (issue #2473). The ordinary send
 * - every credential static - keeps resolving auth inside the build, byte for
 * byte as it did before this existed.
 *
 * `ok == false` carries the 400 the route answers with. There is one: an
 * OAuth 2.0 config carrying a token deferral would otherwise bind, which no
 * deferral can serve.
 */
struct SendRowAuth {
    bool ok = true;
    std::string error;
    /// The parsed, still-unbound auth - `bind_auth_row`'s input, not the
    /// payload's, because the join addresses a credential by its position in
    /// the walk over *this* value.
    vayu::http::Auth auth;
    /// The credentials split around their tokens; empty when none carries one.
    vayu::core::StepDataTemplate credentials;
    /// A credential holds a name only the scopes answer
    /// (`core::credentials_await_scripts`): the bind joins the row into `auth`
    /// without applying it (`core::bind_iteration_holding_auth`), and the
    /// exchange applies it after the pre-request script
    /// (`apply_late_auth`). A single-request load run carries it into
    /// `core::LoadAuthPlan::after_scripts` when it declares `requestElements`;
    /// a collection run decides it per step when its plan resolves
    /// (`core::ScenarioStep::auth_after_scripts`).
    bool after_scripts                    = false;
    vayu::http::AuthResolution resolution = vayu::http::AuthResolution::Apply;
};

/**
 * Decide how `POST /execute` resolves the credentials of a send carrying a row.
 *
 * The half of the sequence that must happen **before** the request is built;
 * `vayu::core::bind_auth_row` is the half that happens after, and the two are
 * split exactly there because `build_request` sits between them.
 *
 * An ordinary send - a credential spelling no token at all - returns `Apply`
 * with an empty template and no refusal, having parsed nothing. Whether the
 * send carries a *row* is deliberately not asked (issue #1055): a credential
 * carrying only the `{{$vu}}` / `{{$iteration}}` identity is bindable without
 * one, and a `{{data.*}}` that does need a row is refused by name at the bind,
 * the way the same token in the URL already was.
 *
 * @p bound_columns are the bare names the row can bind (issue #1007), so a
 * credential written `{{username}}` is deferred and joined against the row the
 * way `{{data.username}}` always was. Empty for a send with no row, and for a
 * caller that has not read the row's columns - which resolves those names from
 * the scopes, as it did before there was a row to ask.
 *
 * Extracted from the handler (execution.cpp) so send_with_row_test.cpp can
 * drive it directly, matching the suite's other route-core tests.
 */
SendRowAuth plan_send_row_auth (const nlohmann::json& json,
const vayu::http::BoundColumnNames& bound_columns = {});

/**
 * The outcome of reading `POST /runs`' top-level `data` rows (issue #993).
 *
 * `set` is null when the payload carried none - the ordinary load run, which
 * must stay distinguishable from a run whose rows happen to be empty, since a
 * present-but-empty array is refused rather than run.
 *
 * `ok == false` carries the 400 the route answers with. Every rejection is loud
 * for the reason the whole `{{data.column}}` namespace exists: a token says the
 * value came from the file, so a set the engine could not read must never
 * become a run that sends the token as it stands.
 */
struct LoadDataRows {
    bool ok = true;
    std::string error;
    std::unique_ptr<vayu::core::LoadDataSet> set;
    /// How this run's credentials resolve (issue #1055), read off the same
    /// payload. Carried beside @ref set rather than inside it because a
    /// credential spelling `{{$vu}}` defers on a run that has no rows at all;
    /// default - and so `Apply` - for a scenario run, whose steps resolved
    /// their own auth when the plan did.
    vayu::core::LoadAuthPlan auth;
};

/**
 * Read the `data` rows off a `POST /runs` payload, bounded by @p limits (the
 * `maxScenarioDataRows` / `maxScenarioDataBytes` settings - the same bounds a
 * collection run's set is held to).
 *
 * Two things at once, because both must happen before any run row exists: the
 * rows are validated through `core::read_data_rows`, and the credentials are
 * planned through `plan_send_row_auth` - the build is what would otherwise
 * base64 a `{{data.column}}` out of reach, so how it resolves auth has to be
 * decided before it runs.
 *
 * @p is_scenario refuses the field by name: a collection run states its rows as
 * `scenario.data`, where they are bound per iteration and shared by every step,
 * and a payload carrying both would have one of the two silently dropped. The
 * same holds for `dataFileName` / `dataFileHash` (issue #2051) and
 * `dataFileCastNumbers` (issue #2540), which otherwise ride the set through
 * `core::read_data_file_fields`.
 *
 * Extracted from the handler (execution.cpp) so load_data_test.cpp can
 * drive it directly, matching the suite's other route-core tests.
 */
LoadDataRows read_load_data_set (const nlohmann::json& json,
const vayu::core::ScenarioLimits& limits,
bool is_scenario);

/**
 * The stream-only half of a recorded design result (issue #573).
 *
 * Passed to `record_design_result` rather than written by the stream worker
 * itself, so "what a design run persists" stays one decision in one place -
 * including the transient rule, which a second recording path would have to
 * remember to honour.
 */
struct StreamRecord {
    /// The bounded `events` node, from `stream_trace_node`.
    nlohmann::json events;
    /// The run's terminal status. A stream that was stopped is `Stopped`, which
    /// is neither the `Completed` nor the `Failed` the response alone implies.
    vayu::RunStatus status = vayu::RunStatus::Completed;
};

/**
 * @brief Record a finished design execution against its run row.
 *
 * Writes the result trace, moves the run to its terminal status, and trims the
 * run history. Logs on failure rather than throwing: a storage problem must not
 * turn a request the user already sent into an error.
 *
 * @param run_id `std::nullopt` for a **transient** execution (issue #382),
 *        which records nothing at all - the single choke point that rule lives
 *        at.
 * @param stream The streaming additions, or nullptr for an ordinary send.
 * @param validation The schema verdict this response already got (issue #628),
 *        stored verbatim on the trace. `std::nullopt` writes no node, which is
 *        what an unbound collection - and a stream, whose body is an event
 *        stream rather than a document any response schema describes - means.
 * @param scripts What this send's scripts produced, from
 *        `build_script_result_node` - the *same* object the buffered path also
 *        returns in its `/execute` body (issue #725). A property of the
 *        execution rather than of the transport, which is why it is a parameter
 *        here and not a `StreamRecord` field: a send whose results were stored
 *        only when it happened to stream is how a restored Tests tab came to be
 *        empty for every ordinary send. An empty object writes no node, so a
 *        request with no scripts stores nothing.
 */
void record_design_result (vayu::db::Database& db,
const std::optional<std::string>& run_id,
const vayu::Request& request,
const vayu::Response& response,
const StreamRecord* stream                                     = nullptr,
const std::optional<vayu::core::ValidationVerdict>& validation = std::nullopt,
const nlohmann::json& scripts = nlohmann::json::object (),
/// This exchange's element outcomes (issue #1514), the same array
/// `build_response_json` also returns - one object, two homes, on the
/// `scripts` precedent above. An empty array writes no node.
const nlohmann::json& elements = nlohmann::json::array (),
/// `timing.engineMs` of the live body (issue #2132), stored flat on the trace
/// beside `totalMs` so a restored response shows the figure the live one did.
/// Absent for a send that measured none: a stream, the auth-failure reply.
std::optional<double> engine_ms = std::nullopt);

/** Where one `GET /runs/:id/live` stream has got to between polls. */
struct LiveMetricsCursor {
    /// The id of the next tick to send.
    size_t offset = 0;
    /// When the stream first found the run closed with every tick sent, which
    /// starts `LIVE_SETTLE_TIMEOUT_MS`. Empty until then.
    std::optional<std::chrono::steady_clock::time_point> drained_since;
};

/** What one poll of `GET /runs/:id/live` sends, in this order. */
struct LiveMetricsStep {
    /// Tick frames, already framed. Empty means nothing new arrived.
    std::vector<std::string> ticks;
    /// The `event: complete` frame. Set means the stream ends after it.
    std::optional<std::string> completion;
};

/**
 * One poll of the live metrics stream: the ticks since @p cursor, and the
 * `complete` frame once the run is closed, drained and settled - or once
 * `LIVE_SETTLE_TIMEOUT_MS` has passed since it was first closed and drained,
 * in which case the frame carries a status only if the row already has one.
 *
 * @p now is the caller's clock, so the bound is testable without waiting.
 * Defined in metrics.cpp; live_metrics_route_test.cpp drives it directly.
 */
LiveMetricsStep live_metrics_step (vayu::db::Database& db,
const std::string& run_id,
const vayu::core::RunContext& context,
LiveMetricsCursor& cursor,
std::chrono::steady_clock::time_point now);

/**
 * Testable core of `GET /runs/:id/report`: `{http_status, json_body}`, 404 for
 * a missing run. Defined in runs.cpp; `POST /export/run-report` reads it too.
 *
 * A load run that is not terminal reads none of its `results` rows (#2659):
 * until its summary is stored, its counts come from the context @p live_runs
 * holds for it (active or retained), and are zero when there is none - null
 * @p live_runs included. A terminal run's report never reads the context.
 */
std::pair<int, nlohmann::json> run_report_response (vayu::db::Database& db,
const std::string& run_id,
vayu::core::RunManager* live_runs = nullptr);

/**
 * Testable core of `GET /runs/:id/metrics`: one `{data, pagination}` page of
 * the run's ticks, 404 for a missing run. @p limit and @p offset arrive
 * clamped (at most `RUN_TIME_SERIES_PAGE_MAX` ticks a page). Defined in
 * metrics.cpp; `POST /export/run-report` pages it to the end.
 *
 * With @p max_points set (#2547), @p limit and @p offset are ignored and the
 * whole series comes back as at most that many ticks: every stored tick when
 * it fits, otherwise runs of `ceil(total / max_points)` consecutive ticks each
 * folded through a `MetricTickBucket`. The envelope then adds `bucketed` and
 * `ticksPerBucket`, which the paged answer never carries.
 */
std::pair<int, nlohmann::json> run_time_series_response (vayu::db::Database& db,
const std::string& run_id,
int64_t limit,
int64_t offset,
std::optional<int64_t> max_points = std::nullopt);

/**
 * Testable core of `GET /runs/:id/monitor`: one `{data, pagination}` page of
 * the server-vitals samples scraped during the run, 404 for a missing run, an
 * empty `data` for a run that configured no monitor. Defined in metrics.cpp.
 *
 * @p max_points behaves as it does for `run_time_series_response`, with
 * `MonitorSampleBucket` folding the samples: @p limit and @p offset are
 * ignored, a series of at most @p max_points samples comes back raw, and the
 * envelope adds `bucketed` and `ticksPerBucket` (the samples a bucket folds,
 * named for the key the tick series already uses).
 */
std::pair<int, nlohmann::json> run_monitor_series_response (vayu::db::Database& db,
const std::string& run_id,
int64_t limit,
int64_t offset,
std::optional<int64_t> max_points = std::nullopt);

/// The most ticks one `run_time_series_response` page returns.
constexpr int64_t RUN_TIME_SERIES_PAGE_MAX = 50000;

/**
 * The `maxPoints` query parameter of `GET /runs/:id/metrics`: a positive
 * integer capped at `RUN_TIME_SERIES_PAGE_MAX`. Anything else is
 * `std::nullopt`, the same answer as an absent parameter, so a malformed
 * value falls back to the paged series the way a malformed `limit` falls back
 * to its default. Defined in metrics.cpp.
 */
std::optional<int64_t> parse_max_points (std::string_view raw);

/**
 * Folds consecutive stored ticks of `GET /runs/:id/metrics` into one (#2547).
 *
 * Most tick fields are cumulative (run totals, run-long rates, the status-code
 * map, `custom_metrics`), so a folded tick is its bucket's *last* tick, with
 * these keys replaced:
 *
 * - `latency_p50_ms` / `latency_p95_ms` / `latency_p99_ms`: the max over the
 *   bucket, its worst second. Each row's percentile is of its own second, so
 *   the max is an upper bound on the bucket's percentile, never an estimate of
 *   it; `0` is a second with no completion.
 * - `current_concurrency`, `backpressure`: the max.
 * - `current_rps`, `current_send_rate`: the mean of the bucket's ticks.
 * - `window_avg_latency_ms`, `window_avg_queue_wait_ms` (#2393): the mean over
 *   the ticks that carried a number, `null` when none did (every second idle).
 *   The run's own mean over the bucket would weight each second by its
 *   completions; this one weights the seconds equally, as the chart plots them.
 *
 * Any other key, recognised or not, is the last tick's. A key no tick in the
 * bucket carried is never added, and a bucket of one tick is that tick
 * unchanged. Defined in metrics.cpp.
 */
class MetricTickBucket {
    public:
    /// Fold in the next tick, in stored order.
    void add (nlohmann::json tick);
    [[nodiscard]] bool empty () const;
    /// The folded tick. The bucket is empty again afterwards.
    [[nodiscard]] nlohmann::json take ();

    private:
    nlohmann::json last_;
    nlohmann::json maxima_ = nlohmann::json::object ();
    size_t ticks_          = 0;

    /// A key averaged over the ticks that carried a number for it.
    struct Mean {
        double sum    = 0.0;
        size_t ticks  = 0;
        bool seen_key = false; // Present (maybe null) on some tick.
    };
    std::map<std::string, Mean, std::less<>> means_;
};

/**
 * Folds consecutive stored samples of `GET /runs/:id/monitor` into one (#2611).
 *
 * A sample is `{timestamp, series: {name: number}}` with no cumulative field,
 * so the folded sample takes the *last* sample's `timestamp` and, for every
 * `series` name, the max over the bucket's samples that carried it. The max
 * suits a gauge (cpu, memory, queue depth: the bucket's worst moment, which a
 * mean would hide) and equals the last value for a monotone counter. A name no
 * sample in the bucket carried is never added, a non-number value is skipped,
 * and a bucket of one sample is that sample unchanged. Defined in metrics.cpp.
 */
class MonitorSampleBucket {
    public:
    /// Fold in the next sample, in stored order.
    void add (nlohmann::json sample);
    [[nodiscard]] bool empty () const;
    /// The folded sample. The bucket is empty again afterwards.
    [[nodiscard]] nlohmann::json take ();

    private:
    nlohmann::json last_;
    nlohmann::json maxima_ = nlohmann::json::object ();
    size_t samples_        = 0;
};

/**
 * Testable core of `POST /export/run-report` (#2127): a finished load run as
 * a shareable document (`core/run_export.hpp`), nothing written. Defined in
 * run_export.cpp.
 */
std::pair<int, nlohmann::json>
export_run_report_response (vayu::db::Database& db, const nlohmann::json& json);

/**
 * The one wrapper every export route answers through: parse the body, run
 * @p core, log a refusal, serialise with invalid UTF-8 replaced. Defined in
 * postman_export.cpp.
 */
void answer_export (const char* path,
const httplib::Request& req,
httplib::Response& res,
std::pair<int, nlohmann::json> (*core) (vayu::db::Database&, const nlohmann::json&),
vayu::db::Database& db);

/**
 * @brief Callback type for graceful shutdown
 * Called when /shutdown endpoint is hit to perform platform-specific cleanup
 */
using ShutdownCallback = std::function<void ()>;

/**
 * @brief Context passed to route setup functions
 */
struct RouteContext {
    httplib::Server& server;
    vayu::db::Database& db;
    vayu::core::RunManager& run_manager;
    ShutdownCallback on_shutdown; // Optional graceful-shutdown callback
    vayu::http::OAuth2AuthorizeManager& authorize_manager; // Owned by Server; see server.hpp
    /// The design-mode cookie jar (issue #301). Owned by Server; read by
    /// `/execute` (which sends through it) and by `/cookies` (which shows and
    /// clears it). Not reachable from the load path - see cookie_jar.hpp.
    vayu::http::CookieJar& cookie_jar;
    /// The local OAuth 2.0 mock issuers (issue #479). Owned by Server; see
    /// server.hpp for why it is declared before server_.
    vayu::http::MockIssuerManager& mock_issuer_manager;
    /// The webhook inboxes (issue #480). Owned by Server; read by `/inbox`.
    vayu::http::InboxManager& inbox_manager;
    /// The collection mock servers (issue #481 phase 2). Owned by Server; read
    /// by `/mock`.
    vayu::http::MockServerManager& mock_server_manager;
    /// The streaming consumers (issue #573). Owned by Server; started by
    /// `/execute`, read by `/runs/:id/events`, stopped by `/runs/:id/stop`.
    vayu::http::SseStreamManager& sse_manager;
    /// The `GET /runs` row summaries (issue #1150). Owned by Server; read by
    /// `/runs` alone, which is the one endpoint a visible history surface
    /// polls. See run_summary_cache.hpp for why a run id keys it exactly.
    vayu::http::RunSummaryCache& run_summary_cache;
    /// The secret every write to `/file-grants` and `/file-roots` must carry
    /// (#2356). Owned by Server; read through `admit_file_trust_write`. A
    /// context built without one refuses those writes.
    const vayu::http::GrantSecret& grant_secret = vayu::http::no_grant_secret ();
};

// Route registration functions (implemented in separate files)
void register_health_routes (RouteContext& ctx);
void register_config_routes (RouteContext& ctx);
void register_workspace_routes (RouteContext& ctx);
void register_collection_routes (RouteContext& ctx);
void register_request_routes (RouteContext& ctx);
void register_request_example_routes (RouteContext& ctx);
void register_trash_routes (RouteContext& ctx);
void register_spec_routes (RouteContext& ctx);
void register_spec_sync_routes (RouteContext& ctx);
void register_spec_match_routes (RouteContext& ctx);
void register_spec_diff_routes (RouteContext& ctx);
void register_spec_describe_routes (RouteContext& ctx);
void register_spec_bind_routes (RouteContext& ctx);
void register_spec_export_routes (RouteContext& ctx);
void register_postman_export_routes (RouteContext& ctx);
void register_run_export_routes (RouteContext& ctx);
void register_reorder_routes (RouteContext& ctx);
void register_environment_routes (RouteContext& ctx);
void register_client_certificate_routes (RouteContext& ctx);
void register_file_root_routes (RouteContext& ctx);
void register_file_grant_routes (RouteContext& ctx);
void register_globals_routes (RouteContext& ctx);
void register_run_routes (RouteContext& ctx);
void register_execution_routes (RouteContext& ctx);
void register_compose_routes (RouteContext& ctx);
void register_metrics_routes (RouteContext& ctx);
void register_scripting_routes (RouteContext& ctx);
void register_import_routes (RouteContext& ctx);
void register_diagnostics_routes (RouteContext& ctx);
void register_oauth_routes (RouteContext& ctx);
void register_cookie_routes (RouteContext& ctx);
void register_mock_issuer_routes (RouteContext& ctx);
void register_inbox_routes (RouteContext& ctx);
void register_event_stream_routes (RouteContext& ctx);
void register_mock_server_routes (RouteContext& ctx);
void register_elements_routes (RouteContext& ctx);

/**
 * @brief Generate the TypeScript declarations for the `pm.*` script surface.
 *
 * Derived from `get_script_completions ()` so the surface is declared once;
 * see script_types.cpp for why a hand-written `pm.d.ts` in the app was not the
 * shape chosen. Deterministic - the same table always yields identical text.
 */
std::string generate_script_typedefs ();

} // namespace vayu::http::routes
