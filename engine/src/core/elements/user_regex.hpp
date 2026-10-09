#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file user_regex.hpp
 * @brief The one way a pattern a user wrote is compiled and run (#1874):
 *        `extract.regex`, `assert.jsonpath`'s `regex`, `assert.contains`'s
 *        `matches` and `control.if`'s `matches` all go through it.
 *
 * RE2, not `std::regex`: libstdc++'s executor recurses once per consumed
 * character, so a greedy group spanning a response body of a few tens of
 * kilobytes overflowed the worker's stack and took the daemon down. RE2 runs
 * in time linear in the text and keeps its state on the heap, so no body size
 * and no pattern can do that. The price is the dialect: no backreferences and
 * no lookaround, which RE2 refuses at compile time. Text is matched as bytes,
 * as `std::regex` matched it, so a body that is not UTF-8 is still searchable.
 *
 * Source-tree-local (not under `include/vayu/`), and `<re2/re2.h>` is
 * included only by `user_regex.cpp`: nothing outside
 * `engine/src/core/elements/` runs a user's pattern.
 */

#include <expected>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <string_view>

namespace re2 {
class RE2;
} // namespace re2

namespace vayu::core {

/// A compiled user pattern. Cheap to copy; matching is const and safe to call
/// from several threads at once.
class UserRegex {
    public:
    /// Whether the pattern matches anywhere in @p text (`std::regex_search`'s
    /// question, not `std::regex_match`'s).
    [[nodiscard]] bool search (std::string_view text) const;

    /// Calls @p visit once per non-overlapping match, leftmost first. The span
    /// holds group 0 (the whole match) then every capture group; a group that
    /// did not take part is an empty view. After an empty match the search
    /// resumes one byte later, so the walk always ends.
    void for_each_match (std::string_view text,
    const std::function<void (std::span<const std::string_view> groups)>& visit) const;

    private:
    friend std::expected<UserRegex, std::string> compile_user_regex (std::string_view pattern);
    explicit UserRegex (std::shared_ptr<const re2::RE2> compiled);

    std::shared_ptr<const re2::RE2> compiled_;
};

/// @p pattern compiled, or `"invalid regular expression: <reason>"` - the
/// sentence every caller reports as its element's `"error"` outcome.
[[nodiscard]] std::expected<UserRegex, std::string> compile_user_regex (
std::string_view pattern);

} // namespace vayu::core
