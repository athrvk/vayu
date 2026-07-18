/**
 * @file tests/config_route_test.cpp
 * @brief Tests for POST /config validation (apply_config_update).
 *
 * Focus: a validation failure must return the *specific* reason (which key,
 * why) in the nested `error.message` shape the app reads - not a generic
 * "check the logs" string that surfaces as a bare "HTTP 400".
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/db/database.hpp"

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
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        for (const char* s : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + s);
        }
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

} // namespace
