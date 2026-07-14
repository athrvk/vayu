#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <httplib.h>

#include <atomic>
#include <memory>
#include <thread>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/oauth_authorize.hpp"
#include "vayu/http/routes.hpp"

namespace vayu::http {

class Server {
    public:
    Server (vayu::db::Database& db, vayu::core::RunManager& run_manager, int port, bool verbose = false);
    ~Server ();

    void start ();
    void stop ();
    bool is_running () const;

    /**
     * @brief Set a callback to be invoked when /shutdown endpoint is called
     * This allows the daemon to perform platform-specific cleanup (lock file release, etc.)
     * @param callback Function to call during graceful shutdown
     */
    void set_shutdown_callback (routes::ShutdownCallback callback);

    private:
    void setup_routes ();

    vayu::db::Database& db_;
    vayu::core::RunManager& run_manager_;
    int port_;
    bool verbose_;
    // Declared before server_ so it is destroyed *after* server_ (reverse member
    // order): the httplib lambdas that reference it are gone before its dtor
    // stops and joins any live loopback listeners, and db_ (external) is still
    // alive at that point. Previously a function-local static outliving db_.
    OAuth2AuthorizeManager oauth_authorize_manager_;
    httplib::Server server_;
    std::thread server_thread_;
    std::atomic<bool> is_running_{ false };
    std::unique_ptr<routes::RouteContext> route_ctx_;
    routes::ShutdownCallback shutdown_callback_;
};

} // namespace vayu::http
