#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/daemon_args.hpp
 * @brief What `vayu-engine`'s argument vector says to do (#1031).
 *
 * Moved out of `daemon.cpp` so it can be *called*: the loop is where every rule
 * in #1031 is either applied or not, and a test that reaches only the helpers
 * under it cannot tell a flag wired to the wrong reader from one wired to the
 * right one. `daemon.cpp` keeps what a parse should not own - printing, and the
 * exit code - so this answers with a decision rather than with `std::cout`.
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

/// What the daemon was asked to run with. Seeded by the caller, because the
/// data directory's default is a platform path this header has no business
/// knowing.
struct DaemonArgs {
    int port = vayu::core::constants::defaults::PORT;
    /// 0=warn/error, 1=info+, 2=debug+
    int verbosity = 0;
    std::string data_dir;
};

/// What the argument vector asked for, when it did not ask for a run.
enum class DaemonRequest : std::uint8_t {
    /// Carry on with what @ref DaemonArgs now holds.
    Continue,
    /// `-h` / `--help`: print the usage and stop, successfully.
    Help,
};

namespace detail {

/// `-p` / `--port <PORT>`. Rule 1 only: a flag-shaped value is refused by the
/// parse, which says the same thing and can name the range while doing it.
inline std::expected<void, std::string>
read_port_flag (std::span<char* const> args, size_t& i, DaemonArgs& out) {
    const auto next = argument_after (args, i);
    if (!next) {
        return std::unexpected (missing_value_error (PORT_FLAG.name, "a port number"));
    }
    const auto port = parse_numeric_flag (PORT_FLAG, *next);
    if (!port) {
        return std::unexpected (port.error ());
    }
    out.port = *port;
    ++i;
    return {};
}

/// `-d` / `--data-dir <DIR>`.
inline std::expected<void, std::string>
read_data_dir_flag (std::span<char* const> args, size_t& i, DaemonArgs& out) {
    const auto value =
    read_flag_value ("--data-dir", "a directory", argument_after (args, i));
    if (!value) {
        return std::unexpected (value.error ());
    }
    out.data_dir = *value;
    ++i;
    return {};
}

/// `-v` / `--verbose [LEVEL]`. The level is optional, so an absent one is the
/// default rather than the missing value rule 1 refuses.
inline std::expected<void, std::string>
read_verbosity_flag (std::span<char* const> args, size_t& i, DaemonArgs& out) {
    if (!next_is_a_level (args, i)) {
        out.verbosity = 1;
        return {};
    }
    const auto level = parse_numeric_flag (VERBOSITY_FLAG, args[i + 1]);
    if (!level) {
        return std::unexpected (level.error ());
    }
    out.verbosity = *level;
    ++i;
    return {};
}

} // namespace detail

/**
 * @brief Read @p args onto @p out.
 *
 * @return what to do next, or the line to print on stderr before exiting 1.
 *         Every argument is either acted on or refused - nothing is dropped.
 */
inline std::expected<DaemonRequest, std::string>
read_daemon_args (std::span<char* const> args, DaemonArgs& out) {
    for (size_t i = 1; i < args.size (); ++i) {
        const std::string_view arg = args[i];
        std::expected<void, std::string> outcome;

        if (arg == vayu::core::constants::cli::ARG_PORT_SHORT ||
        arg == vayu::core::constants::cli::ARG_PORT_LONG) {
            outcome = detail::read_port_flag (args, i, out);
        } else if (arg == "-d" || arg == "--data-dir") {
            outcome = detail::read_data_dir_flag (args, i, out);
        } else if (arg == "-v" || arg == "--verbose") {
            outcome = detail::read_verbosity_flag (args, i, out);
        } else if (arg == "-h" || arg == "--help") {
            return DaemonRequest::Help;
        } else {
            outcome = std::unexpected (unknown_argument_error (arg, "vayu-engine"));
        }

        if (!outcome) {
            return std::unexpected (outcome.error ());
        }
    }
    return DaemonRequest::Continue;
}

} // namespace vayu::core
