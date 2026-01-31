/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/health.cpp
 * @brief Health check and shutdown routes
 */

#include <thread>

#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace vayu::http::routes {

void register_health_routes (RouteContext& ctx) {
    /**
     * GET /health
     * Returns server health status, version, and available worker threads.
     */
    ctx.server.Get ("/health", [] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_debug ("GET /health - Health check requested");
        nlohmann::json response;
        response["status"]  = "ok";
        response["version"] = vayu::Version::string;
        response["workers"] = std::thread::hardware_concurrency ();
        res.set_content (response.dump (), "application/json");
    });

    /**
     * POST /shutdown
     * Triggers a graceful shutdown of the engine.
     * This is used by the Electron app to cleanly shut down the engine on Windows
     * where SIGTERM doesn't work as expected.
     *
     * The shutdown sequence:
     * 1. Send response to client
     * 2. Call the shutdown callback (sets g_running = false in daemon.cpp)
     * 3. Main loop in daemon.cpp exits and calls server.stop() once
     * 4. daemon.cpp then performs final cleanup (stop runs, release lock, flush logs)
     */
    ctx.server.Post ("/shutdown", [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info ("POST /shutdown - Graceful shutdown requested");
        nlohmann::json response;
        response["status"]  = "ok";
        response["message"] = "Shutdown initiated";
        res.set_content (response.dump (), "application/json");

        // Schedule callback after response is sent so client gets 200 OK
        std::thread ([&ctx] () {
            std::this_thread::sleep_for (std::chrono::milliseconds (100));
            if (ctx.on_shutdown) {
                vayu::utils::log_debug (
                "POST /shutdown - Invoking shutdown callback");
                ctx.on_shutdown ();
            }
        })
        .detach ();
    });
}

} // namespace vayu::http::routes
