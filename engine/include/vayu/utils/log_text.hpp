#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/log_text.hpp
 * @brief A bounded copy of caller-authored text, for a `LogRecord` field
 *        (issue #2359).
 *
 * A record's `msg` is never redacted - only `fields` are, by key
 * (`utils/log_redact.hpp`) - so text a user's script chose (`throw new
 * Error (...)`) must not be concatenated into one. It goes in a field instead,
 * through this: a script can throw a megabyte, and a log line is not where
 * that belongs.
 */

#include <cstddef>
#include <string>
#include <string_view>

#include "vayu/utils/encoding.hpp"

namespace vayu::utils {

/// The most bytes of caller-authored text one log field carries.
inline constexpr std::size_t kLoggedTextMaxBytes = 512;

/// Appended where @ref bounded_log_text cut, so a reader of the log knows the
/// field is not the whole message.
inline constexpr std::string_view kLoggedTextTruncationMarker =
"...[truncated]";

/**
 * @brief @p text as a log field carries it: unchanged up to
 *        @ref kLoggedTextMaxBytes, otherwise cut there on a UTF-8 character
 *        boundary and followed by @ref kLoggedTextTruncationMarker.
 *
 * Only the copy a log call is handed is bounded; the caller keeps, stores and
 * answers with the full text.
 */
inline std::string bounded_log_text (std::string_view text) {
    if (text.size () <= kLoggedTextMaxBytes) {
        return std::string (text);
    }
    std::string bounded (
    without_incomplete_utf8_tail (text.substr (0, kLoggedTextMaxBytes)));
    bounded += kLoggedTextTruncationMarker;
    return bounded;
}

} // namespace vayu::utils
