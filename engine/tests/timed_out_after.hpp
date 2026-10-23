#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/timed_out_after.hpp
 * @brief The deadline a transfer actually ran under, read off libcurl's
 *        timeout message.
 *
 * libcurl reports `CURLE_OPERATION_TIMEDOUT` as "Operation timed out after
 * 503 milliseconds with 0 bytes received", and that number is the timeout the
 * transfer was given plus however late the check ran. Asserting it pins which
 * timeout applied, where the elapsed wall clock of the whole call would also
 * count the script runtime and the server around it.
 */

#include <cstdint>
#include <optional>
#include <regex>
#include <string>

#include "vayu/utils/parse.hpp"

namespace vayu::tests {

/// The milliseconds a libcurl timeout message in @p text reports, or nothing
/// when @p text holds no such message.
[[nodiscard]] inline std::optional<int64_t> timed_out_after_ms (const std::string& text) {
    static const std::regex pattern (R"(timed out after (\d+) milliseconds)");
    std::smatch match;
    if (!std::regex_search (text, match, pattern)) {
        return std::nullopt;
    }
    return vayu::utils::parse_number<int64_t> (match[1].str ());
}

} // namespace vayu::tests
