#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <httplib.h>

#include <cstddef>
#include <string>

/**
 * @file request_log.hpp
 * @brief One request line per HTTP call, from one place (issue #1510).
 *
 * Before this, a route's request line was hand-written per handler - about
 * half the routes had none at all, so an absent line was never evidence a
 * route did not run. `install_request_logger` replaces every one of those
 * with a single hook on the `httplib::Server` itself: a `set_pre_routing_handler`
 * stamps the start time onto `Response::user_data` (the mechanism cpp-httplib
 * gives a pre-routing handler to hand a route handler data; a post-response
 * logger reads it the same way, since both run on the connection's own thread
 * for the same request), and `set_logger` reads it back to emit one line.
 *
 * The line never carries the query string, headers or body - any of the three
 * can hold a token, an OAuth code, or a credential - only method, path, status,
 * duration and response size (`format_request_log_line`).
 */

namespace vayu::http {

/// One HTTP call's request-line fields, kept separate from httplib's own
/// `Request`/`Response` so the format and level rule are testable without a
/// running server.
struct RequestLogLine {
    std::string method;
    std::string path;
    int status                 = 0;
    double duration_ms         = 0.0;
    std::size_t response_bytes = 0;
};

/// `"GET /inbox 200 1.3ms 412B"` - method, path, status, duration and response
/// bytes, in that order, and nothing else.
std::string format_request_log_line (const RequestLogLine& line);

/// Writes @p line through `vayu::utils::Logger` at the level its status calls
/// for: 2xx at DEBUG (only `-v 2` shows the happy path), 3xx/4xx at INFO
/// (`-v 1` shows a caller's own mistake), 5xx at WARNING (visible even at
/// `-v 0`, because an engine failure is not something a quiet run should hide).
void log_request (const RequestLogLine& line);

/// Installs the pre-routing timestamp and the post-response logger on
/// @p server. Never call this on a server that already installs its own
/// `set_pre_routing_handler` for routing (the mock server's listener does,
/// to serve an arbitrarily long mocked path) - that handler's return value
/// decides whether cpp-httplib routes the request at all, and this one must
/// not replace it.
void install_request_logger (httplib::Server& server);

} // namespace vayu::http
