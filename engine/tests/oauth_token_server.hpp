#pragma once

/**
 * @file oauth_token_server.hpp
 * @brief In-process OAuth 2.0 token endpoint for the oauth_* tests.
 *
 * One endpoint per behaviour, chosen by path, counting every request it
 * answers: `hits()` is how a test tells a cached token from an exchange. Shared
 * so the client, authorize and route tests assert against the same provider
 * rather than three drifting copies.
 */

#include <httplib.h>

#include <chrono>
#include <map>
#include <string>
#include <thread>

namespace vayu::tests {

/// The `application/x-www-form-urlencoded` body as raw (still percent-encoded)
/// key/value pairs.
inline std::map<std::string, std::string> parse_form (const std::string& body) {
    std::map<std::string, std::string> out;
    size_t pos = 0;
    while (pos < body.size ()) {
        auto amp = body.find ('&', pos);
        auto pair =
        body.substr (pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (auto eq = pair.find ('='); eq != std::string::npos) {
            out[pair.substr (0, eq)] = pair.substr (eq + 1);
        }
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return out;
}

/// Mock IdP: records the last request for assertions.
///
/// `/token` answers `AT<hits>` with refresh token `RT1`, so every exchange
/// yields an access token no earlier row can share.
class MockTokenServer {
    public:
    MockTokenServer () {
        svr_.Post (".*", [this] (const httplib::Request& req, httplib::Response& res) {
            ++hits_;
            last_path_         = req.path;
            last_target_       = req.target;
            last_headers_      = req.headers;
            last_body_         = req.body;
            last_auth_         = req.get_header_value ("Authorization");
            last_content_type_ = req.get_header_value ("Content-Type");
            const auto form    = parse_form (req.body);
            const auto grant =
            form.count ("grant_type") ? form.at ("grant_type") : "";

            if (req.path == "/token") {
                res.set_content (R"({"access_token":"AT)" + std::to_string (hits_) +
                R"(","token_type":"Bearer","expires_in":3600,"refresh_token":"RT1","scope":"s1"})",
                "application/json");
            } else if (req.path == "/token-plain") {
                res.set_content (R"({"access_token":"AT-PLAIN"})", "application/json");
            } else if (req.path == "/token-legacy") {
                // Form-encoded body with a string expires_in (legacy GitHub style)
                res.set_content (
                "access_token=legacy&token_type=bearer&expires_in=1200", "text/plain");
            } else if (req.path == "/refresh-norotate") {
                if (grant == "refresh_token") {
                    res.set_content (R"({"access_token":"REFRESHED","expires_in":3600})",
                    "application/json");
                } else {
                    res.set_content (R"({"access_token":"FRESH","expires_in":3600})",
                    "application/json");
                }
            } else if (req.path == "/refresh-then-fresh") {
                if (grant == "refresh_token") {
                    res.status = 400;
                    res.set_content (R"({"error":"invalid_grant"})", "application/json");
                } else {
                    res.set_content (R"({"access_token":"FRESH-AFTER-REJECT","expires_in":3600})",
                    "application/json");
                }
            } else if (req.path == "/token-fail") {
                res.status = 400;
                res.set_content (R"({"error":"invalid_client","error_description":"bad secret"})",
                "application/json");
            } else {
                res.status = 404;
            }
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] { svr_.listen_after_bind (); });
        while (!svr_.is_running ())
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
    }
    ~MockTokenServer () {
        svr_.stop ();
        if (thread_.joinable ())
            thread_.join ();
    }
    MockTokenServer (const MockTokenServer&)            = delete;
    MockTokenServer& operator= (const MockTokenServer&) = delete;
    MockTokenServer (MockTokenServer&&)                 = delete;
    MockTokenServer& operator= (MockTokenServer&&)      = delete;

    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + path;
    }
    int hits () const {
        return hits_;
    }
    const std::string& last_body () const {
        return last_body_;
    }
    const std::string& last_auth () const {
        return last_auth_;
    }
    const std::string& last_content_type () const {
        return last_content_type_;
    }
    /// The request target as sent: the path and any query, still encoded.
    const std::string& last_target () const {
        return last_target_;
    }
    /// How many lines of header @p name the last request carried.
    size_t header_count (const std::string& name) const {
        return last_headers_.count (name);
    }
    std::string last_header (const std::string& name) const {
        const auto found = last_headers_.find (name);
        return found == last_headers_.end () ? "" : found->second;
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    int hits_ = 0;
    std::string last_path_, last_target_, last_body_, last_auth_, last_content_type_;
    httplib::Headers last_headers_;
    std::thread thread_;
};

} // namespace vayu::tests
