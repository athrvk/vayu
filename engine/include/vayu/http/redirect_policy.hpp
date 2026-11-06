#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/redirect_policy.hpp
 * @brief What the engine's own redirect loop decides between two hops (#3255).
 *
 * A send that follows redirects runs one transfer per hop and decides here what
 * the next one is, rather than leaving `CURLOPT_FOLLOWLOCATION` to do it inside
 * one transfer: libcurl hands a client certificate only to the origin a
 * transfer started at, so every hop has to be its own transfer for the
 * certificate registry to be consulted for it (#3300). `Client::send`, the SSE
 * consumer (#3301) and the load path's event loop (#3302) drive their chains
 * through `RedirectChain`.
 *
 * The rules restate what libcurl did, so a send behaves as it did when libcurl
 * followed: which statuses are followed, how a `Location` resolves, which
 * method and body a hop keeps, which headers stay with the first origin and
 * how the limit is worded. The one rule that is Vayu's own is the cookie rule
 * at the bottom.
 */

#include <curl/curl.h>

#include <expected>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/types.hpp"

namespace vayu::http {

/**
 * @brief Whether a response with @p status is a redirect a following send acts
 *        on, given that it names a `Location`: any 3xx, as libcurl follows.
 */
[[nodiscard]] bool is_redirect_status (int status);

/**
 * @brief The first non-blank `Location` value in @p lines, or nullopt.
 *
 * Names compare case-insensitively, because an HTTP/2 block spells them
 * lower-case.
 */
[[nodiscard]] std::optional<std::string> location_of (const std::vector<HeaderLine>& lines);

/**
 * @brief @p location resolved against @p base_url, the URL the hop that
 *        answered was sent to.
 *
 * libcurl's own resolution (`CURLU`, encoding spaces and bytes a URL cannot
 * carry), with the fragment dropped: it never goes on the wire. The base is
 * read with the scheme guess libcurl applies to a URL that names none, so a
 * relative `Location` resolves against what was dialled. A `Location` that
 * does not parse, or that names a scheme other than `http` or `https`, is an
 * `InvalidUrl` error worded as libcurl worded the same refusal.
 */
[[nodiscard]] std::expected<std::string, Error>
resolve_redirect_target (const std::string& base_url, const std::string& location);

/// The request a redirect asks for next: its method, and whether the body the
/// previous hop carried goes with it.
struct RedirectedRequest {
    HttpMethod method = HttpMethod::GET;
    bool keeps_body   = true;
};

/**
 * @brief What a hop sent as @p method becomes after a @p status redirect.
 *
 * libcurl's `CURLFOLLOW_ALL` rule: a 301, 302 or 303 drops the body, and a
 * `POST` among them becomes a `GET`; every other verb keeps its name, because
 * libcurl kept sending a custom method string. Any other 3xx (307 and 308
 * above all) keeps the method and the body. One deliberate difference: libcurl
 * re-sent a streamed (`CURLOPT_UPLOAD`) body on a 301 or 302 with its verb; the
 * rule here drops it, as it does every other body (#3300).
 */
[[nodiscard]] RedirectedRequest redirected_request (int status, HttpMethod method);

/**
 * @brief Whether @p a and @p b share an origin: scheme, host and port, the
 *        port defaulted from the scheme and the host compared without case.
 *
 * A URL that does not parse shares an origin with nothing, so whatever an
 * origin change withholds is withheld.
 */
[[nodiscard]] bool same_origin (const std::string& a, const std::string& b);

/**
 * @brief Whether a request header named @p name stays with the origin the
 *        send started at: `Authorization` and `Cookie`.
 *
 * libcurl's rule, kept as it was: a hop to any other origin goes without them,
 * and a hop back to the first origin carries them again. Every other header
 * follows, an API key in `X-Api-Key` included (`SECURITY.md`).
 */
[[nodiscard]] bool is_origin_bound_header (std::string_view name);

/**
 * @brief Whether a request header named @p name describes the body
 *        (`Content-Type`, `Content-Length`), so a hop that dropped the body
 *        drops it too.
 */
[[nodiscard]] bool is_body_header (std::string_view name);

/**
 * @brief Whether a chain that has followed @p followed redirects may follow
 *        no more under @p max_redirects. Negative means no limit.
 */
[[nodiscard]] bool redirect_limit_reached (int followed, int max_redirects);

/**
 * @brief The `TooManyRedirects` error a chain ends with at @p max_redirects,
 *        in the words libcurl's own limit used (#2462).
 */
[[nodiscard]] Error too_many_redirects_error (int max_redirects);

// ---------------------------------------------------------------------------
// The request a chain sends next
// ---------------------------------------------------------------------------

namespace detail {
struct BodySource;
} // namespace detail

/// Where one hop of a chain goes and what it carries.
struct Hop {
    std::string url;
    HttpMethod method = HttpMethod::GET;
    bool carries_body = false;
    /// A 301, 302 or 303 changed the request, so no line about a body goes.
    bool rewritten = false;
    /// Redirects followed before this hop.
    int followed = 0;
};

/// The next hop's URL, or the error that ends the chain.
using NextHop = std::expected<std::string, Error>;

/**
 * @brief The request side of a chain a driver follows itself, one transfer
 *        per hop on one handle: where each hop goes, and the method, body and
 *        request lines the handle sends there.
 *
 * A driver configures the handle for the first hop and puts `first_headers ()`
 * on it; after each transfer it asks `redirect_target` where the answer leads
 * and `advance`s to it. What surrounds a transfer stays the driver's: the
 * transport policy for `hop ().url`, which matches the client certificate
 * against that hop's own origin, its sinks, its deadlines and `HopCookies`.
 *
 * The handle points into the header lists held here and into the body source
 * it was given, so the chain outlives every transfer of it, and the handle is
 * not reset between hops.
 */
class RedirectChain {
    public:
    /**
     * @param first_headers The list `build_request_header_list` built for
     *        @p request, taken over; null for none.
     * @param body What `apply_method_and_body` filled for the first hop.
     */
    RedirectChain (const Request& request, curl_slist* first_headers, detail::BodySource& body);

    /// The hop the next transfer sends.
    [[nodiscard]] const Hop& hop () const {
        return hop_;
    }

    /// The list the first hop sends, or null for none.
    [[nodiscard]] curl_slist* first_headers () const {
        return first_headers_.get ();
    }

    /**
     * @brief Where the finished hop's @p status answer, whose header lines are
     *        @p lines, sends the chain.
     *
     * Nullopt when it is the final answer: the request does not follow, the
     * status is no redirect, or it names no `Location`. Otherwise the next
     * URL, or the error the chain ends with: the request's `max_redirects`
     * (negative is no limit), or a `Location` `resolve_redirect_target`
     * refuses.
     */
    [[nodiscard]] std::optional<NextHop>
    redirect_target (const std::vector<HeaderLine>& lines, int status) const;

    /**
     * @brief Points @p curl at @p next_url after a @p status redirect: the
     *        URL, the method and body the redirect asks for, and the request
     *        lines that go to its origin.
     *
     * `Authorization` and the typed `Cookie` rows (`CURLOPT_COOKIE`) go only to
     * the origin the chain started at, as libcurl compared against its first
     * origin: a hop back there carries them again.
     */
    void advance (CURL* curl, int status, std::string next_url);

    private:
    struct SlistDeleter {
        void operator() (curl_slist* list) const;
    };
    using SlistPtr = std::unique_ptr<curl_slist, SlistDeleter>;

    void apply_method (CURL* curl, int status);
    void apply_headers (CURL* curl, bool first_origin);

    const Request* request_   = nullptr;
    detail::BodySource* body_ = nullptr;
    Hop hop_;
    SlistPtr first_headers_;
    /// The list a later hop sends when it leaves out lines of the first.
    SlistPtr hop_headers_;
};

// ---------------------------------------------------------------------------
// Cookies a hop set
// ---------------------------------------------------------------------------

/**
 * @brief The identity libcurl replaces a cookie by: domain, path and name of
 *        one `CURLINFO_COOKIELIST` (Netscape) line, or nullopt for a line that
 *        is not one.
 */
[[nodiscard]] std::optional<std::string> cookie_identity (std::string_view netscape_line);

/**
 * @brief @p netscape_line with its expiry in the past, which, handed to
 *        `CURLOPT_COOKIELIST`, replaces the cookie and so removes it.
 */
[[nodiscard]] std::optional<std::string> expired_cookie_line (std::string_view netscape_line);

/**
 * @brief Keeps a cookie one hop set off a later hop to another origin
 *        (#3300).
 *
 * Vayu's rule, not libcurl's: libcurl's cookie engine matches by host and path
 * alone, so on its own a cookie `127.0.0.1:8080` set rides a redirect to
 * `127.0.0.1:9090`. A `Set-Cookie` is stored in the handle's cookie engine
 * (and the jar after it) under the origin that set it, and goes out on a later
 * hop of the same send only when that hop's origin is the setter's. A cookie
 * the jar held before the send is not a hop's and is matched as always.
 *
 * Works on the handle's cookie engine between transfers: `before_hop` removes
 * what the coming hop must not carry, `after_hop` notes what the hop set and
 * puts the removed cookies back, so the jar is reconciled from a complete
 * list. The handle must not be reset between hops.
 */
class HopCookies {
    public:
    explicit HopCookies (CURL* curl) : curl_ (curl) {
    }

    /**
     * @brief For a driver that seeded the engine itself and starts keeping
     *        track only once the first hop, to @p first_hop_url, has finished
     *        (the load path, #3302): @p held_before is what the engine held as
     *        that hop started, in `CURLINFO_COOKIELIST`'s own spelling. Call
     *        `after_hop` next.
     */
    HopCookies (CURL* curl, std::string first_hop_url, std::vector<std::string> held_before)
    : curl_ (curl), hop_url_ (std::move (first_hop_url)),
      before_ (std::move (held_before)) {
    }

    /// Before the transfer to @p hop_url.
    void before_hop (const std::string& hop_url);

    /// After that transfer, whatever it ended with.
    void after_hop ();

    private:
    CURL* curl_ = nullptr;
    std::string hop_url_;
    /// The engine's lines as the hop started, after the removals.
    std::vector<std::string> before_;
    /// Lines removed for the hop under way, put back after it.
    std::vector<std::string> withheld_;
    /// Cookie identity -> the URL of the hop whose `Set-Cookie` last set it.
    std::vector<std::pair<std::string, std::string>> set_by_;
};

} // namespace vayu::http
