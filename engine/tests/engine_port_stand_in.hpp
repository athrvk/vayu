#pragma once

/**
 * @file engine_port_stand_in.hpp
 * @brief A listener registered as this process's engine port (#2355).
 *
 * `vayu::http::set_engine_port` is set once per process, as the daemon sets
 * it, so every test that needs a reserved port shares this one: an
 * `EchoServer` on an ephemeral loopback port, registered on first use and
 * kept for the life of the process. Assert on the change in
 * `requests_seen ()` across a send, never on its absolute value: earlier
 * tests in the same process may have used it.
 */

#include <mutex>

#include "echo_server.hpp"
#include "vayu/http/loopback_guard.hpp"

namespace vayu::tests {

inline EchoServer& engine_port_stand_in () {
    static EchoServer server;
    static std::once_flag registered;
    std::call_once (
    registered, [] { vayu::http::set_engine_port (server.port ()); });
    return server;
}

} // namespace vayu::tests
