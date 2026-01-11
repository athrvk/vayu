#pragma once

#include <httplib.h>

#include <chrono>
#include <nlohmann/json.hpp>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"

namespace vayu::http::routes {

/**
 * @brief Common utilities for route handlers
 */
inline int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

/**
 * @brief Send a JSON error response
 */
inline void send_error(httplib::Response& res, int status, const std::string& message) {
    res.status = status;
    res.set_content(nlohmann::json{{"error", message}}.dump(), "application/json");
}

/**
 * @brief Send a JSON success response
 */
inline void send_json(httplib::Response& res, const nlohmann::json& data) {
    res.set_content(data.dump(), "application/json");
}

/**
 * @brief Context passed to route setup functions
 */
struct RouteContext {
    httplib::Server& server;
    vayu::db::Database& db;
    vayu::core::RunManager& run_manager;
    bool verbose;
};

// Route registration functions (implemented in separate files)
void register_health_routes(RouteContext& ctx);
void register_collection_routes(RouteContext& ctx);
void register_request_routes(RouteContext& ctx);
void register_environment_routes(RouteContext& ctx);
void register_globals_routes(RouteContext& ctx);
void register_run_routes(RouteContext& ctx);
void register_execution_routes(RouteContext& ctx);
void register_metrics_routes(RouteContext& ctx);
void register_scripting_routes(RouteContext& ctx);

}  // namespace vayu::http::routes
