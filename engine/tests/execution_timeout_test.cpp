/**
 * @file tests/execution_timeout_test.cpp
 * @brief Tests timeout resolution for design-mode POST /request.
 *
 * Regression: the handler used the compile-time DEFAULT_TIMEOUT_MS (30s)
 * whenever the request body omitted a "timeout" field, ignoring the
 * user-configurable engine `defaultTimeout` setting.
 */

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

namespace vayu::http::routes {
// Declared in execution.cpp.
int resolve_request_timeout_ms (const nlohmann::json& json, int configured_default);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::resolve_request_timeout_ms;

TEST (ResolveRequestTimeout, ExplicitTimeoutWins) {
    auto json = nlohmann::json::parse (R"({"timeout":5000})");
    EXPECT_EQ (resolve_request_timeout_ms (json, 120000), 5000);
}

TEST (ResolveRequestTimeout, FallsBackToConfiguredDefaultWhenOmitted) {
    auto json = nlohmann::json::parse (R"({"url":"http://x"})");
    // Must use the configured engine defaultTimeout, NOT the 30s constant.
    EXPECT_EQ (resolve_request_timeout_ms (json, 120000), 120000);
}

TEST (ResolveRequestTimeout, IgnoresNonNumericTimeout) {
    auto json = nlohmann::json::parse (R"({"timeout":"oops"})");
    EXPECT_EQ (resolve_request_timeout_ms (json, 120000), 120000);
}

} // namespace
