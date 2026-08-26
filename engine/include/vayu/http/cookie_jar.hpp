/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/cookie_jar.hpp
 * @brief The engine's cookie jar - the state that makes "log in once, reuse
 *        the session" possible (issue #301, step 2).
 *
 * Step 1 gave a script `pm.response.cookies`, which reads one response's
 * `Set-Cookie` (`set_cookie.hpp`). That is a view of a single exchange and
 * nothing more; nothing persisted a session across requests. This is that
 * missing state.
 *
 * ## libcurl owns the cookie semantics, this owns the storage
 *
 * The jar stores cookies exactly as libcurl exports them
 * (`CURLINFO_COOKIELIST`, Netscape format) and hands them straight back
 * (`CURLOPT_COOKIELIST`) on the next request in the same scope. Domain
 * matching, path matching, `Secure`, `Max-Age` vs `Expires`, replacement of a
 * cookie already held - all of it stays inside libcurl's cookie engine, which
 * is a tested implementation of RFC 6265 that we would otherwise be
 * re-deriving. A hand-rolled copy of a primitive does not receive the
 * primitive's fixes.
 *
 * `parse_cookie_line` / `cookie_matches` below exist only for the two *read*
 * views - `pm.cookies` and `GET /cookies` - which need to answer "what is in
 * here" without performing a transfer, something no libcurl call offers. They
 * never decide what goes on the wire.
 *
 * ## A script's writes are staged, not applied where they are made
 *
 * `pm.cookies.jar().set/unset/clear` (issue #337) do not touch the map while
 * the script runs. They stage a `CookieWrite`, and the next transfer of that
 * execution seeds its handle with the scope's lines *plus* the staged writes
 * applied on top (`apply_cookie_writes`) - so the write rides the request it
 * was made for, and the transfer's own capture is what persists it. That
 * ordering is the point: `capture_jar_cookies` **replaces** the scope's list
 * with what the finishing handle held, so a write applied into the live map
 * beside an in-flight transfer would be discarded by it. A write that has no
 * transfer left to ride (a post-request script's) is applied by the route
 * through `CookieJar::apply`.
 *
 * ## Scope, lifetime, persistence, threading
 *
 * - **Scope: one jar per environment**, keyed by environment id, with
 *   `NO_ENVIRONMENT_SCOPE` (the empty string) for requests sent with no
 *   environment selected. The environment is the axis that separates staging
 *   from production, and cookies ignore port and scheme, so `localhost:3000`
 *   staging and `localhost:8080` production would otherwise share a session
 *   cookie. A jar per *run* would defeat the feature outright.
 * - **Lifetime: the engine process.** Cleared on exit and on request through
 *   `DELETE /cookies`.
 * - **Persistence: none, deliberately.** A stored jar is credential-grade
 *   material, and writing it beside the request store would open a new secrets
 *   path rather than reuse the one auth tokens already have. Session cookies
 *   are the common case anyway, and those die with the process by definition.
 * - **Threading: one mutex, held only around the map.** Every accessor copies
 *   what it needs out before returning; no reference into the storage escapes,
 *   so a caller cannot read a jar another thread is rewriting.
 *
 * ## Not on the load path
 *
 * Load runs neither read nor write the jar. Sharing one across the event
 * loop's workers is either a lock on the 60k-RPS hot path or per-worker jars
 * that do not actually share - and a load run repeats a single request, where
 * a session cookie is not what is under test. `event_loop_worker.cpp` is
 * therefore untouched by all of this.
 */

#pragma once

#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::http {

/**
 * @brief The scope key used for requests sent with no environment selected.
 *
 * Not a magic empty string at each call site: an environment id is never
 * empty, so the empty key cannot collide with one, and naming it keeps the
 * "no environment" jar findable by grep.
 */
inline constexpr std::string_view NO_ENVIRONMENT_SCOPE = "";

/**
 * @brief One cookie, as read back out of the jar for a *view*.
 *
 * Not what the jar stores - it stores libcurl's own lines (see the file
 * comment). This is the parsed shape the two readers need:
 * `pm.cookies` (name/value, after matching on domain/path/secure/expiry) and
 * `GET /cookies` (every field, so the Settings panel can show what is held and
 * why it would be sent).
 */
struct JarCookie {
    /// Domain as libcurl holds it: `example.com` for a host-only cookie,
    /// `.example.com` for one that came with a `Domain` attribute.
    std::string domain;
    /// libcurl's tailmatch flag - true when subdomains match too.
    bool include_subdomains = false;
    std::string path;
    bool secure    = false;
    bool http_only = false;
    /// Unix seconds, or 0 for a session cookie (no expiry; dies with the jar).
    int64_t expires = 0;
    std::string name;
    std::string value;
};

/**
 * @brief Parse one line of libcurl's Netscape cookie format.
 *
 * Seven tab-separated fields - domain, tailmatch, path, secure, expiry, name,
 * value - with the domain optionally prefixed `#HttpOnly_`. Any other line
 * starting with `#` is a comment, and a line with the wrong field count is
 * malformed; both yield `nullopt` rather than a half-filled cookie.
 */
[[nodiscard]] std::optional<JarCookie> parse_cookie_line (std::string_view line);

/**
 * @brief Would @p cookie be sent to this URL, per RFC 6265 §5.1.3-§5.4?
 *
 * The read views' matcher, not the wire's - see the file comment. @p host and
 * @p path come from the request URL, @p secure_transport is whether its scheme
 * is https, and @p now_seconds is the current unix time (passed in so a test
 * can place a cookie's expiry on either side of it without sleeping).
 */
[[nodiscard]] bool cookie_matches (const JarCookie& cookie,
std::string_view host,
std::string_view path,
bool secure_transport,
int64_t now_seconds);

/**
 * @brief Write one cookie back as a Netscape line - the inverse of
 *        `parse_cookie_line`, and the only place a line is built.
 *
 * A script-written cookie has no `Set-Cookie` to come from, so it becomes one
 * of libcurl's own lines here and is thereafter the same kind of thing a
 * received cookie is.
 */
[[nodiscard]] std::string format_cookie_line (const JarCookie& cookie);

/**
 * @brief Fill a script-supplied cookie's URL-derived defaults.
 *
 * `pm.cookies.jar().set(url, cookie)` carries the URL precisely so domain and
 * path have somewhere to come from: an empty @p cookie.domain becomes @p url's
 * host (host-only, as a `Set-Cookie` with no `Domain` attribute is), and an
 * empty `path` becomes RFC 6265 §5.1.4's default-path - the URL's path with
 * its last segment removed. Explicit fields are kept as given; a leading dot
 * on the domain is libcurl's spelling of "subdomains too" and sets the
 * tailmatch flag.
 *
 * `nullopt` when the result could not be stored honestly: an unparseable URL,
 * an empty name, or a field carrying a tab or newline - the separators of the
 * very format this is about to be written in, which would silently corrupt the
 * line and make the cookie vanish on the next read.
 */
[[nodiscard]] std::optional<JarCookie>
cookie_for_url (const std::string& url, JarCookie cookie);

/**
 * @brief One staged jar mutation from a script (issue #337).
 *
 * Staged rather than applied - see the file comment for why the write cannot
 * land in the live map beside a transfer.
 */
struct CookieWrite {
    enum class Kind {
        /// Merge `line` in, replacing a cookie of the same name/domain/path.
        Set,
        /// Drop the cookies named `name` that would be sent to `url`.
        Unset,
        /// Empty the scope.
        Clear,
    };

    Kind kind = Kind::Set;
    /// `Set` only: the line to merge, from `format_cookie_line`.
    std::string line;
    /// `Unset` only: the URL the removal is scoped to, and the cookie name.
    std::string url;
    std::string name;
};

/**
 * @brief @p lines with @p writes applied on top, in order. Pure - it is what
 *        a transfer seeds its handle with and what `CookieJar::apply` stores.
 */
[[nodiscard]] std::vector<std::string> apply_cookie_writes (std::vector<std::string> lines,
const std::vector<CookieWrite>& writes);

/**
 * @brief The cookies among @p lines that would be sent to @p url.
 *
 * `CookieJar::matching` over lines the caller already holds, so a script can
 * read the jar *with* its own staged writes applied without those writes
 * having to reach the map first. An unparseable URL matches nothing.
 */
[[nodiscard]] std::vector<JarCookie>
matching_in (const std::vector<std::string>& lines, const std::string& url);

/**
 * @brief One scope's contents, for `GET /cookies`.
 */
struct CookieScopeView {
    /// Absent for the no-environment jar; the environment id otherwise.
    std::optional<std::string> environment_id;
    std::vector<JarCookie> cookies;
};

/**
 * @brief The process-wide jar. Owned by `http::Server`, reached through
 *        `RouteContext::cookie_jar`.
 */
class CookieJar {
    public:
    CookieJar ()  = default;
    ~CookieJar () = default;

    // Non-copyable, non-movable: it is held by reference (RouteContext, and
    // ClientConfig for the duration of a send), so a copy would silently
    // become a second jar that no reader ever sees again.
    CookieJar (const CookieJar&)            = delete;
    CookieJar& operator= (const CookieJar&) = delete;
    CookieJar (CookieJar&&)                 = delete;
    CookieJar& operator= (CookieJar&&)      = delete;

    /**
     * @brief The scope's stored lines, ready for `CURLOPT_COOKIELIST`.
     */
    [[nodiscard]] std::vector<std::string> lines_for (const std::string& scope) const;

    /**
     * @brief Replace the scope's contents with what a transfer left behind.
     *
     * Replace rather than merge: `CURLINFO_COOKIELIST` returns the *whole*
     * jar the handle held, which is what we injected plus whatever the
     * response changed, so merging would resurrect a cookie the server
     * deleted by expiring it.
     */
    void store (const std::string& scope, std::vector<std::string> lines);

    /**
     * @brief The cookies in @p scope that would be sent to @p url.
     *
     * What `pm.cookies` reads. An unparseable URL matches nothing rather than
     * throwing - the caller has already sent (or is about to send) the request
     * through libcurl, which is the component entitled to reject a URL.
     */
    [[nodiscard]] std::vector<JarCookie>
    matching (const std::string& scope, const std::string& url) const;

    /**
     * @brief Apply staged script writes to @p scope.
     *
     * For writes with no transfer left to carry them - a post-request
     * script's. A write made before a transfer rides that transfer instead
     * (`ClientConfig::cookie_writes`), so it is applied exactly once either
     * way; see the file comment.
     */
    void apply (const std::string& scope, const std::vector<CookieWrite>& writes);

    /**
     * @brief Every scope's contents, for the Settings panel. Scopes with no
     *        cookies left are not reported.
     */
    [[nodiscard]] std::vector<CookieScopeView> snapshot () const;

    /**
     * @brief Drop one scope's jar. Returns how many cookies went.
     */
    size_t clear (const std::string& scope);

    /**
     * @brief Drop every jar. Returns how many cookies went.
     */
    size_t clear_all ();

    private:
    mutable std::mutex mutex_;
    /// scope key -> libcurl's own lines, verbatim. Ordered, so `snapshot()`
    /// and therefore the Settings panel list the same way every read.
    std::map<std::string, std::vector<std::string>> scopes_;
};

} // namespace vayu::http
