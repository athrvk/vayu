/**
 * @file http/server.cpp
 * @brief HTTP Server implementation with modular route registration
 */

#include "vayu/http/server.hpp"

#include <chrono>
#include <iostream>
#include <nlohmann/json.hpp>

#include "vayu/core/constants.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace vayu::http {

Server::Server(vayu::db::Database& db, vayu::core::RunManager& run_manager, int port, bool verbose)
    : db_(db), run_manager_(run_manager), port_(port), verbose_(verbose) {
    setup_routes();
}

Server::~Server() {
    stop();
}

void Server::start() {
    if (is_running_) return;

    is_running_ = true;
    server_thread_ = std::thread([this]() {
        vayu::utils::log_info("Vayu Engine " + std::string(vayu::Version::string));

        // Load and display config
        nlohmann::json config;
        auto stored_config = db_.get_config("global_settings");
        if (stored_config) {
            try {
                config = nlohmann::json::parse(*stored_config);
            } catch (...) {
            }
        }
        if (config.empty()) {
            config["workers"] = std::thread::hardware_concurrency();
            config["maxConnections"] = vayu::core::constants::server::MAX_CONNECTIONS;
            config["defaultTimeout"] = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;
            config["statsInterval"] = vayu::core::constants::server::STATS_INTERVAL_MS;
            config["contextPoolSize"] = vayu::core::constants::server::CONTEXT_POOL_SIZE;
        }
        config["verbose"] = verbose_;
        vayu::utils::log_info("Configuration: " + config.dump());

        vayu::utils::log_info("Listening on http://127.0.0.1:" + std::to_string(port_));
        server_.listen("127.0.0.1", port_);
        is_running_ = false;
    });
}

void Server::stop() {
    if (is_running_) {
        server_.stop();

        // Give the server thread a chance to exit gracefully
        if (server_thread_.joinable()) {
            auto join_start = std::chrono::steady_clock::now();
            while (server_thread_.joinable()) {
                auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                                   std::chrono::steady_clock::now() - join_start)
                                   .count();

                if (elapsed >= 3) {
                    vayu::utils::log_warning(
                        "Server thread did not exit after 3 seconds, detaching...");
                    server_thread_.detach();
                    break;
                }

                if (!is_running_) {
                    server_thread_.join();
                    break;
                }

                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
        }
        is_running_ = false;
    }
}

bool Server::is_running() const {
    return is_running_;
}

void Server::setup_routes() {
    // ==========================================
    // CORS Configuration
    // ==========================================
    server_.set_default_headers(
        {{"Access-Control-Allow-Origin", "*"},
         {"Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS"},
         {"Access-Control-Allow-Headers",
          "Content-Type, Authorization, ngrok-skip-browser-warning"}});

    // Handle OPTIONS preflight requests
    server_.Options(".*",
                    [](const httplib::Request&, httplib::Response& res) { res.status = 204; });

    // ==========================================
    // Register Modular Routes
    // ==========================================
    // Note: route_ctx_ is a class member, ensuring it outlives the lambdas
    route_ctx_ = std::make_unique<routes::RouteContext>(
        routes::RouteContext{server_, db_, run_manager_, verbose_});

    routes::register_health_routes(*route_ctx_);
    routes::register_collection_routes(*route_ctx_);
    routes::register_request_routes(*route_ctx_);
    routes::register_environment_routes(*route_ctx_);
    routes::register_globals_routes(*route_ctx_);
    routes::register_run_routes(*route_ctx_);
    routes::register_execution_routes(*route_ctx_);
    routes::register_metrics_routes(*route_ctx_);
    routes::register_scripting_routes(*route_ctx_);
}

}  // namespace vayu::http
