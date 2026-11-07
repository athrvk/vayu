#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/listener_registry.hpp"
#include "vayu/utils/stop_signal.hpp"

#include <chrono>
#include <cstdint>
#include <map>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>

namespace vayu::http {

/**
 * Result of starting an interactive authorization attempt.
 */
struct AuthorizeStart {
    bool ok = true;
    std::string attempt_id;
    std::string authorize_url; // open this in the browser
    std::string redirect_uri;  // where the IdP will send the code
    /// When the attempt times out, in epoch milliseconds: the one deadline a
    /// client waits on (#3347).
    int64_t expires_at = 0;
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
 * The manager's clock. The defaults are the product's; a test shortens them so
 * it never waits out real minutes.
 */
struct AuthorizeTimings {
    std::chrono::milliseconds attempt_ttl{ vayu::core::constants::oauth_authorize::ATTEMPT_TTL_MS };
    /// Counted from the attempt's start, like the TTL, so keep it longer.
    std::chrono::milliseconds record_retention{
        vayu::core::constants::oauth_authorize::RECORD_RETENTION_MS
    };
    std::chrono::milliseconds reap_interval{ vayu::core::constants::oauth_authorize::REAP_INTERVAL_MS };
};

/**
 * Owns interactive OAuth 2.0 authorization-code attempts. In loopback mode the
 * engine binds a one-shot 127.0.0.1 listener that captures the IdP redirect,
 * validates state, and exchanges the code - all in-process, no browser code in
 * the engine. In embedded mode the app captures the redirect URL and hands it
 * back via complete(); the engine still owns state validation and the exchange.
 *
 * A reaper thread the manager owns fails each attempt still pending at its
 * deadline, tears down every settled attempt's listener and moves its result
 * aside for `record_retention`, so an attempt nobody polls frees its port and
 * `status` reads without writing (#3347).
 *
 * Thread-safe. The destructor shuts down (see `shutdown`), so a Database
 * passed to start() must outlive the manager.
 */
class OAuth2AuthorizeManager {
    public:
    // Constructor and destructor are defined out-of-line (in the .cpp) because
    // the registry holds unique_ptr<Attempt> and Attempt is an incomplete type
    // here.
    explicit OAuth2AuthorizeManager (AuthorizeTimings timings = {});
    ~OAuth2AuthorizeManager ();

    OAuth2AuthorizeManager (const OAuth2AuthorizeManager&)            = delete;
    OAuth2AuthorizeManager& operator= (const OAuth2AuthorizeManager&) = delete;
    OAuth2AuthorizeManager (OAuth2AuthorizeManager&&)                 = delete;
    OAuth2AuthorizeManager& operator= (OAuth2AuthorizeManager&&)      = delete;

    // mode: "loopback" (default) or "embedded". Refused with a 429 while
    // `MAX_ATTEMPTS` are unsettled, and with a 503 after `shutdown`.
    AuthorizeStart
    start (vayu::db::Database& db, const nlohmann::json& config, const std::string& mode);

    // Embedded mode: complete the attempt from the captured callback URL. Its
    // token exchange ends early when the attempt is cancelled or the manager
    // shuts down.
    AuthorizeStatus complete (vayu::db::Database& db,
    const std::string& attempt_id,
    const std::string& callback_url);

    /// Reads only: an attempt past its deadline the reaper has not reached yet
    /// is reported as the timeout the reaper will record.
    AuthorizeStatus status (const std::string& attempt_id);
    void cancel (const std::string& attempt_id);

    /// Stop the reaper and every loopback listener, cancel every token
    /// exchange, drop every attempt, and refuse every later start with a 503.
    /// Terminal and idempotent; the destructor runs it too.
    void shutdown ();

    private:
    struct Attempt;
    using Attempts = ListenerRegistry<Attempt>;
    using Clock    = std::chrono::steady_clock;

    /// A settled attempt's result, kept after its listener is gone.
    struct SettledRecord {
        AuthorizeStatus status;
        Clock::time_point erase_at;
    };

    void reap ();
    void run_reaper ();
    AuthorizeStatus settled_status (const std::string& attempt_id) const;

    const AuthorizeTimings timings_;
    /// Unsettled attempts only, so the registry's cap counts what holds a
    /// port or an exchange.
    Attempts attempts_;
    /// Taken after the registry's lock, never before it.
    mutable std::mutex settled_mutex_;
    std::map<std::string, SettledRecord> settled_;
    vayu::utils::StopSignal reaper_stop_;
    /// Declared last: it reads every member above until `shutdown` joins it.
    std::thread reaper_;
};

/**
 * Build the IdP authorization URL for a config (exposed for unit testing),
 * with the config's `authorizationParams` rows (`oauth::extra_params`) after
 * the parameters the engine writes.
 */
std::string build_authorize_url (const nlohmann::json& config,
const std::string& state,
const std::string& code_challenge,
const std::string& redirect_uri,
bool pkce);

} // namespace vayu::http
