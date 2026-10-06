/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/server.cpp
 * @brief HTTP Server implementation with modular route registration
 */

#include "vayu/http/server.hpp"

#include <chrono>
#include <future>
#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>

#include "vayu/core/constants.hpp"
#include "vayu/http/request_log.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace vayu::http {

namespace {

/// True when @p req names this listener by one of its loopback spellings and
/// nothing else, exactly once.
bool names_this_listener (const httplib::Request& req, int port) {
    if (req.get_header_value_count ("Host") != 1) {
        return false;
    }
    const std::string host   = req.get_header_value ("Host");
    const std::string suffix = ":" + std::to_string (port);
    if (!host.ends_with (suffix)) {
        return false;
    }
    const std::string_view name =
    std::string_view (host).substr (0, host.size () - suffix.size ());
    return vayu::utils::ascii_lower_equal (name, "127.0.0.1") ||
    vayu::utils::ascii_lower_equal (name, "localhost") ||
    vayu::utils::ascii_lower_equal (name, "[::1]");
}

/**
 * The management API serves no browser: no CORS header ever leaves this
 * server, and a request carrying `Origin` is refused. The Electron shell is the
 * one browser-context client, and it strips `Origin` from the renderer's
 * requests and supplies the CORS response headers the renderer needs itself
 * (`app/electron/engine-origin.ts`), so to this server the renderer looks like
 * curl, the CLI or the MCP server's fetch - none of which sends `Origin`.
 *
 * `Host` is checked first and on every request, `OPTIONS` included: DNS
 * rebinding makes a hostile page same-origin with this listener, and a
 * same-origin `GET` carries no `Origin`, so only the name the page dialled -
 * which is never a loopback literal - tells it apart.
 *
 * `OPTIONS` is exempt from the `Origin` rule and answered 204 with no CORS
 * header: a preflight that says nothing grants nothing, and answering it
 * keeps the shell's own preflight working whether or not Chromium lets the
 * shell rewrite a preflight's headers.
 *
 * The invariant this gate leans on: **a GET route must never have a side
 * effect, because any web page can make the engine run one.** A scriptless
 * GET (`<img>`, a `no-cors` fetch, a navigation) carries a loopback `Host` and
 * no `Origin`, so it passes here; it is harmless only because the page cannot
 * read the answer (no CORS header) and the route changes nothing.
 */
httplib::Server::HandlerResponse
admit_management_request (const httplib::Request& req, httplib::Response& res, int port) {
    if (!names_this_listener (req, port)) {
        routes::send_error (res, 403,
        "Refused by the Host check: the engine answers only Host 127.0.0.1:" +
        std::to_string (port) + ", localhost:" + std::to_string (port) +
        " or [::1]:" + std::to_string (port));
        return httplib::Server::HandlerResponse::Handled;
    }
    if (req.method == "OPTIONS") {
        res.status = 204;
        return httplib::Server::HandlerResponse::Handled;
    }
    if (req.has_header ("Origin")) {
        routes::send_error (res, 403,
        "Refused: the engine does not serve browser origins (the request "
        "carried "
        "an Origin header)");
        return httplib::Server::HandlerResponse::Handled;
    }
    return httplib::Server::HandlerResponse::Unhandled;
}

/**
 * Every body this server reads is judged before a byte of it is read
 * (#1824), which needs its length up front: a chunked body could only be
 * bounded by cpp-httplib while it is read, against a limit that cannot follow
 * a setting changed while the server runs, so it is refused instead. Every
 * first-party client (the app, `vayu-cli`, the MCP server) sends
 * `Content-Length`. cpp-httplib already answers 400 for any
 * `Transfer-Encoding` that does not end in `chunked`.
 */
httplib::Server::HandlerResponse
refuse_unbounded_body (const httplib::Request& req, httplib::Response& res) {
    using vayu::core::constants::request_body::MAX_BYTES;
    if (req.has_header ("Transfer-Encoding")) {
        routes::send_error (res, 411,
        "Refused: the engine reads a request body only when its length is "
        "declared up front - send Content-Length, not Transfer-Encoding: "
        "chunked");
        return httplib::Server::HandlerResponse::Handled;
    }
    const size_t length = req.get_header_value_u64 ("Content-Length");
    if (length <= MAX_BYTES) {
        return httplib::Server::HandlerResponse::Unhandled;
    }
    routes::send_error (res, 413,
    "Request body is " + std::to_string (length) + " bytes, over the limit of " +
    std::to_string (MAX_BYTES) + " the engine reads for any request");
    return httplib::Server::HandlerResponse::Handled;
}

} // namespace

Server::Server (vayu::db::Database& db, vayu::core::RunManager& run_manager, int port)
: db_ (db), run_manager_ (run_manager), port_ (port) {
    setup_routes ();
}

Server::~Server () {
    stop ();
}

bool Server::start () {
    if (is_running_)
        return true;

    bind_error_.clear ();

    vayu::utils::log_info ("startup", "Vayu Engine " + std::string (vayu::Version::string));

    // Load and display config
    auto entries = db_.get_all_config_entries ();
    nlohmann::json config;
    for (const auto& entry : entries) {
        config[entry.key] = entry.value;
    }
    vayu::utils::log_info ("config", "Configuration loaded", { { "config", config } });

    // The engine's port is fixed by contract (docs/architecture.md), so this
    // listener must never *share* it - a second binder is a collision to
    // report, not a peer to split traffic with. cpp-httplib's default socket
    // options say the opposite: they set SO_REUSEPORT where it exists, and the
    // kernel then hands each accept loop a random half of the connections
    // (the #512 defect, one layer down). SO_REUSEADDR alone still lets a
    // restart step over its own sockets left in TIME_WAIT, which is the only
    // sharing wanted here; on Windows, where SO_REUSEADDR is what lets one
    // process take a port another is actively serving, SO_EXCLUSIVEADDRUSE is
    // the same statement spelled for that platform.
    server_.set_socket_options ([] (socket_t sock) {
#if VAYU_PLATFORM_WINDOWS
        httplib::set_socket_opt (sock, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, 1);
#else
        httplib::set_socket_opt (sock, SOL_SOCKET, SO_REUSEADDR, 1);
#endif
    });

    // Bind here rather than inside the listener thread: `listen()` folds the
    // bind into the serve loop and reports its failure only as a `false` no
    // caller was reading, so a taken port printed a listening banner and exited
    // 0 (#983). Binding first makes the outcome this call's return value.
    const std::string where = "127.0.0.1:" + std::to_string (port_);
    if (!server_.bind_to_port ("127.0.0.1", port_)) {
        bind_error_ = "Could not bind " +
        where + " - another process, possibly another Vayu engine, is already listening there";
        vayu::utils::log_error ("startup", bind_error_);
        return false;
    }

    is_running_ = true;
    // Shared with the thread rather than a member it writes through, because
    // a thread `stop()` gave up on and detached may outlive this object.
    auto exited           = std::make_shared<std::promise<void>> ();
    server_thread_exited_ = exited->get_future ();
    server_thread_        = std::thread ([this, exited] () {
        server_.listen_after_bind ();
        is_running_ = false;
        exited->set_value ();
    });

    // `stop()` racing ahead of the accept loop is missed by cpp-httplib and the
    // join that follows then waits out its 3s detach fallback, so `start()`
    // returns only once the loop is live - the rule managed_listener.hpp spells
    // out for every other listener in the engine.
    server_.wait_until_ready ();

    vayu::utils::log_info ("startup", "Listening on http://" + where);
    return true;
}

void Server::stop () {
    if (is_running_) {
        server_.stop ();

        // Give the server thread a chance to exit gracefully. Waited on rather
        // than polled: the 100 ms re-check this replaces was the whole of
        // "Server stopped in 100ms" on every shutdown, since the accept loop
        // is gone within a keep-alive check interval of `stop()`.
        if (server_thread_.joinable ()) {
            if (server_thread_exited_.wait_for (std::chrono::seconds (3)) ==
            std::future_status::ready) {
                server_thread_.join ();
            } else {
                vayu::utils::log_warning ("shutdown",
                "Server thread did not exit after 3 seconds, detaching...");
                server_thread_.detach ();
            }
        }
        is_running_ = false;
    }

    // Outside the `is_running_` guard and after the listener is down, because
    // "the server has stopped" must mean no engine work is still in flight
    // (#646). A stream consumer is a worker like a run worker: it holds `db_`,
    // reads `cookie_jar_` and is inside a curl transfer. `daemon.cpp` runs
    // `curl_global_cleanup` between this call and `~Server`, so a stream joined
    // only by the member destructor would still be transferring while curl's
    // global state was torn down underneath it - the #125 defect, in the one
    // worker RunManager does not own. Draining an idle manager is immediate.
    sse_manager_.shutdown ();
}

bool Server::is_running () const {
    return is_running_;
}

const std::string& Server::bind_error () const {
    return bind_error_;
}

void Server::set_shutdown_callback (routes::ShutdownCallback callback) {
    shutdown_callback_ = std::move (callback);
    // Update the route context if it exists
    if (route_ctx_) {
        route_ctx_->on_shutdown = shutdown_callback_;
    }
}

void Server::setup_routes () {
    // One request line per call (issue #1510), before anything else touches
    // server_: a route registered below that never logged its own entry now
    // always does, at the level its status calls for. The gate rides the same
    // pre-routing handler, so a refused request gets its line too. The Host
    // and Origin rules run first. The body caps need the headers only, and the
    // import one goes before the general one because it names the setting.
    // A refusal is a 4xx, on which cpp-httplib closes the connection rather
    // than draining the unread body.
    install_request_logger (server_,
    [this, port = port_] (const httplib::Request& req, httplib::Response& res) {
        constexpr auto handled = httplib::Server::HandlerResponse::Handled;
        if (admit_management_request (req, res, port) == handled ||
        routes::reject_oversized_import (db_, req, res) == handled) {
            return handled;
        }
        return refuse_unbounded_body (req, res);
    });
    // Without this, cpp-httplib's own 100 MB default would refuse a body the
    // guard above admits once a body-size setting is raised.
    server_.set_payload_max_length (vayu::core::constants::request_body::MAX_BYTES);

    // Every response here is a live read of state that changes under the
    // client (#1507); none of it is valid to replay from a browser's disk
    // cache. The mock server and inbox listeners are separate
    // ManagedListener-owned httplib::Server instances (mock_server.cpp,
    // routes/inbox.cpp) and never call set_default_headers, so this reaches
    // only the management API.
    server_.set_default_headers ({ { "Cache-Control", "no-store" } });

    // ==========================================
    // Register Modular Routes
    // ==========================================
    // Note: route_ctx_ is a class member, ensuring it outlives the lambdas
    route_ctx_ = std::make_unique<routes::RouteContext> (
    routes::RouteContext{ server_, db_, run_manager_, shutdown_callback_,
    oauth_authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
    mock_server_manager_, sse_manager_, run_summary_cache_ });

    routes::register_health_routes (*route_ctx_);
    routes::register_config_routes (*route_ctx_);
    routes::register_workspace_routes (*route_ctx_);
    routes::register_collection_routes (*route_ctx_);
    routes::register_request_routes (*route_ctx_);
    routes::register_request_example_routes (*route_ctx_);
    routes::register_trash_routes (*route_ctx_);
    routes::register_spec_routes (*route_ctx_);
    routes::register_spec_sync_routes (*route_ctx_);
    routes::register_spec_match_routes (*route_ctx_);
    routes::register_spec_diff_routes (*route_ctx_);
    routes::register_spec_describe_routes (*route_ctx_);
    routes::register_spec_bind_routes (*route_ctx_);
    routes::register_spec_export_routes (*route_ctx_);
    routes::register_postman_export_routes (*route_ctx_);
    routes::register_reorder_routes (*route_ctx_);
    routes::register_environment_routes (*route_ctx_);
    routes::register_client_certificate_routes (*route_ctx_);
    routes::register_file_root_routes (*route_ctx_);
    routes::register_globals_routes (*route_ctx_);
    routes::register_run_routes (*route_ctx_);
    routes::register_execution_routes (*route_ctx_);
    routes::register_compose_routes (*route_ctx_);
    routes::register_metrics_routes (*route_ctx_);
    routes::register_scripting_routes (*route_ctx_);
    routes::register_import_routes (*route_ctx_);
    routes::register_diagnostics_routes (*route_ctx_);
    routes::register_oauth_routes (*route_ctx_);
    routes::register_cookie_routes (*route_ctx_);
    routes::register_mock_issuer_routes (*route_ctx_);
    routes::register_inbox_routes (*route_ctx_);
    routes::register_mock_server_routes (*route_ctx_);
    routes::register_event_stream_routes (*route_ctx_);
    routes::register_elements_routes (*route_ctx_);
}

} // namespace vayu::http
