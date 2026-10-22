/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/request_body_parse_scan_test.cpp
 * @brief The guard behind `parse_request_json` (#2671): no handler under
 *        `src/http/routes` parses a request body with a bare
 *        `nlohmann::json::parse`.
 *
 * `request_body_depth_test.cpp` proves each adopted route refuses a body
 * nested 100,000 levels; this scan is what notices the next route that does
 * not adopt the helper at all, since a new handler is a route no test names.
 * The one parse that may read request text lives in `http/routes.hpp`, outside
 * the tree scanned. A stored column or a snapshot (`blob`, `row.*`,
 * `summary_json`, `snapshot`) is the engine's own text and is not matched.
 */

#include <cctype>
#include <cstddef>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"

namespace {

/// The expressions that name the request text a handler was given: the
/// `httplib::Request` member, and the parameter the testable cores take it as.
constexpr std::string_view kRequestTextNames[] = { "req.body", "request_body", "body" };

bool is_identifier_char (char c) {
    return (std::isalnum (static_cast<unsigned char> (c)) != 0) || c == '_';
}

std::string_view skip_spaces (std::string_view text) {
    while (!text.empty () &&
    (std::isspace (static_cast<unsigned char> (text.front ())) != 0)) {
        text.remove_prefix (1);
    }
    return text;
}

/// Whether @p arguments (the text after a call's opening parenthesis) begins
/// with one of the request-text names as a whole word, so `body_text` is not
/// `body`.
bool begins_with_request_text (std::string_view arguments) {
    for (const std::string_view name : kRequestTextNames) {
        if (arguments.substr (0, name.size ()) != name) {
            continue;
        }
        const auto rest = arguments.substr (name.size ());
        if (rest.empty () || !is_identifier_char (rest.front ())) {
            return true;
        }
    }
    return false;
}

/**
 * @brief Whether @p code passes request text straight to a `json::parse`.
 *
 * `json::parse` is matched as a suffix so `nlohmann::json::parse`,
 * `ordered_json::parse` and a file's own `using json = ...` alias are all the
 * same call. The repository's clang-format puts a space before the argument
 * list and lets a call wrap, so whitespace is skipped on both sides of the
 * parenthesis.
 */
bool parses_request_text (const std::string& code) {
    constexpr std::string_view kCall = "json::parse";
    for (std::size_t at = code.find (kCall); at != std::string::npos;
    at                  = code.find (kCall, at + 1)) {
        const auto after_name =
        skip_spaces (std::string_view (code).substr (at + kCall.size ()));
        if (after_name.empty () || after_name.front () != '(') {
            continue;
        }
        if (begins_with_request_text (skip_spaces (after_name.substr (1)))) {
            return true;
        }
    }
    return false;
}

TEST (RequestBodyParseScan, NoRouteParsesItsBodyWithoutTheHelper) {
    const std::filesystem::path tree =
    std::filesystem::path{ VAYU_ENGINE_SOURCE_DIR } / "src" / "http" / "routes";
    ASSERT_TRUE (std::filesystem::is_directory (tree))
    << tree.string () << " is not where the guard looks";

    std::size_t scanned_files = 0;
    std::size_t scanned_bytes = 0;
    std::vector<std::string> offenders;
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
        if (parses_request_text (code)) {
            offenders.push_back (relative);
        }
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_files, 30U) << "the guard found almost no route sources";
    ASSERT_GT (scanned_bytes, 500'000U)
    << "the guard read almost no route code";

    std::string joined;
    for (const auto& offender : offenders) {
        joined += "\n  " + offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "a request body parsed with a bare json::parse is not depth-bounded: "
       "nlohmann parses a body nested 100,000 levels, and the first dump () "
       "or copy of it overflows the stack. Read it with parse_request_json "
       "and answer refuse_request_body (or as_response from a core). "
       "Offenders:"
    << joined;
}

// The matcher is pinned on planted text, kept out of the scan above: a broken
// matcher would otherwise leave that scan passing on a tree that had brought
// every raw parse back.
TEST (RequestBodyParseScan, TheMatcherSeesARequestBodyParseAndNotAStoredColumn) {
    for (const char* parse : {
         "auto json = nlohmann::json::parse (req.body);",
         "auto json = nlohmann::json::parse(req.body);",
         "json = nlohmann::json::parse (request_body);",
         "parsed = nlohmann::json::parse (body);",
         "parsed = nlohmann::json::parse (body, nullptr, false);",
         "x = nlohmann::ordered_json::parse (req.body);",
         "x = json::parse   (   req.body );",
         "x = nlohmann::json::parse (\n    req.body);",
         "x = nlohmann::json::parse\n(body);",
         }) {
        EXPECT_TRUE (parses_request_text (parse)) << parse;
    }

    for (const char* parse : {
         "nlohmann::json::parse (blob, nullptr, false)",
         "nlohmann::json::parse (row.config_snapshot, nullptr, false)",
         "nlohmann::json::parse (summary_json)",
         "nlohmann::json::parse (snapshot)",
         "nlohmann::json::parse (sanitized)",
         "nlohmann::json::parse (stored->variables, nullptr, false)",
         "nlohmann::json::parse (*entry.options)",
         "nlohmann::json::parse (g.body_text)",
         "nlohmann::json::parse (body_text)",
         "nlohmann::json::parse (request_body_copy)",
         "nlohmann::json::parse (the_body)",
         "auto json = parse_request_json (req.body);",
         "const auto parsed = parse_request_json (body);",
         "nlohmann::json::parse_error",
         "json::parser (body)",
         "if (req.body.empty ()) { return; }",
         }) {
        EXPECT_FALSE (parses_request_text (parse)) << parse;
    }

    // Prose that names the old spelling is not a parse.
    EXPECT_FALSE (parses_request_text (vayu::tests::strip_comments (
    "// never nlohmann::json::parse (req.body) here\n")));
    EXPECT_TRUE (parses_request_text (vayu::tests::strip_comments (
    "/* see below */ nlohmann::json::parse (req.body);\n")));
}

} // namespace
