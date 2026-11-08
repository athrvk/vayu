#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/disconnect_watch.hpp
 * @brief Ends a buffered handler's outbound work once its caller hangs up
 *        (#3383).
 *
 * A buffered `POST /execute` writes nothing to its caller until the exchange
 * is over, so no failed write tells it the caller has gone. This polls the
 * connection from a thread of its own and raises one flag, the one the
 * exchange's transfers watch as `ClientConfig::cancel`. The flag rises when
 * the server stops too (`RouteContext::server_stopping`), so the handler still
 * hands its transfers a single pointer, and `caller_left` says which of the
 * two raised it.
 *
 * "Gone" is httplib's `Request::is_connection_closed`: the socket reads
 * end-of-stream or an error. A caller that closed and one that only shut down
 * its sending side send the same FIN, and TCP tells them apart only once the
 * server writes, so a caller that half-closes after its request reads as gone
 * too. A hand-built `httplib::Request` answers "closed" until something sets
 * the function, so a test that calls a handler directly sets it.
 */

#include <atomic>
#include <chrono>
#include <exception>
#include <functional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#include "vayu/utils/logger.hpp"
#include "vayu/utils/stop_signal.hpp"

namespace vayu::http {

class DisconnectWatch {
    public:
    /// How often the connection is read. A transfer acts on the flag at its
    /// next libcurl progress tick, about once a second, so this adds a tenth
    /// to that at most.
    static constexpr std::chrono::milliseconds POLL_INTERVAL{ 100 };

    /// @p connection_closed is read on the watch's thread and by `caller_left`;
    /// @p server_stopping must outlive the watch.
    /// @throws std::invalid_argument for an empty @p connection_closed.
    DisconnectWatch (std::function<bool ()> connection_closed,
    const std::atomic<bool>& server_stopping)
    : connection_closed_ (std::move (connection_closed)),
      server_stopping_ (server_stopping) {
        if (!connection_closed_) {
            throw std::invalid_argument (
            "DisconnectWatch needs a connection probe");
        }
        thread_ = std::thread ([this] { watch (); });
    }

    ~DisconnectWatch () {
        try {
            done_.request ();
            if (thread_.joinable ()) {
                thread_.join ();
            }
        } catch (const std::exception& e) {
            log_unrecoverable ("Disconnect watch shutdown failed", e.what ());
        } catch (...) {
            log_unrecoverable ("Disconnect watch shutdown failed", "unknown exception");
        }
    }

    DisconnectWatch (const DisconnectWatch&)            = delete;
    DisconnectWatch& operator= (const DisconnectWatch&) = delete;
    DisconnectWatch (DisconnectWatch&&)                 = delete;
    DisconnectWatch& operator= (DisconnectWatch&&)      = delete;

    /// Raised once the caller has gone or the server is stopping, and never
    /// lowered. Lives as long as the watch.
    [[nodiscard]] const std::atomic<bool>& cancel () const noexcept {
        return cancel_;
    }

    /// Whether the caller hung up, rather than the server stopping. Reads the
    /// connection once more, so a caller that left after the last poll is
    /// not missed.
    [[nodiscard]] bool caller_left () {
        if (!caller_left_.load (std::memory_order_acquire) && !stopping () &&
        connection_closed_ ()) {
            mark_caller_left ();
        }
        return caller_left_.load (std::memory_order_acquire);
    }

    private:
    [[nodiscard]] bool stopping () const noexcept {
        return server_stopping_.load (std::memory_order_acquire);
    }

    void mark_caller_left () noexcept {
        caller_left_.store (true, std::memory_order_release);
        cancel_.store (true, std::memory_order_release);
    }

    /// True once the flag is raised, after which there is nothing to watch.
    [[nodiscard]] bool poll_once () {
        if (stopping ()) {
            cancel_.store (true, std::memory_order_release);
            return true;
        }
        if (connection_closed_ ()) {
            mark_caller_left ();
            return true;
        }
        return false;
    }

    void watch () noexcept {
        try {
            while (!poll_once ()) {
                if (done_.wait_for (POLL_INTERVAL)) {
                    return;
                }
            }
        } catch (const std::exception& e) {
            log_unrecoverable ("Disconnect watch failed", e.what ());
        } catch (...) {
            log_unrecoverable ("Disconnect watch failed", "unknown exception");
        }
    }

    /// Both callers are frames an escaping exception terminates, so the
    /// report itself must not throw.
    static void log_unrecoverable (std::string_view what, std::string_view detail) noexcept {
        try {
            vayu::utils::log_error (
            "http", std::string (what) + ": " + std::string (detail));
        } catch (...) {
            // @deliberate the logger failed while reporting a failure in a
            // frame that terminates if anything escapes it; there is nowhere
            // left to report to.
        }
    }

    std::function<bool ()> connection_closed_;
    const std::atomic<bool>& server_stopping_;
    std::atomic<bool> cancel_{ false };
    std::atomic<bool> caller_left_{ false };
    vayu::utils::StopSignal done_;
    std::thread thread_;
};

} // namespace vayu::http
