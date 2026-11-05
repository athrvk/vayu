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
 * certificate registry to be consulted for it (#3300). `Client::send` is the
 * driver on this unit today; SSE (#3301) and the load path (#3302) still let
 * libcurl follow.
 *
 * The rules restate what libcurl did, so a send behaves as it did when libcurl
 * followed: which statuses are followed, how a `Location` resolves, which
 * method and body a hop keeps, which headers stay with the first origin and
 * how the limit is worded. The one rule that is Vayu's own is the cookie rule
 * at the bottom.
 */

#include <curl/curl.h>

#include <expected>
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
 * above all) keeps the method and the body.
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

/**
 * @brief The sentence that opens a redirect-limit failure, then @p detail.
 *
 * @p limit is the number of redirects followed when the limit was reached; the
 * sentence names no number when it is unknown rather than guess one.
 */
[[nodiscard]] std::string
too_many_redirects_message (std::optional<long> limit, std::string_view detail);

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
