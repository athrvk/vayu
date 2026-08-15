#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <httplib.h>

#include <chrono>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_builder.hpp"
// The `POST /execute` core - `ScriptVariableScopes`, the exchange itself - now
// shared with the scenario runner and therefore declared where `vayu_core` can
// see it. Included here so route TUs keep naming it through routes.hpp.
#include "vayu/http/request_exchange.hpp"
#include "vayu/utils/logger.hpp"

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
 */
inline void send_error (httplib::Response& res,
int status,
const std::string& message,
std::string_view code = {}) {
    res.status = status;
    res.set_content (error_body (status, message, code).dump (), "application/json");
}

/**
 * @brief Send a JSON success response
 */
inline void send_json (httplib::Response& res, const nlohmann::json& data) {
    res.set_content (data.dump (), "application/json");
}

/**
 * @brief Wrap a handler so a deprecated-alias registration is distinguishable
 *        in the logs from its canonical counterpart.
 *
 * The renamed routes register one shared handler under both the canonical path
 * (first) and the legacy path (second). cpp-httplib handlers are copyable
 * std::functions, so the body is never duplicated; `req.matches[1]` is
 * identical under both patterns. The alias registration wraps the handler with
 * this so the per-request logs carry a ` (deprecated alias)` marker and the
 * actual `req.path` that was hit - the canonical registration logs unchanged.
 */
inline httplib::Server::Handler deprecated_alias (httplib::Server::Handler handler) {
    return [handler = std::move (handler)] (
           const httplib::Request& req, httplib::Response& res) {
        vayu::utils::log_info (req.method + " " + req.path +
        " (deprecated alias) - prefer the canonical path");
        handler (req, res);
    };
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
 */
[[nodiscard]] inline std::optional<std::pair<int, nlohmann::json>>
apply_json_field (const nlohmann::json& json,
const char* key,
std::string& out,
const char* default_value,
bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            out = default_value;
        }
        return std::nullopt;
    }
    const auto& value = json[key];
    if (value.is_null ()) {
        out = default_value;
        return std::nullopt;
    }
    if (!value.is_object ()) {
        return std::make_pair (400,
        error_body (400, std::string ("Invalid '") + key + "': must be a JSON object"));
    }
    out = value.dump ();
    return std::nullopt;
}

/**
 * Same rule for a field stored as a dumped **array** of KeyValueEntry
 * (`params` / `headers` on a request, `headers` on a saved example). A null
 * resets to `[]`; a present value must be an array whose every entry carries
 * string `key`/`value` and boolean `enabled`. Returns the 400 body on a
 * malformed entry, nullopt otherwise.
 *
 * Here rather than in requests.cpp because saved examples store the same shape
 * and must validate it the same way - a second copy would drift the moment the
 * entry shape gains a field.
 */
[[nodiscard]] inline std::optional<std::pair<int, nlohmann::json>>
apply_key_value_field (const nlohmann::json& json, const char* key, std::string& out, bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            out = "[]";
        }
        return std::nullopt;
    }
    const auto& value = json[key];
    if (value.is_null ()) {
        out = "[]";
        return std::nullopt;
    }
    if (!value.is_array ()) {
        return std::make_pair (400,
        error_body (400, std::string ("Invalid '") + key + "': must be an array of {key, value, enabled}"));
    }
    for (size_t i = 0; i < value.size (); ++i) {
        const auto& entry = value[i];
        if (!entry.contains ("key") || !entry["key"].is_string () ||
        !entry.contains ("value") || !entry["value"].is_string () ||
        !entry.contains ("enabled") || !entry["enabled"].is_boolean ()) {
            return std::make_pair (400,
            error_body (400,
            std::string ("Invalid ") + key + " entry at index " + std::to_string (i) +
            ": missing required field (key, value, or enabled)"));
        }
    }
    out = value.dump ();
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
inline std::optional<std::pair<int, nlohmann::json>> apply_http_version_field (
const nlohmann::json& json,
const char* key,
std::string& out,
const std::string& seed,
bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            out = seed;
        }
        return std::nullopt;
    }
    if (json[key].is_null ()) {
        out = seed;
        return std::nullopt;
    }

    if (json[key].is_string ()) {
        const std::string candidate = json[key].get<std::string> ();
        // Acceptance goes through the domain's own parser rather than a
        // hand-rolled comparison, so this cannot come to disagree with what
        // deserialize_request and the config seed accept.
        if (vayu::http_version_from_string (candidate).has_value ()) {
            out = candidate;
            return std::nullopt;
        }
        return std::make_pair (400,
        error_body (400,
        std::string ("Invalid '") + key + "': '" + candidate +
        "' is not a valid HTTP version. Valid values: " + http_version_valid_list ()));
    }

    return std::make_pair (400,
    error_body (400,
    std::string ("Invalid '") + key +
    "': must be a string. Valid values: " + http_version_valid_list ()));
}

/**
 * A field with no default: absent on create and `null` on either verb are both
 * 400s, because there is nothing to fall back to. Returns the error response
 * body, or nullopt when the value is acceptable (including "absent on update",
 * which keeps the stored value).
 */
inline std::optional<std::pair<int, nlohmann::json>>
apply_required_string_field (const nlohmann::json& json, const char* key, std::string& out, bool is_create) {
    if (!json.contains (key)) {
        if (is_create) {
            return std::make_pair (400,
            error_body (400, std::string ("Missing required field: ") + key));
        }
        return std::nullopt; // Absent on update -> keep.
    }
    if (json[key].is_null ()) {
        return std::make_pair (400,
        error_body (400, std::string ("Invalid '") + key + "': null is not allowed (this field has no default)"));
    }
    out = json[key].get<std::string> ();
    return std::nullopt;
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
inline std::optional<std::pair<int, nlohmann::json>> reject_client_supplied_id (
const nlohmann::json& json) {
    if (!json.contains ("id")) {
        return std::nullopt;
    }
    return std::make_pair (400,
    error_body (400,
    "id is assigned by the engine; omit it "
    "(bulk import: POST /import/apply)"));
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
inline std::optional<std::pair<int, nlohmann::json>>
reject_mismatched_body_id (const nlohmann::json& json, const std::string& path_id) {
    if (!json.contains ("id")) {
        return std::nullopt;
    }
    if (json["id"].is_string () && json["id"].get<std::string> () == path_id) {
        return std::nullopt;
    }
    return std::make_pair (400,
    error_body (400, "Body 'id' must match the id in the path ('" + path_id + "') or be omitted"));
}

/**
 * The per-resource field appliers, shared by the single-resource create/update
 * cores and by `POST /import/apply` (issue #96). Bulk import must store exactly
 * what `POST /<resource>` would store, so it calls these rather than
 * re-deriving the null-vs-absent rule or the per-field validation - a second
 * copy would drift the moment a field is added.
 *
 * Each returns an error response {http_status, json_body} when a no-default
 * field is missing or null (or, for collections, when the proposed parent would
 * form a cycle), and nullopt on success. `is_create` selects the absent-field
 * behaviour; see the rule above. Defined in collections.cpp / requests.cpp /
 * environments.cpp.
 */
std::optional<std::pair<int, nlohmann::json>> apply_collection_fields (vayu::db::Database& db,
vayu::db::Collection& c,
const nlohmann::json& json,
bool is_create);
std::optional<std::pair<int, nlohmann::json>> apply_request_fields (vayu::db::Database& db,
vayu::db::Request& r,
const nlohmann::json& json,
bool is_create);
std::optional<std::pair<int, nlohmann::json>>
apply_environment_fields (vayu::db::Environment& e, const nlohmann::json& json, bool is_create);
/**
 * Saved example responses (issue #481) follow the same rule, and the same
 * shared-applier reason: `POST /import/apply` writes examples nested under
 * their request item, so both paths must agree on what a field means and where
 * the body cap sits. Defined in examples.cpp.
 */
std::optional<std::pair<int, nlohmann::json>>
apply_request_example_fields (vayu::db::RequestExample& x, const nlohmann::json& json, bool is_create);

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
std::optional<std::pair<int, nlohmann::json>> reject_unbindable_spec (vayu::db::Database& db,
const std::string& openapi,
const std::unordered_set<std::string>& pending);

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
 * The outcome of reading `POST /execute`'s `transient` flag (issue #382).
 *
 * `value` is what the payload asked for; `ok == false` means the field was
 * present with a non-boolean type, which is a `400` rather than a silent
 * `false` - see `read_transient_flag`.
 */
struct TransientFlag {
    bool ok = true;
    std::string error;
    bool value = false;
};

/**
 * Read the `transient` flag off a `POST /execute` payload.
 *
 * Extracted from the handler (execution.cpp) so transient_execute_test.cpp can
 * drive it directly, matching the suite's other route-core tests.
 */
TransientFlag read_transient_flag (const nlohmann::json& json);

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
 * when `credentials` is non-empty: a `{{data.column}}` inside a credential has
 * to carry the row's value *before* `apply_auth` collapses a username and a
 * password into one base64 `Authorization` value, since after that the token is
 * unreadable and goes out as base64 of its own literal text (issue #591). The
 * ordinary send - every credential static - keeps resolving auth inside the
 * build, byte for byte as it did before this existed.
 *
 * `ok == false` carries the 400 the route answers with. There is one: an
 * OAuth 2.0 config carrying a data token, which no deferral can serve.
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
    vayu::http::AuthResolution resolution = vayu::http::AuthResolution::Apply;
};

/**
 * Decide how `POST /execute` resolves the credentials of a send carrying a row.
 *
 * The half of the sequence that must happen **before** the request is built;
 * `vayu::core::bind_auth_row` is the half that happens after, and the two are
 * split exactly there because `build_request` sits between them.
 *
 * @p has_row is false for an ordinary send, which returns `Apply` with an empty
 * template and no refusal: without a row there is nothing to bind a token
 * against, so a `{{data.*}}` in a credential keeps today's goes-out-literal
 * behaviour rather than becoming a new refusal this endpoint never had.
 *
 * Extracted from the handler (execution.cpp) so send_with_row_test.cpp can
 * drive it directly, matching the suite's other route-core tests.
 */
SendRowAuth plan_send_row_auth (const nlohmann::json& json, bool has_row);

/**
 * What a design execution's two scripts produced, as the four keys every
 * client already reads: `testResults`, `consoleLogs`, `preScriptError` and
 * `postScriptError`.
 *
 * One builder for two homes. A buffered send merges it into the `/execute`
 * response body; a streaming send has already answered `202`, so it stores the
 * same object in its trace (`StreamRecord::scripts`) and the app reads it back
 * from there. Building it twice is how the live pane and the restored one would
 * come to disagree about what a failed assertion looks like.
 *
 * Each key is present only when it has something to say, so a request with no
 * scripts contributes an empty object and stores nothing.
 *
 * Non-static: execution_trace_test.cpp drives it directly.
 */
[[nodiscard]] nlohmann::json build_script_result_node (const vayu::ScriptResult& pre_script_result,
const vayu::ScriptResult& post_script_result);

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
    /**
     * What the run's scripts produced, from `build_script_result_node`, or null
     * when the request carried none (issue #575).
     *
     * Stored rather than returned, because there is nobody left to return it
     * to: the route answered `202` the moment the stream started, so a
     * streaming run's test results reach the app the same way its events do -
     * through the trace. `restore-response.ts` maps this node onto the response
     * pane's existing Tests and Console panes.
     */
    nlohmann::json scripts;
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
 */
void record_design_result (vayu::db::Database& db,
const std::optional<std::string>& run_id,
const vayu::Request& request,
const vayu::Response& response,
const StreamRecord* stream = nullptr);

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
    bool verbose;
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
};

// Route registration functions (implemented in separate files)
void register_health_routes (RouteContext& ctx);
void register_config_routes (RouteContext& ctx);
void register_collection_routes (RouteContext& ctx);
void register_request_routes (RouteContext& ctx);
void register_request_example_routes (RouteContext& ctx);
void register_spec_routes (RouteContext& ctx);
void register_reorder_routes (RouteContext& ctx);
void register_environment_routes (RouteContext& ctx);
void register_globals_routes (RouteContext& ctx);
void register_run_routes (RouteContext& ctx);
void register_execution_routes (RouteContext& ctx);
void register_compose_routes (RouteContext& ctx);
void register_metrics_routes (RouteContext& ctx);
void register_scripting_routes (RouteContext& ctx);
void register_import_routes (RouteContext& ctx);
void register_oauth_routes (RouteContext& ctx);
void register_cookie_routes (RouteContext& ctx);
void register_mock_issuer_routes (RouteContext& ctx);
void register_inbox_routes (RouteContext& ctx);
void register_event_stream_routes (RouteContext& ctx);
void register_mock_server_routes (RouteContext& ctx);

/**
 * @brief Generate the TypeScript declarations for the `pm.*` script surface.
 *
 * Derived from `get_script_completions ()` so the surface is declared once;
 * see script_types.cpp for why a hand-written `pm.d.ts` in the app was not the
 * shape chosen. Deterministic - the same table always yields identical text.
 */
std::string generate_script_typedefs ();

} // namespace vayu::http::routes
