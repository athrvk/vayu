#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_export_fixtures.hpp
 * @brief The `tests/fixtures/run-export/` documents and goldens, read for the
 *        suites that render them (#2131, #2135).
 *
 * Each case is `<case>.document.json` (a run-report document, validated
 * against `docs/engine/run-export.schema.json` so it cannot drift into a shape
 * the builder never writes) and one golden per renderer. A golden is
 * regenerated with `VAYU_UPDATE_GOLDEN=1`, never edited by hand; the goldens
 * are read as bytes and `.gitattributes` keeps them LF on every platform.
 */

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace vayu::tests {

inline std::filesystem::path fixtures_dir () {
    return std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "tests" / "fixtures";
}

inline std::filesystem::path case_path (std::string_view name, std::string_view suffix) {
    return fixtures_dir () / "run-export" / (std::string (name) + std::string (suffix));
}

/// MSVC deprecates `std::getenv` (C4996) and this suite builds with `/W4 /WX`,
/// so the deprecation is followed, as `script_types_test.cpp` does.
inline bool env_is_set (const char* name) {
#ifdef _WIN32
    char* value   = nullptr;
    size_t length = 0;
    if (_dupenv_s (&value, &length, name) != 0 || value == nullptr) {
        return false;
    }
    const std::unique_ptr<char, decltype (&std::free)> owned (value, &std::free);
    return true;
#else
    // NOLINTNEXTLINE(concurrency-mt-unsafe)
    return std::getenv (name) != nullptr;
#endif
}

inline std::string read_bytes (const std::filesystem::path& path) {
    std::ifstream in (path, std::ios::binary);
    if (!in.good ()) {
        ADD_FAILURE () << "fixture missing: " << path;
        return {};
    }
    std::ostringstream buffer;
    buffer << in.rdbuf ();
    return buffer.str ();
}

inline nlohmann::ordered_json read_document (std::string_view name) {
    const std::string text = read_bytes (case_path (name, ".document.json"));
    EXPECT_FALSE (text.empty ()) << name;
    return nlohmann::ordered_json::parse (text);
}

} // namespace vayu::tests
