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

/// Records what the last request actually carried: its path, its headers, its
/// Content-Type, its raw body, and - for a multipart request - the parts
/// httplib parsed out of it.
///
/// The path and headers are recorded for the same reason the body is: a
/// substitution that reaches the request struct but not the wire has to be
/// visible here (issue #601 binds a data row into all three).
///
/// Multipart is asserted through those parsed parts rather than by matching
/// the envelope byte for byte, because httplib parses a multipart body itself
/// and leaves `req.body` empty. That is the better assertion anyway: httplib
/// splits the body on the boundary it read from the *header*, so a body whose
/// boundary disagreed with its Content-Type yields no parts at all, and a
/// part it can read is a part a real server can read.
class EchoServer {
    public:
    /// What a multipart part declared about itself, beside its bytes. A file
    /// part is only distinguishable from a text one by these - a part sent
    /// without its filename arrives as an ordinary field.
    struct Part {
        std::string content;
        std::string filename;
        std::string content_type;
    };

    EchoServer () {
        auto record = [this] (const httplib::Request& req, httplib::Response& res) {
            {
                std::lock_guard<std::mutex> lock (mutex_);
                path_         = req.path;
                target_       = req.target;
                headers_      = req.headers;
                body_         = req.body;
                content_type_ = req.get_header_value ("Content-Type");
                parts_.clear ();
                // httplib splits a multipart body in two: a part that declares
                // a filename is a *file* and lands in `files`, everything else
                // in `fields`. Both are parts of the same body here - which
                // half a part lands in is itself an assertion the file tests
                // make, through `Part::filename`.
                for (const auto& [name, field] : req.form.fields) {
                    parts_[name] = Part{ field.content, "", "" };
                }
                for (const auto& [name, file] : req.form.files) {
                    parts_[name] = Part{ file.content, file.filename, file.content_type };
                }
            }
            res.set_content ("{}", "application/json");
        };
        // `/echo` and anything under it. The suffix form is what lets a test
        // send to a path built by substitution (`/echo/users/{{data.id}}`) and
        // read back the path the server was actually asked for.
        svr_.Get ("/echo.*", record);
        svr_.Post ("/echo.*", record);
        svr_.Put ("/echo.*", record);

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

    /// The path the server was asked for, including anything appended to
    /// {@link url}.
    std::string path () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return path_;
    }

    /// One request header as received, or `""` when it was not sent. Header
    /// names are matched case-insensitively, as httplib stores them.
    std::string header (const std::string& name) const {
        std::lock_guard<std::mutex> lock (mutex_);
        const auto found = headers_.find (name);
        return found == headers_.end () ? std::string () : found->second;
    }

    /// Whether the header arrived at all. The distinction {@link header}
    /// cannot make: an empty-valued header and an absent one both read as
    /// `""` there, and telling them apart is the whole question when what is
    /// under test is which headers reached the wire (issue #662).
    bool has_header (const std::string& name) const {
        std::lock_guard<std::mutex> lock (mutex_);
        return headers_.find (name) != headers_.end ();
    }

    /// The request target as received - {@link path} plus the query string,
    /// still percent-encoded. What a test asserts against when the encoding
    /// itself is the point (an api key placed in the query).
    std::string target () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return target_;
    }

    std::string content_type () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return content_type_;
    }

    /// The multipart parts, by field name. Empty for every other body.
    std::map<std::string, Part> parts () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return parts_;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    mutable std::mutex mutex_;
    std::string path_;
    std::string target_;
    httplib::Headers headers_;
    std::string body_;
    std::string content_type_;
    std::map<std::string, Part> parts_;
};

} // namespace vayu::tests
