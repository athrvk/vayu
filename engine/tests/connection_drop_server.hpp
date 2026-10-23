#pragma once

/**
 * @file connection_drop_server.hpp
 * @brief A keep-alive HTTP/1.1 listener that can read a request and close the
 *        connection without writing a byte (#2799).
 *
 * That is the shape libcurl re-sends on its own when it meets it on a reused
 * connection, and httplib cannot produce it: a handler always answers. So this
 * is a raw-socket listener on port 0, one thread per connection, counting
 * every request head it reads. It reads heads only, which is all the tests
 * that use it send (a GET); a body would be read as the next request.
 */

#include <array>
#include <atomic>
#include <cstddef>
#include <functional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace vayu::tests {

class ConnectionDropServer {
    public:
    /// Whether to answer a request: @p arrival counts every request head the
    /// server has read, from 1; @p on_connection counts them on this
    /// connection alone. False closes the connection unanswered. Called from
    /// several connection threads at once, so it must not keep state.
    using AnswerRule =
    std::function<bool (std::size_t arrival, std::size_t on_connection)>;

    /// The rule every reused connection meets: the first request on a
    /// connection is answered, the next one is read and dropped.
    static bool first_on_each_connection (std::size_t /*arrival*/, std::size_t on_connection) {
        return on_connection == 1;
    }

    explicit ConnectionDropServer (AnswerRule rule = first_on_each_connection)
    : rule_ (std::move (rule)) {
#ifdef _WIN32
        WSADATA wsa{};
        WSAStartup (MAKEWORD (2, 2), &wsa);
#endif
        listener_ = ::socket (AF_INET, SOCK_STREAM, IPPROTO_TCP);
        sockaddr_in address{};
        address.sin_family      = AF_INET;
        address.sin_addr.s_addr = htonl (INADDR_LOOPBACK);
        address.sin_port        = 0;
        SockLen length          = sizeof (address);
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        auto* generic = reinterpret_cast<sockaddr*> (&address);
        if (listener_ == NO_SOCKET || ::bind (listener_, generic, length) != 0 ||
        ::listen (listener_, SOMAXCONN) != 0 ||
        ::getsockname (listener_, generic, &length) != 0) {
            return; // port_ stays 0, which every test using this asserts on.
        }
        port_     = ntohs (address.sin_port);
        acceptor_ = std::thread ([this] () { accept_loop (); });
    }

    /// Every thread waits through `wait_readable`, so each sees the stop
    /// within one poll; a connection thread closes its own socket.
    ~ConnectionDropServer () {
        stopping_.store (true);
        if (acceptor_.joinable ()) {
            acceptor_.join ();
        }
        if (listener_ != NO_SOCKET) {
            close_socket (listener_);
        }
        for (auto& connection : connections_) {
            connection.join ();
        }
#ifdef _WIN32
        WSACleanup ();
#endif
    }
    ConnectionDropServer (const ConnectionDropServer&)            = delete;
    ConnectionDropServer& operator= (const ConnectionDropServer&) = delete;
    ConnectionDropServer (ConnectionDropServer&&)                 = delete;
    ConnectionDropServer& operator= (ConnectionDropServer&&)      = delete;

    /// 0 when the listener could not be opened.
    [[nodiscard]] int port () const {
        return port_;
    }

    [[nodiscard]] std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/";
    }

    /// Request heads read, answered or not.
    [[nodiscard]] std::size_t arrivals () const {
        return arrivals_.load ();
    }

    /// Requests read and then dropped unanswered.
    [[nodiscard]] std::size_t dropped () const {
        return dropped_.load ();
    }

    private:
#ifdef _WIN32
    using Socket                      = SOCKET;
    using SockLen                     = int;
    using IoLength                    = int;
    static constexpr Socket NO_SOCKET = INVALID_SOCKET;
    static void close_socket (Socket socket) {
        closesocket (socket);
    }
    static int poll_one (pollfd* fd, int timeout_ms) {
        return WSAPoll (fd, 1, timeout_ms);
    }
#else
    using Socket                      = int;
    using SockLen                     = socklen_t;
    using IoLength                    = std::size_t;
    static constexpr Socket NO_SOCKET = -1;
    static void close_socket (Socket socket) {
        ::close (socket);
    }
    static int poll_one (pollfd* fd, int timeout_ms) {
        return ::poll (fd, 1, timeout_ms);
    }
#endif
#ifdef MSG_NOSIGNAL
    static constexpr int SEND_FLAGS = MSG_NOSIGNAL;
#else
    static constexpr int SEND_FLAGS = 0;
#endif

    static constexpr std::string_view RESPONSE =
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: "
    "2\r\n\r\nok";
    static constexpr std::string_view HEAD_END = "\r\n\r\n";

    /// Whether @p socket has something to read (a connection, bytes, or the
    /// peer's close), polling until it does or the destructor stops the
    /// server. The poll's timeout is only how often the stop flag is read.
    /// Every wait goes through here because nothing the destructor can do to
    /// a socket from another thread wakes a blocked call on every platform:
    /// closing a listener does not end an `accept`, and on Windows `shutdown`
    /// does not end a `recv`. A client that outlives the server (an
    /// `EventLoop` torn down after the test body) still holds its last
    /// connection open, so that `recv` is pending at every such destruction.
    [[nodiscard]] bool wait_readable (Socket socket) const {
        constexpr int STOP_POLL_MS = 20;
        while (!stopping_.load ()) {
            pollfd ready{};
            ready.fd         = socket;
            ready.events     = POLLIN;
            const int polled = poll_one (&ready, STOP_POLL_MS);
            if (polled != 0) {
                return polled > 0;
            }
        }
        return false;
    }

    void accept_loop () {
        while (wait_readable (listener_)) {
            const Socket client = ::accept (listener_, nullptr, nullptr);
            if (client == NO_SOCKET) {
                continue;
            }
#ifdef SO_NOSIGPIPE
            const int on = 1;
            setsockopt (client, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof (on));
#endif
            connections_.emplace_back ([this, client] () { serve (client); });
        }
    }

    /// Reads request heads off one connection and answers or drops each.
    void serve (Socket client) {
        std::string pending;
        std::size_t on_connection = 0;
        std::array<char, 4096> chunk{};
        for (;;) {
            const auto head_end = pending.find (HEAD_END);
            if (head_end == std::string::npos) {
                if (!wait_readable (client)) {
                    break;
                }
                const auto got = ::recv (
                client, chunk.data (), static_cast<IoLength> (chunk.size ()), 0);
                if (got <= 0) {
                    break;
                }
                pending.append (chunk.data (), static_cast<std::size_t> (got));
                continue;
            }
            pending.erase (0, head_end + HEAD_END.size ());
            const std::size_t arrival = arrivals_.fetch_add (1) + 1;
            if (!rule_ (arrival, ++on_connection)) {
                dropped_.fetch_add (1);
                break;
            }
            if (!send_all (client, RESPONSE)) {
                break;
            }
        }
        close_socket (client);
    }

    static bool send_all (Socket client, std::string_view bytes) {
        while (!bytes.empty ()) {
            const auto sent = ::send (client, bytes.data (),
            static_cast<IoLength> (bytes.size ()), SEND_FLAGS);
            if (sent <= 0) {
                return false;
            }
            bytes.remove_prefix (static_cast<std::size_t> (sent));
        }
        return true;
    }

    AnswerRule rule_;
    Socket listener_ = NO_SOCKET;
    int port_        = 0;
    std::atomic<bool> stopping_{ false };
    std::atomic<std::size_t> arrivals_{ 0 };
    std::atomic<std::size_t> dropped_{ 0 };
    std::thread acceptor_;
    // Written by the accept thread alone, joined after it.
    std::vector<std::thread> connections_;
};

} // namespace vayu::tests
