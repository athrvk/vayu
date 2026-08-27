#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/numeric_flag.hpp
 * @brief A numeric command-line flag's value, or the refusal to print (#1028).
 *
 * Both argument loops - `vayu-engine`'s and `vayu-cli`'s - used to hand the
 * text after a flag to `std::stoi` unchecked. That gets two things wrong at
 * once, and neither is visible until a user hits it:
 *
 * - **It throws the name of a function at the user.** `--port notanumber` left
 *   `std::invalid_argument` to travel to whatever caught it, so the daemon's
 *   whole answer was `vayu-engine: stoi` - the function that threw, not the
 *   flag, the value or what was expected. Before the top-level handler existed
 *   the same input aborted with no message at all.
 * - **It accepts a prefix.** `std::stoi ("1abc")` is 1, so a mistyped level was
 *   silently a different level. `vayu::utils::parse_number` exists because that
 *   half kept being forgotten; this is the layer above it that adds the range
 *   and the sentence, which `parse.hpp` deliberately leaves to its callers.
 *
 * A flag is described once, here, and both the loop that reads it and the test
 * that holds it to its range name the same `NumericFlag`. The range is part of
 * the description rather than a second argument at the call site, because
 * `--port 99999` parsing fine and failing at bind time is a worse place to
 * learn it, and because a range spelled at the call site is a range that can
 * disagree with the one the tests check.
 */

#include <expected>
#include <string>
#include <string_view>

#include "vayu/utils/parse.hpp"

namespace vayu::core {

/// One numeric flag: the name to blame, and the values it accepts.
struct NumericFlag {
    /// The long spelling, which is what the refusal names however it was typed
    /// - `-p` and `--port` are the same flag and the same mistake.
    std::string_view name;
    int min = 0;
    int max = 0;
};

/// `-p` / `--port`. The upper bound is the last port a TCP socket can carry;
/// 0 is excluded because it means "any port" to `bind`, which the engine's
/// fixed-port contract does not offer (see docs/architecture.md).
inline constexpr NumericFlag PORT_FLAG{ .name = "--port", .min = 1, .max = 65535 };

/// `-v` / `--verbose <LEVEL>`. The three levels the logger has: 0 warn/error,
/// 1 info, 2 debug.
inline constexpr NumericFlag VERBOSITY_FLAG{ .name = "--verbose", .min = 0, .max = 2 };

/**
 * @brief @p text as @p flag's value, or the line to print before refusing.
 *
 * Non-numeric, partly numeric and out-of-range are one message on purpose:
 * each is the same thing wrong from the user's side - the value does not name
 * one of the numbers this flag takes - and the message says which numbers it
 * does take, which is the part they need either way.
 */
inline std::expected<int, std::string>
parse_numeric_flag (const NumericFlag& flag, std::string_view text) {
    const auto value = vayu::utils::parse_number<int> (text);
    if (!value.has_value () || *value < flag.min || *value > flag.max) {
        return std::unexpected (std::string (flag.name) +
        " expects a number between " + std::to_string (flag.min) + " and " +
        std::to_string (flag.max) + ", got \"" + std::string (text) + "\"");
    }
    return *value;
}

} // namespace vayu::core
