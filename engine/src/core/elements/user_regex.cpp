/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file user_regex.cpp
 * @brief The only translation unit that includes `<re2/re2.h>` (#1874).
 */

#include "user_regex.hpp"

#include <cstdint>
#include <utility>
#include <vector>

#include <re2/re2.h>

namespace vayu::core {

namespace {

/// RE2's own default, stated so it is a decision rather than an accident: the
/// compiled program and the DFA caches share it. A pattern whose program
/// alone exceeds it fails to compile ("pattern too large"); a search whose
/// DFA fills it falls back to RE2's NFA, slower and still linear.
constexpr int64_t USER_REGEX_MAX_MEM = int64_t{ 8 } << 20;

RE2::Options user_regex_options () {
    RE2::Options options;
    // Bytes, as std::regex over a std::string read them: a body need not be
    // UTF-8, and in RE2's UTF-8 mode `.` does not match an invalid byte, so
    // `<title>(.*)</title>` would quietly miss on a Latin-1 page. A UTF-8
    // literal in the pattern still matches the same bytes in the text.
    options.set_encoding (RE2::Options::EncodingLatin1);
    options.set_posix_syntax (false);
    options.set_longest_match (false);
    options.set_dot_nl (false);
    options.set_case_sensitive (true);
    options.set_max_mem (USER_REGEX_MAX_MEM);
    // A bad pattern is the element's "error" outcome; RE2 writing it to
    // stderr as well would bypass the engine's logger.
    options.set_log_errors (false);
    return options;
}

} // namespace

UserRegex::UserRegex (std::shared_ptr<const re2::RE2> compiled)
: compiled_ (std::move (compiled)) {
}

bool UserRegex::search (std::string_view text) const {
    return RE2::PartialMatch (text, *compiled_);
}

void UserRegex::for_each_match (std::string_view text,
const std::function<void (std::span<const std::string_view> groups)>& visit) const {
    const auto group_count =
    static_cast<size_t> (compiled_->NumberOfCapturingGroups ()) + 1;
    std::vector<std::string_view> groups (group_count);
    size_t from = 0;
    while (from <= text.size () &&
    compiled_->Match (text, from, text.size (), RE2::UNANCHORED, groups.data (),
    static_cast<int> (group_count))) {
        visit (groups);
        const std::string_view whole = groups.front ();
        const auto match_end =
        static_cast<size_t> (whole.data () - text.data ()) + whole.size ();
        from = whole.empty () ? match_end + 1 : match_end;
    }
}

std::expected<UserRegex, std::string> compile_user_regex (std::string_view pattern) {
    auto compiled = std::make_shared<const re2::RE2> (pattern, user_regex_options ());
    if (!compiled->ok ()) {
        return std::unexpected ("invalid regular expression: " + compiled->error ());
    }
    return UserRegex (std::move (compiled));
}

} // namespace vayu::core
