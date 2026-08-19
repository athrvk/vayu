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

#include <curl/curl.h>

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

    /**
     * @brief Largest response body this client will buffer, 0 = unbounded
     *        (issue #784).
     *
     * Zero, and therefore unbounded, for every caller that does not set it -
     * which is what "Design-mode sends are not affected" by
     * `maxResponseBodyBytes` has always meant, and this must not change it. The
     * `/import/fetch` proxy sets it, because that route buffers a response from
     * a URL a user typed with nothing behind it at all.
     *
     * Enforced by the write callback, which cuts the transfer short as soon as
     * the body grows past the bound - whether the server declared a length or
     * not - and fails it with `ErrorCode::ResponseTooLarge` rather than
     * buffering to the end. The declared length, when there is one, is what the
     * error message names as the count.
     */
    size_t max_response_bytes = 0;
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
 * @brief Select OpenSSL as this process's TLS backend, before curl is
 *        initialized (issue #851).
 *
 * Returns libcurl's own verdict: `CURLSSLSET_OK` when OpenSSL is now the
 * backend every transfer will use, `CURLSSLSET_UNKNOWN_BACKEND` for a build
 * that has no OpenSSL to select, and `CURLSSLSET_TOO_LATE` when curl was
 * already initialized - which would mean a caller reached curl before
 * `global_init`, and the selection below never took.
 *
 * **Why this exists rather than the manifest alone.** `engine/vcpkg.json` asks
 * for `curl` with `default-features: false` and an explicit `openssl`, which
 * should be the whole story - but the port's `http2` feature *itself* depends
 * on `curl[ssl]`, and the engine requires `http2`. On Windows `ssl` resolves to
 * Schannel, so the shipped libcurl is a **MultiSSL** build carrying both
 * backends however the manifest is written (#858 tracks getting it down to
 * one).
 *
 * On such a build libcurl picks the backend itself, and `multissl_setup`
 * consults the **`CURL_SSL_BACKEND` environment variable** before falling back
 * to the first compiled-in one. So an environment naming `schannel` - a
 * corporate login script, a leftover shell export - would silently move every
 * transfer onto the backend #851 exists to get off: mTLS stops working (#842)
 * and the trust model changes, with every document here still describing
 * OpenSSL. Naming the backend explicitly is what closes that, because
 * `multissl_setup` reads the environment only when no caller has chosen.
 *
 * Idempotent, and deliberately separate from `global_init` so the ordering it
 * depends on is one call a test can assert rather than a comment.
 */
CURLsslset pin_tls_backend ();

/**
 * @brief Initialize curl globally (call once at startup)
 *
 * Pins the TLS backend first - see `pin_tls_backend`, which must run before
 * curl is initialized to have any effect.
 */
void global_init ();

/**
 * @brief Cleanup curl globally (call once at shutdown)
 */
void global_cleanup ();

} // namespace vayu::http
