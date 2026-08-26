/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/bounds_primitives_test.cpp
 * @brief `vayu::utils::parse_number` and `vayu::http::CurlErrorBuffer` (issue
 *        #945 batch 4), and the guard that keeps hand-rolled copies of them
 *        out of the tree.
 *
 * The `cppcoreguidelines-pro-bounds-*` family is mostly not N decisions: it is
 * a handful of places where a length was thrown away and then re-derived by
 * hand. Two of those had grown copies - five sites naming a `string_view`'s two
 * ends for `std::from_chars`, three declaring a bare `char[CURL_ERROR_SIZE]`
 * for libcurl - and both are the kind of copy that *works*, which is why they
 * accumulated: the arithmetic is correct at every site, right up until one of
 * them forgets the half that is not.
 *
 * The behavioural half is what each primitive promises. `parse_number` must
 * refuse a partial parse, because "42abc is 42" is exactly the mistake a copy
 * makes by leaving out the `ptr != end` check. `CurlErrorBuffer` must be empty
 * when libcurl wrote nothing, because a handle is reused across transfers and
 * libcurl only ever writes on failure - so a buffer that is not cleared answers
 * a later success with an earlier failure's message.
 *
 * The scanning half is for what no behavioural test can reach. The tidy gates
 * lint only the files a change touches (#946), so nothing holds either count
 * at zero in a file nobody edits; the scan is what does. Unlike a
 * subscript, both spellings are tokens - `from_chars` and `CURLOPT_ERRORBUFFER`
 * - so this family is scannable after all, for the two shapes that had copies.
 */

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <curl/curl.h>
#include <gtest/gtest.h>

#include "source_scan.hpp"
#include "vayu/http/curl_error_buffer.hpp"
#include "vayu/http/curl_options.hpp"
#include "vayu/utils/parse.hpp"

namespace vayu {
namespace {

// ---------------------------------------------------------------------------
// parse_number
// ---------------------------------------------------------------------------

TEST (ParseNumber, ReadsTheWholeViewAndNothingLess) {
    EXPECT_EQ (utils::parse_number<int> ("0"), 0);
    EXPECT_EQ (utils::parse_number<int> ("65535"), 65535);
    EXPECT_EQ (utils::parse_number<int> ("-7"), -7);
    EXPECT_EQ (utils::parse_number<std::int64_t> ("9007199254740993"), 9007199254740993);

    // The view's bound is what says where the number ends: a longer buffer
    // behind it must not be read past.
    const std::string_view padded = std::string_view ("12345").substr (0, 3);
    EXPECT_EQ (utils::parse_number<int> (padded), 123);
}

TEST (ParseNumber, RefusesEverythingThatIsNotAWholeNumber) {
    // The one a hand-rolled copy gets wrong by dropping the end-of-input check.
    EXPECT_EQ (utils::parse_number<int> ("42abc"), std::nullopt);
    EXPECT_EQ (utils::parse_number<int> ("200 OK"), std::nullopt);

    EXPECT_EQ (utils::parse_number<int> (""), std::nullopt);
    EXPECT_EQ (utils::parse_number<int> (" 1"), std::nullopt);
    EXPECT_EQ (utils::parse_number<int> ("+1"), std::nullopt);
    EXPECT_EQ (utils::parse_number<int> ("0x10"), std::nullopt);
    EXPECT_EQ (utils::parse_number<unsigned> ("-1"), std::nullopt);

    // Out of range is a refusal, not a wrap or a throw: this runs on the event
    // loop workers, which have no handler.
    EXPECT_EQ (utils::parse_number<std::int32_t> ("99999999999999999999"), std::nullopt);
}

// ---------------------------------------------------------------------------
// CurlErrorBuffer
// ---------------------------------------------------------------------------

TEST (CurlErrorBuffer, IsEmptyUntilLibcurlWritesSomething) {
    http::CurlErrorBuffer errors;
    EXPECT_TRUE (errors.message ().empty ());

    CURL* curl = curl_easy_init ();
    ASSERT_NE (curl, nullptr);
    errors.attach (curl);

    // Attaching does not manufacture a message, and a transfer that never ran
    // has none to report.
    EXPECT_TRUE (errors.message ().empty ());
    curl_easy_cleanup (curl);
}

TEST (CurlErrorBuffer, ReportsWhatAFailedTransferWroteAndForgetsItOnTheNext) {
    http::CurlErrorBuffer errors;
    CURL* curl = curl_easy_init ();
    ASSERT_NE (curl, nullptr);
    errors.attach (curl);

    // A scheme libcurl does not support fails before any socket is opened, so
    // this is a message with no network behind it.
    http::set_opt<CURLOPT_URL> (curl, "not-a-scheme://vayu.invalid/");
    ASSERT_NE (curl_easy_perform (curl), CURLE_OK);
    EXPECT_FALSE (errors.message ().empty ())
    << "libcurl reported a failure and the buffer did not carry its text";

    // The whole point of attach clearing: libcurl writes only on failure, so a
    // reused handle would otherwise answer the next transfer with this one's
    // message.
    errors.attach (curl);
    EXPECT_TRUE (errors.message ().empty ())
    << "the previous transfer's error survived into the next one";

    curl_easy_cleanup (curl);
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/// The files allowed to spell one, and why - per (file, token), because a file
/// that owns one primitive has no standing to hand-roll the other.
struct ExemptSpelling {
    std::string_view file;
    std::string_view token;
};

/// A `constexpr std::array` rather than the `std::vector<std::string>` this
/// reads more naturally as: a namespace-scope container with a throwing
/// constructor is `cert-err58-cpp`, a finding of this same paydown.
constexpr std::array<ExemptSpelling, 2> kExempt = { {
{ "include/vayu/utils/parse.hpp", "from_chars" },
{ "include/vayu/http/curl_error_buffer.hpp", "CURLOPT_ERRORBUFFER" },
} };

bool is_exempt (std::string_view file, std::string_view token) {
    return std::any_of (kExempt.begin (), kExempt.end (), [&] (const ExemptSpelling& entry) {
        return entry.file == file && entry.token == token;
    });
}

TEST (BoundsPrimitives, TheEngineSourcesGoThroughThePrimitives) {
    const std::filesystem::path root{ VAYU_ENGINE_SOURCE_DIR };
    std::size_t scanned_files = 0;
    std::size_t scanned_bytes = 0;
    std::vector<std::string> offenders;

    for (const auto* directory : { "src", "include", "tests" }) {
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
            // This file's own planted positives live in string literals, which
            // `strip_comments` does not blank.
            if (relative == "tests/bounds_primitives_test.cpp") {
                continue;
            }

            const std::string code = tests::strip_comments (tests::read_source (path));
            ASSERT_FALSE (code.empty ()) << relative << " read as empty";
            ++scanned_files;
            scanned_bytes += code.size ();

            if (!is_exempt (relative, "from_chars") && tests::names_call (code, "from_chars")) {
                offenders.push_back (relative + ": std::from_chars");
            }
            // A plain substring: the option name is one token and appears
            // nowhere else, so there is nothing narrower to match.
            if (!is_exempt (relative, "CURLOPT_ERRORBUFFER") &&
            code.find ("CURLOPT_ERRORBUFFER") != std::string::npos) {
                offenders.push_back (relative + ": CURLOPT_ERRORBUFFER");
            }
        }
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_files, 200u) << "the guard found almost no sources";
    ASSERT_GT (scanned_bytes, 100'000u) << "the guard read empty sources";

    std::string joined;
    for (const auto& offender : offenders) {
        if (!joined.empty ()) {
            joined += "\n  ";
        }
        joined += offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "each of these is a copy of a primitive, and a copy does not receive "
       "the primitive's fixes. Parse an integer with vayu::utils::parse_number "
       "and give libcurl a vayu::http::CurlErrorBuffer, or add the file to "
       "kExempt with the token it is allowed to spell. Offenders:\n  "
    << joined;
}

TEST (BoundsPrimitives, TheGuardSeesTheSpellingsAndNotTheirNeighbours) {
    // The planted positives. Without these, a broken matcher would leave the
    // guard above passing on a tree that had brought every copy back.
    EXPECT_TRUE (tests::names_call ("std::from_chars (begin, end, value)", "from_chars"));
    EXPECT_TRUE (tests::names_call ("const auto r = from_chars(a, b, c);", "from_chars"));

    // And the calls this rule is not about. `to_chars` is the writing
    // direction and has no bound to lose; a name that merely ends in the same
    // letters is a different function.
    EXPECT_FALSE (tests::names_call ("std::to_chars (first, last, value)", "from_chars"));
    EXPECT_FALSE (tests::names_call ("legacy_from_chars (begin, end, value)", "from_chars"));

    // And the stripper really does blank prose, which is what keeps the
    // exemption list to files that spell one in code.
    EXPECT_FALSE (tests::names_call (
    tests::strip_comments ("// never call std::from_chars (a, b, c) here\n"), "from_chars"));
    EXPECT_TRUE (tests::names_call (
    tests::strip_comments ("/* see below */ std::from_chars (a, b, c);\n"), "from_chars"));
}

} // namespace
} // namespace vayu
