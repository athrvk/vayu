/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/optional_assert_test.cpp
 * @brief What `ASSERT_HAS_VALUE` promises a test that uses it (issue #980),
 *        and the guard that keeps the spelling it replaced out of the suite.
 *
 * The property that made the macro necessary - that
 * `bugprone-unchecked-optional-access` accepts the guard it writes - is a lint
 * result and cannot be asserted from inside the suite; `optional_assert.hpp`
 * records how it was measured. What a running test *can* pin is the half a
 * caller depends on: that an empty optional stops the test body fatally, that
 * the failure names the expression it was given, and that a caller's own
 * message survives. Those are what a future rewrite of the macro would break
 * silently.
 *
 * The scan at the bottom is the other half of the wave. CI lints a pull
 * request's *changed* lines, so once these conversions stop being new nothing
 * holds the family at zero - the same argument #945 made for `concurrency-*`.
 * It could not be turned on until every test file was converted, which is what
 * #980's last batch did; reverting any one conversion fails it.
 */

#include <algorithm>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest-spi.h>
#include <gtest/gtest.h>

#include "optional_assert.hpp"
#include "source_scan.hpp"

namespace {

// Free functions rather than locals: `EXPECT_FATAL_FAILURE` runs its statement
// in a class of its own, which cannot reach the enclosing test body's variables.

std::optional<std::string> empty_row () {
    return std::nullopt;
}

std::optional<std::string> filled_row () {
    return std::string ("row");
}

} // namespace

TEST (OptionalAssert, LetsTheTestReadTheValueItAsserted) {
    const std::optional<std::string> row = filled_row ();
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (*row, "row");
}

TEST (OptionalAssert, AnEmptyOptionalIsAFatalFailureNamingTheExpression) {
    EXPECT_FATAL_FAILURE (
    ASSERT_HAS_VALUE (empty_row ()), "expected empty_row () to hold a value");
}

TEST (OptionalAssert, TheCallersOwnMessageReachesTheFailure) {
    EXPECT_FATAL_FAILURE (
    ASSERT_HAS_VALUE (empty_row ()) << "after the second write", "after the second write");
}

TEST (OptionalAssert, AnEngagedOptionalRaisesNothing) {
    EXPECT_NONFATAL_FAILURE (
    {
        ASSERT_HAS_VALUE (filled_row ());
        ADD_FAILURE () << "the body continued";
    },
    "the body continued");
}

namespace {

/**
 * @brief Whether @p code guards an optional with `ASSERT_TRUE (x.has_value ())`.
 *
 * The whole argument has to be the `has_value ()` call, not merely contain
 * one: `ASSERT_TRUE (a.has_value () && b)` is a different assertion, and the
 * rule this scan states is about the guard spelling alone. `EXPECT_TRUE` is
 * left out for the same reason - it asserts something about an optional rather
 * than guarding a read below it, and it is the right call when a test says an
 * optional is engaged and stops there.
 */
bool guards_with_assert_true (const std::string& code) {
    constexpr std::string_view kOpen = "ASSERT_TRUE (";
    constexpr std::string_view kEnd  = ".has_value ()";

    const std::string_view source (code);
    for (size_t at = source.find (kOpen); at != std::string_view::npos;
    at             = source.find (kOpen, at + 1)) {
        size_t depth          = 1;
        size_t i              = at + kOpen.size ();
        const size_t argument = i;
        for (; i < source.size () && depth > 0; ++i) {
            if (source[i] == '(') {
                ++depth;
            } else if (source[i] == ')') {
                --depth;
            }
        }
        if (depth != 0) {
            continue; // unbalanced, so not an assertion this scan can read
        }
        std::string_view inside = source.substr (argument, i - argument - 1);
        while (!inside.empty () && (inside.back () == ' ' || inside.back () == '\n')) {
            inside.remove_suffix (1);
        }
        if (inside.ends_with (kEnd)) {
            return true;
        }
    }
    return false;
}

/// This file plants the spelling in string literals to pin the matcher below,
/// and `strip_comments` does not model literals - so the file carrying the
/// guard is the one file the guard cannot read.
constexpr std::string_view kScanExempt = "tests/optional_assert_test.cpp";

} // namespace

/**
 * Every test file guards an engaged optional with `ASSERT_HAS_VALUE`. The
 * gtest spelling reads the same at run time and the optional check cannot
 * follow it, which is where 561 findings came from (#980); a file that brings
 * it back would pass CI, because the gate lints changed lines only.
 */
TEST (OptionalAssertGuard, NoTestFileGuardsWithAssertTrue) {
    const std::filesystem::path tests =
    std::filesystem::path{ VAYU_ENGINE_SOURCE_DIR } / "tests";
    ASSERT_TRUE (std::filesystem::is_directory (tests))
    << tests.string () << " is not where the guard looks";

    size_t scanned_files = 0;
    size_t scanned_bytes = 0;
    std::vector<std::string> offenders;

    for (const auto& entry : std::filesystem::recursive_directory_iterator (tests)) {
        const std::string extension = entry.path ().extension ().string ();
        if (!entry.is_regular_file () || (extension != ".cpp" && extension != ".hpp")) {
            continue;
        }
        const std::string relative =
        std::filesystem::relative (entry.path (), VAYU_ENGINE_SOURCE_DIR).generic_string ();

        const std::string code =
        vayu::tests::strip_comments (vayu::tests::read_source (entry.path ()));
        ASSERT_FALSE (code.empty ()) << relative << " read as empty";
        ++scanned_files;
        scanned_bytes += code.size ();

        if (relative != kScanExempt && guards_with_assert_true (code)) {
            offenders.push_back (relative);
        }
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_files, 100u) << "the guard found almost no test sources";
    ASSERT_GT (scanned_bytes, 100'000u) << "the guard read empty sources";

    std::string joined;
    for (const auto& offender : offenders) {
        if (!joined.empty ()) {
            joined += "\n  ";
        }
        joined += offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "ASSERT_TRUE (opt.has_value ()) guards the reads under it at run time "
       "and "
       "bugprone-unchecked-optional-access cannot see that it does. Use "
       "ASSERT_HAS_VALUE (opt) from tests/optional_assert.hpp. Offenders:\n  "
    << joined;
}

/**
 * The matcher still finds the spelling it is looking for, and still ignores
 * the assertions that are not it. Without this, a stripper that blanked too
 * much would leave the guard above passing on a suite that had brought every
 * one of them back.
 */
TEST (OptionalAssertGuard, TheGuardSeesTheSpellingAndNotItsNeighbours) {
    EXPECT_TRUE (guards_with_assert_true ("ASSERT_TRUE (row.has_value ());"));
    EXPECT_TRUE (
    guards_with_assert_true ("ASSERT_TRUE (db.get_run (id).has_value ());"));

    EXPECT_FALSE (guards_with_assert_true ("ASSERT_HAS_VALUE (row);"));
    EXPECT_FALSE (guards_with_assert_true ("EXPECT_TRUE (row.has_value ());"));
    EXPECT_FALSE (guards_with_assert_true ("ASSERT_FALSE (row.has_value ());"));
    EXPECT_FALSE (
    guards_with_assert_true ("ASSERT_TRUE (row.has_value () && row->ok);"));

    EXPECT_FALSE (guards_with_assert_true (vayu::tests::strip_comments (
    "// never ASSERT_TRUE (row.has_value ()) here\n")));
}
