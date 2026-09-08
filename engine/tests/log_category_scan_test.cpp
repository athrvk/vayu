/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/log_category_scan_test.cpp
 * @brief Every `log_*` call site names a real category (issue #1557).
 *
 * `LogRecord::cat` is a `std::string_view` over whatever a call site passes -
 * nothing at the type level stops a typo or a missing argument from compiling,
 * since the parameter has no default. This scans `engine/src` the way the
 * acceptance criteria do (`rg 'log_(debug|info|warning|error) \("' engine/src`)
 * and asserts the token right after the opening parenthesis is one of the
 * closed category list #1556 defines, on every call.
 */

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"

namespace {

/// The closed category list #1556's parent issue defines for the engine, plus
/// `cli` for `vayu-cli`. Adding a category is one line here and one in
/// `docs/engine/log-record.schema.json`'s `cat` enum.
constexpr std::array<std::string_view, 12> kValidCategories = { "startup", "config", "http",
    "db", "run", "script", "inbox", "mock", "oauth", "client", "shutdown", "cli" };

bool is_valid_category (std::string_view name) {
    return std::find (kValidCategories.begin (), kValidCategories.end (), name) !=
    kValidCategories.end ();
}

bool is_identifier_char (char c) {
    return (std::isalnum (static_cast<unsigned char> (c)) != 0) || c == '_';
}

/**
 * @brief Every `vayu::utils::log_(debug|info|warning|error) (` call in @p code
 *        whose first argument is not a quoted string from @ref kValidCategories.
 *
 * Bounded the way `source_scan.hpp`'s `names_call` is (a longer name, or a
 * qualifier, must not confuse the match), then reads exactly one argument: a
 * leading `"`, up to the next unescaped `"`, nothing else - the category is
 * always a plain literal, never a computed string, so this never needs to
 * balance parens or handle concatenation.
 */
std::vector<std::string> uncategorized_calls (const std::string& code) {
    constexpr std::array<std::string_view, 4> kFunctions = { "log_debug",
        "log_info", "log_warning", "log_error" };
    std::vector<std::string> offenders;

    for (const auto function : kFunctions) {
        for (size_t at = code.find (function); at != std::string::npos;
        at             = code.find (function, at + 1)) {
            if (at > 0 && is_identifier_char (code[at - 1])) {
                continue; // part of a longer or qualified name already matched
            }
            size_t after = at + function.size ();
            if (after < code.size () && is_identifier_char (code[after])) {
                continue; // log_debugger, hypothetically
            }
            while (after < code.size () &&
            std::isspace (static_cast<unsigned char> (code[after]))) {
                ++after;
            }
            if (after >= code.size () || code[after] != '(') {
                continue;
            }
            ++after;
            while (after < code.size () &&
            std::isspace (static_cast<unsigned char> (code[after]))) {
                ++after;
            }
            if (after >= code.size () || code[after] != '"') {
                offenders.push_back (std::string (function) + " (<no category literal>)");
                continue;
            }
            const size_t start         = after + 1;
            const size_t close         = code.find ('"', start);
            const std::string category = close == std::string::npos ?
            std::string{} :
            code.substr (start, close - start);
            if (!is_valid_category (category)) {
                offenders.push_back (std::string (function) + " (\"" + category + "\", ...)");
            }
        }
    }
    return offenders;
}

TEST (LogCategoryScanTest, EveryCallSiteInEngineSrcNamesARealCategory) {
    const std::filesystem::path src_dir =
    std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "src";
    ASSERT_TRUE (std::filesystem::is_directory (src_dir))
    << src_dir.string () << " is not where the guard looks";

    size_t scanned_files = 0;
    size_t scanned_bytes = 0;
    std::vector<std::string> offenders;

    for (const auto& entry : std::filesystem::recursive_directory_iterator (src_dir)) {
        if (!entry.is_regular_file ()) {
            continue;
        }
        const auto& path = entry.path ();
        if (path.extension () != ".cpp" && path.extension () != ".hpp") {
            continue;
        }
        const std::string code =
        vayu::tests::strip_comments (vayu::tests::read_source (path));
        ASSERT_FALSE (code.empty ()) << path.string () << " read as empty";
        ++scanned_files;
        scanned_bytes += code.size ();

        for (const auto& call : uncategorized_calls (code)) {
            offenders.push_back (
            std::filesystem::relative (path, src_dir).string () + ": " + call);
        }
    }

    // A scan that read nothing passes forever, so it says what it read - the
    // whole point of #1557 is that this now covers hundreds of call sites.
    ASSERT_GT (scanned_files, 40u)
    << "the guard found almost no engine sources";
    ASSERT_GT (scanned_bytes, 200'000u) << "the guard read empty sources";

    std::string joined;
    for (const auto& offender : offenders) {
        if (!joined.empty ()) {
            joined += "\n  ";
        }
        joined += offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "every log_debug/log_info/log_warning/log_error call takes a category "
       "literal from the closed list as its first argument (issue #1557). "
       "Offenders:\n  "
    << joined;
}

/**
 * The matcher catches what it should - a missing category, an invalid one,
 * and a category that reads as a longer name or a plain message - and leaves
 * a correctly categorized call alone. Without this, a bug in the boundary or
 * quote-matching logic above could leave the scan passing on a tree full of
 * violations, the same failure mode `source_scan.hpp`'s own docs warn about.
 */
TEST (LogCategoryScanTest, TheMatcherSeesEveryShapeItShould) {
    EXPECT_TRUE (
    uncategorized_calls (R"(vayu::utils::log_info ("http", "GET /health");)").empty ());
    EXPECT_TRUE (uncategorized_calls (R"(vayu::utils::log_debug ("db", "row written", fields);)")
    .empty ());

    EXPECT_EQ (
    uncategorized_calls (R"(vayu::utils::log_info ("Returning 3 items");)").size (), 1u)
    << "a message with no category argument at all must be caught";
    EXPECT_EQ (
    uncategorized_calls (R"(vayu::utils::log_warning ("notacategory", "x");)").size (), 1u)
    << "a string that is not in the closed list must be caught";
    EXPECT_TRUE (
    uncategorized_calls (R"(vayu::utils::log_info_verbose ("x", "y");)").empty ())
    << "a longer name must not be mistaken for log_info";
    EXPECT_TRUE (uncategorized_calls (
    vayu::tests::strip_comments ("// vayu::utils::log_info (\"bad\");\n"))
    .empty ())
    << "a commented-out call must not be scanned";
}

} // namespace
