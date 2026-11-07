#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/held_request.hpp
 * @brief A request held in an engine listener's handler, with proof it got
 *        there (#3345).
 *
 * A handler that paces its answer (a mock's `latencyMs`, an issuer's `slow`
 * mode, an inbox's `delayMs`) changes nothing a test can see before it waits,
 * so "the request is in the handler" cannot be awaited directly, and a stop
 * that lands before the listener accepted the connection refuses it instead
 * of interrupting it. `HeldRequest` writes an @p opener the listener answers
 * at once and the @p held request behind it, in one write on one connection.
 * Once the opener's answer arrives the listener has accepted the connection
 * and the held request's bytes have arrived with the opener's, and
 * cpp-httplib serves a request whose bytes are already readable whatever
 * stops its listener next.
 *
 * Both requests are written whole as given; @p held should say
 * `Connection: close`, which is what ends the read.
 */

#include <httplib.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <future>
#include <string>
#include <string_view>

namespace vayu::tests {

namespace held_request_detail {

/// Through httplib's own socket helpers, which already hold every platform's
/// spelling of a socket (`server_gate_test.cpp`'s `raw_answer` does the same).
inline socket_t connect_loopback (int port, int read_timeout_s) {
    auto error = httplib::Error::Success;
    return httplib::detail::create_client_socket ("127.0.0.1", "", port,
    AF_INET, true, false, nullptr, 5, 0, read_timeout_s, 0, 5, 0, "", error);
}

inline bool is_open (socket_t socket) {
    // SOCKET is unsigned on Windows and INVALID_SOCKET is (-1) there.
    return socket != static_cast<socket_t> (INVALID_SOCKET);
}

} // namespace held_request_detail

/// A bodiless request that leaves the connection open for the one behind it.
/// @p header_lines are whole lines, each ending in CRLF.
inline std::string opener_request (std::string_view method,
std::string_view target,
std::string_view header_lines = {}) {
    return std::string (method) + " " + std::string (target) +
    " HTTP/1.1\r\nHost: 127.0.0.1\r\n" + std::string (header_lines) + "\r\n";
}

/// The opener a mock server or an inbox answers before its pacing: a CORS
/// preflight, which both answer `204` at once.
inline std::string preflight_opener (std::string_view path) {
    return opener_request ("OPTIONS", path, "Access-Control-Request-Method: GET\r\n");
}

/// A request asking the listener to close once it has answered, carrying
/// @p form_body as a form when it is not empty.
inline std::string closing_request (std::string_view method,
std::string_view target,
std::string_view form_body = {}) {
    std::string request = std::string (method) + " " + std::string (target) +
    " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n";
    if (!form_body.empty ()) {
        request +=
        "Content-Type: application/x-www-form-urlencoded\r\nContent-Length: " +
        std::to_string (form_body.size ()) + "\r\n";
    }
    return request + "\r\n" + std::string (form_body);
}

/// Whether anything accepts a TCP connection on 127.0.0.1:@p port.
inline bool accepts_connections (int port) {
    const socket_t socket = held_request_detail::connect_loopback (port, 1);
    if (!held_request_detail::is_open (socket)) {
        return false;
    }
    httplib::detail::close_socket (socket);
    return true;
}

class HeldRequest {
    public:
    /// Past the 30s delay the tests hold a request in, so a broken build still
    /// reads the late answer rather than timing out first.
    static constexpr int READ_TIMEOUT_S = 40;

    HeldRequest (int port, std::string opener, std::string held)
    : answer_ (std::async (std::launch::async,
      [this, port, wire = std::move (opener) + std::move (held)] () {
          return exchange (port, wire);
      })) {
    }

    /// True once the listener has begun answering the opener.
    [[nodiscard]] bool opener_answered () const {
        return opener_answered_.load ();
    }

    /// True once the listener has closed the connection.
    [[nodiscard]] bool finished () const {
        return answer_.wait_for (std::chrono::seconds (0)) == std::future_status::ready;
    }

    /// The held request's status, waiting for the close; 0 when it got none.
    int held_status () {
        const std::string& answer = answer_.get ();
        // The opener's status line opens the answer; the held one's follows.
        const auto second = answer.find ("HTTP/1.1 ", 1);
        if (second == std::string::npos || answer.size () < second + 12) {
            return 0;
        }
        return std::stoi (answer.substr (second + 9, 3));
    }

    private:
    std::string exchange (int port, std::string_view wire) {
        const socket_t socket = held_request_detail::connect_loopback (port, READ_TIMEOUT_S);
        if (!held_request_detail::is_open (socket)) {
            return {};
        }
        std::size_t sent = 0;
        while (sent < wire.size ()) {
            const std::string_view rest = wire.substr (sent);
            const auto n =
            httplib::detail::send_socket (socket, rest.data (), rest.size (), 0);
            if (n <= 0) {
                break;
            }
            sent += static_cast<std::size_t> (n);
        }
        std::string answer;
        std::array<char, 512> buffer{};
        while (sent == wire.size ()) {
            const auto n =
            httplib::detail::read_socket (socket, buffer.data (), buffer.size (), 0);
            if (n <= 0) {
                break;
            }
            answer.append (buffer.data (), static_cast<std::size_t> (n));
            opener_answered_.store (true);
        }
        httplib::detail::close_socket (socket);
        return answer;
    }

    std::atomic<bool> opener_answered_{ false };
    /// Declared last so it is destroyed first: its destructor waits for the
    /// reader, which writes `opener_answered_`.
    std::shared_future<std::string> answer_;
};

} // namespace vayu::tests
