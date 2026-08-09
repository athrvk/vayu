/**
 * @file tests/config_route_test.cpp
 * @brief Tests for POST /config validation (apply_config_update).
 *
 * Focus: a validation failure must return the *specific* reason (which key,
 * why) in the nested `error.message` shape the app reads - not a generic
 * "check the logs" string that surfaces as a bare "HTTP 400".
 */

#include <gtest/gtest.h>

#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Declared in config.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> apply_config_update (vayu::db::Database& db,
const std::string& body);
} // namespace vayu::http::routes

namespace {

class ConfigRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_config_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        // The constructor only syncs the schema; seeding the default config
        // (incl. the "workers" key these tests exercise) happens in init(),
        // exactly as the daemon does at startup. Without this the config table
        // is empty and every keyed update is rejected as an unknown key.
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }
    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (ConfigRouteTest, InvalidJsonIs400WithReason) {
    auto [status, body] = vayu::http::routes::apply_config_update (*db_, "not json");
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["code"], "invalid_config");
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Invalid JSON"),
    std::string::npos);
}

TEST_F (ConfigRouteTest, InvalidRequestFormatIs400) {
    auto [status, body] = vayu::http::routes::apply_config_update (*db_, R"({"foo":"bar"})");
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["code"], "invalid_config");
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Invalid request format"),
    std::string::npos);
}

TEST_F (ConfigRouteTest, UnknownKeyNamesTheKey) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"totally_made_up_key":"1"}})");
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("Unknown config key"), std::string::npos);
    EXPECT_NE (message.find ("totally_made_up_key"), std::string::npos);
}

TEST_F (ConfigRouteTest, OutOfRangeReportsBoundAndValue) {
    // "workers" is seeded as an integer with min 1 / max 128.
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"workers":"999"}})");
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("workers"), std::string::npos);
    EXPECT_NE (message.find ("128"), std::string::npos); // the exceeded bound
    EXPECT_NE (message.find ("999"), std::string::npos); // the offending value
}

TEST_F (ConfigRouteTest, NonIntegerReportsType) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"workers":"abc"}})");
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("workers"), std::string::npos);
    EXPECT_NE (message.find ("integer"), std::string::npos);
}

TEST_F (ConfigRouteTest, InvalidValueDoesNotPersist) {
    auto before = db_->get_config_entry ("workers");
    ASSERT_TRUE (before.has_value ());

    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"999"}})");

    auto after = db_->get_config_entry ("workers");
    ASSERT_TRUE (after.has_value ());
    EXPECT_EQ (after->value, before->value); // rejected update left the DB untouched
}

TEST_F (ConfigRouteTest, ValidUpdateSucceedsAndPersists) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"workers":"4"}})");
    EXPECT_EQ (status, 200);
    EXPECT_TRUE (body["success"].get<bool> ());

    auto stored = db_->get_config_entry ("workers");
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->value, "4");
}

TEST_F (ConfigRouteTest, SingleUpdateFormatSucceeds) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"key":"workers","value":"8"})");
    EXPECT_EQ (status, 200);
    EXPECT_TRUE (body["success"].get<bool> ());

    auto stored = db_->get_config_entry ("workers");
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->value, "8");
}

// Find one entry by key in the "entries" array of an apply_config_update
// response body. Fails the calling test if the key is missing.
json find_entry (const json& body, const std::string& key) {
    for (const auto& entry : body["entries"]) {
        if (entry["key"] == key) {
            return entry;
        }
    }
    ADD_FAILURE () << "entry '" << key << "' not found in response";
    return json{};
}

TEST_F (ConfigRouteTest, EnumEntrySerializesOptionsAsArrayOfValueLabel) {
    // Any successful update returns the full entry list, including the
    // seeded "defaultHttpVersion" enum entry - trigger via an unrelated key.
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json entry = find_entry (body, "defaultHttpVersion");
    ASSERT_EQ (entry["type"], "enum");
    ASSERT_TRUE (entry.contains ("options"));
    ASSERT_TRUE (entry["options"].is_array ());

    const auto& versions = vayu::all_http_versions ();
    ASSERT_EQ (entry["options"].size (), versions.size ());
    for (size_t i = 0; i < versions.size (); ++i) {
        EXPECT_EQ (entry["options"][i]["value"], vayu::to_string (versions[i]));
        EXPECT_EQ (entry["options"][i]["label"], vayu::http_version_label (versions[i]));
    }
}

TEST_F (ConfigRouteTest, NonEnumEntryOmitsOptionsEntirely) {
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json entry = find_entry (body, "workers");
    EXPECT_FALSE (entry.contains ("options")); // absent, not null
}

TEST_F (ConfigRouteTest, EnumUpdateRejectsValueOutsideOptionsWith400) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"defaultHttpVersion":"http3"}})");
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("defaultHttpVersion"), std::string::npos);
    EXPECT_NE (message.find ("http3"), std::string::npos);
}

TEST_F (ConfigRouteTest, EnumUpdateAcceptsValidOption) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"defaultHttpVersion":"http2"}})");
    EXPECT_EQ (status, 200);
    EXPECT_TRUE (body["success"].get<bool> ());

    auto stored = db_->get_config_entry ("defaultHttpVersion");
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->value, "http2");
    // save_config_entry replaces the whole row, so a value-only update must not
    // drop the option list - without it the entry becomes unrenderable.
    ASSERT_TRUE (stored->options.has_value ());
    EXPECT_EQ (nlohmann::json::parse (*stored->options).size (),
    vayu::all_http_versions ().size ());
}

TEST_F (ConfigRouteTest, MalformedOptionsOmitsTheKeyInsteadOfFailingTheWholeListing) {
    // Only seed_default_config writes this column, so this state means a
    // tampered or truncated row. It must cost one entry's option list, not the
    // entire GET /config payload - an unguarded parse here would 500 the whole
    // settings screen.
    auto entry = db_->get_config_entry ("defaultHttpVersion");
    ASSERT_TRUE (entry.has_value ());
    entry->options = "{not valid json";
    db_->save_config_entry (*entry);

    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json broken = find_entry (body, "defaultHttpVersion");
    EXPECT_EQ (broken["type"], "enum");
    EXPECT_FALSE (broken.contains ("options"));

    // The rest of the listing is unaffected.
    json healthy = find_entry (body, "workers");
    EXPECT_EQ (healthy["value"], "4");
}

// Mutation-check target: if seed_default_config() ever hardcodes the option
// list instead of deriving it from all_http_versions(), this must fail. The
// two most likely mutations - dropping an entry, or reordering it - are both
// caught because the comparison is index-by-index against the exact same
// domain source production is supposed to consult.
TEST_F (ConfigRouteTest, SeededDefaultHttpVersionOptionsMatchAllHttpVersionsInOrder) {
    auto entry = db_->get_config_entry ("defaultHttpVersion");
    ASSERT_TRUE (entry.has_value ());
    ASSERT_TRUE (entry->options.has_value ());

    json options         = json::parse (*entry->options);
    const auto& versions = vayu::all_http_versions ();
    ASSERT_EQ (options.size (), versions.size ());
    for (size_t i = 0; i < versions.size (); ++i) {
        EXPECT_EQ (options[i]["value"], vayu::to_string (versions[i]));
        EXPECT_EQ (options[i]["label"], vayu::http_version_label (versions[i]));
    }
}

} // namespace
