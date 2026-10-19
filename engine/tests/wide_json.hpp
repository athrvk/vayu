#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/wide_json.hpp
 * @brief The input that tells a linear JSON parse from a quadratic one (#2497).
 *
 * `nlohmann::ordered_json::parse` scans every member already read to place the
 * next, so one object of 100,000 short keys (about a megabyte) costs tens of
 * seconds there and well under one second in `utils::parse_ordered_json`. A
 * test that sends this through an entry point and compares the time to
 * `LINEAR_PARSE_BUDGET` fails if that entry point parses with the quadratic one.
 */

#include <chrono>
#include <cstddef>
#include <string>

namespace vayu::tests {

/// Generous for a linear parse in a Debug build; the quadratic one is far past it.
inline constexpr auto LINEAR_PARSE_BUDGET = std::chrono::seconds (5);

/// How many members `wide_object_json` writes.
inline constexpr size_t WIDE_OBJECT_KEYS = 100'000;

/// `{"k0":0,"k1":1,...}` with @p keys distinct members, in that order.
[[nodiscard]] inline std::string wide_object_json (size_t keys = WIDE_OBJECT_KEYS) {
    std::string body = "{";
    for (size_t i = 0; i < keys; ++i) {
        const std::string n = std::to_string (i);
        body += i == 0 ? "\"k" : ",\"k";
        body += n;
        body += "\":";
        body += n;
    }
    body += "}";
    return body;
}

} // namespace vayu::tests
