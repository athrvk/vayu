// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// `fixtures/chai-conformance.json` read once, for the tests that hold the
// scripting surface to it: `script_chai_conformance_test.cpp` runs each row,
// `script_completions_test.cpp` checks each row is offered in the editor.

#pragma once

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>

namespace vayu::tests {

/// The conformance table, or an empty object (and a test failure) when the
/// file cannot be read - which the callers' non-empty guards then report by
/// name rather than passing over nothing.
inline const nlohmann::json& chai_conformance_table () {
    static const nlohmann::json table = [] {
        const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
        "tests" / "fixtures" / "chai-conformance.json";
        std::ifstream in (path);
        if (!in.good ()) {
            ADD_FAILURE () << "fixture missing: " << path;
            return nlohmann::json::object ();
        }
        return nlohmann::json::parse (in);
    }();
    return table;
}

} // namespace vayu::tests
