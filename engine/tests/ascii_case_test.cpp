/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/ascii_case_test.cpp
 * @brief `vayu::utils::ascii_lower` and `ascii_lower_equal` (issue #1060), and
 *        the guard that keeps the fold they replaced out of `src` and
 *        `include`.
 *
 * Two halves, because the defect has two.
 *
 * The behavioural half is the byte above 127. Twenty-seven of the twenty-nine
 * hand-rolled folds cast to `unsigned char` before calling `std::tolower` and
 * two did not, which is undefined where `char` is signed - and undefined is
 * exactly what does not reproduce on demand, so what is pinned here is the
 * rule that makes the question moot: the fold touches the twenty-six letters
 * and returns every other byte as it went in, on either signing of `char`.
 * `-funsigned-char` is a real build here (it is the default on ARM), so both
 * halves of that sentence are asserted rather than one.
 *
 * The scanning half is for what no behavioural test can reach. A twenty-ninth
 * copy added tomorrow works perfectly on the ASCII input every caller has;
 * nothing fails, and the primitive's next fix simply does not reach it. What
 * is testable is that `src` and `include` no longer name the call, which is
 * also what holds an *untouched* file at zero once the lint gates have stopped
 * looking at it (they lint only the files a change touches, #946). Reverting
 * any one of the conversions fails the scan.
 */

#include <algorithm>
#include <array>
#include <cstddef>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::utils {
namespace {

TEST (AsciiLower, LowersTheTwentySixLettersAndNothingElse) {
    EXPECT_EQ (ascii_lower ("CONTENT-TYPE"), "content-type");
    EXPECT_EQ (ascii_lower ("Content-Type"), "content-type");

    // Already lower is the common case at the call sites, and must be a
    // faithful copy rather than a near one.
    EXPECT_EQ (ascii_lower ("content-type"), "content-type");
    EXPECT_EQ (ascii_lower (""), "");

    // The neighbours of 'A'-'Z' in ASCII, which an off-by-one range test would
    // fold: '@' is 'A' - 1 and '[' is 'Z' + 1.
    EXPECT_EQ (ascii_lower ("@[`{ 0189_-."), "@[`{ 0189_-.");
}

/**
 * The case the two uncast `::tolower` sites got wrong, and the reason the fold
 * is spelled as a range test on the `char` rather than as a call taking an
 * `unsigned char`: a byte above 127 is negative where `char` is signed, and
 * passing it to `std::tolower` is undefined. Here it is simply not a letter.
 */
TEST (AsciiLower, LeavesAByteAbove127ExactlyAsItWas) {
    const std::string utf8 = "caf\xC3\xA9-HEADER";
    EXPECT_EQ (ascii_lower (utf8), "caf\xC3\xA9-header");

    // Every byte from 0x80 up, none of which is a letter under this rule on
    // either signing of `char`.
    std::string high;
    for (int byte = 0x80; byte <= 0xFF; ++byte) {
        high.push_back (static_cast<char> (byte));
    }
    EXPECT_EQ (ascii_lower (high), high);
}

TEST (AsciiLower, TheCharacterFoldIsAConstantExpression) {
    // The comparator in `types.hpp` calls it per character per lookup, so it
    // has to be the cheap spelling as well as the correct one.
    static_assert (ascii_lower ('A') == 'a');
    static_assert (ascii_lower ('Z') == 'z');
    static_assert (ascii_lower ('a') == 'a');
    static_assert (ascii_lower ('7') == '7');
    static_assert (ascii_lower ('@') == '@');
    static_assert (ascii_lower ('[') == '[');
    SUCCEED ();
}

TEST (AsciiLowerEqual, MatchesUnderTheFoldAndBuildsNothing) {
    EXPECT_TRUE (ascii_lower_equal ("Authorization", "AUTHORIZATION"));
    EXPECT_TRUE (ascii_lower_equal ("", ""));

    EXPECT_FALSE (ascii_lower_equal ("authorization", "authorisation"));
    EXPECT_FALSE (ascii_lower_equal ("auth", "authorization")); // a prefix is not a match
    EXPECT_FALSE (ascii_lower_equal ("authorization", "auth"));

    // Embedded NULs are compared, not treated as a terminator - the views
    // carry their own length.
    EXPECT_TRUE (
    ascii_lower_equal (std::string_view ("A\0b", 3), std::string_view ("a\0B", 3)));
    EXPECT_FALSE (
    ascii_lower_equal (std::string_view ("a\0b", 3), std::string_view ("a", 1)));
}

/**
 * The two answers `CaseInsensitiveLess` gives have to agree: `equal` is what
 * callers ask outside the map and `operator()` is what the map itself orders
 * by, and before #1060 they were two separate spellings of the fold. A byte
 * above 127 is where a divergence would have shown first.
 */
TEST (CaseInsensitiveLess, TheOrderingAndTheEqualityAgree) {
    const CaseInsensitiveLess less;

    EXPECT_TRUE (CaseInsensitiveLess::equal ("Content-Type", "CONTENT-TYPE"));
    EXPECT_FALSE (less ("Content-Type", "CONTENT-TYPE"));
    EXPECT_FALSE (less ("CONTENT-TYPE", "Content-Type"));

    EXPECT_FALSE (CaseInsensitiveLess::equal ("Accept", "Accept-Encoding"));
    EXPECT_TRUE (less ("Accept", "Accept-Encoding"));

    const std::string high  = "caf\xC3\xA9";
    const std::string other = "caf\xC3\xA8";
    EXPECT_TRUE (CaseInsensitiveLess::equal (high, high));
    EXPECT_FALSE (CaseInsensitiveLess::equal (high, other));

    // And the map keyed by it still treats a header name one way.
    Headers headers;
    headers["Content-Type"] = "application/json";
    headers["CONTENT-TYPE"] = "text/plain";
    EXPECT_EQ (headers.size (), 1u);
    EXPECT_EQ (headers.at ("content-type"), "text/plain");
}

/// The one name the conversions replaced. `towlower` is deliberately not here:
/// nothing in the engine has ever named it, and a guard is worth having for
/// the spelling that actually accumulated.
constexpr std::string_view kFoldCall = "tolower";

/**
 * @brief Whether @p code names `tolower` at all, called or not.
 *
 * `tests::names_call` is the wrong matcher here and the reason is the whole
 * point of the issue: the two sites that were actually undefined spelled it
 * `std::transform (b, e, b, ::tolower)`, passing the function rather than
 * calling it, so the `(` that `names_call` requires after the name is not
 * there. A guard built on it would have read the one spelling this fix exists
 * for as a clean tree.
 *
 * Bounded on both sides like `names_call`, and for the same reason: without
 * it `tolower_count` and any longer name containing this one would be
 * reported, which would make the rule unstatable. Nothing narrower is needed -
 * `std::` and `::` sit to the left of the name and do not interfere, and
 * `towlower` does not contain it.
 */
bool names_fold (const std::string& code, std::string_view name) {
    const auto is_identifier_char = [] (char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
        (c >= 'A' && c <= 'Z') || c == '_';
    };

    for (size_t at = code.find (name); at != std::string::npos;
    at             = code.find (name, at + 1)) {
        if (at > 0 && is_identifier_char (code[at - 1])) {
            continue;
        }
        const size_t after = at + name.size ();
        if (after < code.size () && is_identifier_char (code[after])) {
            continue;
        }
        return true;
    }
    return false;
}

/// One file, one call, the shape `reentrant_test.cpp` settled on - `constexpr`
/// arrays of views rather than the `std::vector<std::string>` they read more
/// naturally as, because a namespace-scope container with a throwing
/// constructor is a `cert-err58-cpp` finding.
struct ExemptSite {
    std::string_view file;
    std::string_view call;
};

/// Empty, and that is the claim: the fold is written as a range test on the
/// character, so even the primitive itself does not call `std::tolower`. A
/// site that genuinely cannot route through `utils/ascii_case.hpp` belongs
/// here with its reason beside it, not silenced at the line.
constexpr std::array<ExemptSite, 0> kExempt = {};

bool is_exempt (std::string_view file, std::string_view call) {
    return std::any_of (kExempt.begin (), kExempt.end (), [&] (const ExemptSite& site) {
        return site.file == file && site.call == call;
    });
}

TEST (AsciiFold, TheEngineSourcesDoNotHandRollIt) {
    const std::filesystem::path root{ VAYU_ENGINE_SOURCE_DIR };
    size_t scanned_files = 0;
    size_t scanned_bytes = 0;
    std::vector<std::string> offenders;

    for (const auto* directory : { "src", "include" }) {
        const auto tree = root / directory;
        ASSERT_TRUE (std::filesystem::is_directory (tree))
        << tree.string () << " is not where the guard looks";

        for (const auto& entry : std::filesystem::recursive_directory_iterator (tree)) {
            const auto& path            = entry.path ();
            const std::string extension = path.extension ().string ();
            if (!entry.is_regular_file () || (extension != ".cpp" && extension != ".hpp")) {
                continue;
            }
            const std::string relative =
            std::filesystem::relative (path, root).generic_string ();

            const std::string code = tests::strip_comments (tests::read_source (path));
            ASSERT_FALSE (code.empty ()) << relative << " read as empty";
            ++scanned_files;
            scanned_bytes += code.size ();

            if (is_exempt (relative, kFoldCall) || !names_fold (code, kFoldCall)) {
                continue;
            }
            std::string offender = relative;
            offender += " calls ";
            offender += kFoldCall;
            offenders.push_back (std::move (offender));
        }
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_files, 100u) << "the guard found almost no sources";
    ASSERT_GT (scanned_bytes, 100'000u) << "the guard read empty sources";

    std::string joined;
    for (const auto& offender : offenders) {
        if (!joined.empty ()) {
            joined += "\n  ";
        }
        joined += offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "a hand-rolled fold does not receive the primitive's fixes, and reads "
       "the process's C locale for any byte above 127. Use "
       "vayu/utils/ascii_case.hpp - ascii_lower for a character or a string, "
       "ascii_lower_equal to compare without building one - or add the site "
       "to kExempt with its reason. Offenders:\n  "
    << joined;
}

/**
 * The matcher still finds the call it should, and still ignores the longer
 * names that contain it. Without this, an over-eager `strip_comments` or a
 * broken boundary check would leave the guard above passing on a tree that had
 * brought every copy back.
 */
TEST (AsciiFold, TheGuardSeesTheNameCalledOrPassed) {
    EXPECT_TRUE (names_fold ("c = std::tolower (c);", kFoldCall));

    // The spelling `tests::names_call` misses, and the one that was undefined:
    // the function passed rather than called, so no `(` follows the name.
    EXPECT_TRUE (names_fold ("std::transform (b, e, b, ::tolower);", kFoldCall));
    EXPECT_FALSE (tests::names_call ("std::transform (b, e, b, ::tolower);", kFoldCall));

    EXPECT_FALSE (names_fold ("x = ascii_lower (c);", kFoldCall));
    EXPECT_FALSE (names_fold ("y = std::towlower (c);", kFoldCall));
    EXPECT_FALSE (names_fold ("int tolower_count = 0;", kFoldCall));
    EXPECT_FALSE (names_fold ("auto x = my_tolower (c);", kFoldCall));

    // The prose in `ascii_case.hpp` names the call it replaced, so the guard
    // has to read code and not comments or it could never be quieted.
    EXPECT_FALSE (
    names_fold (tests::strip_comments (
                "// the sites that spelled std::tolower (c) themselves\n"),
    kFoldCall));
    EXPECT_TRUE (names_fold (
    tests::strip_comments ("/* see above */ std::tolower (c);\n"), kFoldCall));
}

} // namespace
} // namespace vayu::utils
