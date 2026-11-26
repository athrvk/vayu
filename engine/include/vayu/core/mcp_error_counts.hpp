#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief A run's failed `mcp` replies counted by `McpErrorClass`, and a
 *        `protocol` failure's JSON-RPC `error.code` (#3828).
 *
 * The code is the server's choice, so it is counted into a fixed table of
 * slots and never used as a key: the codes JSON-RPC 2.0 reserves (-32700,
 * -32600 to -32603), the implementation-defined server band (-32000 to -32099,
 * where MCP's own -32020 and -32022 sit), and one slot for every other code.
 * `MetricsCollector` keeps the same table in atomics for the load paths; the
 * sequential collection runner, which does not feed the collector, keeps this
 * plain copy. Both serialise through @ref McpErrorCounts::to_json.
 */

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/types.hpp"

namespace vayu::core {

struct McpErrorCounts {
    static constexpr size_t CLASS_COUNT     = 3;
    static constexpr size_t CODE_SLOT_COUNT = 106;
    static constexpr size_t OTHER_CODE_SLOT = CODE_SLOT_COUNT - 1;

    /// The slot @p code is counted in: 0 for -32700, 1-4 for -32600 to
    /// -32603, 5-104 for -32000 to -32099, @ref OTHER_CODE_SLOT for the rest.
    [[nodiscard]] static constexpr size_t code_slot (std::int64_t code) noexcept {
        if (code == -32700) {
            return 0;
        }
        if (code <= -32600 && code >= -32603) {
            return static_cast<size_t> (1 + (-32600 - code));
        }
        if (code <= -32000 && code >= -32099) {
            return static_cast<size_t> (5 + (-32000 - code));
        }
        return OTHER_CODE_SLOT;
    }

    /// The code @p slot counts, the inverse of @ref code_slot. Meaningless for
    /// @ref OTHER_CODE_SLOT, which counts many.
    [[nodiscard]] static constexpr std::int64_t slot_code (size_t slot) noexcept {
        if (slot == 0) {
            return -32700;
        }
        if (slot < 5) {
            return -32600 - static_cast<std::int64_t> (slot - 1);
        }
        return -32000 - static_cast<std::int64_t> (slot - 5);
    }

    std::array<size_t, CLASS_COUNT> classes{};
    std::array<size_t, CODE_SLOT_COUNT> protocol_codes{};

    /// One failed reply of @p error_class; @p code is counted only for a
    /// `protocol` failure, the one class that carries a JSON-RPC error.
    void record (McpErrorClass error_class, std::optional<std::int64_t> code) {
        ++classes.at (static_cast<size_t> (error_class));
        if (error_class == McpErrorClass::Protocol && code) {
            ++protocol_codes.at (code_slot (*code));
        }
    }

    /**
     * The summary's `error_classes` and the report's `summary.errorClasses`:
     * `{transport?, protocol?, tool?, protocolCodes?}`, each class and each
     * code only when counted, so a run with no failed reply is `{}`.
     * `protocolCodes` is keyed by the code as a string (`"-32602"`) and
     * `"other"`; a JSON-RPC error with no integer `code` is in `protocol`
     * and no code, so the codes can sum below it.
     */
    [[nodiscard]] nlohmann::json to_json () const {
        nlohmann::json out = nlohmann::json::object ();
        for (size_t slot = 0; slot < CLASS_COUNT; ++slot) {
            if (const size_t count = classes.at (slot); count > 0) {
                out[to_string (static_cast<McpErrorClass> (slot))] = count;
            }
        }
        nlohmann::json codes = nlohmann::json::object ();
        for (size_t slot = 0; slot < CODE_SLOT_COUNT; ++slot) {
            const size_t count = protocol_codes.at (slot);
            if (count == 0) {
                continue;
            }
            codes[slot == OTHER_CODE_SLOT ? std::string ("other") : std::to_string (slot_code (slot))] =
            count;
        }
        if (!codes.empty ()) {
            out["protocolCodes"] = std::move (codes);
        }
        return out;
    }
};

// `McpErrorClass` names its last enumerator here by hand, as `ERROR_CODE_COUNT`
// does: a class appended to the enum must raise `CLASS_COUNT`.
static_assert (static_cast<size_t> (McpErrorClass::Tool) + 1 == McpErrorCounts::CLASS_COUNT,
"McpErrorClass grew: raise McpErrorCounts::CLASS_COUNT to count the new class");
/// The wire name of each class (`transport`, `protocol`, `tool`), indexed by
/// `McpErrorClass`: the keys of `summary.errorClasses`, in the order every
/// reader lists them. Read from `to_string`, so the two cannot disagree.
inline constexpr std::array<std::string_view, McpErrorCounts::CLASS_COUNT> MCP_ERROR_CLASS_NAMES = [] {
    std::array<std::string_view, McpErrorCounts::CLASS_COUNT> names{};
    for (size_t slot = 0; slot < names.size (); ++slot) {
        names.at (slot) = to_string (static_cast<McpErrorClass> (slot));
    }
    return names;
}();

static_assert (McpErrorCounts::code_slot (-32099) + 1 == McpErrorCounts::OTHER_CODE_SLOT,
"the server band's last slot sits just before the other-code slot");
static_assert (
McpErrorCounts::code_slot (-32603) == 4 && McpErrorCounts::code_slot (-32000) == 5,
"the reserved codes and the server band are contiguous slots");

} // namespace vayu::core
