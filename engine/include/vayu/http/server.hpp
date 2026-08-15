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
#include "vayu/http/inbox.hpp"
#include "vayu/http/mock_issuer.hpp"
#include "vayu/http/mock_server.hpp"
#include "vayu/http/oauth_authorize.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/sse_stream.hpp"

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
    // Everything from here down to server_ is declared *before* it so it is
    // destroyed *after* it (reverse member order): the httplib lambdas that
    // reference these members are gone with server_, and db_ - external, so
    // outliving all of this - is still alive when their destructors run.
    //
    // That matters most for the four listener-owning managers: each holds one
    // ManagedListener per attempt / issuer / inbox / mock server, and each
    // destructor stops and joins those listener threads while a handler may
    // still be writing to db_. The one rule they all run on lives on the helper
    // - see managed_listener.hpp. The cookie jar is here for the first half of
    // the reason alone: an in-flight /execute holds a reference to it, and it is
    // process-lifetime by design (see cookie_jar.hpp).
    //
    // SseStreamManager owns curl transfers rather than listeners, and is here
    // for exactly the same reason: its workers write run rows through db_ and
    // read cookie_jar_, and its shutdown stops and joins every one of them.
    // Declared after the jar so it is destroyed before it.
    //
    // The declaration order is the backstop, not the mechanism: `stop()` drains
    // it explicitly, because `daemon.cpp` calls `curl_global_cleanup` between
    // its `server.stop()` and this object's destruction, and a transfer still
    // running then is the #125 defect (see sse_stream.hpp and #646).
    OAuth2AuthorizeManager oauth_authorize_manager_;
    CookieJar cookie_jar_;
    MockIssuerManager mock_issuer_manager_;
    InboxManager inbox_manager_;
    MockServerManager mock_server_manager_;
    SseStreamManager sse_manager_;
    httplib::Server server_;
    std::thread server_thread_;
    std::atomic<bool> is_running_{ false };
    std::unique_ptr<routes::RouteContext> route_ctx_;
    routes::ShutdownCallback shutdown_callback_;
};

} // namespace vayu::http
