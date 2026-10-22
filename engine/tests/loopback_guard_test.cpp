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
#include <string_view>
#include <utility>

#include "echo_server.hpp"
#include "engine_port_stand_in.hpp"
#include "optional_assert.hpp"
#include "proxy_server.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
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
// The reference rule (#2364): every loopback and link-local peer but the source
// ============================================================================

using vayu::http::is_refused_local_peer;
using vayu::http::LocalPeerRule;

/// Every spelling of a link-local address the rule must recognise.
constexpr auto LINK_LOCAL_SPELLINGS =
std::to_array<const char*> ({ "169.254.0.1", "169.254.169.254", "169.254.255.255",
"169.254.1", "0xa9.0xfe.1.1", "fe80::1", "[fe80::1]", "FE80::ABCD", "fe9a::1",
"febf:ffff::1", "::ffff:169.254.1.1", "[::ffff:a9fe:101]" });

/// Addresses beside the link-local ranges that are not in them.
constexpr auto NEAR_LINK_LOCAL = std::to_array<const char*> ({ "169.255.0.1",
"169.253.255.255", "fe7f::1", "fec0::1", "ff02::1", "::ffff:169.255.0.1" });

/// The rule for a reference found at @p source_url; fails the test if none.
LocalPeerRule rule_for (const std::string& source_url) {
    const auto rule = vayu::http::local_peer_rule_for_source (source_url);
    if (!rule) {
        ADD_FAILURE () << "no rule for " << source_url;
        return {};
    }
    return *rule;
}

TEST (LocalPeerRulePredicate, WithNoSourceRefusesEveryLoopbackAndLinkLocalPeer) {
    for (const char* host : LOOPBACK_SPELLINGS) {
        EXPECT_TRUE (is_refused_local_peer (host, OTHER_PORT, LocalPeerRule{})) << host;
    }
    for (const char* host : LINK_LOCAL_SPELLINGS) {
        EXPECT_TRUE (is_refused_local_peer (host, OTHER_PORT, LocalPeerRule{})) << host;
    }
}

TEST (LocalPeerRulePredicate, AllowsEveryOtherAddress) {
    for (const char* host : ELSEWHERE) {
        if (std::string_view (host).empty ()) {
            continue; // not an address; see FailsClosedOnWhatIsNotAnAddress
        }
        EXPECT_FALSE (is_refused_local_peer (host, OTHER_PORT, LocalPeerRule{})) << host;
    }
    for (const char* host : NEAR_LINK_LOCAL) {
        EXPECT_FALSE (is_refused_local_peer (host, OTHER_PORT, LocalPeerRule{})) << host;
    }
}

TEST (LocalPeerRulePredicate, FailsClosedOnWhatIsNotAnAddress) {
    EXPECT_TRUE (is_refused_local_peer ("", OTHER_PORT, LocalPeerRule{}));
    EXPECT_TRUE (is_refused_local_peer ("fe80::1%eth0", OTHER_PORT, LocalPeerRule{}));
}

// A loopback source is this machine by any name, so any loopback peer on its
// port is its own; on another port, or link-local, it is not.
TEST (LocalPeerRulePredicate, ALoopbackSourceAllowsLoopbackOnItsOwnPortOnly) {
    for (const char* source : { "http://127.0.0.1:3000/spec.json",
         "http://localhost:3000/", "http://dev.localhost:3000/a.yaml",
         "http://[::1]:3000/", "http://LOCALHOST.:3000/" }) {
        const LocalPeerRule rule = rule_for (source);
        EXPECT_FALSE (is_refused_local_peer ("127.0.0.1", 3000, rule)) << source;
        EXPECT_FALSE (is_refused_local_peer ("::1", 3000, rule)) << source;
        EXPECT_TRUE (is_refused_local_peer ("127.0.0.1", 3001, rule)) << source;
        EXPECT_TRUE (is_refused_local_peer ("169.254.1.1", 3000, rule)) << source;
    }
}

TEST (LocalPeerRulePredicate, TheSourcePortIsTheSchemeDefaultWhenItNamesNone) {
    const LocalPeerRule rule = rule_for ("https://localhost/spec.json");
    EXPECT_FALSE (is_refused_local_peer ("127.0.0.1", 443, rule));
    EXPECT_TRUE (is_refused_local_peer ("127.0.0.1", 80, rule));
}

// A link-local peer is the source's only when the source names that address.
TEST (LocalPeerRulePredicate, ALinkLocalSourceAllowsOnlyItsOwnAddress) {
    const LocalPeerRule v4 = rule_for ("http://169.254.10.20:8080/spec.json");
    EXPECT_FALSE (is_refused_local_peer ("169.254.10.20", 8080, v4));
    EXPECT_TRUE (is_refused_local_peer ("169.254.10.21", 8080, v4));
    EXPECT_TRUE (is_refused_local_peer ("169.254.10.20", 8081, v4));
    EXPECT_TRUE (is_refused_local_peer ("127.0.0.1", 8080, v4));

    const LocalPeerRule v6 = rule_for ("http://[fe80::1]:8080/spec.json");
    EXPECT_FALSE (is_refused_local_peer ("fe80::1", 8080, v6));
    EXPECT_FALSE (is_refused_local_peer ("FE80:0:0::1", 8080, v6));
    EXPECT_TRUE (is_refused_local_peer ("fe80::2", 8080, v6));
}

// A source named by a host name earns nothing on loopback, even on its own
// port: a name that resolves there is what a rebinding DNS answer looks like.
TEST (LocalPeerRulePredicate, ASourceNamedByAHostNameEarnsNothing) {
    const LocalPeerRule rule =
    rule_for ("http://specs.example.com:3000/spec.json");
    EXPECT_TRUE (is_refused_local_peer ("127.0.0.1", 3000, rule));
    EXPECT_TRUE (is_refused_local_peer ("169.254.1.1", 3000, rule));
    EXPECT_FALSE (is_refused_local_peer ("93.184.215.14", 3000, rule));
}

TEST (LocalPeerRulePredicate, ASourceUrlNamingNoHostHasNoRule) {
    EXPECT_FALSE (vayu::http::local_peer_rule_for_source ("http://").has_value ());
    EXPECT_FALSE (vayu::http::local_peer_rule_for_source ("").has_value ());
}

// The URL half (#2605), which is all a proxied reference has: what the text
// names, in the spellings a URL parser reads, judged by the same source rule.
using vayu::http::is_refused_reference_url;

constexpr auto LOCAL_REFERENCE_URLS = std::to_array<const char*> (
{ "http://127.0.0.1:3000/a", "http://127.1/a", "http://0x7f.0.0.1/a",
"http://2130706433/a", "http://localhost/a", "http://LOCALHOST.:3000/a",
"http://dev.localhost/a", "http://[::1]/a", "http://[::ffff:127.0.0.1]/a",
"http://0.0.0.0/a", "http://[::]/a", "http://169.254.169.254/latest",
"http://[fe80::1]:8080/a", "https://user:pw@localhost/a" });

constexpr auto ELSEWHERE_REFERENCE_URLS = std::to_array<const char*> (
{ "http://example.com/a", "http://10.0.0.1/a", "http://localhost.example.com/a",
"http://127.example/a", "http://specs.example.test:3000/a", "http://[::2]/a" });

TEST (LocalPeerRulePredicate, AReferenceUrlNamingALocalHostIsRefusedByItsText) {
    for (const char* url : LOCAL_REFERENCE_URLS) {
        EXPECT_TRUE (is_refused_reference_url (url, LocalPeerRule{})) << url;
        EXPECT_TRUE (is_refused_reference_url (url, rule_for ("http://specs.example.test/")))
        << url;
    }
    for (const char* url : ELSEWHERE_REFERENCE_URLS) {
        EXPECT_FALSE (is_refused_reference_url (url, LocalPeerRule{})) << url;
    }
}

TEST (LocalPeerRulePredicate, AReferenceUrlNamingTheSourceIsNotRefused) {
    const LocalPeerRule loopback = rule_for ("http://localhost:3000/spec.json");
    for (const char* url : { "http://localhost:3000/a", "http://127.0.0.1:3000/a",
         "http://dev.localhost:3000/a", "http://[::1]:3000/a" }) {
        EXPECT_FALSE (is_refused_reference_url (url, loopback)) << url;
    }
    EXPECT_TRUE (is_refused_reference_url ("http://localhost:3001/a", loopback));
    EXPECT_TRUE (is_refused_reference_url ("http://169.254.1.1:3000/a", loopback));

    const LocalPeerRule link_local =
    rule_for ("http://169.254.10.20:8080/spec.json");
    EXPECT_FALSE (is_refused_reference_url ("http://169.254.10.20:8080/a", link_local));
    EXPECT_TRUE (is_refused_reference_url ("http://169.254.10.21:8080/a", link_local));

    EXPECT_TRUE (is_refused_reference_url ("http://127.0.0.1:3000/a",
    rule_for ("http://specs.example.com:3000/spec.json")))
    << "a source named by a host name earns nothing on loopback";
}

// How the rule recognises a configured proxy: by what its URL names, a
// loopback name meeting any loopback address and nothing else meeting a name.
TEST (LocalPeerRulePredicate, APeerIsNamedByItsAddressOrALoopbackName) {
    using vayu::http::is_peer_named_by;
    EXPECT_TRUE (is_peer_named_by ("127.0.0.1", 8888, "127.0.0.1", 8888));
    EXPECT_TRUE (is_peer_named_by ("127.0.0.1", 8888, "localhost", 8888));
    EXPECT_TRUE (is_peer_named_by ("::1", 8888, "localhost", 8888));
    EXPECT_TRUE (is_peer_named_by ("10.0.0.5", 3128, "10.0.0.5", 3128));
    EXPECT_FALSE (is_peer_named_by ("127.0.0.1", 8889, "127.0.0.1", 8888));
    EXPECT_FALSE (is_peer_named_by ("127.0.0.1", 8888, "proxy.example.com", 8888));
    EXPECT_FALSE (is_peer_named_by ("127.0.0.1", 8888, "", 8888));
    EXPECT_FALSE (is_peer_named_by ("", 8888, "localhost", 8888));
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

// The literal check reads the URL the handle is given (#2465): with encoding
// on, a leading space and a backslash are gone before libcurl parses the URL,
// so neither may hide the engine port from it. Mutation-check: let
// `validate_transferable` read `request.url` and both pass the gate.
TEST (LoopbackGuardRegistry, TheLiteralCheckReadsTheUrlTheWireSends) {
    const int port         = vayu::tests::engine_port_stand_in ().port ();
    const std::string tail = ":" + std::to_string (port) + "/x";
    for (const std::string& url : { " localhost" + tail, "http:\\\\localhost" + tail }) {
        vayu::Request request;
        request.url = url;
        const auto refused = vayu::http::detail::validate_transferable (request);
        ASSERT_HAS_VALUE (refused) << url;
        EXPECT_EQ (refused->code, vayu::ErrorCode::InvalidUrl) << url;
        EXPECT_NE (refused->message.find ("own engine port " + std::to_string (port)),
        std::string::npos)
        << url << ": " << refused->message;
    }
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

// A leading space the wire drops (#2465), where the proxy leaves the literal
// check as the only one that can refuse.
TEST_F (LoopbackGuardTransport, ALeadingSpaceDoesNotHideTheEnginePortFromAnyDriver) {
    vayu::tests::MockProxy proxy;
    vayu::http::TransportPolicy proxied;
    proxied.proxy_mode = vayu::http::ProxyMode::Manual;
    proxied.proxy_url  = proxy.url ();
    expect_refused_everywhere (
    " localhost:" + std::to_string (reserved_port) + "/echo", proxied);
    EXPECT_EQ (proxy.count (), 0U) << "the request was handed to the proxy";
}

// `disableUrlEncoding` sends the URL as typed, leading space included, and
// libcurl refuses that as malformed; the gate reads the same URL, so the
// refusal is about the space and nothing is dialled.
TEST_F (LoopbackGuardTransport, SentAsTypedALeadingSpaceIsAMalformedUrl) {
    const auto& stand_in  = vayu::tests::engine_port_stand_in ();
    const int seen_before = stand_in.requests_seen ();
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = " localhost:" + std::to_string (reserved_port) + "/echo";
    request.disable_url_encoding = true;
    vayu::http::ClientConfig config;
    config.transport = direct ();
    const vayu::Response response = vayu::http::Client{ config }.send (request).value ();

    EXPECT_EQ (response.error_code, vayu::ErrorCode::InvalidUrl) << response.error_message;
    EXPECT_NE (response.error_message.find ("space or control character"), std::string::npos)
    << response.error_message;
    EXPECT_EQ (stand_in.requests_seen (), seen_before);
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

// The reference rule rides the same callback as the reserved ports, on the
// single-request client that `/import/fetch` sends with.

/// One GET to @p url through a client carrying @p rule, proxy off.
vayu::Response send_with_rule (const std::string& url, const LocalPeerRule& rule) {
    vayu::http::ClientConfig config;
    config.transport.proxy_mode = vayu::http::ProxyMode::Off;
    config.local_peer_rule      = rule;
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = url;
    return vayu::http::Client{ config }.send (request).value ();
}

TEST_F (LoopbackGuardTransport, TheReferenceRuleRefusesAPeerAndNamesItself) {
    vayu::tests::EchoServer local;
    const vayu::Response response = send_with_rule (local.url (), LocalPeerRule{});

    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, vayu::ErrorCode::InvalidUrl) << response.error_message;
    EXPECT_EQ (response.error_message,
    "Cannot send this request: " + vayu::http::local_peer_refusal ());
    EXPECT_EQ (local.requests_seen (), 0);
}

// The reference rule is added to the reserved ports, never in place of them:
// a source on the engine's own port does not make that port reachable, and the
// refusal is the engine-port sentence.
TEST_F (LoopbackGuardTransport, TheReferenceRuleNeverOpensAReservedPort) {
    const auto& stand_in          = vayu::tests::engine_port_stand_in ();
    const int seen_before         = stand_in.requests_seen ();
    const std::string url         = on_reserved_port ("vayu-guard.localhost");
    const vayu::Response response = send_with_rule (url, rule_for (url));

    EXPECT_EQ (response.error_code, vayu::ErrorCode::InvalidUrl) << response.error_message;
    EXPECT_NE (response.error_message.find ("own engine port " + std::to_string (reserved_port)),
    std::string::npos)
    << response.error_message;
    EXPECT_EQ (stand_in.requests_seen (), seen_before);
}

} // namespace
