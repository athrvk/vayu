/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/header_min_max_scan_test.cpp
 * @brief No public header calls `min` or `max` where `windows.h` could turn
 *        the call into a macro.
 *
 * `NOMINMAX` is PRIVATE to `vayu_core` (`engine/CMakeLists.txt`), so a test
 * translation unit that includes `<curl/curl.h>` or `<httplib.h>` ahead of an
 * engine header gets `windows.h`'s `min(a, b)` and `max(a, b)` macros, and an
 * unparenthesized `std::min (a, b)` or `numeric_limits<T>::max ()` in that
 * header fails on MSVC with C2589 (#3825 added a header include to
 * `request_composer_test.cpp` and broke the Windows build). Nothing on Linux or
 * macOS can see this, so the call sites are scanned for instead: the macro only
 * expands when the name is followed by `(`, and `(std::min) (a, b)` is not.
 */

#include <cstddef>
#include <filesystem>
#include <format>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"

namespace {

/// Whether @p line names `min` or `max` as an unparenthesized call, which is
/// what the `windows.h` macros match. `(std::min) (` and `std::min<T> (` do not
/// match: the first has `)` after the name, the second `<`.
bool calls_min_or_max (const std::string& line) {
    return vayu::tests::names_call (line, "min") || vayu::tests::names_call (line, "max");
}

/// `path:line` for every line of @p code that @ref calls_min_or_max.
std::vector<std::string>
macro_exposed_lines (const std::string& label, const std::string& code) {
    std::vector<std::string> offenders;
    std::istringstream lines (code);
    std::string line;
    for (std::size_t number = 1; std::getline (lines, line); ++number) {
        if (calls_min_or_max (line)) {
            offenders.push_back (std::format ("{}:{}: {}", label, number, line));
        }
    }
    return offenders;
}

TEST (HeaderMinMaxScan, NoPublicHeaderCallsMinOrMaxUnparenthesized) {
    const std::filesystem::path tree =
    std::filesystem::path{ VAYU_ENGINE_SOURCE_DIR } / "include";
    ASSERT_TRUE (std::filesystem::is_directory (tree))
    << tree.string () << " is not where the guard looks";

    std::size_t scanned_files = 0;
    std::size_t scanned_bytes = 0;
    std::vector<std::string> offenders;
    for (const auto& entry : std::filesystem::recursive_directory_iterator (tree)) {
        if (!entry.is_regular_file () || entry.path ().extension () != ".hpp") {
            continue;
        }
        const std::string relative =
        std::filesystem::relative (entry.path (), tree).generic_string ();
        const std::string code =
        vayu::tests::strip_comments (vayu::tests::read_source (entry.path ()));
        ASSERT_FALSE (code.empty ()) << relative << " read as empty";
        ++scanned_files;
        scanned_bytes += code.size ();
        for (auto& offender : macro_exposed_lines (relative, code)) {
            offenders.push_back (std::move (offender));
        }
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_files, 100U)
    << "the guard found almost no public headers";
    ASSERT_GT (scanned_bytes, 300'000U)
    << "the guard read almost no header code";

    std::string joined;
    for (const auto& offender : offenders) {
        joined += "\n  " + offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "a header that calls min or max unparenthesized does not compile in a "
       "translation unit that includes windows.h without NOMINMAX (MSVC "
       "C2589). Write (std::min) (a, b), (std::max) (a, b) and "
       "(std::numeric_limits<T>::max) (). Offenders:"
    << joined;
}

// The matcher is pinned on planted text, kept out of the scan above: a broken
// matcher would otherwise leave that scan passing on a tree that had brought
// every unparenthesized call back.
TEST (HeaderMinMaxScan, TheMatcherSeesAMacroExposedCallAndNotAParenthesizedOne) {
    for (const char* line : {
         "return std::min (a, b);",
         "return std::min(a, b);",
         "return std::max (a, b);",
         "constexpr auto top = std::numeric_limits<size_t>::max ();",
         "constexpr auto bottom = std::numeric_limits<int>::min();",
         "const auto widest = Clock::duration::max ();",
         "return min (a, b);",
         }) {
        EXPECT_TRUE (calls_min_or_max (line)) << line;
    }

    for (const char* line : {
         "return (std::min) (a, b);",
         "return (std::max)(a, b);",
         "constexpr auto top = (std::numeric_limits<size_t>::max) ();",
         "return std::max<int64_t> (a, 0);",
         "std::max_element (v.begin (), v.end ());",
         "const auto max_gap = 3;",
         "std::size_t minimum (int x);",
         "x = max_gap_.value_or (0);",
         }) {
        EXPECT_FALSE (calls_min_or_max (line)) << line;
    }

    // Prose that names the old spelling is not a call.
    EXPECT_TRUE (macro_exposed_lines ("h", vayu::tests::strip_comments ("// std::min (a, b) here\n"))
    .empty ());
    EXPECT_EQ (macro_exposed_lines ("h", vayu::tests::strip_comments ("/* see below */\nreturn std::min (a, b);\n"))
               .size (),
    1U);
}

} // namespace
