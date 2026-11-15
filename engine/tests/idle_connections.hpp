#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/idle_connections.hpp
 * @brief Loopback connections a listener is left holding, and a count of the
 *        ones the peer has closed.
 *
 * What a listener does with more connections than it will hold: the ones it
 * keeps stay silent (a worker is waiting on a request line or inside a
 * handler, or the connection is queued for a worker), and the ones it refuses
 * are closed at accept. A client tells the two apart by whether the socket has
 * become readable and then reads end-of-stream or an error.
 *
 * A connection that sends nothing is closed by cpp-httplib's read timeout
 * (5s by default), so a test that must outlast it sets a longer one on the
 * server, or sends a request a handler then holds (an inbox's `delayMs`).
 */

#include <httplib.h>

#include <cstddef>
#include <string>
#include <vector>

#include "held_request.hpp"

namespace vayu::tests {

class IdleConnections {
    public:
    /// Opens up to @p count connections to 127.0.0.1:@p port, each writing
    /// @p request (nothing when empty); `opened ()` is how many the kernel
    /// accepted.
    IdleConnections (int port, std::size_t count, const std::string& request = {}) {
        for (std::size_t i = 0; i < count; ++i) {
            const socket_t socket = held_request_detail::connect_loopback (port, 1);
            if (!held_request_detail::is_open (socket)) {
                continue;
            }
            if (!request.empty ()) {
                httplib::detail::send_socket (socket, request.data (), request.size (), 0);
            }
            connections_.push_back ({ socket, false });
        }
    }
    ~IdleConnections () {
        close_all ();
    }
    IdleConnections (const IdleConnections&)            = delete;
    IdleConnections& operator= (const IdleConnections&) = delete;
    IdleConnections (IdleConnections&&)                 = delete;
    IdleConnections& operator= (IdleConnections&&)      = delete;

    [[nodiscard]] std::size_t opened () const {
        return connections_.size ();
    }

    /// How many connections the peer has closed so far (each read once).
    [[nodiscard]] std::size_t closed_by_peer () {
        std::size_t closed = 0;
        for (auto& connection : connections_) {
            if (!connection.closed && has_ended (connection.socket)) {
                connection.closed = true;
            }
            closed += connection.closed ? 1U : 0U;
        }
        return closed;
    }

    /// Closes every connection from this side, which frees a worker still
    /// waiting on one.
    void close_all () {
        for (const auto& connection : connections_) {
            httplib::detail::close_socket (connection.socket);
        }
        connections_.clear ();
    }

    private:
    struct Connection {
        socket_t socket;
        bool closed;
    };

    /// Readable with nothing to read is end-of-stream or a reset; the listener
    /// under test never answers an idle connection with data.
    static bool has_ended (socket_t socket) {
        if (httplib::detail::select_read (socket, 0, 0) <= 0) {
            return false;
        }
        char byte = 0;
        return httplib::detail::read_socket (socket, &byte, 1, 0) <= 0;
    }

    std::vector<Connection> connections_;
};

} // namespace vayu::tests
