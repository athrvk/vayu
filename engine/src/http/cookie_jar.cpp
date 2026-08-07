/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/cookie_jar.cpp
 * @brief The cookie jar's storage and its two read views. See cookie_jar.hpp
 *        for the scope / lifetime / persistence / threading decisions.
 */

#include "vayu/http/cookie_jar.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <ctime>
#include <utility>

namespace vayu::http {

namespace {

constexpr std::string_view HTTP_ONLY_PREFIX = "#HttpOnly_";
constexpr size_t NETSCAPE_FIELDS            = 7;

/// A case-insensitive compare for hostnames, which are ASCII and
/// case-insensitive (RFC 6265 §5.1.2 lowercases before comparing). Cookie
/// *names* are not - see find_cookie in script_engine.cpp.
bool hosts_equal (std::string_view a, std::string_view b) {
    return a.size () == b.size () &&
    std::equal (a.begin (), a.end (), b.begin (), [] (unsigned char l, unsigned char r) {
        return std::tolower (l) == std::tolower (r);
    });
}

/**
 * @brief RFC 6265 §5.1.4 path-match.
 *
 * The `/foo` cookie reaches `/foo` and `/foo/bar` but not `/foobar`, which is
 * the case a `starts_with` on its own gets wrong.
 */
bool path_matches (std::string_view cookie_path, std::string_view request_path) {
    if (cookie_path.empty () || request_path == cookie_path) {
        return true;
    }
    if (!request_path.starts_with (cookie_path)) {
        return false;
    }
    return cookie_path.back () == '/' || request_path[cookie_path.size ()] == '/';
}

/// One field of a URL, read through libcurl's own parser rather than a
/// hand-rolled split - the same reason the jar stores libcurl's cookie lines.
std::optional<std::string> url_part (CURLU* handle, CURLUPart part) {
    char* value = nullptr;
    if (curl_url_get (handle, part, &value, 0) != CURLUE_OK) {
        return std::nullopt;
    }
    std::string out (value);
    curl_free (value);
    return out;
}

} // namespace

std::optional<JarCookie> parse_cookie_line (std::string_view line) {
    // A `#` line is a comment unless it carries libcurl's httponly marker.
    const bool http_only = line.starts_with (HTTP_ONLY_PREFIX);
    if (http_only) {
        line.remove_prefix (HTTP_ONLY_PREFIX.size ());
    } else if (line.starts_with ("#")) {
        return std::nullopt;
    }

    std::array<std::string_view, NETSCAPE_FIELDS> fields{};
    size_t count = 0;
    size_t start = 0;
    while (count < NETSCAPE_FIELDS) {
        const size_t tab = line.find ('\t', start);
        // The value (last field) may itself be empty and may contain no tab;
        // every earlier field must be tab-terminated.
        if (tab == std::string_view::npos) {
            fields[count++] = line.substr (start);
            break;
        }
        fields[count++] = line.substr (start, tab - start);
        start           = tab + 1;
    }
    if (count != NETSCAPE_FIELDS) {
        return std::nullopt;
    }

    JarCookie cookie;
    cookie.domain             = std::string (fields[0]);
    cookie.include_subdomains = fields[1] == "TRUE";
    cookie.path               = std::string (fields[2]);
    cookie.secure             = fields[3] == "TRUE";
    cookie.http_only          = http_only;
    cookie.name               = std::string (fields[5]);
    cookie.value              = std::string (fields[6]);

    // An expiry libcurl did not write as a number is not a cookie we can
    // reason about; refuse the line rather than treat it as a session cookie
    // that never expires.
    const auto* first     = fields[4].data ();
    const auto* last      = first + fields[4].size ();
    const auto conversion = std::from_chars (first, last, cookie.expires);
    if (conversion.ec != std::errc{} || conversion.ptr != last) {
        return std::nullopt;
    }

    // A cookie with no name is not addressable by any reader (`pm.cookies.get`
    // takes a name), so it is dropped here for the same reason parse_set_cookie
    // drops one.
    if (cookie.name.empty ()) {
        return std::nullopt;
    }
    return cookie;
}

bool cookie_matches (const JarCookie& cookie,
std::string_view host,
std::string_view path,
bool secure_transport,
int64_t now_seconds) {
    if (cookie.secure && !secure_transport) {
        return false;
    }
    // 0 is a session cookie: no expiry, valid for as long as the jar lives.
    if (cookie.expires != 0 && cookie.expires <= now_seconds) {
        return false;
    }

    std::string_view domain = cookie.domain;
    // libcurl writes the leading dot for a `Domain=` cookie; RFC 6265 §5.1.3
    // compares against the bare name either way.
    if (domain.starts_with (".")) {
        domain.remove_prefix (1);
    }
    if (domain.empty ()) {
        return false;
    }

    if (hosts_equal (host, domain)) {
        return path_matches (cookie.path, path);
    }
    if (!cookie.include_subdomains) {
        return false;
    }
    // A subdomain match needs the dot: `notexample.com` must not match
    // `example.com`.
    if (host.size () <= domain.size () + 1) {
        return false;
    }
    const size_t offset = host.size () - domain.size ();
    if (host[offset - 1] != '.' || !hosts_equal (host.substr (offset), domain)) {
        return false;
    }
    return path_matches (cookie.path, path);
}

std::string format_cookie_line (const JarCookie& cookie) {
    std::string line;
    if (cookie.http_only) {
        line += HTTP_ONLY_PREFIX;
    }
    line += cookie.domain;
    line += '\t';
    line += cookie.include_subdomains ? "TRUE" : "FALSE";
    line += '\t';
    line += cookie.path;
    line += '\t';
    line += cookie.secure ? "TRUE" : "FALSE";
    line += '\t';
    line += std::to_string (cookie.expires);
    line += '\t';
    line += cookie.name;
    line += '\t';
    line += cookie.value;
    return line;
}

std::optional<JarCookie> cookie_for_url (const std::string& url, JarCookie cookie) {
    if (cookie.name.empty ()) {
        return std::nullopt;
    }
    // The line's own separators. A value carrying one would be written as a
    // line with the wrong field count, which parse_cookie_line then refuses -
    // the cookie would appear to have been stored and be gone on the next read.
    for (const std::string_view field :
    { std::string_view (cookie.name), std::string_view (cookie.value),
    std::string_view (cookie.domain), std::string_view (cookie.path) }) {
        if (field.find_first_of ("\t\r\n") != std::string_view::npos) {
            return std::nullopt;
        }
    }

    if (!cookie.domain.empty () && !cookie.path.empty ()) {
        cookie.include_subdomains = cookie.domain.starts_with (".");
        return cookie;
    }

    CURLU* parsed = curl_url ();
    if (!parsed) {
        return std::nullopt;
    }
    std::optional<std::string> host;
    std::optional<std::string> path;
    if (curl_url_set (parsed, CURLUPART_URL, url.c_str (), 0) == CURLUE_OK) {
        host = url_part (parsed, CURLUPART_HOST);
        path = url_part (parsed, CURLUPART_PATH);
    }
    curl_url_cleanup (parsed);
    if (!host || !path) {
        return std::nullopt;
    }

    if (cookie.domain.empty ()) {
        // Host-only, which is what a Set-Cookie with no Domain attribute is.
        cookie.domain = *host;
    }
    if (cookie.path.empty ()) {
        // RFC 6265 §5.1.4 default-path: everything up to the last `/`, and `/`
        // when that leaves nothing.
        const size_t last = path->rfind ('/');
        cookie.path =
        (last == std::string::npos || last == 0) ? "/" : path->substr (0, last);
    }
    cookie.include_subdomains = cookie.domain.starts_with (".");
    return cookie;
}

std::vector<std::string> apply_cookie_writes (std::vector<std::string> lines,
const std::vector<CookieWrite>& writes) {
    for (const auto& write : writes) {
        switch (write.kind) {
        case CookieWrite::Kind::Clear: lines.clear (); break;

        case CookieWrite::Kind::Set: {
            const auto written = parse_cookie_line (write.line);
            if (!written) {
                // Refused at the binding, so reaching here means a caller built
                // a line by hand; dropping it is better than storing a line no
                // reader can parse.
                break;
            }
            // RFC 6265 §5.3: name, domain and path are a cookie's identity, so
            // a second write of the same three replaces rather than duplicates.
            std::erase_if (lines, [&written] (const std::string& line) {
                const auto held = parse_cookie_line (line);
                return held && held->name == written->name &&
                held->domain == written->domain && held->path == written->path;
            });
            lines.push_back (write.line);
            break;
        }

        case CookieWrite::Kind::Unset: {
            // URL-scoped, like the read half: `unset` removes what a request to
            // that URL would have carried, not every cookie sharing the name.
            const auto doomed = matching_in (lines, write.url);
            std::erase_if (lines, [&write, &doomed] (const std::string& line) {
                const auto held = parse_cookie_line (line);
                if (!held || held->name != write.name) {
                    return false;
                }
                return std::any_of (doomed.begin (), doomed.end (),
                [&held] (const JarCookie& match) {
                    return match.name == held->name &&
                    match.domain == held->domain && match.path == held->path;
                });
            });
            break;
        }
        }
    }
    return lines;
}

std::vector<JarCookie>
matching_in (const std::vector<std::string>& lines, const std::string& url) {
    CURLU* parsed = curl_url ();
    if (!parsed) {
        return {};
    }
    std::optional<std::string> host;
    std::optional<std::string> path;
    std::optional<std::string> scheme;
    if (curl_url_set (parsed, CURLUPART_URL, url.c_str (), 0) == CURLUE_OK) {
        host   = url_part (parsed, CURLUPART_HOST);
        path   = url_part (parsed, CURLUPART_PATH);
        scheme = url_part (parsed, CURLUPART_SCHEME);
    }
    curl_url_cleanup (parsed);
    if (!host || !path) {
        return {};
    }

    const bool secure_transport = scheme && hosts_equal (*scheme, "https");
    const auto now              = static_cast<int64_t> (std::time (nullptr));

    std::vector<JarCookie> out;
    for (const auto& line : lines) {
        auto cookie = parse_cookie_line (line);
        if (cookie && cookie_matches (*cookie, *host, *path, secure_transport, now)) {
            out.push_back (std::move (*cookie));
        }
    }
    return out;
}

std::vector<std::string> CookieJar::lines_for (const std::string& scope) const {
    const std::lock_guard<std::mutex> lock (mutex_);
    const auto it = scopes_.find (scope);
    return it == scopes_.end () ? std::vector<std::string>{} : it->second;
}

void CookieJar::store (const std::string& scope, std::vector<std::string> lines) {
    const std::lock_guard<std::mutex> lock (mutex_);
    if (lines.empty ()) {
        // Do not leave an empty scope behind: `snapshot()` reports scopes, and
        // an environment whose cookies all expired would otherwise show up as
        // a jar with nothing in it.
        scopes_.erase (scope);
        return;
    }
    scopes_[scope] = std::move (lines);
}

std::vector<JarCookie>
CookieJar::matching (const std::string& scope, const std::string& url) const {
    return matching_in (lines_for (scope), url);
}

void CookieJar::apply (const std::string& scope, const std::vector<CookieWrite>& writes) {
    if (writes.empty ()) {
        return;
    }
    const std::lock_guard<std::mutex> lock (mutex_);
    const auto it = scopes_.find (scope);
    auto applied  = apply_cookie_writes (
    it == scopes_.end () ? std::vector<std::string>{} : it->second, writes);
    if (applied.empty ()) {
        // Same reason store() erases: an emptied scope is not a scope the
        // Settings panel should list.
        scopes_.erase (scope);
        return;
    }
    scopes_[scope] = std::move (applied);
}

std::vector<CookieScopeView> CookieJar::snapshot () const {
    std::vector<std::pair<std::string, std::vector<std::string>>> copies;
    {
        const std::lock_guard<std::mutex> lock (mutex_);
        copies.assign (scopes_.begin (), scopes_.end ());
    }

    std::vector<CookieScopeView> out;
    out.reserve (copies.size ());
    for (auto& [scope, lines] : copies) {
        CookieScopeView view;
        if (scope != NO_ENVIRONMENT_SCOPE) {
            view.environment_id = scope;
        }
        for (const auto& line : lines) {
            if (auto cookie = parse_cookie_line (line)) {
                view.cookies.push_back (std::move (*cookie));
            }
        }
        if (!view.cookies.empty ()) {
            out.push_back (std::move (view));
        }
    }
    return out;
}

size_t CookieJar::clear (const std::string& scope) {
    const std::lock_guard<std::mutex> lock (mutex_);
    const auto it = scopes_.find (scope);
    if (it == scopes_.end ()) {
        return 0;
    }
    const size_t removed = it->second.size ();
    scopes_.erase (it);
    return removed;
}

size_t CookieJar::clear_all () {
    const std::lock_guard<std::mutex> lock (mutex_);
    size_t removed = 0;
    for (const auto& [scope, lines] : scopes_) {
        removed += lines.size ();
    }
    scopes_.clear ();
    return removed;
}

} // namespace vayu::http
