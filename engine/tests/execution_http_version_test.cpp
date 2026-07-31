/**
 * @file tests/execution_http_version_test.cpp
 * @brief Tests the "httpVersion" field on a POST /runs body.
 *
 * Not an override: one protocol control in the request builder's Settings tab
 * governs Send and load test alike. This field is how a run states its
 * protocol at all, and how MCP's ad-hoc runs - which have no saved request to
 * read from - specify one. It is validated strictly (a 400 naming the field
 * and the valid values), unlike deserialize_request's lenient string-to-Auto
 * coercion of a corrupted stored row - see normalize_run_http_version's doc
 * comment in execution.cpp.
 */

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include "vayu/types.hpp"

namespace vayu::http::routes {
// Declared in execution.cpp.
std::optional<std::pair<int, nlohmann::json>> normalize_run_http_version (
nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::normalize_run_http_version;

TEST (NormalizeRunHttpVersion, AbsentLeavesJsonUntouched) {
    auto json = nlohmann::json::parse (R"({"method":"GET","url":"http://x"})");
    EXPECT_EQ (normalize_run_http_version (json), std::nullopt);
    EXPECT_FALSE (json.contains ("httpVersion"));
}

// Every member of all_http_versions() must be accepted, iterated rather than
// hardcoded so a future domain member is covered automatically.
TEST (NormalizeRunHttpVersion, AcceptsEveryValidVersion) {
    for (const auto version : vayu::all_http_versions ()) {
        const std::string wire = vayu::to_string (version);
        auto json = nlohmann::json::parse (R"({"httpVersion":")" + wire + "\"}");
        EXPECT_EQ (normalize_run_http_version (json), std::nullopt) << wire;
        ASSERT_TRUE (json.contains ("httpVersion")) << wire;
        EXPECT_EQ (json["httpVersion"], wire) << wire;
    }
}

TEST (NormalizeRunHttpVersion, NullIsErasedSoItBehavesLikeAnAbsentKey) {
    // Discriminates against writing a resolved seed back onto the key: this
    // fails if `null` is turned into a concrete value instead of removed.
    // Both produce `Auto` today, since that is also Request::http_version's
    // default - erasing is what stops the two diverging once anything resolves
    // a default at this layer.
    auto json = nlohmann::json::parse (R"({"url":"https://x/y","httpVersion":null})");
    EXPECT_EQ (normalize_run_http_version (json), std::nullopt);
    EXPECT_FALSE (json.contains ("httpVersion"));
    EXPECT_EQ (json["url"], "https://x/y"); // nothing else disturbed
}

TEST (NormalizeRunHttpVersion, RejectsUnrecognizedString) {
    auto json = nlohmann::json::parse (R"({"httpVersion":"spdy"})");
    auto err  = normalize_run_http_version (json);
    ASSERT_TRUE (err.has_value ());
    EXPECT_EQ (err->first, 400);
    const std::string message = err->second["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("httpVersion"), std::string::npos);
    // Every wire value must be named in the rejection, the same guarantee
    // resource_write_route_test.cpp holds the CRUD route to.
    for (const auto version : vayu::all_http_versions ()) {
        EXPECT_NE (message.find (vayu::to_string (version)), std::string::npos)
        << "missing " << vayu::to_string (version);
    }
}

TEST (NormalizeRunHttpVersion, RejectsNonStringValue) {
    auto json = nlohmann::json::parse (R"({"httpVersion":2})");
    auto err  = normalize_run_http_version (json);
    ASSERT_TRUE (err.has_value ());
    EXPECT_EQ (err->first, 400);
    EXPECT_NE (
    err->second["error"]["message"].get<std::string> ().find ("httpVersion"),
    std::string::npos);
}

} // namespace
