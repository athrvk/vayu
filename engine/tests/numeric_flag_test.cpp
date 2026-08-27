/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/numeric_flag_test.cpp
 * @brief The numeric command-line flags and what each accepts (issue #1028),
 *        and the guard that keeps `std::stoi` out of the two argument loops.
 *
 * `--port notanumber` used to answer `vayu-engine: stoi` - the name of the
 * function that threw - and, before the daemon had a top-level handler at all,
 * to abort with no message. Both are the same missing check: the text after a
 * flag went to `std::stoi` without anyone asking whether it was a number, or
 * one of the numbers that flag takes.
 *
 * The behavioural half below is per flag, because the range is the part a user
 * needs and the part that can silently be wrong: `--port 99999` parsed fine and
 * failed later at bind time, and `--verbose 5` was clamped to 2 without saying
 * so. Each flag is described once in `core/numeric_flag.hpp`, so these tests
 * and the argument loops read the same description rather than two copies of
 * it that can drift.
 *
 * The scanning half is for what no behavioural test reaches: a *new* `std::stoi`
 * arriving in either loop later. It is deliberately narrow - the engine parses
 * integers out of stored config, imported documents and libcurl's replies in
 * other places, and `std::stoi` is a reasonable answer there - so the rule is
 * about the two files that read a human's arguments, not about the tree.
 */

#include <array>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"
#include "vayu/core/numeric_flag.hpp"

namespace vayu {
namespace {

using core::parse_numeric_flag;
using core::PORT_FLAG;
using core::VERBOSITY_FLAG;

/// Every refusal has to carry the three things the old `stoi` message did not.
void expect_names_flag_value_and_range (const std::string& message,
const core::NumericFlag& flag,
std::string_view value) {
    EXPECT_NE (message.find (flag.name), std::string::npos) << message;
    EXPECT_NE (message.find (std::string (value)), std::string::npos) << message;
    EXPECT_NE (message.find (std::to_string (flag.min)), std::string::npos) << message;
    EXPECT_NE (message.find (std::to_string (flag.max)), std::string::npos) << message;
}

// ---------------------------------------------------------------------------
// --port
// ---------------------------------------------------------------------------

TEST (NumericFlagTest, PortTakesEveryPortAndItsEnds) {
    EXPECT_EQ (parse_numeric_flag (PORT_FLAG, "9876").value (), 9876);
    EXPECT_EQ (parse_numeric_flag (PORT_FLAG, "1").value (), 1);
    EXPECT_EQ (parse_numeric_flag (PORT_FLAG, "65535").value (), 65535);
}

TEST (NumericFlagTest, PortRefusesAValueThatIsNotANumber) {
    const auto parsed = parse_numeric_flag (PORT_FLAG, "notanumber");
    ASSERT_FALSE (parsed.has_value ());
    expect_names_flag_value_and_range (parsed.error (), PORT_FLAG, "notanumber");

    // The mistake `std::stoi` made quietly rather than loudly: a number with a
    // tail was the number, so a typo became a different port.
    const auto partial = parse_numeric_flag (PORT_FLAG, "9876x");
    ASSERT_FALSE (partial.has_value ());
    expect_names_flag_value_and_range (partial.error (), PORT_FLAG, "9876x");

    EXPECT_FALSE (parse_numeric_flag (PORT_FLAG, "").has_value ());
    EXPECT_FALSE (parse_numeric_flag (PORT_FLAG, " 80").has_value ());
    EXPECT_FALSE (parse_numeric_flag (PORT_FLAG, "+80").has_value ());
}

TEST (NumericFlagTest, PortRefusesAValueOutsideTheRange) {
    // Parsed fine and then failed at bind time, which is a worse place to learn
    // it - the whole reason the range is checked here.
    const auto high = parse_numeric_flag (PORT_FLAG, "99999");
    ASSERT_FALSE (high.has_value ());
    expect_names_flag_value_and_range (high.error (), PORT_FLAG, "99999");

    EXPECT_FALSE (parse_numeric_flag (PORT_FLAG, "65536").has_value ());
    EXPECT_FALSE (parse_numeric_flag (PORT_FLAG, "0").has_value ());
    EXPECT_FALSE (parse_numeric_flag (PORT_FLAG, "-1").has_value ());

    // Wider than `int`: `std::stoi` answered this one with `std::out_of_range`,
    // which reached the user as the word "stoi" like every other failure.
    EXPECT_FALSE (parse_numeric_flag (PORT_FLAG, "99999999999999999999").has_value ());
}

// ---------------------------------------------------------------------------
// --verbose
// ---------------------------------------------------------------------------

TEST (NumericFlagTest, VerbosityTakesTheThreeLevelsTheLoggerHas) {
    EXPECT_EQ (parse_numeric_flag (VERBOSITY_FLAG, "0").value (), 0);
    EXPECT_EQ (parse_numeric_flag (VERBOSITY_FLAG, "1").value (), 1);
    EXPECT_EQ (parse_numeric_flag (VERBOSITY_FLAG, "2").value (), 2);
}

TEST (NumericFlagTest, VerbosityRefusesAValueThatIsNotANumber) {
    // Both loops decide "was a level meant at all?" on a leading digit, so what
    // reaches this parse is a value that was meant as one - `1abc` is a
    // mistyped level, and used to be read as level 1.
    const auto parsed = parse_numeric_flag (VERBOSITY_FLAG, "1abc");
    ASSERT_FALSE (parsed.has_value ());
    expect_names_flag_value_and_range (parsed.error (), VERBOSITY_FLAG, "1abc");
}

TEST (NumericFlagTest, VerbosityRefusesALevelThatDoesNotExist) {
    // Clamped to 2 before, which answered a user who asked for something the
    // logger does not have by silently giving them something else.
    const auto parsed = parse_numeric_flag (VERBOSITY_FLAG, "5");
    ASSERT_FALSE (parsed.has_value ());
    expect_names_flag_value_and_range (parsed.error (), VERBOSITY_FLAG, "5");

    EXPECT_FALSE (parse_numeric_flag (VERBOSITY_FLAG, "3").has_value ());
    EXPECT_FALSE (parse_numeric_flag (VERBOSITY_FLAG, "-1").has_value ());
}

TEST (NumericFlagTest, TheMessageIsTheOneAUserCanActOn) {
    // Named in full rather than only probed, because the shape of this sentence
    // is the fix: the flag, the range and the value, where `stoi` was.
    EXPECT_EQ (parse_numeric_flag (PORT_FLAG, "notanumber").error (),
    "--port expects a number between 1 and 65535, got \"notanumber\"");
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/// The two files that read a human's arguments. Everywhere else in the engine
/// parses integers out of its own stored data, where a throwing parse has no
/// user to confuse.
constexpr std::array<std::string_view, 2> kArgumentLoops = { {
"src/daemon.cpp",
"src/cli.cpp",
} };

TEST (NumericFlagTest, TheArgumentLoopsDoNotThrowIntegersAtTheUser) {
    const std::filesystem::path root{ VAYU_ENGINE_SOURCE_DIR };
    std::vector<std::string> offenders;
    std::size_t scanned_bytes = 0;

    for (const auto& relative : kArgumentLoops) {
        const auto path = root / relative;
        ASSERT_TRUE (std::filesystem::is_regular_file (path))
        << path.string () << " is not where the guard looks";

        const std::string code = tests::strip_comments (tests::read_source (path));
        ASSERT_FALSE (code.empty ()) << relative << " read as empty";
        scanned_bytes += code.size ();

        for (const auto* thrower : { "stoi", "stol", "stoll", "atoi" }) {
            if (tests::names_call (code, thrower)) {
                offenders.push_back (std::string (relative) + ": " + thrower);
            }
        }
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_bytes, 10'000u) << "the guard read empty sources";

    std::string joined;
    for (const auto& offender : offenders) {
        if (!joined.empty ()) {
            joined += "\n  ";
        }
        joined += offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "each of these throws the name of a function at whoever mistyped a "
       "flag, and accepts a partial number besides. Describe the flag in "
       "core/numeric_flag.hpp and read it with parse_numeric_flag. "
       "Offenders:\n  "
    << joined;
}

TEST (NumericFlagTest, TheGuardSeesTheCallsAndNotTheirNeighbours) {
    // The planted positives. Without these, a broken matcher would leave the
    // guard above passing on a loop that had brought every `stoi` back.
    EXPECT_TRUE (tests::names_call ("port = std::stoi (args[++i]);", "stoi"));
    EXPECT_TRUE (tests::names_call ("auto v = stoi(text);", "stoi"));

    // And the names that merely contain one. `std::stoul` is a different
    // function, and a variable is not a call at all.
    EXPECT_FALSE (tests::names_call ("std::stoul (text)", "stoi"));
    EXPECT_FALSE (tests::names_call ("const int stoic = 3;", "stoi"));

    // And prose really is blanked, which is what lets these files explain the
    // rule they are held to.
    EXPECT_FALSE (tests::names_call (
    tests::strip_comments ("// never std::stoi (text) here\n"), "stoi"));
}

} // namespace
} // namespace vayu
