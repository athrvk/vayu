/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_export_formats_test.cpp
 * @brief The formats `POST /export/run-report` can write, against
 *        `engine/tests/fixtures/run-export-formats.json` (#2139).
 *
 * The renderer's registry (`run-export-formats.ts`) and the MCP server's list
 * (`electron/mcp/run-export-formats.ts`) read the same fixture, so a format the
 * engine gains or loses fails here or in whichever copy was not updated.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <set>
#include <string>
#include <tuple>

#include <nlohmann/json.hpp>

#include "vayu/core/run_export.hpp"

namespace {

using nlohmann::json;

/// (id, mimeType, extension): the three members the engine itself owns. The
/// fixture's `copyable` and `mcp` are the clients' choices.
using FormatKey = std::tuple<std::string, std::string, std::string>;

json load_formats_fixture () {
    const auto path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "tests" /
    "fixtures" / "run-export-formats.json";
    std::ifstream in (path);
    if (!in.good ()) {
        ADD_FAILURE () << "fixture missing: " << path;
        return json::array ();
    }
    return json::parse (in);
}

std::set<FormatKey> fixture_formats (const json& fixture) {
    std::set<FormatKey> keys;
    for (const json& row : fixture) {
        keys.emplace (row.at ("id").get<std::string> (),
        row.at ("mimeType").get<std::string> (),
        row.at ("extension").get<std::string> ());
    }
    return keys;
}

std::set<FormatKey> writable_formats () {
    std::set<FormatKey> keys;
    for (const vayu::core::RunExportFormat& row : vayu::core::RUN_EXPORT_FORMATS) {
        keys.emplace (std::string (row.name), std::string (row.mime_type),
        std::string (row.file_suffix));
    }
    return keys;
}

TEST (RunExportFormatsFixtureTest, IsNotEmpty) {
    const json fixture = load_formats_fixture ();
    ASSERT_TRUE (fixture.is_array ());
    EXPECT_FALSE (fixture.empty ());
}

TEST (RunExportFormatsFixtureTest, ListsExactlyTheFormatsTheEngineWrites) {
    const std::set<FormatKey> expected = fixture_formats (load_formats_fixture ());
    ASSERT_FALSE (expected.empty ());
    EXPECT_EQ (writable_formats (), expected);
}

} // namespace
