#pragma once

/**
 * @file mcp_port_stand_in.hpp
 * @brief The port registered as this process's MCP port (#3580).
 *
 * `vayu::http::set_mcp_port` is set once per process, as the daemon sets it,
 * so every test that reads the MCP reservation through the public predicate
 * shares this one. It is deliberately not `defaults::MCP_PORT`: a registered
 * port replaces the default, so a test can tell the registered port apart
 * from the fallback, and 9877 is a port like any other in this process.
 *
 * Nothing listens on it; the guard refuses a transfer before it dials. It sits
 * below every platform's ephemeral range (32768 and up on Linux, 49152 and up
 * on macOS and Windows), so no test server bound to port 0 can be handed it
 * and then find its own transfers refused.
 */

#include <mutex>

#include "vayu/http/loopback_guard.hpp"

namespace vayu::tests {

inline constexpr int MCP_PORT_STAND_IN = 19878;

inline int mcp_port_stand_in () {
    static std::once_flag registered;
    std::call_once (
    registered, [] { vayu::http::set_mcp_port (MCP_PORT_STAND_IN); });
    return MCP_PORT_STAND_IN;
}

} // namespace vayu::tests
