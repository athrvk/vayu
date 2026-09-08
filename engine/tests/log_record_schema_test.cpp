/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/log_record_schema_test.cpp
 * @brief Every line the file sink writes validates against
 *        `docs/engine/log-record.schema.json` (issue #1557).
 *
 * The schema is the one contract both this side and the (not yet landed) app
 * side of #1556 validate against in tests, so a category added on one side and
 * not the other reds a test - the same shape `element-kinds.json` pins for the
 * element registry. This file owns reading it back and running it through
 * valijson the way `core/schema_validation.cpp` does for a response body.
 */

#include <atomic>
#include <filesystem>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <valijson/adapters/nlohmann_json_adapter.hpp>
#include <valijson/schema.hpp>
#include <valijson/schema_parser.hpp>
#include <valijson/validator.hpp>

#include "vayu/utils/logger.hpp"

namespace {

using vayu::utils::Logger;

nlohmann::json load_schema () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    ".." / "docs" / "engine" / "log-record.schema.json";
    std::ifstream in (path);
    // A schema that failed to open parses "" as invalid JSON, which fails the
    // very first test loudly rather than passing every case that follows for
    // want of anything to validate against.
    std::stringstream buffer;
    buffer << in.rdbuf ();
    return nlohmann::json::parse (buffer.str ());
}

bool validates (const nlohmann::json& schema_json, const nlohmann::json& record) {
    valijson::Schema schema;
    valijson::SchemaParser parser;
    const valijson::adapters::NlohmannJsonAdapter schema_adapter (schema_json);
    parser.populateSchema (schema_adapter, schema);

    valijson::Validator validator;
    const valijson::adapters::NlohmannJsonAdapter target (record);
    valijson::ValidationResults results;
    return validator.validate (schema, target, &results);
}

class ScratchLogDir {
    public:
    ScratchLogDir () {
        static std::atomic<int> counter{ 0 };
        path_ = std::filesystem::temp_directory_path () /
        ("vayu-log-schema-test-" + std::to_string (counter.fetch_add (1)) + "-" +
        std::to_string (static_cast<unsigned long long> (std::hash<std::string>{}(
        ::testing::UnitTest::GetInstance ()->current_test_info ()->name ()))));
        std::filesystem::create_directories (path_);
    }
    ~ScratchLogDir () {
        std::error_code ignored;
        std::filesystem::remove_all (path_, ignored);
    }
    ScratchLogDir (const ScratchLogDir&)            = delete;
    ScratchLogDir& operator= (const ScratchLogDir&) = delete;
    ScratchLogDir (ScratchLogDir&&)                 = delete;
    ScratchLogDir& operator= (ScratchLogDir&&)      = delete;

    std::string string () const {
        return path_.string ();
    }
    const std::filesystem::path& path () const {
        return path_;
    }

    private:
    std::filesystem::path path_;
};

std::vector<nlohmann::json> read_records (const std::filesystem::path& dir) {
    std::filesystem::path newest;
    for (const auto& entry : std::filesystem::directory_iterator (dir)) {
        if (entry.path ().extension () == ".log" && entry.path () > newest) {
            newest = entry.path ();
        }
    }
    std::vector<nlohmann::json> records;
    std::ifstream in (newest);
    std::string line;
    while (std::getline (in, line)) {
        if (!line.empty ()) {
            records.push_back (nlohmann::json::parse (line));
        }
    }
    return records;
}

TEST (LogRecordSchemaTest, TheSchemaFileParsesAsJson) {
    const nlohmann::json schema = load_schema ();
    EXPECT_TRUE (schema.is_object ())
    << "docs/engine/log-record.schema.json did not parse";
    EXPECT_TRUE (schema.contains ("oneOf"));
}

TEST (LogRecordSchemaTest, EveryEngineRecordShapeValidates) {
    const nlohmann::json schema = load_schema ();
    ScratchLogDir dir;
    Logger::instance ().init (dir.string (), "engine");
    Logger::instance ().set_max_file_bytes (0);
    Logger::instance ().set_file_level (Logger::Level::DEBUG);

    vayu::utils::log_debug ("http", "GET /health 200 1.3ms 412B",
    { { "method", "GET" }, { "path", "/health" }, { "status", 200 },
    { "ms", 1.3 }, { "bytes", 412 } });
    vayu::utils::log_info ("db", "Creating collection", { { "id", "c1" } });
    vayu::utils::log_warning ("config", "Ignoring unrecognised logLevel 'trace'");
    vayu::utils::log_error ("startup", "Failed to initialize database: disk full");
    Logger::instance ().flush ();

    const auto records = read_records (dir.path ());
    ASSERT_EQ (records.size (), 4u);
    for (const auto& record : records) {
        EXPECT_TRUE (validates (schema, record)) << record.dump ();
    }
}

TEST (LogRecordSchemaTest, ACliRecordValidatesUnderTheCliBranch) {
    const nlohmann::json schema = load_schema ();
    ScratchLogDir dir;
    Logger::instance ().init (dir.string (), "cli");
    Logger::instance ().set_max_file_bytes (0);
    Logger::instance ().set_file_level (Logger::Level::DEBUG);

    vayu::utils::log_info ("cli", "vayu-cli 1.0.0");
    Logger::instance ().flush ();

    const auto records = read_records (dir.path ());
    ASSERT_FALSE (records.empty ());
    EXPECT_TRUE (validates (schema, records.back ())) << records.back ().dump ();
}

// Mutation-check: change `record.at ("cat")` in the fixture below to a
// category from the wrong branch (`"db"` under `src: "cli"` is fine since
// `cli`'s enum is a superset, but `"boundary"`, `renderer`'s own, is not) and
// this reds - proving the `oneOf` per-`src` branch is load-bearing, not just
// present.
TEST (LogRecordSchemaTest, ACategoryFromAnotherSourcesListFailsValidation) {
    const nlohmann::json schema = load_schema ();
    nlohmann::json record{
        { "ts", "2026-09-07T13:57:19.123Z" },
        { "level", "info" },
        { "src", "engine" },
        { "cat", "boundary" }, // renderer-only, per the schema's oneOf
        { "msg", "x" },
        { "pid", 1 },
    };
    EXPECT_FALSE (validates (schema, record));
}

} // namespace
