#pragma once

/**
 * @file echo_server.hpp
 * @brief In-process HTTP endpoint that records what a request actually carried.
 *
 * The body tests assert on the wire rather than on the parsed struct: a
 * regression that re-broke serialization while leaving the parse intact still
 * has to redden them. That needs a server, and it needs to be in-process -
 * tests must not depend on external endpoints (see `mock_server.hpp`).
 *
 * Shared rather than copied per test file: a private copy would not receive
 * this one's fixes, and the multipart reading below is exactly the kind of
 * detail that only gets right once.
 */

#include <httplib.h>

#include <map>
#include <mutex>
#include <string>
#include <thread>

namespace vayu::tests {

/// Records what the last request actually carried: its Content-Type, its raw
/// body, and - for a multipart request - the parts httplib parsed out of it.
///
/// Multipart is asserted through those parsed parts rather than by matching
/// the envelope byte for byte, because httplib parses a multipart body itself
/// and leaves `req.body` empty. That is the better assertion anyway: httplib
/// splits the body on the boundary it read from the *header*, so a body whose
/// boundary disagreed with its Content-Type yields no parts at all, and a
/// part it can read is a part a real server can read.
class EchoServer {
    public:
    EchoServer () {
        auto record = [this] (const httplib::Request& req, httplib::Response& res) {
            {
                std::lock_guard<std::mutex> lock (mutex_);
                body_         = req.body;
                content_type_ = req.get_header_value ("Content-Type");
                parts_.clear ();
                for (const auto& [name, field] : req.form.fields) {
                    parts_[name] = field.content;
                }
            }
            res.set_content ("{}", "application/json");
        };
        svr_.Post ("/echo", record);
        svr_.Put ("/echo", record);

        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~EchoServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }

    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/echo";
    }

    std::string body () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return body_;
    }

    std::string content_type () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return content_type_;
    }

    /// The multipart parts, by field name. Empty for every other body.
    std::map<std::string, std::string> parts () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return parts_;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    mutable std::mutex mutex_;
    std::string body_;
    std::string content_type_;
    std::map<std::string, std::string> parts_;
};

} // namespace vayu::tests
