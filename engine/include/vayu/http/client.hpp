#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/client.hpp
 * @brief HTTP client using libcurl
 */

#include <memory>

#include "vayu/core/constants.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

/**
 * @brief HTTP Client configuration
 */
struct ClientConfig {
    std::string user_agent = vayu::core::constants::defaults::DEFAULT_USER_AGENT;
    bool verbose = vayu::core::constants::defaults::VERBOSE;

    /**
     * @brief How this transfer reaches the network (issue #705).
     *
     * Defaults to the environment pickup, which is what every `Client` did
     * before the policy existed. It replaced a `proxy_url` and a
     * `ca_bundle_path` that no code in the repo's history ever assigned - the
     * "written but never read" defect inverted - so a caller that wants a
     * proxy now has one field to set and `resolve_transport_policy(db)` to
     * fill it.
     */
    TransportPolicy transport;

    /**
     * @brief The jar this client reads cookies from and writes them back to,
     *        or null to send no stored cookie and keep none (issue #301).
     *
     * Null is the default because most `Client` users are not a user's
     * request: the OAuth token call, the import fetch and the update check are
     * the engine talking on its own behalf, and a session cookie picked up
     * there belongs to nobody's environment. Only `POST /execute` and the
     * `pm.sendRequest` inside it opt in - see `cookie_scope`.
     */
    CookieJar* cookie_jar = nullptr;

    /**
     * @brief Which jar - the environment id, or `NO_ENVIRONMENT_SCOPE`.
     *
     * Read only when `cookie_jar` is set.
     */
    std::string cookie_scope{ NO_ENVIRONMENT_SCOPE };

    /**
     * @brief Script jar writes this transfer carries (issue #337).
     *
     * Applied on top of the scope's stored lines when the handle is seeded, so
     * a `pm.cookies.jar().set` made just before the send rides the request it
     * was made for - and the transfer's own capture is what writes it back to
     * the jar. See cookie_jar.hpp for why the write is not applied to the map
     * directly. Read only when `cookie_jar` is set.
     */
    std::vector<CookieWrite> cookie_writes;
};

/**
 * @brief HTTP Client for making requests
 *
 * This is the simple synchronous client using curl_easy.
 * For high-concurrency scenarios, see EventLoop which uses curl_multi.
 */
class Client {
    public:
    /**
     * @brief Construct a new Client
     */
    explicit Client (ClientConfig config = {});

    /**
     * @brief Destructor
     */
    ~Client ();

    // Non-copyable
    Client (const Client&)            = delete;
    Client& operator= (const Client&) = delete;

    // Movable
    Client (Client&&) noexcept;
    Client& operator= (Client&&) noexcept;

    /**
     * @brief Send an HTTP request and return the response
     *
     * @param request The request to send
     * @return Result<Response> The response or an error
     */
    [[nodiscard]] Result<Response> send (const Request& request);

    /**
     * @brief Convenience method for GET requests
     */
    [[nodiscard]] Result<Response>
    get (const std::string& url, const Headers& headers = {});

    /**
     * @brief Convenience method for POST requests
     */
    [[nodiscard]] Result<Response>
    post (const std::string& url, const std::string& body, const Headers& headers = {});

    /**
     * @brief Get the last error message from curl
     */
    [[nodiscard]] std::string last_error () const;

    private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

/**
 * @brief Initialize curl globally (call once at startup)
 */
void global_init ();

/**
 * @brief Cleanup curl globally (call once at shutdown)
 */
void global_cleanup ();

} // namespace vayu::http
