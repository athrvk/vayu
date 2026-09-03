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

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>

#include "vayu/core/constants.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

/**
 * @brief Called as a response body arrives, for a caller that reports it
 *        (issue #882).
 *
 * `received` is the body buffered so far and `declared_total` is the upstream's
 * `Content-Length`, absent when it declared none - a chunked response has no
 * denominator, and the import dialog says "4.2 MB received" rather than drawing
 * a percentage of a number nobody stated.
 *
 * Return false to abandon the transfer. That is what a streaming caller does
 * when its own listener has gone: `/import/fetch` writes each report to an SSE
 * sink, and once that socket is dead there is nobody to read the remaining
 * megabytes for.
 */
using BodyProgressCallback =
std::function<bool (uint64_t received, std::optional<uint64_t> declared_total)>;

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
     * `maxResponseBodyBytes` still means: that setting is the load path's, and
     * nothing here reads it. The `/import/fetch` proxy sets it, because that
     * route buffers a response from a URL a user typed with nothing behind it
     * at all, and since #1157 the design-mode send sets it too - from
     * `maxDesignResponseBodyBytes`, its own setting, and with
     * @ref truncate_over_limit, which is what makes that bound survivable for a
     * response someone is watching for.
     *
     * Enforced by the write callback, which cuts the transfer short as soon as
     * the body grows past the bound - whether the server declared a length or
     * not - and fails it with `ErrorCode::ResponseTooLarge` rather than
     * buffering to the end. The declared length, when there is one, is what the
     * error message names as the count.
     */
    size_t max_response_bytes = 0;

    /**
     * @brief What reaching @ref max_response_bytes means: keep the prefix and
     *        report a truncated response (true), or refuse the transfer
     *        (false, the default) - issue #1157.
     *
     * The bound is enforced identically either way; this decides only what the
     * caller is handed afterwards. False is the right answer for a machine
     * reader - `/import/fetch` cannot import half a document and answers a
     * `413` - and true is the right answer for the design-mode send, where a
     * person asked to see this response: the prefix, its status and its
     * headers are worth more than an empty pane, and `Response::body_truncated`
     * is what stops that prefix being read as the whole body.
     *
     * Ignored when @ref max_response_bytes is 0, which nothing can exceed.
     */
    bool truncate_over_limit = false;

    /**
     * @brief Report the body's arrival to this callback, or null to report
     *        nothing (issue #882).
     *
     * Null for every caller but the streaming half of `/import/fetch`, which is
     * the only one with somewhere to send a report. Called from the write
     * callback, so it is called on the thread that ran `send` and once per curl
     * write - roughly every 16 KiB - which means a caller that emits something
     * per call has to throttle for itself. Deliberately unthrottled here: the
     * client reports what arrived, and how often that is worth relaying is a
     * decision only the caller can make.
     */
    BodyProgressCallback on_body_progress;

    /**
     * @brief Abort only after this long below a trickle, instead of after a
     *        fixed total (issue #882). 0 keeps the total bound.
     *
     * A total timeout on a download is a bound on its *size*, not on its health:
     * `Request::timeout_ms` defaults to 30s, so a 10 MB spec needed better than
     * 340 KB/s merely to arrive. `/import/fetch` reported that as
     * "Operation timed out ... with 4177920 out of 6296254 bytes received" - a
     * transfer that had never once stopped, killed for being large.
     *
     * Set instead of the total, not beside it: libcurl's low-speed options abort
     * when throughput stays under `STALL_FLOOR_BYTES_PER_SEC` for this long, and
     * a transfer with both bounds would still die at whichever fired first. What
     * still bounds the total is `max_response_bytes`, which every caller that
     * sets this also sets - so a hostile URL is bounded by the bytes it may send
     * rather than by the seconds it may take, which is the bound that was always
     * meant.
     *
     * Only the import fetch sets it. A design send's timeout is a number the
     * user typed against an endpoint they are testing, and it must stay exactly
     * what they typed.
     */
    long stall_timeout_ms = 0;
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

/// What `pin_tls_backend` managed to do, in this engine's terms rather than
/// libcurl's.
///
/// Named here rather than returning `CURLsslset` so this header does not have
/// to include `curl/curl.h`: on Windows that reaches `windows.h`, whose
/// `min`/`max` macros break `std::min`/`std::max` in every translation unit
/// that includes this one. `NOMINMAX` is deliberately PRIVATE to `vayu_core`
/// (`CMakeLists.txt`), so `vayu-engine` does not get it and `daemon.cpp` is
/// where that lands - which is exactly how this was found.
enum class TlsBackendSelection : std::uint8_t {
    /// OpenSSL is the backend every transfer will use, because we said so.
    Selected,
    /// This build has no OpenSSL to select - so whatever it does verify with,
    /// nothing this repo documents about trust applies to it.
    Unavailable,
    /// curl was already initialized, so the choice was made without us. A
    /// caller reached curl before `global_init`.
    TooLate
};

/**
 * @brief Select OpenSSL as this process's TLS backend, before curl is
 *        initialized (issue #851).
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
TlsBackendSelection pin_tls_backend ();

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
