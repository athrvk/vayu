#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/cookie_warnings.hpp
 * @brief The warnings a design send carries about the cookies libcurl's
 *        cookie engine withheld or discarded without an error (#3307), one copy
 *        for both design drivers: `Client::send` and the stream consumer
 *        (#3315).
 *
 * Outgoing, libcurl says what it withheld only as a `CURLINFO_TEXT` notice, so
 * a driver installs a debug callback and hands it every such line at any log
 * verbosity (`note_cookie_notice`): the warning is the response's, not the
 * log's. Incoming, it says nothing at all, so the driver's header callback
 * replays `SetCookieLimits` on the lines it sees (`IncomingCookieWatch`) when
 * the send has a jar. After the chain, `apply_cookie_notices` and
 * `apply_incoming_cookies` move both onto the response. A warning names a
 * cookie and never carries its value.
 */

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/http/set_cookie.hpp"
#include "vayu/http/set_cookie_limits.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

/// What libcurl's own notices said about the cookies it attached, across every
/// hop of a chain.
struct CookieNotices {
    std::vector<ResponseWarning> warnings;
};

/// Keeps the warning a `CURLINFO_TEXT` @p notice stands for, once however many
/// hops report it. Any other line is ignored.
void note_cookie_notice (CookieNotices& notices, std::string_view notice);

/// Moves @p notices onto @p response, and takes the typed `Cookie` rows out of
/// its `request_headers` when libcurl dropped them.
void apply_cookie_notices (CookieNotices& notices, Response& response);

/// The `Set-Cookie` headers of one send that libcurl's cookie engine discarded
/// without a word (#3307). Fed by a header callback only when the send has a
/// jar: without one libcurl's engine is off and discards nothing.
struct IncomingCookieWatch {
    SetCookieLimits limits;
    /// Beyond the per-response limit, summed over every hop of the chain.
    size_t ignored   = 0;
    size_t oversized = 0;
    /// Names of the first oversized cookies. Never a value.
    std::vector<std::string> oversized_names;

    /// @p value and @p raw_line_bytes as `SetCookieLimits::note` takes them.
    void note (std::string_view value, size_t raw_line_bytes);

    private:
    void note_oversized (const std::optional<SetCookie>& cookie);
};

/// Hands @p line to @p watch if it is a `Set-Cookie` header; a null @p watch
/// (a send with no jar) takes nothing. @p raw_bytes is what the header
/// callback was given, line ending included.
void watch_set_cookie (IncomingCookieWatch* watch, std::string_view line, size_t raw_bytes);

/// Moves what @p watch saw onto @p response. Names a cookie, never a value.
void apply_incoming_cookies (const IncomingCookieWatch& watch, Response& response);

} // namespace vayu::http
