/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/argument_rules_test.cpp
 * @brief What each argument loop does with an argument it cannot act on (#1031).
 *
 * Three rules, and the tests below are per rule *per loop* rather than on the
 * helper under them, because a rule is only worth what the loop wired to it is:
 * a flag reading the wrong helper, or none, is exactly the defect these replace
 * and it is invisible from underneath.
 *
 * Each rule is here because it was silent, and each was measured on the real
 * binaries before the fix:
 *
 * - `vayu-engine --data-dir . --port` listened on the default 9876 and said
 *   nothing, so a flag that was typed had no effect and left no trace.
 * - `vayu-engine --data-dir --port 9999` took the string `--port` as the data
 *   directory and *created* it - `--port/db/vayu.db`, `--port/logs/`,
 *   `--port/vayu.lock` - then listened on 9876, because `9999` matched nothing
 *   afterwards and was dropped in turn. This is the one that does damage,
 *   because it succeeds.
 * - `vayu-engine --prot 9999` ran on 9876; `vayu-cli --prot 9999` printed
 *   nothing and exited 0. A typo was indistinguishable from no flag.
 *
 * The loops take `std::span<char* const>`, the shape `main` hands them, so the
 * fixture below builds one from string literals rather than the tests each
 * spelling a `char*` array.
 */

#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "optional_assert.hpp"
#include "vayu/core/cli_args.hpp"
#include "vayu/core/daemon_args.hpp"

namespace vayu {
namespace {

/// An argument vector with the program name in front, owned for as long as the
/// span is read. `argv` is `char* const`, not `const char*`, so the strings are
/// copied into buffers this holds rather than pointed at literals.
class ArgumentVector {
    public:
    explicit ArgumentVector (std::initializer_list<std::string_view> arguments) {
        storage_.emplace_back ("vayu-test");
        for (const auto& argument : arguments) {
            storage_.emplace_back (argument);
        }
        pointers_.reserve (storage_.size ());
        for (auto& entry : storage_) {
            pointers_.push_back (entry.data ());
        }
    }

    std::span<char* const> span () const {
        return { pointers_.data (), pointers_.size () };
    }

    private:
    std::vector<std::string> storage_;
    std::vector<char*> pointers_;
};

core::DaemonArgs seeded_daemon_args () {
    core::DaemonArgs args;
    args.data_dir = "seeded";
    return args;
}

// ---------------------------------------------------------------------------
// Rule 1 - a flag that takes a value, given none
// ---------------------------------------------------------------------------

TEST (ArgumentRulesTest, DaemonRefusesAValueFlagWithNothingAfterIt) {
    for (const auto* flag : { "--port", "-p", "--data-dir", "-d" }) {
        auto parsed = seeded_daemon_args ();
        const ArgumentVector args ({ flag });
        const auto request = core::read_daemon_args (args.span (), parsed);

        ASSERT_FALSE (request.has_value ()) << flag << " was accepted with no value";
        EXPECT_NE (request.error ().find ("nothing follows it"), std::string::npos)
        << request.error ();
        // The default must not quietly stand: that is what made the missing
        // value invisible.
        EXPECT_EQ (parsed.data_dir, "seeded");
    }
}

TEST (ArgumentRulesTest, CliRefusesAValueFlagWithNothingAfterIt) {
    for (const auto* flag : { "--daemon", "run" }) {
        core::CliOptions options;
        const ArgumentVector args ({ flag });
        const auto request = core::read_cli_flags (args.span (), options);

        ASSERT_FALSE (request.has_value ()) << flag << " was accepted with no value";
        EXPECT_NE (request.error ().find (flag), std::string::npos) << request.error ();
        EXPECT_NE (request.error ().find ("nothing follows it"), std::string::npos)
        << request.error ();
    }
}

TEST (ArgumentRulesTest, AnOptionalLevelIsNotAMissingValue) {
    // `--verbose` takes its level optionally, so rule 1 must not reach it -
    // `-v` last on the line is verbose at the default, as it has always been.
    for (const auto* flag : { "-v", "--verbose" }) {
        auto parsed = seeded_daemon_args ();
        const ArgumentVector args ({ flag });
        const auto request = core::read_daemon_args (args.span (), parsed);

        ASSERT_HAS_VALUE (request) << request.error ();
        EXPECT_EQ (parsed.verbosity, 1);
    }

    core::CliOptions options;
    const ArgumentVector cli_args ({ "--verbose" });
    ASSERT_HAS_VALUE (core::read_cli_flags (cli_args.span (), options));
    EXPECT_EQ (options.verbosity, 1);
}

// ---------------------------------------------------------------------------
// Rule 2 - a value that reads as another flag
// ---------------------------------------------------------------------------

TEST (ArgumentRulesTest, DaemonRefusesAValueThatReadsAsAnotherFlag) {
    // The reproduction from the issue: this used to create a data directory
    // called `--port`, with a database in it, and then listen on 9876.
    auto parsed = seeded_daemon_args ();
    const ArgumentVector args ({ "--data-dir", "--port", "9999" });
    const auto request = core::read_daemon_args (args.span (), parsed);

    ASSERT_FALSE (request.has_value ());
    EXPECT_NE (request.error ().find ("--data-dir"), std::string::npos)
    << request.error ();
    EXPECT_NE (request.error ().find ("--port"), std::string::npos) << request.error ();
    EXPECT_EQ (parsed.data_dir, "seeded")
    << "the flag was taken as a directory anyway";
}

TEST (ArgumentRulesTest, CliRefusesAValueThatReadsAsAnotherFlag) {
    // `vayu-cli --daemon run req.json` set the daemon URL to the string "run",
    // left the command empty, printed nothing and exited 0.
    core::CliOptions options;
    const ArgumentVector args ({ "--daemon", "--no-color" });
    const auto request = core::read_cli_flags (args.span (), options);

    ASSERT_FALSE (request.has_value ());
    EXPECT_NE (request.error ().find ("--daemon"), std::string::npos) << request.error ();
    EXPECT_NE (request.error ().find ("--no-color"), std::string::npos)
    << request.error ();
}

TEST (ArgumentRulesTest, ANumericFlagKeepsItsOwnBetterRefusal) {
    // `--port` needs rule 1, not rule 2: `parse_numeric_flag` already refuses a
    // flag-shaped value, and it can name the range while doing it. The message
    // a user sees for `--port --data-dir` should be the numeric one.
    auto parsed = seeded_daemon_args ();
    const ArgumentVector args ({ "--port", "--data-dir", "." });
    const auto request = core::read_daemon_args (args.span (), parsed);

    ASSERT_FALSE (request.has_value ());
    EXPECT_EQ (request.error (),
    "--port expects a number between 1 and 65535, got \"--data-dir\"");
}

// ---------------------------------------------------------------------------
// Rule 3 - an argument that matches nothing
// ---------------------------------------------------------------------------

TEST (ArgumentRulesTest, DaemonRefusesAnUnknownArgument) {
    auto parsed = seeded_daemon_args ();
    const ArgumentVector args ({ "--prot", "9999" });
    const auto request = core::read_daemon_args (args.span (), parsed);

    ASSERT_FALSE (request.has_value ()) << "a mistyped flag was dropped again";
    EXPECT_NE (request.error ().find ("--prot"), std::string::npos) << request.error ();
    EXPECT_NE (request.error ().find ("--help"), std::string::npos) << request.error ();
    EXPECT_EQ (parsed.port, vayu::core::constants::defaults::PORT);
}

TEST (ArgumentRulesTest, CliRefusesAnUnknownArgument) {
    core::CliOptions options;
    const ArgumentVector args ({ "run", "req.json", "--prot", "9999" });
    const auto request = core::read_cli_flags (args.span (), options);

    ASSERT_FALSE (request.has_value ());
    EXPECT_NE (request.error ().find ("--prot"), std::string::npos) << request.error ();
    EXPECT_NE (request.error ().find ("--help"), std::string::npos) << request.error ();
}

TEST (ArgumentRulesTest, TheCommandItselfIsLeftToTheDispatch) {
    // An unrecognised *command* is not this loop's to refuse: `run_cli` names it
    // and points at `--help` already, and a refusal here would take that over
    // with a worse sentence.
    core::CliOptions options;
    const ArgumentVector args ({ "frobnicate" });
    const auto request = core::read_cli_flags (args.span (), options);

    ASSERT_HAS_VALUE (request) << request.error ();
    EXPECT_EQ (*request, core::CliRequest::Continue);
}

// ---------------------------------------------------------------------------
// What the rules must not have broken
// ---------------------------------------------------------------------------

TEST (ArgumentRulesTest, TheDaemonStillReadsAWholeCommandLine) {
    auto parsed = seeded_daemon_args ();
    const ArgumentVector args ({ "--port", "8080", "-d", "/tmp/vayu", "-v", "2" });
    const auto request = core::read_daemon_args (args.span (), parsed);

    ASSERT_HAS_VALUE (request) << request.error ();
    EXPECT_EQ (*request, core::DaemonRequest::Continue);
    EXPECT_EQ (parsed.port, 8080);
    EXPECT_EQ (parsed.data_dir, "/tmp/vayu");
    EXPECT_EQ (parsed.verbosity, 2);
}

TEST (ArgumentRulesTest, TheCliStillReadsAWholeCommandLine) {
    core::CliOptions options;
    options.command = "run";
    const ArgumentVector args ({ "run", "req.json", "--daemon",
    "http://127.0.0.1:9999", "--no-color", "--verbose", "2" });
    const auto request = core::read_cli_flags (args.span (), options);

    ASSERT_HAS_VALUE (request) << request.error ();
    EXPECT_EQ (*request, core::CliRequest::Continue);
    EXPECT_EQ (options.filepath, "req.json");
    EXPECT_EQ (options.daemon_url, "http://127.0.0.1:9999");
    EXPECT_FALSE (options.color);
    EXPECT_EQ (options.verbosity, 2);
}

TEST (ArgumentRulesTest, RunWithNoPathLeavesTheFilepathForTheDispatchToReport) {
    // The trailing catch-all this replaced claimed the word `run` itself as the
    // filepath, so `vayu-cli run` answered "Failed to open file: run" and left
    // `run_cli`'s own "Missing request file" branch unreachable.
    core::CliOptions options;
    options.command = "run";
    const ArgumentVector args ({ "run" });
    const auto request = core::read_cli_flags (args.span (), options);

    ASSERT_FALSE (request.has_value ());
    EXPECT_EQ (options.filepath, "")
    << "the command word was taken as its own argument";
}

TEST (ArgumentRulesTest, HelpAndVersionAreRequestsRatherThanOutput) {
    auto parsed = seeded_daemon_args ();
    const ArgumentVector help ({ "--help" });
    const auto daemon_request = core::read_daemon_args (help.span (), parsed);
    ASSERT_HAS_VALUE (daemon_request) << daemon_request.error ();
    EXPECT_EQ (*daemon_request, core::DaemonRequest::Help);

    core::CliOptions options;
    const ArgumentVector version ({ "--version" });
    const auto cli_request = core::read_cli_flags (version.span (), options);
    ASSERT_HAS_VALUE (cli_request) << cli_request.error ();
    EXPECT_EQ (*cli_request, core::CliRequest::Version);
}

TEST (ArgumentRulesTest, AnEmptyValueIsAValueRatherThanAMissingOne) {
    // `--daemon ""` is a value, badly chosen, and belongs to whatever validates
    // it downstream - the distinction `read_flag_value` keeps deliberately.
    core::CliOptions options;
    const ArgumentVector args ({ "--daemon", "" });
    const auto request = core::read_cli_flags (args.span (), options);

    ASSERT_HAS_VALUE (request) << request.error ();
    EXPECT_EQ (options.daemon_url, "");
}

} // namespace
} // namespace vayu
