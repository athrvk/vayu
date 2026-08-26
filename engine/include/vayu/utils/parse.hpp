#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/parse.hpp
 * @brief A whole `std::string_view` as a number, or nothing (issue #945).
 *
 * Five call sites had each written the same eight lines: name the view's two
 * ends, hand them to `std::from_chars`, reject unless the conversion both
 * succeeded and consumed to the end. `std::from_chars` is the right primitive
 * to build on - it is the one integer parse that neither throws on the event
 * loop's handler-less worker threads nor guesses at a base - but it takes a
 * pointer range, and every copy spelled that range as `text.data ()` plus
 * `text.size ()` arithmetic on it. That is two findings per site
 * (`bugprone-suspicious-stringview-data-usage` on the `data ()`,
 * `cppcoreguidelines-pro-bounds-pointer-arithmetic` on the `+`) and, more to
 * the point, five chances to forget the `ptr != end` half - which is what
 * separates "42abc is 42" from "42abc is not a number".
 *
 * `std::to_address` over the view's own iterators is the same two addresses
 * with the bound still attached to them (the spelling settled in the fix that
 * preceded this one), and it belongs in one place rather than at each call.
 *
 * Whole-view is the contract, deliberately: a caller that wants a prefix has a
 * prefix to pass, and every caller here already had to reject a partial parse.
 * Range is *not* part of the contract - a port's 1..65535 and a capture id's
 * "not negative" are the caller's rules, checked on the value this returns.
 */

#include <charconv>
#include <memory>
#include <optional>
#include <string_view>
#include <system_error>

namespace vayu::utils {

/**
 * @brief @p text as a `T`, or `std::nullopt` unless the whole of it is one.
 *
 * Empty input, leading whitespace, a leading `+`, a trailing unit and a value
 * too large for `T` are all "not a number" - `std::from_chars` accepts none of
 * them, and the end-of-input check refuses what it accepted only a prefix of.
 * Never throws: this runs on the event loop workers, which have no handler.
 */
template <typename T> std::optional<T> parse_number (std::string_view text) {
    T value                 = T{};
    const auto* const begin = std::to_address (text.begin ());
    const auto* const end   = std::to_address (text.end ());

    const auto [ptr, ec] = std::from_chars (begin, end, value);
    if (ec != std::errc{} || ptr != end) {
        return std::nullopt;
    }
    return value;
}

} // namespace vayu::utils
