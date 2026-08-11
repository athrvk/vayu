/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file managed_listener.cpp
 * @brief The one copy of the on-demand listener lifecycle (issue #505). The
 *        OAuth callback, mock issuer and webhook inbox managers all run on it.
 */

#include "vayu/http/managed_listener.hpp"

#include <chrono>
#include <stdexcept>

namespace vayu::http {

namespace {

/// How long `start()` waits for the accept loop, in 1ms steps. A local bind is
/// live in well under a millisecond; the bound only matters so a pathological
/// scheduler cannot hang a route handler indefinitely.
constexpr int kListenSpinAttempts = 200;

} // namespace

ManagedListener::ManagedListener ()
: server_ (std::make_unique<httplib::Server> ()) {
}

ManagedListener::~ManagedListener () {
    stop ();
}

httplib::Server& ManagedListener::server () {
    if (!server_) {
        throw std::logic_error (
        "ManagedListener::server() after stop() - the listener is gone");
    }
    return *server_;
}

int ManagedListener::start (const std::string& bind_address, int port) {
    if (!server_ || listening_.load ()) {
        return 0;
    }

    // bind_to_any_port answers -1 on failure, bind_to_port a bool; both become
    // 0 here so every caller has one "nothing is listening" check.
    const int bound = port > 0 ?
    (server_->bind_to_port (bind_address, port) ? port : 0) :
    server_->bind_to_any_port (bind_address);
    if (bound <= 0) {
        return 0;
    }

    httplib::Server* svr = server_.get ();
    listening_.store (true);
    listen_thread_ = std::thread ([svr] { svr->listen_after_bind (); });
    // Return only once the accept loop is live: a stop() that races ahead of
    // listen() is missed, and the join in stop() then hangs.
    for (int i = 0; i < kListenSpinAttempts && !svr->is_running (); ++i) {
        std::this_thread::sleep_for (std::chrono::milliseconds (1));
    }
    return bound;
}

void ManagedListener::stop () {
    if (server_) {
        server_->stop ();
    }
    // A handler still running - a capture inside its configured delay, a token
    // exchange mid-flight - holds this thread, so the join is what makes
    // "stopped" mean "nothing is reading my owner's state any more".
    if (listen_thread_.joinable ()) {
        listen_thread_.join ();
    }
    server_.reset ();
    listening_.store (false);
}

bool ManagedListener::is_listening () const {
    return listening_.load ();
}

} // namespace vayu::http
