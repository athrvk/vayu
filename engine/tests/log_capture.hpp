#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/log_capture.hpp
 * @brief Read back what the file sink wrote, and check the text a script
 *        authored did not reach `msg` (issue #2359).
 *
 * `Logger` is a process-wide singleton, so a test that asserts on a record
 * points it at a directory of its own and reads the file back, the way
 * `log_record_schema_test.cpp` does. This is that, shared by every test that
 * drives a script failure through the real code and then looks at the log.
 */

#include <atomic>
#include <filesystem>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <valijson/adapters/nlohmann_json_adapter.hpp>
#include <valijson/schema.hpp>
#include <valijson/schema_parser.hpp>
#include <valijson/validator.hpp>

#include "vayu/utils/encoding.hpp"
#include "vayu/utils/log_text.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::tests {

/// What a hostile script throws: a secret-looking token, then a run of
/// three-byte characters long enough to pass the log bound, then a tail that
/// only an unbounded copy would carry.
inline constexpr std::string_view SCRIPT_SECRET = "sk-live-SECRET123";
inline constexpr std::string_view SCRIPT_TAIL   = "END-OF-THROWN-TEXT";

/// @p pad_bytes of 'a' between the secret and the multibyte run, so a test can
/// place the bound's cut inside one three-byte character.
inline std::string thrown_text (std::size_t pad_bytes) {
    std::string text (SCRIPT_SECRET);
    text += std::string (pad_bytes, 'a');
    for (int i = 0; i < 400; ++i) {
        text += "\xE2\x82\xAC"; // U+20AC, three bytes
    }
    text += SCRIPT_TAIL;
    return text;
}

/// A script that throws @p text (which must hold no quote or backslash).
inline std::string script_throwing (std::string_view text) {
    return "throw new Error(\"" + std::string (text) + "\");";
}

inline nlohmann::json load_log_schema () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    ".." / "docs" / "engine" / "log-record.schema.json";
    std::ifstream in (path);
    std::stringstream buffer;
    buffer << in.rdbuf ();
    // An unreadable schema parses "" and throws here, so the test fails loudly
    // rather than validating every record against nothing.
    return nlohmann::json::parse (buffer.str ());
}

inline bool validates_against_log_schema (const nlohmann::json& record) {
    static const nlohmann::json schema_json = load_log_schema ();
    valijson::Schema schema;
    valijson::SchemaParser parser;
    const valijson::adapters::NlohmannJsonAdapter schema_adapter (schema_json);
    parser.populateSchema (schema_adapter, schema);

    valijson::Validator validator;
    const valijson::adapters::NlohmannJsonAdapter target (record);
    return validator.validate (schema, target, nullptr);
}

/// Points the logger at a scratch directory for one test and reads it back.
class LogCapture {
    public:
    LogCapture () {
        static std::atomic<int> counter{ 0 };
        path_ = std::filesystem::temp_directory_path () /
        ("vayu-log-capture-" + std::to_string (counter.fetch_add (1)) + "-" +
        std::to_string (static_cast<unsigned long long> (std::hash<std::string>{}(
        ::testing::UnitTest::GetInstance ()->current_test_info ()->name ()))));
        std::filesystem::create_directories (path_);
        vayu::utils::Logger::instance ().init (path_.string (), "engine");
        vayu::utils::Logger::instance ().set_max_file_bytes (0);
        vayu::utils::Logger::instance ().set_file_level (vayu::utils::Logger::Level::DEBUG);
    }
    ~LogCapture () {
        std::error_code ignored;
        std::filesystem::remove_all (path_, ignored);
    }
    LogCapture (const LogCapture&)            = delete;
    LogCapture& operator= (const LogCapture&) = delete;
    LogCapture (LogCapture&&)                 = delete;
    LogCapture& operator= (LogCapture&&)      = delete;

    /// Every record written since construction, in order.
    std::vector<nlohmann::json> records () const {
        vayu::utils::Logger::instance ().flush ();
        std::filesystem::path newest;
        for (const auto& entry : std::filesystem::directory_iterator (path_)) {
            if (entry.path ().extension () == ".log" && entry.path () > newest) {
                newest = entry.path ();
            }
        }
        std::vector<nlohmann::json> out;
        std::ifstream in (newest);
        std::string line;
        while (std::getline (in, line)) {
            if (!line.empty ()) {
                out.push_back (nlohmann::json::parse (line));
            }
        }
        return out;
    }

    /// The records whose `msg` starts with @p msg_prefix.
    std::vector<nlohmann::json> with_msg_prefix (std::string_view msg_prefix) const {
        std::vector<nlohmann::json> out;
        for (auto& record : records ()) {
            if (record.at ("msg").get<std::string> ().starts_with (msg_prefix)) {
                out.push_back (std::move (record));
            }
        }
        return out;
    }

    private:
    std::filesystem::path path_;
};

/// What every site that logs script-authored text owes: the text is in
/// @p field, bounded and valid UTF-8, and nowhere in `msg` or any other field.
inline void expect_script_text_only_bounded_in (const nlohmann::json& record,
std::string_view field) {
    EXPECT_TRUE (validates_against_log_schema (record)) << record.dump ();

    const std::string key (field);
    ASSERT_TRUE (record.contains (key)) << record.dump ();
    const auto bounded = record.at (key).get<std::string> ();
    EXPECT_LE (bounded.size (),
    vayu::utils::kLoggedTextMaxBytes + vayu::utils::kLoggedTextTruncationMarker.size ());
    EXPECT_TRUE (bounded.ends_with (vayu::utils::kLoggedTextTruncationMarker)) << bounded;
    EXPECT_TRUE (vayu::utils::is_valid_utf8_text (bounded));
    EXPECT_NE (bounded.find (SCRIPT_SECRET), std::string::npos)
    << "the bounded field should still say what was thrown: " << bounded;
    EXPECT_EQ (bounded.find (SCRIPT_TAIL), std::string::npos)
    << "the field was not bounded";

    EXPECT_EQ (record.at ("msg").get<std::string> ().find (SCRIPT_SECRET), std::string::npos)
    << record.dump ();
    for (const auto& [name, value] : record.items ()) {
        if (name != key && value.is_string ()) {
            EXPECT_EQ (value.get<std::string> ().find (SCRIPT_SECRET), std::string::npos)
            << name << " in " << record.dump ();
        }
    }
}

} // namespace vayu::tests
