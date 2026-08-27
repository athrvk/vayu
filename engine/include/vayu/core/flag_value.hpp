#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/flag_value.hpp
 * @brief The two ways an argument can be unusable, said once (#1031).
 *
 * `core/numeric_flag.hpp` answers "is this value one of the numbers the flag
 * takes". This answers the questions that come before it and apply to every
 * flag, numeric or not - and that both argument loops used to answer by
 * carrying on regardless:
 *
 * - **There is nothing after the flag.** `vayu-engine --data-dir . --port` used
 *   to listen on the default 9876 and say nothing, so the flag that was typed
 *   had no effect and left no trace.
 * - **What follows is another flag.** This is the one that does damage, because
 *   it *succeeds*: `vayu-engine --data-dir --port 9999` took the string
 *   `--port` as the data directory and created it - database, log and lock file
 *   inside - then listened on 9876, because `9999` matched nothing afterwards
 *   and was dropped in turn.
 *
 * A value beginning with `-` is refused rather than taken, which is the
 * conventional reading and the one that turns that case into a sentence. It
 * costs the user who genuinely means a relative path starting with `-` the
 * `./` prefix, and it is worth that: a leading `-` is a mistyped command line
 * far more often than it is a filename.
 *
 * Numeric flags do not need the second rule - `parse_numeric_flag` refuses
 * `--port` as a number already, and with a better sentence, because it can name
 * the range. They do need the first, which is why `read_flag_value` reports the
 * two separately rather than as one "bad value".
 */

#include <cctype>
#include <expected>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace vayu::core {

namespace detail {

/// The argument after @p i, or nothing when @p i is the last one.
inline std::optional<std::string_view> argument_after (std::span<char* const> args, size_t i) {
    if (i + 1 >= args.size ()) {
        return std::nullopt;
    }
    return std::string_view (args[i + 1]);
}

/// Whether the argument after @p i was meant as an *optional* level, which a
/// leading digit is the whole of the question for: `-v run` is verbose with no
/// level rather than a bad one, and so is `-v` last on the line. Stated once
/// because both `--verbose` flags answer it and they must answer it alike.
inline bool next_is_a_level (std::span<char* const> args, size_t i) {
    const auto next = argument_after (args, i);
    return next.has_value () && !next->empty () &&
    std::isdigit (static_cast<unsigned char> (next->front ())) != 0;
}

} // namespace detail

/// Whether @p text reads as another flag rather than as a value.
inline bool looks_like_a_flag (std::string_view text) {
    return text.starts_with ("-");
}

/// The first rule's refusal: nothing followed the flag. @p expected names what
/// the flag wanted ("a directory", "a port number"), because "expects a value"
/// tells someone who has just mistyped the flag the least useful half of it.
inline std::string missing_value_error (std::string_view flag, std::string_view expected) {
    return std::string (flag) + " expects " + std::string (expected) + ", and nothing follows it";
}

/// The second rule's refusal. Kept apart from the first because a numeric flag
/// takes only rule 1 and answers this one better itself: `parse_numeric_flag`
/// names the range where this can only say the value looked like a flag.
inline std::string flag_shaped_value_error (std::string_view flag,
std::string_view expected,
std::string_view value) {
    return std::string (flag) + " expects " + std::string (expected) + ", got \"" +
    std::string (value) + "\" - a value starting with \"-\" reads as another flag";
}

/**
 * @brief The value @p flag should take, or the line to refuse the run with.
 *
 * @param expected what the flag wants, as it reads after "expects".
 * @param next the argument following the flag, or `std::nullopt` when the flag
 *        was the last thing on the command line. Empty and absent are kept
 *        apart deliberately: `--daemon ""` is a value, badly chosen, and
 *        belongs to whatever validates it downstream rather than here.
 */
inline std::expected<std::string_view, std::string> read_flag_value (std::string_view flag,
std::string_view expected,
std::optional<std::string_view> next) {
    if (!next.has_value ()) {
        return std::unexpected (missing_value_error (flag, expected));
    }
    if (looks_like_a_flag (*next)) {
        return std::unexpected (flag_shaped_value_error (flag, expected, *next));
    }
    return *next;
}

/**
 * @brief The refusal for an argument that matches nothing.
 *
 * Both loops used to drop one silently, so a mistyped `--prot 9999` was
 * indistinguishable from passing no flag at all - the engine listened on the
 * default port and exited 0 whenever it was told to.
 */
inline std::string unknown_argument_error (std::string_view argument, std::string_view program) {
    return "unknown argument \"" + std::string (argument) + "\" - run " +
    std::string (program) + " --help for the arguments it takes";
}

} // namespace vayu::core
