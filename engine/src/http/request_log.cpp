/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/request_log.hpp"

#include <chrono>
#include <iomanip>
#include <sstream>

#include "vayu/utils/logger.hpp"

namespace vayu::http {
namespace {

// The key `Response::user_data` carries the pre-routing timestamp under.
// Namespaced so it cannot collide with a route handler's own use of the same
// map (`user_data` is documented as "arbitrary data" a handler may read too).
constexpr const char* kStartTimeKey = "vayu.request_log.start";

} // namespace

std::string format_request_log_line (const RequestLogLine& line) {
    std::ostringstream out;
    out << line.method << ' ' << line.path << ' ' << line.status << ' '
        << std::fixed << std::setprecision (1) << line.duration_ms << "ms "
        << line.response_bytes << 'B';
    return out.str ();
}

void log_request (const RequestLogLine& line) {
    const std::string text = format_request_log_line (line);
    if (line.status >= 500) {
        vayu::utils::log_warning (text);
    } else if (line.status >= 300) {
        vayu::utils::log_info (text);
    } else {
        vayu::utils::log_debug (text);
    }
}

void install_request_logger (httplib::Server& server) {
    server.set_pre_routing_handler ([] (const httplib::Request&, httplib::Response& res) {
        res.user_data.set (kStartTimeKey, std::chrono::steady_clock::now ());
        return httplib::Server::HandlerResponse::Unhandled;
    });

    server.set_logger ([] (const httplib::Request& req, const httplib::Response& res) {
        double duration_ms = 0.0;
        if (const auto* started =
            res.user_data.get<std::chrono::steady_clock::time_point> (kStartTimeKey)) {
            duration_ms = std::chrono::duration<double, std::milli> (
            std::chrono::steady_clock::now () - *started)
                          .count ();
        }
        // A streamed response (SSE, a content provider) leaves `body` empty;
        // `Content-Length` is the next-best answer and is itself absent for a
        // chunked transfer, which reports 0 rather than guessing.
        std::size_t response_bytes = res.body.size ();
        if (response_bytes == 0 && res.has_header ("Content-Length")) {
            response_bytes = res.get_header_value_u64 ("Content-Length");
        }
        log_request ({ req.method, req.path, res.status, duration_ms, response_bytes });
    });
}

} // namespace vayu::http
