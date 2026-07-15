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

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"

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
