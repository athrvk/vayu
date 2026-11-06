/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/cookie_warnings.cpp
 * @brief The cookie warnings of a design send. See
 *        `vayu/http/cookie_warnings.hpp`.
 */

#include "vayu/http/cookie_warnings.hpp"

#include <algorithm>
#include <utility>

#include "vayu/utils/encoding.hpp"

namespace vayu::http {

namespace {

// The two notices libcurl writes (lib/http.c `http_cookies`, lib/cookie.c
// `Curl_cookie_getlist`) when it withholds or caps the cookies it attaches. It
// reports them nowhere but this text channel, so a reworded notice stops the
// warning silently; the transfer tests in cookie_jar_test.cpp run a real
// libcurl through both and fail instead.
constexpr std::string_view CODE_COOKIE_NOT_SENT      = "cookie_not_sent";
constexpr std::string_view CODE_COOKIE_LIMIT_REACHED = "cookie_limit_reached";
constexpr std::string_view COOKIE_RESTRICTED_PREFIX =
"Restricted outgoing cookies due to header size, '";
constexpr std::string_view COOKIE_RESTRICTED_SUFFIX = "' not sent";
constexpr std::string_view COOKIE_LIMIT_PREFIX =
"Included max number of cookies (";

/// libcurl's MAX_COOKIE_HEADER_LEN and MAX_COOKIE_SEND_AMOUNT.
constexpr int COOKIE_HEADER_LIMIT_BYTES = 8190;
constexpr int COOKIE_SEND_LIMIT         = 150;

/// How much of a cookie name a warning carries.
constexpr size_t DROPPED_NAME_MAX_BYTES = 64;
/// libcurl formats a notice into a 2048-byte line and ends one that does not
/// fit in "...".
constexpr std::string_view NOTICE_CUT_MARK = "...";

// libcurl's cookie engine discards a response's cookies without an error
// (`set_cookie_limits.hpp`); a design send names the cookies it dropped.
constexpr std::string_view CODE_COOKIE_DROPPED_OVERSIZED =
"cookie_dropped_oversized";
constexpr std::string_view CODE_COOKIE_DROPPED_TOO_MANY =
"cookie_dropped_too_many";
/// How many dropped cookies a warning names.
constexpr size_t NAMED_DROPPED_COOKIES = 5;

/// @p name as a message may carry it, cut to `DROPPED_NAME_MAX_BYTES` with
/// "..." marking the cut, or nothing for a name that is not text. A name is
/// wire bytes, and a message that is not valid UTF-8 makes the serializer
/// throw: a name that is not text is left out rather than repaired.
std::optional<std::string> bounded_cookie_name (std::string_view name) {
    if (!vayu::utils::is_valid_utf8_text (name)) {
        return std::nullopt;
    }
    const bool cut = name.size () > DROPPED_NAME_MAX_BYTES;
    name = vayu::utils::without_incomplete_utf8_tail (name.substr (0, DROPPED_NAME_MAX_BYTES));
    return std::string (name) + (cut ? "..." : "");
}

/// The cookie name in the text after the header-size notice's prefix: up to its
/// suffix, or, when libcurl cut the line short of the suffix, whatever it kept
/// less the "..." it ended on. Then a cut name loses at most the half
/// character at its end.
std::string_view restricted_cookie_name (std::string_view rest) {
    if (rest.ends_with (COOKIE_RESTRICTED_SUFFIX)) {
        // Up to the suffix's quote, so a name holding a quote of its own stays
        // whole.
        return rest.substr (0, rest.size () - COOKIE_RESTRICTED_SUFFIX.size ());
    }
    if (rest.ends_with (NOTICE_CUT_MARK)) {
        rest.remove_suffix (NOTICE_CUT_MARK.size ());
    }
    return vayu::utils::without_incomplete_utf8_tail (rest);
}

/// The warning a `CURLINFO_TEXT` @p notice stands for, or nothing for any other
/// line. The cookie is named and its value never is: the notice carries only
/// the name, and a value does not belong in a message that is stored.
std::optional<ResponseWarning> cookie_warning_from_notice (std::string_view notice) {
    while (!notice.empty () && (notice.back () == '\n' || notice.back () == '\r')) {
        notice.remove_suffix (1);
    }
    if (notice.starts_with (COOKIE_LIMIT_PREFIX)) {
        return ResponseWarning{ std::string (CODE_COOKIE_LIMIT_REACHED),
            "libcurl sends at most " + std::to_string (COOKIE_SEND_LIMIT) +
            " cookies from the jar on one request; the rest were left off." };
    }
    if (!notice.starts_with (COOKIE_RESTRICTED_PREFIX)) {
        return std::nullopt;
    }
    const auto name = bounded_cookie_name (
    restricted_cookie_name (notice.substr (COOKIE_RESTRICTED_PREFIX.size ())));
    return ResponseWarning{ std::string (CODE_COOKIE_NOT_SENT),
        (name ? "Cookie " + *name : std::string ("A cookie")) +
        " was not sent: the Cookie header would pass libcurl's " +
        std::to_string (COOKIE_HEADER_LIMIT_BYTES) +
        "-byte limit. Any typed Cookie rows were dropped with it." };
}

/// "1 header" / "2 headers".
std::string count_of_headers (size_t count) {
    return std::to_string (count) + (count == 1 ? " Set-Cookie header" : " Set-Cookie headers");
}

std::string oversized_message (const IncomingCookieWatch& watch) {
    std::string message = "libcurl dropped " +
    count_of_headers (watch.oversized) + " it cannot store (a line over " +
    std::to_string (SET_COOKIE_LINE_LIMIT_BYTES) + " bytes, or a name and value over " +
    std::to_string (COOKIE_NAME_VALUE_LIMIT_BYTES) + " bytes)";
    for (size_t i = 0; i < watch.oversized_names.size (); ++i) {
        message += (i == 0 ? ": " : ", ") + watch.oversized_names[i];
    }
    const size_t unnamed = watch.oversized - watch.oversized_names.size ();
    if (unnamed > 0) {
        message += (watch.oversized_names.empty () ? ": " : ", ") +
        std::string ("and ") + std::to_string (unnamed) + " more";
    }
    return message + ".";
}

} // namespace

void note_cookie_notice (CookieNotices& notices, std::string_view notice) {
    auto warning = cookie_warning_from_notice (notice);
    if (!warning) {
        return;
    }
    const auto same = [&] (const ResponseWarning& kept) {
        return kept.code == warning->code && kept.message == warning->message;
    };
    if (std::ranges::none_of (notices.warnings, same)) {
        notices.warnings.push_back (std::move (*warning));
    }
}

/// The rows are recorded before the transfer (`build_request_header_list`),
/// but a withheld jar cookie takes the whole `CURLOPT_COOKIE` line with it
/// (lib/http.c), so the record would otherwise claim a cookie the wire never
/// carried. Every `Cookie` entry is a typed row: none rides
/// `CURLOPT_HTTPHEADER`. The cap of 150 jar cookies leaves the typed rows on
/// the wire, so it prunes nothing.
void apply_cookie_notices (CookieNotices& notices, Response& response) {
    for (auto& warning : notices.warnings) {
        response.warnings.push_back (std::move (warning));
    }
    notices.warnings.clear ();
    const bool withheld =
    std::ranges::any_of (response.warnings, [] (const ResponseWarning& warning) {
        return warning.code == CODE_COOKIE_NOT_SENT;
    });
    if (withheld) {
        response.request_headers.erase ("Cookie");
    }
}

void IncomingCookieWatch::note (std::string_view value, size_t raw_line_bytes) {
    switch (limits.note (value, raw_line_bytes)) {
    case SetCookieFate::Oversized:
        note_oversized (vayu::http::parse_set_cookie_line (value));
        break;
    case SetCookieFate::Ignored: ++ignored; break;
    case SetCookieFate::NotACookie:
    case SetCookieFate::Stored: break;
    }
}

void IncomingCookieWatch::note_oversized (const std::optional<SetCookie>& cookie) {
    ++oversized;
    if (!cookie || oversized_names.size () >= NAMED_DROPPED_COOKIES) {
        return;
    }
    if (auto name = bounded_cookie_name (cookie->name)) {
        oversized_names.push_back (std::move (*name));
    }
}

void watch_set_cookie (IncomingCookieWatch* watch, std::string_view line, size_t raw_bytes) {
    if (watch == nullptr) {
        return;
    }
    if (const auto value = set_cookie_header_value (line)) {
        watch->note (*value, raw_bytes);
    }
}

void apply_incoming_cookies (const IncomingCookieWatch& watch, Response& response) {
    if (watch.oversized > 0) {
        response.warnings.push_back (
        { std::string (CODE_COOKIE_DROPPED_OVERSIZED), oversized_message (watch) });
    }
    if (watch.ignored > 0) {
        response.warnings.push_back ({ std::string (CODE_COOKIE_DROPPED_TOO_MANY),
        "libcurl keeps at most " + std::to_string (SET_COOKIES_PER_RESPONSE_LIMIT) +
        " cookies from one response; " + count_of_headers (watch.ignored) +
        (watch.ignored == 1 ? " after that was ignored." : " after that were ignored.") });
    }
}

} // namespace vayu::http
