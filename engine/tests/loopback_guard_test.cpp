/**
 * @file tests/loopback_guard_test.cpp
 * @brief No transfer the engine sends reaches Vayu's own engine or MCP port
 *        (#2355): the predicate, the registry, and the refusal on every driver.
 *
 * The driver cases are the ones that matter. Each runs against a stand-in for
 * the engine port (`engine_port_stand_in.hpp`) and asserts that it saw no
 * request, for a URL naming the port, for a redirect to it and for a name
 * that resolves to loopback. The last two are invisible to any text check on
 * the URL, so they prove the pre-request callback rather than
 * `validate_transferable`.
 *
 * Mutation checks: drop the `CURLOPT_PREREQFUNCTION` set in
 * `apply_transport_policy` and the redirect and resolved-name cases fail while
 * the literal ones pass; drop the `reserved_target_port` clause from
 * `validate_transferable` and the literal cases fail (the proxied one most
 * plainly, since nothing else can refuse it).
 */

#include <gtest/gtest.h>

#include <array>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

#include "echo_server.hpp"
#include "engine_port_stand_in.hpp"
#include "proxy_server.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/loopback_guard.hpp"
#include "vayu/http/sse_stream.hpp"

namespace {

using vayu::http::detail::is_reserved_loopback_target;

constexpr int MCP_PORT    = vayu::core::constants::defaults::MCP_PORT;
constexpr int ENGINE_PORT = 9876;
constexpr int OTHER_PORT  = 8080;

/// Every spelling of "this machine" the guard must recognise.
constexpr auto LOOPBACK_SPELLINGS = std::to_array<const char*> ({ "127.0.0.1",
"127.1.2.3", "localhost", "LOCALHOST.", "[::1]", "::1", "::ffff:127.0.0.1",
"[::ffff:127.9.9.9]", "127.1", "0x7f.0.0.1", "0.0.0.0", "::" });

/// Hosts that share no address with this machine's loopback.
constexpr auto ELSEWHERE = std::to_array<const char*> ({ "10.0.0.1",
"192.168.1.5", "128.0.0.1", "126.255.255.255", "::2", "::ffff:10.0.0.1",
"example.com", "localhost.example.com", "notlocalhost", "127.example", "" });

// ============================================================================
// The predicate
// ============================================================================

TEST (LoopbackGuardPredicate, RefusesEveryLoopbackSpellingOnTheEnginePort) {
    for (const char* host : LOOPBACK_SPELLINGS) {
        EXPECT_TRUE (is_reserved_loopback_target (host, ENGINE_PORT, ENGINE_PORT)) << host;
    }
}

TEST (LoopbackGuardPredicate, RefusesEveryLoopbackSpellingOnTheMcpPort) {
    for (const char* host : LOOPBACK_SPELLINGS) {
        EXPECT_TRUE (is_reserved_loopback_target (host, MCP_PORT, ENGINE_PORT)) << host;
    }
}

// Users test local servers all the time; only Vayu's own ports are refused.
TEST (LoopbackGuardPredicate, AllowsLoopbackOnAnyOtherPort) {
    for (const char* host : LOOPBACK_SPELLINGS) {
        EXPECT_FALSE (is_reserved_loopback_target (host, OTHER_PORT, ENGINE_PORT)) << host;
    }
}

TEST (LoopbackGuardPredicate, AllowsAnotherHostOnAReservedPort) {
    for (const char* host : ELSEWHERE) {
        EXPECT_FALSE (is_reserved_loopback_target (host, ENGINE_PORT, ENGINE_PORT)) << host;
        EXPECT_FALSE (is_reserved_loopback_target (host, MCP_PORT, ENGINE_PORT)) << host;
    }
}

// Before the daemon registers its port (a test's in-process Server, the CLI),
// the MCP port is still reserved and nothing else is.
TEST (LoopbackGuardPredicate, WithNoRegisteredEnginePortOnlyTheMcpPortIsReserved) {
    EXPECT_FALSE (is_reserved_loopback_target ("127.0.0.1", ENGINE_PORT, std::nullopt));
    EXPECT_TRUE (is_reserved_loopback_target ("127.0.0.1", MCP_PORT, std::nullopt));
}

// ============================================================================
// The registry
// ============================================================================

TEST (LoopbackGuardRegistry, IsSetOnceAndRefusesASecondPort) {
    const int port = vayu::tests::engine_port_stand_in ().port ();
    ASSERT_EQ (vayu::http::registered_engine_port (), port);

    EXPECT_NO_THROW (vayu::http::set_engine_port (port))
    << "repeating the registered port is a no-op";
    EXPECT_THROW (vayu::http::set_engine_port (port == 1 ? 2 : 1), std::logic_error);
    EXPECT_THROW (vayu::http::set_engine_port (0), std::invalid_argument);
    EXPECT_THROW (vayu::http::set_engine_port (65536), std::invalid_argument);
    EXPECT_EQ (vayu::http::registered_engine_port (), port)
    << "a refused registration must leave the first one in force";
}

TEST (LoopbackGuardRegistry, ReadsTheReservedPortOffAUrl) {
    const int port         = vayu::tests::engine_port_stand_in ().port ();
    const std::string tail = ":" + std::to_string (port) + "/health";

    EXPECT_EQ (vayu::http::reserved_target_port ("http://127.0.0.1" + tail), port);
    EXPECT_EQ (vayu::http::reserved_target_port ("http://localhost" + tail), port);
    EXPECT_EQ (vayu::http::reserved_target_port ("http://[::1]" + tail), port);
    EXPECT_EQ (vayu::http::reserved_target_port ("https://user:pw@127.0.0.1" + tail), port);
    EXPECT_EQ (vayu::http::reserved_target_port ("http://127.0.0.1:9877/mcp"), MCP_PORT);

    EXPECT_EQ (vayu::http::reserved_target_port ("http://example.com" + tail), std::nullopt);
    EXPECT_EQ (vayu::http::reserved_target_port ("http://127.0.0.1/health"), std::nullopt)
    << "the scheme default port is not a reserved one";
}

TEST (LoopbackGuardRegistry, TheRefusalNamesWhichPortItIs) {
    const int port = vayu::tests::engine_port_stand_in ().port ();
    EXPECT_NE (vayu::http::reserved_target_refusal (port).find (
               "own engine port " + std::to_string (port)),
    std::string::npos);
    EXPECT_NE (
    vayu::http::reserved_target_refusal (MCP_PORT).find ("own MCP port 9877"),
    std::string::npos);
}

// ============================================================================
// Every driver refuses, and the stand-in sees nothing
// ============================================================================

enum class Driver : std::uint8_t { Client, EventLoop, SseStream };

const char* driver_name (Driver driver) {
    switch (driver) {
    case Driver::Client: return "Client::send";
    case Driver::EventLoop: return "event loop worker";
    case Driver::SseStream: return "SSE stream";
    }
    return "unknown";
}

constexpr auto ALL_DRIVERS =
std::to_array<Driver> ({ Driver::Client, Driver::EventLoop, Driver::SseStream });

class LoopbackGuardTransport : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        reserved_port = vayu::tests::engine_port_stand_in ().port ();
    }

    void TearDown () override {
        vayu::http::global_cleanup ();
    }

    /// Proxy off, the default here: a runner exporting `http_proxy` would
    /// otherwise connect to the proxy, which is the documented edge the
    /// connected-address check cannot see past.
    static vayu::http::TransportPolicy direct () {
        vayu::http::TransportPolicy policy;
        policy.proxy_mode = vayu::http::ProxyMode::Off;
        return policy;
    }

    /// One GET to @p url through @p driver, as the response it completes with.
    static vayu::Response send_through (Driver driver,
    const std::string& url,
    const vayu::http::TransportPolicy& policy = direct ()) {
        vayu::Request request;
        request.method = vayu::HttpMethod::GET;
        request.url    = url;
        switch (driver) {
        case Driver::Client: {
            vayu::http::ClientConfig config;
            config.transport = policy;
            return vayu::http::Client{ config }.send (request).value ();
        }
        case Driver::EventLoop: {
            vayu::http::EventLoopConfig config;
            config.transport = policy;
            vayu::http::EventLoop loop{ std::move (config) };
            loop.start ();
            auto handle = loop.submit_async (request);
            auto result = handle.future.get ();
            loop.stop ();
            return result.value ();
        }
        case Driver::SseStream: {
            vayu::http::SseStreamRequest spec;
            spec.run_id    = "run_guard";
            spec.request   = request;
            spec.transport = policy;
            vayu::http::SseStreamContext context ("run_guard", spec.limits);
            return vayu::http::consume_sse_stream (spec, context);
        }
        }
        return {};
    }

    /// Sends @p url through every driver and asserts each one was refused
    /// with the engine-port sentence while the stand-in saw nothing.
    void expect_refused_everywhere (const std::string& url,
    const vayu::http::TransportPolicy& policy = direct ()) const {
        const auto& stand_in = vayu::tests::engine_port_stand_in ();
        for (const Driver driver : ALL_DRIVERS) {
            const int seen_before         = stand_in.requests_seen ();
            const vayu::Response response = send_through (driver, url, policy);

            EXPECT_EQ (response.status_code, 0) << driver_name (driver) << ": " << url;
            EXPECT_EQ (response.error_code, vayu::ErrorCode::InvalidUrl)
            << driver_name (driver) << ": " << response.error_message;
            EXPECT_NE (response.error_message.find (
                       "own engine port " + std::to_string (reserved_port)),
            std::string::npos)
            << driver_name (driver) << ": " << response.error_message;
            EXPECT_EQ (stand_in.requests_seen (), seen_before)
            << driver_name (driver)
            << " delivered a request to the engine port via " << url;
        }
    }

    std::string on_reserved_port (const std::string& host) const {
        return "http://" + host + ":" + std::to_string (reserved_port) + "/echo";
    }

    int reserved_port = 0;
};

TEST_F (LoopbackGuardTransport, ALiteralEnginePortIsRefusedByEveryDriver) {
    expect_refused_everywhere (on_reserved_port ("127.0.0.1"));
    expect_refused_everywhere (on_reserved_port ("[::1]"));
}

// Through a proxy the connected address is the proxy's, so only the literal
// check stands between the URL and the engine: the proxy must see nothing.
TEST_F (LoopbackGuardTransport, ALiteralEnginePortIsRefusedEvenThroughAProxy) {
    vayu::tests::MockProxy proxy;
    vayu::http::TransportPolicy proxied;
    proxied.proxy_mode = vayu::http::ProxyMode::Manual;
    proxied.proxy_url  = proxy.url ();
    expect_refused_everywhere (on_reserved_port ("127.0.0.1"), proxied);
    EXPECT_EQ (proxy.count (), 0U) << "the request was handed to the proxy";
}

TEST_F (LoopbackGuardTransport, ARedirectToTheEnginePortIsRefusedByEveryDriver) {
    vayu::tests::EchoServer origin;
    expect_refused_everywhere (
    origin.redirect_to (on_reserved_port ("127.0.0.1")));
    EXPECT_EQ (origin.requests_seen (), 3)
    << "each driver reached the origin, so the refusal came at the redirect";
}

TEST_F (LoopbackGuardTransport, ARedirectToLocalhostOnTheEnginePortIsRefused) {
    vayu::tests::EchoServer origin;
    expect_refused_everywhere (
    origin.redirect_to (on_reserved_port ("localhost")));
}

// libcurl resolves every `*.localhost` name to loopback itself, so this is a
// name no literal check recognises that still dials the engine.
TEST_F (LoopbackGuardTransport, ANameResolvingToLoopbackIsRefusedByEveryDriver) {
    expect_refused_everywhere (on_reserved_port ("vayu-guard.localhost"));
}

TEST_F (LoopbackGuardTransport, AnotherLoopbackPortIsStillReachedByEveryDriver) {
    vayu::tests::EchoServer local;
    for (const Driver driver : ALL_DRIVERS) {
        const vayu::Response response = send_through (driver, local.url ());
        EXPECT_EQ (response.status_code, 200)
        << driver_name (driver) << ": " << response.error_message;
        EXPECT_FALSE (response.has_error ()) << driver_name (driver);
    }
    EXPECT_EQ (local.requests_seen (), 3);
}

} // namespace
