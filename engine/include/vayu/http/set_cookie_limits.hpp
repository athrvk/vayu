#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/set_cookie_limits.hpp
 * @brief Which received `Set-Cookie` lines libcurl's cookie engine discards
 *        without a word (#3307).
 *
 * libcurl drops a line over 5000 bytes, a cookie whose name and value pass
 * 4096, and every cookie after the 50th of one response (lib/cookie.c:
 * `MAX_COOKIE_LINE`, `MAX_NAME`, `MAX_SET_COOKIE_AMOUNT`). None is an error and
 * only one leaves a notice, so each driver's header callback replays the rules
 * on the lines it sees: the design send to name what was dropped, the event
 * loop to count it for the run. One copy, so the two cannot disagree.
 * `cookie_jar_test.cpp` runs a real libcurl at the boundary of each limit, so a
 * changed one fails there.
 *
 * Allocation-free: the event loop runs it on every header line of every
 * transfer that tracks cookies.
 */

#include <cctype>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>

#include "vayu/utils/ascii_case.hpp"

namespace vayu::http {

/// The header libcurl's cookie engine reads.
inline constexpr std::string_view SET_COOKIE_FIELD = "Set-Cookie";
/// A line libcurl measures from the byte after `Set-Cookie:`, terminator
/// included; longer than this is discarded unread.
inline constexpr std::size_t SET_COOKIE_LINE_LIMIT_BYTES = 5000;
/// The first pair of a cookie, name plus value, trimmed.
inline constexpr std::size_t COOKIE_NAME_VALUE_LIMIT_BYTES = 4096;
/// Cookies one response may add to the jar; the next is ignored.
inline constexpr std::size_t SET_COOKIES_PER_RESPONSE_LIMIT = 50;

/// What libcurl's cookie engine does with one received `Set-Cookie` line.
enum class SetCookieFate : std::uint8_t {
    /// Names no cookie (no `=` in the first pair, or one at its start), so
    /// nothing is stored and the per-response count does not move.
    NotACookie,
    Stored,
    /// Discarded for its length: the line, or the name and value.
    Oversized,
    /// Past `SET_COOKIES_PER_RESPONSE_LIMIT` in its response.
    Ignored,
};

[[nodiscard]] constexpr bool is_dropped (SetCookieFate fate) {
    return fate == SetCookieFate::Oversized || fate == SetCookieFate::Ignored;
}

/// The text after `Set-Cookie:` when @p line (its terminator stripped) is that
/// header, matched as libcurl matches it: the whole name in any case, the colon
/// straight after. `Set-Cookie2:` and `X-Set-Cookie:` are not.
[[nodiscard]] inline std::optional<std::string_view> set_cookie_header_value (
std::string_view line) {
    constexpr std::size_t colon = SET_COOKIE_FIELD.size ();
    if (line.size () <= colon || line[colon] != ':' ||
    !vayu::utils::ascii_lower_equal (line.substr (0, colon), SET_COOKIE_FIELD)) {
        return std::nullopt;
    }
    return line.substr (colon + 1);
}

/**
 * @brief One transfer's count of the cookies its current response stored,
 *        which is what the per-response limit is judged against.
 *
 * Not thread-safe: one belongs to one transfer, which libcurl drives from one
 * thread.
 */
class SetCookieLimits {
    public:
    /// libcurl's count restarts with each response (`Curl_req_soft_reset`), so
    /// a header callback calls this at every status line: a redirect hop and a
    /// 1xx block each start over.
    void start_response () {
        stored_in_response_ = 0;
    }

    /// @p value is what `set_cookie_header_value` answered for a line;
    /// @p raw_line_bytes is what the header callback was handed for that whole
    /// line, terminator included.
    [[nodiscard]] SetCookieFate note (std::string_view value, std::size_t raw_line_bytes) {
        // libcurl measures from the byte after the colon to the end of the
        // line as received.
        const std::size_t measured = raw_line_bytes - PREFIX_BYTES;
        if (measured > SET_COOKIE_LINE_LIMIT_BYTES) {
            return SetCookieFate::Oversized;
        }
        // The pair splits at its first `=`, as `parse_set_cookie_line` does.
        const std::string_view pair = value.substr (0, value.find (';'));
        const std::size_t equals    = pair.find ('=');
        if (equals == 0 || equals == std::string_view::npos) {
            return SetCookieFate::NotACookie;
        }
        // The name and value fit inside the measured line, so a short line
        // cannot pass their limit and is not trimmed.
        if (measured > COOKIE_NAME_VALUE_LIMIT_BYTES &&
        trimmed_size (pair.substr (0, equals)) + trimmed_size (pair.substr (equals + 1)) >
        COOKIE_NAME_VALUE_LIMIT_BYTES) {
            return SetCookieFate::Oversized;
        }
        // libcurl counts a cookie once stored, so a line that names none is
        // not one.
        return ++stored_in_response_ > SET_COOKIES_PER_RESPONSE_LIMIT ?
        SetCookieFate::Ignored :
        SetCookieFate::Stored;
    }

    private:
    /// `Set-Cookie:`, which libcurl's line measure starts after.
    static constexpr std::size_t PREFIX_BYTES = SET_COOKIE_FIELD.size () + 1;

    /// The length `parse_set_cookie_line` trims to, without building it.
    static std::size_t trimmed_size (std::string_view text) {
        const auto is_space = [] (char c) {
            return std::isspace (static_cast<unsigned char> (c)) != 0;
        };
        std::size_t begin = 0;
        std::size_t end   = text.size ();
        while (begin < end && is_space (text[begin])) {
            ++begin;
        }
        while (end > begin && is_space (text[end - 1])) {
            --end;
        }
        return end - begin;
    }

    std::size_t stored_in_response_ = 0;
};

} // namespace vayu::http
