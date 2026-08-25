#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/source_scan.hpp
 * @brief Reading the engine's own sources back, for the rules no behavioural
 *        test can see.
 *
 * A handful of rules here are about what the code *says* rather than what it
 * does: the version string staying out of the hub headers (#659), the
 * mt-unsafe C calls staying out of `src` (#945). Both are invisible to a
 * running test - the wrong code works, it just costs a full rebuild once a
 * release, or hands one thread another's error message - so both are scanned
 * for instead.
 *
 * Two disciplines every scan built on this owes, because a source scan fails
 * open: assert it read something (a guard reading an empty string passes
 * forever - one in the app suite did for weeks), and pin the matcher with a
 * planted positive, so blanking the input cannot be mistaken for a clean tree.
 */

#include <cctype>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>

namespace vayu::tests {

/// The whole of @p path as a string, empty if it could not be read - which the
/// caller is expected to assert on rather than skip past.
inline std::string read_source (const std::filesystem::path& path) {
    std::ifstream file (path);
    std::stringstream buffer;
    buffer << file.rdbuf ();
    return buffer.str ();
}

/**
 * @p source with `//` and block comments blanked out.
 *
 * Needed rather than fussy: these rules are *documented* in the very files they
 * police - `constants.hpp` explains why it does not include
 * `vayu/version.hpp`, `transport_policy.cpp` explains why its one `getenv`
 * stays - so a raw substring scan reports the explanation and the only way to
 * quiet it is to delete it. Scanning code and not prose is the honest version.
 *
 * Newlines are preserved so the remaining text keeps its shape. String literals
 * are not modelled: no scanned file opens a comment of either kind inside one,
 * and the failure mode if one appeared would be over-stripping - a lenient
 * guard, which is what each scan's planted-positive test catches.
 */
inline std::string strip_comments (const std::string& source) {
    std::string out;
    out.reserve (source.size ());
    enum class State { Code, Line, Block };
    State state = State::Code;

    for (size_t i = 0; i < source.size (); ++i) {
        const char c    = source[i];
        const char next = i + 1 < source.size () ? source[i + 1] : '\0';
        switch (state) {
        case State::Code:
            if (c == '/' && next == '/') {
                state = State::Line;
                ++i;
            } else if (c == '/' && next == '*') {
                state = State::Block;
                ++i;
            } else {
                out.push_back (c);
            }
            break;
        case State::Line:
            if (c == '\n') {
                state = State::Code;
                out.push_back (c);
            }
            break;
        case State::Block:
            if (c == '*' && next == '/') {
                state = State::Code;
                ++i;
            } else if (c == '\n') {
                out.push_back (c);
            }
            break;
        }
    }
    return out;
}

/**
 * @brief Whether @p code calls @p function by exactly that name.
 *
 * The name has to be bounded on both sides, which a plain `find` is not:
 * `strerror` appears inside `curl_easy_strerror` and `localtime` inside
 * `localtime_r`, and reporting either would make the rule unstatable. A
 * `std::` or `::` qualifier is left of the name and so does not interfere.
 * The repository's clang-format puts a space before the argument list, so the
 * open parenthesis is looked for past any run of spaces.
 */
inline bool names_call (const std::string& code, std::string_view function) {
    const auto is_identifier_char = [] (char c) {
        return (std::isalnum (static_cast<unsigned char> (c)) != 0) || c == '_';
    };

    for (size_t at = code.find (function); at != std::string::npos;
    at             = code.find (function, at + 1)) {
        if (at > 0 && is_identifier_char (code[at - 1])) {
            continue; // curl_easy_strerror, and every other longer name
        }
        size_t after = at + function.size ();
        if (after < code.size () && is_identifier_char (code[after])) {
            continue; // localtime_r, localtime_s
        }
        while (after < code.size () && code[after] == ' ') {
            ++after;
        }
        if (after < code.size () && code[after] == '(') {
            return true;
        }
    }
    return false;
}

} // namespace vayu::tests
