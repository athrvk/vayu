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
 *
 * `MockTlsProxy` is the same forwarder behind a TLS listener, for an `https://`
 * proxy URL (#2469). It still forwards absolute-form requests to a plain-HTTP
 * origin and still does no CONNECT: what it exists to exercise is the handshake
 * with the *proxy*, which is a different trust decision from the origin's.
 */

#include <httplib.h>

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "task_queue.hpp"
#include "tls_server.hpp"

namespace vayu::tests {

/// The proxy behaviour both listeners below share: the CONNECT refusal, the
/// absolute-form forward, and the record of what arrived.
class ProxyForwarder {
    public:
    /// Wires the forwarding behaviour onto @p server, which must outlive
    /// every request this forwarder is asked to answer.
    void install (httplib::Server& server) {
        // CONNECT never reaches the routing table - httplib dispatches only the
        // body-carrying methods - so the tunnel case is answered here, before
        // routing. Refusing it with a 407 is exactly the shape that used to
        // surface as `INTERNAL_ERROR`: curl reports the refusal as
        // `CURLE_RECV_ERROR` and only `CURLINFO_HTTP_CONNECTCODE` remembers
        // that a proxy said no.
        server.set_pre_routing_handler (
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

        server.Get (R"(.*)", [this] (const httplib::Request& req, httplib::Response& res) {
            forward (req, res);
        });
        server.Post (R"(.*)", [this] (const httplib::Request& req, httplib::Response& res) {
            forward (req, res);
        });
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

    mutable std::mutex mutex;
    std::vector<std::string> targets;
};

class MockProxy {
    public:
    MockProxy () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (16);
        forwarder.install (svr);

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~MockProxy () {
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }
    MockProxy (const MockProxy&)            = delete;
    MockProxy& operator= (const MockProxy&) = delete;
    MockProxy (MockProxy&&)                 = delete;
    MockProxy& operator= (MockProxy&&)      = delete;

    /// What to put in `TransportPolicy::proxy_url`.
    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port);
    }

    static constexpr const char* VIA_VALUE = ProxyForwarder::VIA_VALUE;

    /// The absolute-form targets this proxy was asked for, in arrival order.
    /// curl writes an absolute-form request line only when it is proxying, so
    /// a non-empty list *is* the proof of traversal.
    std::vector<std::string> seen () const {
        return forwarder.seen ();
    }

    std::size_t count () const {
        return forwarder.count ();
    }

    private:
    ProxyForwarder forwarder;
    httplib::Server svr;
    std::thread thread;
    int port = 0;
};

/**
 * @brief A forwarding proxy that speaks TLS to its client, its certificate
 *        signed by @p ca and carrying an `IP:127.0.0.1` SAN (#2469).
 *
 * The listener is `httplib::SSLServer`, so a client that does not trust @p ca
 * never completes the handshake and `count ()` stays 0 - the refusal is the
 * assertion, as for `TlsServer`. The leaf names no CRL distribution point: every
 * backend in the build is OpenSSL, which does not revocation-check unless told
 * to (`tls_server.hpp`).
 */
class MockTlsProxy {
    public:
    explicit MockTlsProxy (const TestCertificateAuthority& ca)
    : identity_ (ca.issue ("127.0.0.1", "IP:127.0.0.1,DNS:localhost")),
      cert_pem_ (identity_.pem ()), key_pem_ (identity_.key_pem ()),
      svr_ (httplib::SSLServer::PemMemory{ cert_pem_.c_str (), cert_pem_.size (),
      key_pem_.c_str (), key_pem_.size (), nullptr, 0, nullptr }) {
        if (!svr_.is_valid ()) {
            tls_detail::fail ("the TLS proxy refused its own certificate");
        }
        svr_.new_task_queue = vayu::tests::pooled_task_queue (16);
        forwarder_.install (svr_);

        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~MockTlsProxy () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    MockTlsProxy (const MockTlsProxy&)            = delete;
    MockTlsProxy& operator= (const MockTlsProxy&) = delete;
    MockTlsProxy (MockTlsProxy&&)                 = delete;
    MockTlsProxy& operator= (MockTlsProxy&&)      = delete;

    /// What to put in `TransportPolicy::proxy_url`.
    std::string url () const {
        return "https://127.0.0.1:" + std::to_string (port_);
    }

    /// The absolute-form targets this proxy was asked for, as `MockProxy::seen`.
    std::vector<std::string> seen () const {
        return forwarder_.seen ();
    }

    std::size_t count () const {
        return forwarder_.count ();
    }

    private:
    ProxyForwarder forwarder_;
    CertificateAndKey identity_;
    std::string cert_pem_;
    std::string key_pem_;
    httplib::SSLServer svr_;
    std::thread thread_;
    int port_ = 0;
};

} // namespace vayu::tests
