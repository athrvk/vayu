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

#include "vayu/db/recovery.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace vayu::http::routes {

/**
 * The body of `GET /health`.
 *
 * Extracted from the handler so the `recovery` node can be tested without
 * standing a server up - the node is a claim about the user's data, and the
 * cases worth pinning are the two the caller cannot arrange over HTTP (a clean
 * start and a wiped one).
 *
 * `recovery` is **absent** on a clean start rather than `null`, per the
 * engine's usual absent-not-null rule: a client that has never seen the key has
 * nothing to render, and the app's notice keys off its presence.
 */
nlohmann::json build_health_response (const vayu::db::Database& db) {
    nlohmann::json response;
    response["status"]  = "ok";
    response["version"] = vayu::Version::string;
    response["workers"] = std::thread::hardware_concurrency ();

    if (const auto& recovery = db.recovery ()) {
        nlohmann::json node;
        node["outcome"] = vayu::db::to_string (recovery->outcome);
        node["at"]      = recovery->at;
        // The data directory, effectively - the app names it in the notice, and
        // deriving it renderer-side would mean a second copy of where the
        // engine keeps its database.
        node["databasePath"] = db.path ();
        // Where the corrupt file was moved to, when it was moved (issue #984).
        // Absent rather than null for the same reason the whole node is absent
        // on a clean start - and absent for an outcome that deleted instead, so
        // the app must not derive it from the outcome string.
        if (recovery->quarantined_path) {
            node["quarantinedPath"] = *recovery->quarantined_path;
        }
        response["recovery"] = node;
    }
    return response;
}

void register_health_routes (RouteContext& ctx) {
    /**
     * GET /health
     * Returns server health status, version, available worker threads, and -
     * only when this startup had to recover the database - what it did about it
     * (issue #922).
     */
    ctx.server.Get ("/health", [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_debug ("GET /health - Health check requested");
        res.set_content (build_health_response (ctx.db).dump (), "application/json");
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
