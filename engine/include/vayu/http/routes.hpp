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
#include <utility>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http {
// Owns interactive OAuth 2.0 authorization attempts; defined in oauth_authorize.hpp.
// Forward-declared here so RouteContext can carry a reference without every route
// TU pulling in the loopback listener machinery.
class OAuth2AuthorizeManager;
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
 * @brief Send a JSON error response
 */
inline void send_error (httplib::Response& res, int status, const std::string& message) {
    res.status = status;
    res.set_content (nlohmann::json{ { "error", message } }.dump (), "application/json");
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
 * std::functions, so the body is never duplicated; `req.matches[1]` is identical
 * under both patterns. The alias registration wraps the handler with this so the
 * per-request logs carry a ` (deprecated alias)` marker and the actual `req.path`
 * that was hit - the canonical registration logs unchanged.
 */
inline httplib::Server::Handler
deprecated_alias (httplib::Server::Handler handler) {
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
 */
inline void apply_json_field (const nlohmann::json& json,
const char* key,
std::string& out,
const char* default_value,
bool is_create) {
    if (json.contains (key)) {
        out = json[key].is_null () ? default_value : json[key].dump ();
    } else if (is_create) {
        out = default_value;
    }
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
            nlohmann::json{ { "error", std::string ("Missing required field: ") + key } });
        }
        return std::nullopt; // Absent on update -> keep.
    }
    if (json[key].is_null ()) {
        return std::make_pair (400,
        nlohmann::json{ { "error",
        std::string ("Invalid '") + key + "': null is not allowed (this field has no default)" } });
    }
    out = json[key].get<std::string> ();
    return std::nullopt;
}

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
    ShutdownCallback on_shutdown;                       // Optional graceful-shutdown callback
    vayu::http::OAuth2AuthorizeManager& authorize_manager; // Owned by Server; see server.hpp
};

// Route registration functions (implemented in separate files)
void register_health_routes (RouteContext& ctx);
void register_config_routes (RouteContext& ctx);
void register_collection_routes (RouteContext& ctx);
void register_request_routes (RouteContext& ctx);
void register_environment_routes (RouteContext& ctx);
void register_globals_routes (RouteContext& ctx);
void register_run_routes (RouteContext& ctx);
void register_execution_routes (RouteContext& ctx);
void register_metrics_routes (RouteContext& ctx);
void register_scripting_routes (RouteContext& ctx);
void register_import_routes (RouteContext& ctx);
void register_oauth_routes (RouteContext& ctx);

} // namespace vayu::http::routes
