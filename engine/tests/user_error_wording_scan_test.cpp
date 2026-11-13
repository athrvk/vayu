/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/user_error_wording_scan_test.cpp
 * @brief The guard behind the voice of the engine's own text (#2295, #3500):
 *        nothing in `engine/src` that can reach a client opens "Failed to" or
 *        "Could not".
 *
 * The app shows an engine message beneath its own "Couldn't ..." heading, so a
 * body that opens "Could not bind ..." reads as two voices in one sentence
 * (`docs/ux-writing.md`). A message is built in the statement that answers, or
 * in a local the answer reads later (`mock_issuer.cpp`'s bind message), and not
 * only under `src/http/routes`: a run's error, a backup refusal and a schema
 * verdict all travel from other directories. So the scan reads every statement
 * under `src` and exempts the two kinds that never reach a client, a log call
 * and a `throw`, whose wording stays in the engine's own voice, plus the short
 * `kAllowed` list of text that reaches no screen or must stay as written.
 */

#include <algorithm>
#include <array>
#include <cctype>
#include <cstddef>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"

namespace {

/// The openings the app's voice replaces with "Couldn't ...".
constexpr auto kEnginePhrasing =
std::to_array<std::string_view> ({ "\"Failed to", "\"Could not" });

/// What marks a statement whose text stays inside the engine.
constexpr auto kInternalOnly = std::to_array<std::string_view> (
{ "log_debug", "log_info", "log_warning", "log_error", "throw" });

/// A literal the guard leaves alone, each with the reason it is not UI copy.
struct Allowed {
    std::string_view file;    ///< path under `src`, forward slashes
    std::string_view literal; ///< how the offending literal opens, quote included
    std::string_view reason;
};

constexpr auto kAllowed = std::to_array<Allowed> ({
{ "core/schema_error_text.cpp", "\"Failed to match against any enum values.",
"compared against valijson's own message to pick the rewrite; changing it "
"would stop the rewrite matching" },
{ "core/schema_error_text.cpp", "\"Failed to match regex specified by",
"compared against valijson's own message to pick the rewrite; changing it "
"would stop the rewrite matching" },
{ "core/schema_validation.cpp", "\"Failed to validate",
"the prefixes valijson itself writes, matched to find the failing keyword; "
"never shown" },
{ "utils/logger.cpp", "\"Failed to",
"written to stderr when the log file cannot be opened; never reaches the app" },
{ "http/server.cpp", "\"Could not bind",
"daemon stderr, quoted verbatim by docs/building.md, docs/architecture.md and "
"docs/app/building.md; the app reads the exit, not this line" },
});

bool is_identifier_char (char c) {
    return (std::isalnum (static_cast<unsigned char> (c)) != 0) || c == '_';
}

bool names_identifier (std::string_view statement, std::string_view name) {
    for (std::size_t at = statement.find (name); at != std::string_view::npos;
    at                  = statement.find (name, at + 1)) {
        const bool bounded_left = at == 0 || !is_identifier_char (statement[at - 1]);
        const std::size_t end = at + name.size ();
        const bool bounded_right =
        end >= statement.size () || !is_identifier_char (statement[end]);
        if (bounded_left && bounded_right) {
            return true;
        }
    }
    return false;
}

/// Where the first engine-phrased literal in @p statement opens, or npos.
std::size_t engine_phrasing_at (std::string_view statement) {
    std::size_t first = std::string_view::npos;
    for (const std::string_view opening : kEnginePhrasing) {
        first = std::min (first, statement.find (opening));
    }
    return first;
}

bool stays_inside_the_engine (std::string_view statement) {
    for (const std::string_view name : kInternalOnly) {
        if (names_identifier (statement, name)) {
            return true;
        }
    }
    return false;
}

/**
 * @brief The text from the offending literal to the end of each statement in
 *        @p code that could reach a client opening "Failed to" or "Could not".
 *
 * A statement runs to its `;`, so a message wrapped over several lines or
 * chosen by a ternary is one unit. A literal that itself holds a `;` would
 * split early; no route message does.
 */
std::vector<std::string> engine_phrased_answers (const std::string& code) {
    std::vector<std::string> found;
    std::size_t start = 0;
    while (start < code.size ()) {
        const std::size_t end            = code.find (';', start);
        const std::string_view statement = std::string_view (code).substr (
        start, (end == std::string::npos ? code.size () : end) - start);
        const std::size_t at = engine_phrasing_at (statement);
        if (at != std::string_view::npos && !stays_inside_the_engine (statement)) {
            found.emplace_back (statement.substr (at));
        }
        if (end == std::string::npos) {
            break;
        }
        start = end + 1;
    }
    return found;
}

/// Whether @p statement, which opens at the offending literal, is one `kAllowed`
/// lists for @p file; marks that entry as used.
bool is_allowed (std::string_view file,
std::string_view statement,
std::array<bool, kAllowed.size ()>& used) {
    for (std::size_t i = 0; i < kAllowed.size (); ++i) {
        if (kAllowed.at (i).file == file &&
        statement.starts_with (kAllowed.at (i).literal)) {
            used.at (i) = true;
            return true;
        }
    }
    return false;
}

TEST (UserErrorWordingScan, NothingInTheEngineAnswersInItsOwnVoice) {
    const std::filesystem::path tree =
    std::filesystem::path{ VAYU_ENGINE_SOURCE_DIR } / "src";
    ASSERT_TRUE (std::filesystem::is_directory (tree))
    << tree.string () << " is not where the guard looks";

    std::size_t scanned_files = 0;
    std::size_t scanned_bytes = 0;
    std::size_t routes_files  = 0;
    std::array<bool, kAllowed.size ()> used{};
    std::string offenders;
    for (const auto& entry : std::filesystem::recursive_directory_iterator (tree)) {
        const std::string extension = entry.path ().extension ().string ();
        if (!entry.is_regular_file () || (extension != ".cpp" && extension != ".hpp")) {
            continue;
        }
        const std::string relative =
        std::filesystem::relative (entry.path (), tree).generic_string ();
        const std::string code =
        vayu::tests::strip_comments (vayu::tests::read_source (entry.path ()));
        ASSERT_FALSE (code.empty ()) << relative << " read as empty";
        ++scanned_files;
        scanned_bytes += code.size ();
        routes_files += relative.starts_with ("http/routes/") ? 1U : 0U;
        for (const auto& statement : engine_phrased_answers (code)) {
            if (is_allowed (relative, statement, used)) {
                continue;
            }
            offenders += "\n  ";
            offenders += relative;
            offenders += ": ";
            offenders += statement;
        }
    }

    // A scan that read nothing passes forever, so it says what it read: the
    // whole tree (171 .cpp and 20 .hpp, about 5 MB when this was written) and,
    // within it, the routes the guard began with (over 30 files, 500 KB).
    ASSERT_GT (scanned_files, 150U)
    << "the guard found almost no engine sources";
    ASSERT_GT (scanned_bytes, 3'000'000U)
    << "the guard read almost no engine code";
    ASSERT_GT (routes_files, 30U) << "the guard found almost no route sources";

    EXPECT_TRUE (offenders.empty ())
    << "the engine holds text opening \"Failed to\" or \"Could not\" that can "
       "reach a client; the app puts its own \"Couldn't ...\" heading above "
       "it, so open with \"Couldn't ...\" instead. Text that reaches no screen "
       "goes in kAllowed with its reason. Offenders:"
    << offenders;

    // An entry whose text is gone would otherwise sit there forever.
    for (std::size_t i = 0; i < kAllowed.size (); ++i) {
        EXPECT_TRUE (used.at (i))
        << kAllowed.at (i).file << " no longer holds "
        << kAllowed.at (i).literal << "; delete its kAllowed entry";
    }
}

// The matcher is pinned on planted text, kept out of the scan above: a broken
// matcher would otherwise leave that scan passing on a tree that had brought
// every breach back.
TEST (UserErrorWordingScan, TheMatcherSeesAnAnswerAndNotALogLine) {
    for (const char* breach : {
         "out.error_message = \"Could not bind a local callback port\";",
         "send_error (res, 500, \"Failed to create run record\");",
         "return { 502, error_body (502, \"Failed to fetch: \" + detail) };",
         "out.error_message = held ?\n\"Could not bind\" :\n\"Could not\";",
         "const std::string requested = \"Could not bind 127.0.0.1:\" + port;",
         }) {
        EXPECT_EQ (engine_phrased_answers (breach).size (), 1U) << breach;
    }

    for (const char* clean : {
         "out.error_message = \"Couldn't bind a local callback port\";",
         "send_error (res, 500, \"Couldn't create the run record\");",
         "return { 502, error_body (502, \"Couldn't fetch: \" + d) };",
         "log_error (\"http\", \"Failed to create run: \" + what);",
         "log_warning (\"mock\", \"Could not stop \" + id);",
         "throw std::runtime_error (\"Could not open the database\");",
         "send_error (res, 400, \"Refused to fetch: \" + why);",
         "const auto unthrown = \"Failed\";",
         }) {
        EXPECT_TRUE (engine_phrased_answers (clean).empty ()) << clean;
    }

    // The offender is reported from its literal, not from the code before it.
    const auto reported =
    engine_phrased_answers ("int x = 1; y = f (\"Could not x\");");
    ASSERT_EQ (reported.size (), 1U);
    EXPECT_EQ (reported.front ().rfind ("\"Could not x\"", 0), 0U) << reported.front ();

    // Prose that quotes the old wording is not an answer.
    EXPECT_TRUE (
    engine_phrased_answers (vayu::tests::strip_comments (
                            "// send_error (res, 500, \"Failed to x\");\n"))
    .empty ());
}

// The allowlist is keyed on file and literal together: the same words in
// another file, or another literal in an allowed file, still fail.
TEST (UserErrorWordingScan, AnAllowedLiteralIsAllowedOnlyWhereItIsListed) {
    std::array<bool, kAllowed.size ()> used{};
    EXPECT_TRUE (is_allowed ("utils/logger.cpp", "\"Failed to open log file\"", used));
    EXPECT_TRUE (std::ranges::any_of (used, [] (bool flag) { return flag; }));

    EXPECT_FALSE (is_allowed ("core/run_manager.cpp", "\"Failed to open log file\"", used));
    EXPECT_TRUE (is_allowed ("http/server.cpp", "\"Could not bind 127.0.0.1:\"", used));
    EXPECT_FALSE (is_allowed ("http/server.cpp", "\"Could not open\"", used));
}

} // namespace
