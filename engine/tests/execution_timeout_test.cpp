/**
 * @file tests/execution_timeout_test.cpp
 * @brief Tests the timeout a request or run payload resolves to.
 *
 * Regression: the handler used the compile-time DEFAULT_TIMEOUT_MS (30s)
 * whenever the request body omitted a "timeout" field, ignoring the
 * user-configurable engine `defaultTimeout` setting. The setting's key is
 * pinned by `config_route_test.cpp`, and a load run's use of it by
 * `run_manager_test.cpp` (#2798).
 */

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include "vayu/http/request_exchange.hpp"

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

TEST (ResolveRequestTimeout, NullUsesTheConfiguredDefault) {
    auto json = nlohmann::json::parse (R"({"timeout":null})");
    EXPECT_EQ (resolve_request_timeout_ms (json, 120000), 120000);
}

TEST (ResolveRequestTimeout, IgnoresNonNumericTimeout) {
    auto json = nlohmann::json::parse (R"({"timeout":"oops"})");
    EXPECT_EQ (resolve_request_timeout_ms (json, 120000), 120000);
}

} // namespace
