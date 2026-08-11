#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace vayu::http {

/**
 * A client the mock issuer will authenticate. An empty `client_secret` marks a
 * public client - one that authenticates with its id alone.
 */
struct MockIssuerClient {
    std::string client_id;
    std::string client_secret;
};

/**
 * What a mock issuer runs with. `failure_mode`, `slow_ms` and
 * `expires_in_seconds` are the live-updatable half (PUT /mock-issuer/:id); the
 * rest is fixed at start, because changing a port or a client list underneath a
 * bound listener is a restart, not an update.
 */
struct MockIssuerSettings {
    int port                   = 0; // 0 = ephemeral
    int64_t expires_in_seconds = 3600;
    nlohmann::json claims      = nlohmann::json::object ();
    std::vector<MockIssuerClient> clients; // empty = accept any client id
    std::string failure_mode  = "none"; // none|slow|server_error|invalid_client
    int64_t slow_ms           = 2000;
    bool issue_refresh_tokens = true;
};

/**
 * The outcome of reading a start payload or an update patch. `ok == false`
 * carries the message a `400` should state; the settings are only meaningful
 * when ok.
 */
struct MockIssuerConfig {
    bool ok = true;
    std::string error;
    MockIssuerSettings settings;
};

/**
 * Read a `POST /mock-issuer/start` payload into settings, defaults filling in
 * for absent fields. A field present with the wrong type or an out-of-range
 * value is an error rather than a silently ignored write - a mock issuer that
 * quietly ran with a different expiry than asked for would be worse than no
 * issuer at all, since the whole point is testing expiry behaviour.
 */
MockIssuerConfig parse_mock_issuer_settings (const nlohmann::json& body);

/**
 * Apply a `PUT /mock-issuer/:id` patch to @p current. Only `failureMode`,
 * `slowMs` and `expiresInSeconds` are updatable; any other key is a `400`
 * naming it, so a caller that expected a live port or client change learns that
 * it did not happen.
 */
MockIssuerConfig apply_mock_issuer_patch (const nlohmann::json& body,
const MockIssuerSettings& current);

/**
 * Result of starting a mock issuer.
 */
struct MockIssuerStart {
    bool ok = true;
    std::string issuer_id;
    std::string issuer_url;
    std::string token_url;
    std::string authorize_url;
    /// The HS256 secret this issuer signs with. Returned because a service
    /// under test needs it to verify the tokens the mock mints; it is
    /// throwaway, per-issuer and in-memory only.
    std::string signing_key;
    // error (when !ok)
    int http_status = 400;
    std::string error_code;
    std::string error_message;
};

namespace detail {
/// One running issuer: its settings, its issued codes and refresh tokens, and
/// the listener serving them. Defined in mock_issuer.cpp so this header stays
/// clear of httplib.
struct MockIssuerState;
} // namespace detail

/**
 * Owns local OAuth 2.0 mock issuers: each is an independent `127.0.0.1`
 * listener serving `/token` and `/authorize`, so auth flows are exercisable
 * offline without a real identity provider.
 *
 * Not an IdP. JWKS/RS256, OIDC discovery, token introspection, consent screens
 * and multi-tenant realms are deliberate non-goals - this is a dev-loop tool.
 *
 * State is in-memory only: a restart forgets every issuer. Thread-safe; the
 * destructor stops and joins every live listener, so the manager must outlive
 * nothing it captures (it captures only itself).
 */
class MockIssuerManager {
    public:
    // Defined out-of-line: the map holds unique_ptr<Issuer> and Issuer is an
    // incomplete type here (it owns an httplib::Server, kept out of this header).
    MockIssuerManager ();
    ~MockIssuerManager ();

    MockIssuerManager (const MockIssuerManager&)            = delete;
    MockIssuerManager& operator= (const MockIssuerManager&) = delete;

    MockIssuerStart start (const nlohmann::json& body);

    /// @return false when no issuer has that id.
    bool stop (const std::string& issuer_id);

    /// `{"issuers": [...]}` - one object per running issuer.
    nlohmann::json list () const;

    struct UpdateResult {
        bool found = false;
        bool ok    = true;
        std::string error;
        nlohmann::json issuer; // the updated description, when ok
    };
    UpdateResult update (const std::string& issuer_id, const nlohmann::json& body);

    private:
    mutable std::mutex mutex_;
    std::map<std::string, std::unique_ptr<detail::MockIssuerState>> issuers_;

    /// Stop and join one issuer's listener. Touches no manager state, so it is
    /// called both under `mutex_` (the destructor) and outside it (`stop`,
    /// where joining a listener thread must not block every other caller).
    static void teardown (detail::MockIssuerState& issuer);
};

} // namespace vayu::http
