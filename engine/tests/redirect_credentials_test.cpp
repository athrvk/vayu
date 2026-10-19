/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/redirect_credentials_test.cpp
 * @brief Which credentials a followed redirect carries to the next host
 *        (issue #2476).
 *
 * libcurl drops `Authorization` (and `Cookie`) when a redirect leaves the host
 * it was first sent to; every other header, an API key sent as `X-Api-Key`
 * included, follows. The engine does not change that, and `SECURITY.md`, the
 * API reference and the API Key editor all say so. These cases are what keep
 * the three statements true: an `apikey` auth is a header like any other, and
 * a libcurl or option change that started dropping it, or stopped dropping
 * `Authorization`, fails here rather than in a user's traffic.
 *
 * Two loopback ports are two hosts to libcurl (it compares host and port), so
 * the "other host" is a second in-process server. Both drivers that follow
 * redirects for a single request are exercised: they set the options
 * independently.
 */

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"

namespace {

using nlohmann::json;

constexpr const char* KEY_VALUE = "redirect-test-key-value";

enum class Driver : std::uint8_t { Client, EventLoop };

/// A GET to @p url carrying @p auth, applied the way the engine applies it
/// before any transfer, with redirects followed.
vayu::Request following (const std::string& url, const json& auth) {
    vayu::Request request;
    request.method           = vayu::HttpMethod::GET;
    request.url              = url;
    request.timeout_ms       = 5000;
    request.follow_redirects = true;
    const auto applied       = vayu::http::apply_auth (request, auth, nullptr);
    EXPECT_TRUE (applied.ok);
    return request;
}

void send_through (Driver driver, const vayu::Request& request) {
    if (driver == Driver::Client) {
        vayu::http::Client client;
        const auto result = client.send (request);
        ASSERT_TRUE (result.is_ok ());
        EXPECT_EQ (result.value ().status_code, 200);
        return;
    }
    vayu::http::EventLoop loop;
    loop.start ();
    auto handle       = loop.submit_async (request);
    const auto result = handle.future.get ();
    loop.stop ();
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 200);
}

json api_key_in_header () {
    return { { "mode", "apikey" }, { "key", "X-Api-Key" },
        { "value", KEY_VALUE }, { "in", "header" } };
}

class RedirectCredentials : public ::testing::TestWithParam<Driver> {
    protected:
    vayu::tests::EchoServer origin;
    vayu::tests::EchoServer elsewhere;

    /// Send @p auth to the origin, whose reply is a 302 to @p destination.
    void send_redirected (const std::string& destination, const json& auth) {
        send_through (GetParam (), following (origin.redirect_to (destination), auth));
    }
};

TEST_P (RedirectCredentials, AnApiKeyInAHeaderFollowsARedirectToAnotherHost) {
    send_redirected (elsewhere.url (), api_key_in_header ());
    EXPECT_EQ (elsewhere.requests_seen (), 1);
    EXPECT_EQ (elsewhere.header ("X-Api-Key"), KEY_VALUE);
    EXPECT_FALSE (elsewhere.has_header ("Authorization"));
}

TEST_P (RedirectCredentials, ATypedHeaderNamedLikeTheApiKeyFollowsInItsPlace) {
    vayu::Request request;
    request.method               = vayu::HttpMethod::GET;
    request.url                  = origin.redirect_to (elsewhere.url ());
    request.timeout_ms           = 5000;
    request.follow_redirects     = true;
    request.headers["x-api-key"] = "typed-value";
    ASSERT_TRUE (vayu::http::apply_auth (request, api_key_in_header (), nullptr).ok);
    send_through (GetParam (), request);

    EXPECT_EQ (elsewhere.header ("X-Api-Key"), "typed-value");
    EXPECT_FALSE (elsewhere.has_header ("Authorization"));
}

TEST_P (RedirectCredentials, BearerDoesNotFollowARedirectToAnotherHost) {
    send_redirected (elsewhere.url (),
    { { "mode", "bearer" }, { "token", "redirect-test-token" } });
    EXPECT_EQ (elsewhere.requests_seen (), 1);
    EXPECT_FALSE (elsewhere.has_header ("Authorization"));
}

TEST_P (RedirectCredentials, BasicDoesNotFollowARedirectToAnotherHost) {
    send_redirected (elsewhere.url (),
    { { "mode", "basic" }, { "username", "ada" }, { "password", "redirect-test-pw" } });
    EXPECT_EQ (elsewhere.requests_seen (), 1);
    EXPECT_FALSE (elsewhere.has_header ("Authorization"));
}

// The other half of the rule: `Authorization` is dropped because the host
// changed, not because a redirect happened.
TEST_P (RedirectCredentials, EveryCredentialFollowsARedirectWithinTheHost) {
    const std::string landing = origin.url () + "/landed";
    send_redirected (landing, api_key_in_header ());
    EXPECT_EQ (origin.path (), "/echo/landed");
    EXPECT_EQ (origin.header ("X-Api-Key"), KEY_VALUE);

    send_redirected (landing, { { "mode", "bearer" }, { "token", "redirect-test-token" } });
    EXPECT_EQ (origin.header ("Authorization"), "Bearer redirect-test-token");
}

INSTANTIATE_TEST_SUITE_P (Drivers,
RedirectCredentials,
::testing::Values (Driver::Client, Driver::EventLoop),
[] (const ::testing::TestParamInfo<Driver>& info) {
    return info.param == Driver::Client ? "Client" : "EventLoop";
});

} // namespace
