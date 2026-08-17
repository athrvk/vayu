#pragma once

/**
 * @file proxy_server.hpp
 * @brief An in-process forwarding HTTP proxy, for the transport-policy tests
 *        (issue #705).
 *
 * A proxy is the one thing these tests cannot mock at the seam: the whole
 * question is whether the bytes leave by a different socket, which only a
 * second listener can answer. So this is a real proxy - it accepts the
 * absolute-form request line curl sends only when proxying, forwards it, and
 * stamps `Via` on the way back - and every assertion about "did this path
 * traverse the proxy" is made against what it actually received.
 *
 * In-process rather than a script under `scripts/test/`, following the
 * precedent the engine's own tests set (`mock_server.hpp`, `echo_server.hpp`):
 * ctest runs these in one binary with no external process to start, stop or
 * leave behind on a failure.
 *
 * It is not a general-purpose proxy and should not grow into one. It speaks
 * enough of the protocol for these tests and no more: no CONNECT tunnelling
 * (the tunnel case here is a *refusal*, which needs no upstream at all), no
 * keep-alive reuse across targets, no authentication challenge.
 */

#include <httplib.h>

#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace vayu::tests {

class MockProxy {
    public:
    MockProxy () {
        svr.new_task_queue = [] { return new httplib::ThreadPool (16); };

        // CONNECT never reaches the routing table - httplib dispatches only the
        // body-carrying methods - so the tunnel case is answered here, before
        // routing. Refusing it with a 407 is exactly the shape that used to
        // surface as `INTERNAL_ERROR`: curl reports the refusal as
        // `CURLE_RECV_ERROR` and only `CURLINFO_HTTP_CONNECTCODE` remembers
        // that a proxy said no.
        svr.set_pre_routing_handler (
        [this] (const httplib::Request& req, httplib::Response& res) {
            if (req.method != "CONNECT") {
                return httplib::Server::HandlerResponse::Unhandled;
            }
            record (req.target);
            res.status = 407;
            res.set_header ("Proxy-Authenticate", "Basic realm=\"vayu-test\"");
            res.set_content ("proxy authentication required", "text/plain");
            return httplib::Server::HandlerResponse::Handled;
        });

        svr.Get (R"(.*)", [this] (const httplib::Request& req, httplib::Response& res) {
            forward (req, res);
        });
        svr.Post (R"(.*)", [this] (const httplib::Request& req, httplib::Response& res) {
            forward (req, res);
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~MockProxy () {
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }

    /// What to put in `TransportPolicy::proxy_url`.
    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port);
    }

    /// The header this proxy stamps on every response it forwards. A response
    /// carrying it came through here and could have come from nowhere else.
    static constexpr const char* VIA_VALUE = "1.1 vayu-test-proxy";

    /// The absolute-form targets this proxy was asked for, in arrival order.
    /// curl writes an absolute-form request line only when it is proxying, so
    /// a non-empty list *is* the proof of traversal.
    std::vector<std::string> seen () const {
        std::lock_guard<std::mutex> lock (mutex);
        return targets;
    }

    std::size_t count () const {
        std::lock_guard<std::mutex> lock (mutex);
        return targets.size ();
    }

    private:
    void record (const std::string& target) {
        std::lock_guard<std::mutex> lock (mutex);
        targets.push_back (target);
    }

    /// Split `http://host:port/path?query` into the origin httplib::Client
    /// takes and the path it dials. Returns false for a target that is not
    /// absolute-form, which means the request did not come from a proxying
    /// client and the test asking for it is wrong.
    static bool
    split_absolute (const std::string& target, std::string& origin, std::string& path) {
        const auto scheme_end = target.find ("://");
        if (scheme_end == std::string::npos) {
            return false;
        }
        const auto path_start = target.find ('/', scheme_end + 3);
        if (path_start == std::string::npos) {
            origin = target;
            path   = "/";
        } else {
            origin = target.substr (0, path_start);
            path   = target.substr (path_start);
        }
        return true;
    }

    /// Headers a proxy must not copy onward: they describe this hop, not the
    /// message. `Host` is omitted because httplib::Client sets its own.
    static bool is_hop_by_hop (const std::string& name) {
        static const std::vector<std::string> kHopByHop = { "connection",
            "proxy-connection", "proxy-authorization", "keep-alive", "te",
            "trailer", "transfer-encoding", "upgrade", "host", "content-length" };
        std::string lowered;
        lowered.reserve (name.size ());
        for (const char c : name) {
            lowered.push_back (
            static_cast<char> (std::tolower (static_cast<unsigned char> (c))));
        }
        return std::find (kHopByHop.begin (), kHopByHop.end (), lowered) !=
        kHopByHop.end ();
    }

    void forward (const httplib::Request& req, httplib::Response& res) {
        record (req.target);

        std::string origin;
        std::string path;
        if (!split_absolute (req.target, origin, path)) {
            res.status = 400;
            res.set_content ("not an absolute-form request line", "text/plain");
            return;
        }

        httplib::Headers forwarded;
        for (const auto& [name, value] : req.headers) {
            if (!is_hop_by_hop (name)) {
                forwarded.emplace (name, value);
            }
        }

        httplib::Client upstream (origin);
        upstream.set_connection_timeout (5, 0);
        upstream.set_read_timeout (10, 0);

        httplib::Result result = req.method == "POST" ?
        upstream.Post (path, forwarded, req.body, req.get_header_value ("Content-Type")) :
        upstream.Get (path, forwarded);

        if (!result) {
            res.status = 502;
            res.set_content ("upstream unreachable", "text/plain");
            res.set_header ("Via", VIA_VALUE);
            return;
        }

        res.status = result->status;
        for (const auto& [name, value] : result->headers) {
            if (!is_hop_by_hop (name) && name != "Content-Type") {
                res.set_header (name, value);
            }
        }
        res.set_content (result->body, result->get_header_value ("Content-Type"));
        res.set_header ("Via", VIA_VALUE);
    }

    httplib::Server svr;
    std::thread thread;
    int port = 0;
    mutable std::mutex mutex;
    std::vector<std::string> targets;
};

} // namespace vayu::tests
