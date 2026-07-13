#pragma once

#include "vayu/db/database.hpp"

#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>

namespace vayu::http {

/**
 * Result of starting an interactive authorization attempt.
 */
struct AuthorizeStart {
    bool ok = true;
    std::string attempt_id;
    std::string authorize_url; // open this in the browser
    std::string redirect_uri;  // where the IdP will send the code
    // error (when !ok)
    int http_status = 400;
    std::string error_code;
    std::string error_message;
};

/**
 * Progress of an authorization attempt. `state` is one of:
 * "pending" | "completed" | "failed" | "not_found".
 */
struct AuthorizeStatus {
    std::string state = "not_found";
    std::string error;     // set when failed
    std::string cache_key; // set when completed
};

/**
 * Owns interactive OAuth 2.0 authorization-code attempts. In loopback mode the
 * engine binds a one-shot 127.0.0.1 listener that captures the IdP redirect,
 * validates state, and exchanges the code — all in-process, no browser code in
 * the engine. In embedded mode the app captures the redirect URL and hands it
 * back via complete(); the engine still owns state validation and the exchange.
 *
 * Thread-safe. The destructor stops and joins every live listener, so a
 * Database passed to start() must outlive the manager.
 */
class OAuth2AuthorizeManager {
    public:
    // Constructor and destructor are defined out-of-line (in the .cpp) because
    // the map holds unique_ptr<Attempt> and Attempt is an incomplete type here.
    OAuth2AuthorizeManager ();
    ~OAuth2AuthorizeManager ();

    OAuth2AuthorizeManager (const OAuth2AuthorizeManager&)            = delete;
    OAuth2AuthorizeManager& operator= (const OAuth2AuthorizeManager&) = delete;

    // mode: "loopback" (default) or "embedded".
    AuthorizeStart
    start (vayu::db::Database& db, const nlohmann::json& config, const std::string& mode);

    // Embedded mode: complete the attempt from the captured callback URL.
    AuthorizeStatus complete (vayu::db::Database& db, const std::string& attempt_id,
    const std::string& callback_url);

    AuthorizeStatus status (const std::string& attempt_id);
    void cancel (const std::string& attempt_id);

    private:
    struct Attempt;
    std::mutex mutex_;
    std::map<std::string, std::unique_ptr<Attempt>> attempts_;

    void teardown_locked (Attempt& attempt);
    void reap_timed_out_locked ();
};

/**
 * Build the IdP authorization URL for a config (exposed for unit testing).
 */
std::string build_authorize_url (const nlohmann::json& config,
const std::string& state, const std::string& code_challenge,
const std::string& redirect_uri, bool pkce);

} // namespace vayu::http
