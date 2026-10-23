#pragma once

/**
 * @file silent_listener.hpp
 * @brief A loopback listener that accepts every connection and never writes a
 *        byte (#2835).
 *
 * Dialled as `https://`, the TLS handshake can never finish, which is the
 * connect phase hanging; dialled as `http://`, the connection is made and the
 * request sent, and then nothing comes back, which is silence after connect.
 * The same listener answers both, so a test pair differs in the scheme alone.
 * Raw sockets because httplib always answers, and on port 0.
 */

#include <atomic>
#include <cstddef>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "vayu/utils/parse.hpp"

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

class SilentListener {
    public:
    SilentListener () {
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

    ~SilentListener () {
        stopping_.store (true);
        if (acceptor_.joinable ()) {
            acceptor_.join ();
        }
        close_connections ();
        if (listener_ != NO_SOCKET) {
            close_socket (listener_);
        }
#ifdef _WIN32
        WSACleanup ();
#endif
    }
    SilentListener (const SilentListener&)            = delete;
    SilentListener& operator= (const SilentListener&) = delete;
    SilentListener (SilentListener&&)                 = delete;
    SilentListener& operator= (SilentListener&&)      = delete;

    /// 0 when the listener could not be opened.
    [[nodiscard]] int port () const {
        return port_;
    }

    /// `<scheme>://127.0.0.1:<port>/`.
    [[nodiscard]] std::string url (std::string_view scheme) const {
        return std::string (scheme) + "://127.0.0.1:" + std::to_string (port_) + "/";
    }

    /// Closes every connection held so far, which ends a client still waiting
    /// on one: how a test whose bound failed gets its transfer back to join.
    void close_connections () {
        const std::lock_guard<std::mutex> lock (mutex_);
        for (const Socket client : clients_) {
            close_socket (client);
        }
        clients_.clear ();
    }

    private:
#ifdef _WIN32
    using Socket                      = SOCKET;
    using SockLen                     = int;
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
    static constexpr Socket NO_SOCKET = -1;
    static void close_socket (Socket socket) {
        ::close (socket);
    }
    static int poll_one (pollfd* fd, int timeout_ms) {
        return ::poll (fd, 1, timeout_ms);
    }
#endif

    /// Polls rather than blocking in `accept`, because closing a listener from
    /// another thread does not end an `accept` on every platform. The timeout
    /// is only how often the stop flag is read.
    void accept_loop () {
        constexpr int STOP_POLL_MS = 20;
        while (!stopping_.load ()) {
            pollfd ready{};
            ready.fd     = listener_;
            ready.events = POLLIN;
            if (poll_one (&ready, STOP_POLL_MS) <= 0) {
                continue;
            }
            const Socket client = ::accept (listener_, nullptr, nullptr);
            if (client == NO_SOCKET) {
                continue;
            }
            const std::lock_guard<std::mutex> lock (mutex_);
            clients_.push_back (client);
        }
    }

    Socket listener_ = NO_SOCKET;
    int port_        = 0;
    std::atomic<bool> stopping_{ false };
    std::thread acceptor_;
    std::mutex mutex_;
    std::vector<Socket> clients_;
};

/// The N in libcurl's "... timed out after N milliseconds", or nothing when
/// @p message does not say it. The number is how long the transfer ran, so a
/// test reads which deadline ended it from the message, not from a clock.
[[nodiscard]] inline std::optional<long> timed_out_after_ms (std::string_view message) {
    constexpr std::string_view MARKER = "timed out after ";
    const auto at                     = message.find (MARKER);
    if (at == std::string_view::npos) {
        return std::nullopt;
    }
    std::string_view rest = message.substr (at + MARKER.size ());
    rest                  = rest.substr (0, rest.find (' '));
    return vayu::utils::parse_number<long> (rest);
}

} // namespace vayu::tests
