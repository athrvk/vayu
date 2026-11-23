#pragma once

/**
 * @file oauth_discovery_server.hpp
 * @brief An in-process MCP server and authorization server for the OAuth
 *        discovery tests (#3766).
 *
 * Every `GET` is answered from a table the test fills by path (the query is
 * not part of the key), and every path counts its requests: `hits` is how a
 * test tells a cached document from a fetched one, and an unlisted path is a
 * 404, which is what moves discovery on to its next well-known URL.
 */

#include "task_queue.hpp"
#include "wait_until.hpp"

#include <httplib.h>

#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace vayu::tests {

/// What one path answers.
struct DiscoveryAnswer {
    int status = 200;
    std::string body;
    std::string content_type = "application/json";
    /// Extra response header lines, in order; a name may repeat.
    std::vector<std::pair<std::string, std::string>> headers;
};

class DiscoveryServer {
    public:
    DiscoveryServer () {
        svr_.new_task_queue = pooled_task_queue (8);
        svr_.Get (".*", [this] (const httplib::Request& req, httplib::Response& res) {
            const std::lock_guard<std::mutex> lock (mutex_);
            ++hits_[req.path];
            last_accept_[req.path] = req.get_header_value ("Accept");
            const auto found       = answers_.find (req.path);
            if (found == answers_.end ()) {
                res.status = 404;
                return;
            }
            const DiscoveryAnswer& answer = found->second;
            res.status                    = answer.status;
            for (const auto& [name, value] : answer.headers) {
                res.headers.emplace (name, value);
            }
            res.set_content (answer.body, answer.content_type);
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] { svr_.listen_after_bind (); });
        if (!wait_until ([this] { return svr_.is_running (); })) {
            throw std::runtime_error (
            "the discovery fixture never started listening");
        }
    }
    ~DiscoveryServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    DiscoveryServer (const DiscoveryServer&)            = delete;
    DiscoveryServer& operator= (const DiscoveryServer&) = delete;
    DiscoveryServer (DiscoveryServer&&)                 = delete;
    DiscoveryServer& operator= (DiscoveryServer&&)      = delete;

    /// `http://127.0.0.1:<port>`, no trailing slash.
    [[nodiscard]] std::string origin () const {
        return "http://127.0.0.1:" + std::to_string (port_);
    }
    [[nodiscard]] std::string url (const std::string& path) const {
        return origin () + path;
    }

    void answer (const std::string& path, DiscoveryAnswer answer) {
        const std::lock_guard<std::mutex> lock (mutex_);
        answers_[path] = std::move (answer);
    }

    /// Requests @p path has received, whatever it answered.
    [[nodiscard]] int hits (const std::string& path) const {
        const std::lock_guard<std::mutex> lock (mutex_);
        const auto found = hits_.find (path);
        return found == hits_.end () ? 0 : found->second;
    }

    [[nodiscard]] int total_hits () const {
        const std::lock_guard<std::mutex> lock (mutex_);
        int total = 0;
        for (const auto& [path, count] : hits_) {
            total += count;
        }
        return total;
    }

    /// The `Accept` header of the last request for @p path.
    [[nodiscard]] std::string last_accept (const std::string& path) const {
        const std::lock_guard<std::mutex> lock (mutex_);
        const auto found = last_accept_.find (path);
        return found == last_accept_.end () ? "" : found->second;
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
    mutable std::mutex mutex_;
    std::map<std::string, DiscoveryAnswer> answers_;
    std::map<std::string, int> hits_;
    std::map<std::string, std::string> last_accept_;
};

} // namespace vayu::tests
