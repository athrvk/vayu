/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/user_error_wording_scan_test.cpp
 * @brief The guard behind the voice of a route's refusal (#2295): no text a
 *        handler can hand a client opens "Failed to" or "Could not".
 *
 * The app shows an engine message beneath its own "Couldn't ..." heading, so a
 * body that opens "Could not bind ..." reads as two voices in one sentence
 * (`docs/ux-writing.md`). A route builds its text in the statement that
 * answers, or in a local the answer reads later (`mock_issuer.cpp`'s bind
 * message), so the scan reads every statement under `src/http/routes` and
 * exempts only the two kinds that never reach a client: a log call and a
 * `throw`, whose wording stays in the engine's own voice.
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

TEST (UserErrorWordingScan, NoRouteAnswersInTheEnginesOwnVoice) {
    const std::filesystem::path tree =
    std::filesystem::path{ VAYU_ENGINE_SOURCE_DIR } / "src" / "http" / "routes";
    ASSERT_TRUE (std::filesystem::is_directory (tree))
    << tree.string () << " is not where the guard looks";

    std::size_t scanned_files = 0;
    std::size_t scanned_bytes = 0;
    std::string offenders;
    for (const auto& entry : std::filesystem::directory_iterator (tree)) {
        if (!entry.is_regular_file () || entry.path ().extension () != ".cpp") {
            continue;
        }
        const std::string relative = entry.path ().filename ().string ();
        const std::string code =
        vayu::tests::strip_comments (vayu::tests::read_source (entry.path ()));
        ASSERT_FALSE (code.empty ()) << relative << " read as empty";
        ++scanned_files;
        scanned_bytes += code.size ();
        for (const auto& statement : engine_phrased_answers (code)) {
            offenders += "\n  ";
            offenders += relative;
            offenders += ": ";
            offenders += statement;
        }
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_files, 30U) << "the guard found almost no route sources";
    ASSERT_GT (scanned_bytes, 500'000U)
    << "the guard read almost no route code";

    EXPECT_TRUE (offenders.empty ())
    << "a route holds text opening \"Failed to\" or \"Could not\" that can "
       "reach a client; the app puts its own \"Couldn't ...\" heading above "
       "it, so open with \"Couldn't ...\" instead. Offenders:"
    << offenders;
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

} // namespace
