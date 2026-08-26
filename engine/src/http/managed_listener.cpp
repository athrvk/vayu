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

#include <algorithm>
#include <chrono>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace vayu::http {

namespace {

/// How long `start()` waits for the accept loop, in 1ms steps. A local bind is
/// live in well under a millisecond; the bound only matters so a pathological
/// scheduler cannot hang a route handler indefinitely.
constexpr int kListenSpinAttempts = 200;

/// One live listener's hold on an address:port.
struct PortClaim {
    /// Identity, not ownership: the claim is released by `stop()` before the
    /// listener is destroyed, so this pointer is never dereferenced.
    const ManagedListener* owner = nullptr;
    std::string address;
    int port = 0;
    std::string label;
};

/// What every live listener in this process holds, so an explicitly requested
/// port can be refused before the bind that would silently share it (#512).
/// A handful of listeners run at once - the OAuth callback, at most eight mock
/// issuers, the inboxes - so a linear scan is the whole data structure.
struct ClaimRegistry {
    std::mutex mutex;
    std::vector<PortClaim> claims;
};

ClaimRegistry& registry () {
    static ClaimRegistry instance;
    return instance;
}

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

ManagedListener::StartOutcome ManagedListener::start (const std::string& bind_address,
int port,
const std::string& owner_label) {
    StartOutcome out;
    if (!server_ || listening_.load ()) {
        return out;
    }

    int bound = 0;
    {
        // Held across the bind, not just the scan: the managers start listeners
        // under their own separate locks, so a check released before binding
        // would let two of them claim one port anyway.
        std::lock_guard<std::mutex> lock (registry ().mutex);
        if (port > 0) {
            const auto& claims = registry ().claims;
            const auto held    = std::find_if (
            claims.begin (), claims.end (), [&] (const PortClaim& claim) {
                return claim.port == port && claim.address == bind_address;
            });
            if (held != claims.end ()) {
                out.held_by = held->label.empty () ? "another listener" : held->label;
                return out;
            }
        }

        // bind_to_any_port answers -1 on failure, bind_to_port a bool; both
        // become 0 here so every caller has one "nothing is listening" check.
        if (port > 0) {
            bound = server_->bind_to_port (bind_address, port) ? port : 0;
        } else {
            bound = server_->bind_to_any_port (bind_address);
        }
        if (bound <= 0) {
            return out;
        }
        registry ().claims.push_back (PortClaim{ this, bind_address, bound, owner_label });
    }

    httplib::Server* svr = server_.get ();
    listening_.store (true);
    listen_thread_ = std::thread ([svr] { svr->listen_after_bind (); });
    // Return only once the accept loop is live: a stop() that races ahead of
    // listen() is missed, and the join in stop() then hangs.
    for (int i = 0; i < kListenSpinAttempts && !svr->is_running (); ++i) {
        std::this_thread::sleep_for (std::chrono::milliseconds (1));
    }
    out.port = bound;
    return out;
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

    // Released only after the socket is gone, so the next listener that asks
    // for this port gets a bind that can actually succeed.
    std::lock_guard<std::mutex> lock (registry ().mutex);
    auto& claims = registry ().claims;
    claims.erase (std::remove_if (claims.begin (), claims.end (),
                  [this] (const PortClaim& claim) { return claim.owner == this; }),
    claims.end ());
}

bool ManagedListener::is_listening () const {
    return listening_.load ();
}

} // namespace vayu::http
