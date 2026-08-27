#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/cli_args.hpp
 * @brief What `vayu-cli`'s argument vector says to do (#1031).
 *
 * Moved out of `cli.cpp` for the reason `daemon_args.hpp` was moved out of
 * `daemon.cpp`: the loop is where each rule is applied, so it is the loop a
 * test has to be able to call. `--help` and `--version` become a *request* the
 * caller answers rather than something the parse prints, which is what lets the
 * usage text stay in the binary that owns it.
 */

#include <cstdint>
#include <expected>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#include "vayu/core/constants.hpp"
#include "vayu/core/flag_value.hpp"
#include "vayu/core/numeric_flag.hpp"

namespace vayu::core {

/** What the argument vector says to do, once it has been read. */
struct CliOptions {
    std::string command;
    int verbosity = 0; ///< 0=warn/error, 1=info+, 2=debug+
    bool color    = true;
    std::string filepath;
    std::string daemon_url{ vayu::core::constants::defaults::DAEMON_URL };
};

/// What the argument vector asked for, when it did not ask for a command.
enum class CliRequest : std::uint8_t {
    /// Carry on with what @ref CliOptions now holds.
    Continue,
    /// `-h` / `--help`: print the usage and stop, successfully.
    Help,
    /// `-v` / `--version`.
    Version,
};

namespace detail {

/// `--verbose [LEVEL]`. The level is optional, so a leading digit is what says
/// the next argument was meant as one at all - `--verbose run` is the command
/// with verbose on, not a bad level.
inline std::expected<void, std::string>
read_verbose_flag (std::span<char* const> args, size_t& i, CliOptions& options) {
    if (!next_is_a_level (args, i)) {
        options.verbosity = 1;
        return {};
    }
    const auto level = parse_numeric_flag (VERBOSITY_FLAG, args[i + 1]);
    if (!level) {
        return std::unexpected (level.error ());
    }
    options.verbosity = *level;
    ++i;
    return {};
}

/// `--daemon <url>`.
inline std::expected<void, std::string>
read_daemon_flag (std::span<char* const> args, size_t& i, CliOptions& options) {
    const auto value =
    read_flag_value ("--daemon", "an engine URL", argument_after (args, i));
    if (!value) {
        return std::unexpected (value.error ());
    }
    options.daemon_url = *value;
    ++i;
    return {};
}

/// `run <file>`. The command's own argument, read where the command is - not by
/// the trailing catch-all this replaced, which claimed the *first* non-flag
/// word and so answered `vayu-cli run` by reporting the word `run` as a file it
/// could not open (#1031).
inline std::expected<void, std::string>
read_run_command (std::span<char* const> args, size_t& i, CliOptions& options) {
    const auto value =
    read_flag_value ("run", "a request file path", argument_after (args, i));
    if (!value) {
        return std::unexpected (value.error ());
    }
    options.filepath = *value;
    ++i;
    return {};
}

} // namespace detail

/**
 * @brief Read @p args onto @p options.
 *
 * @return what to do next, or the line to print on stderr before exiting 1.
 *
 * `args[1]` is the command and is seeded onto @p options by the caller; the
 * loop still visits it, because a command is also how `-h` reaches this.
 */
inline std::expected<CliRequest, std::string>
read_cli_flags (std::span<char* const> args, CliOptions& options) {
    for (size_t i = 1; i < args.size (); ++i) {
        const std::string_view arg = args[i];
        std::expected<void, std::string> outcome;

        if (arg == "-h" || arg == "--help") {
            return CliRequest::Help;
        } else if (arg == "-v" || arg == "--version") {
            return CliRequest::Version;
        } else if (arg == "--no-color") {
            options.color = false;
        } else if (arg == "--verbose") {
            outcome = detail::read_verbose_flag (args, i, options);
        } else if (arg == "--daemon") {
            outcome = detail::read_daemon_flag (args, i, options);
        } else if (arg == "run") {
            outcome = detail::read_run_command (args, i, options);
        } else if (i == 1 && !looks_like_a_flag (arg)) {
            // The command sits at `args[1]` and is not this loop's to judge: an
            // unrecognised one is answered by the dispatch, which names it and
            // points at `--help`. Anything else unrecognised is refused below,
            // where it used to be dropped without a word.
        } else {
            outcome = std::unexpected (unknown_argument_error (arg, "vayu-cli"));
        }

        if (!outcome) {
            return std::unexpected (outcome.error ());
        }
    }
    return CliRequest::Continue;
}

} // namespace vayu::core
