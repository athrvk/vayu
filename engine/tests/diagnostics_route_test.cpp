/**
 * @file tests/diagnostics_route_test.cpp
 * @brief Tests for the connection test (`POST /diagnostics/connection`, #708).
 *
 * The route's whole value is that its outcomes are *distinct* - a proxy that
 * refused is not a server that is down - so every test here asserts which
 * outcome came back rather than that something failed. The proxy cases run
 * against the same in-process `MockProxy` the transport-policy suite uses,
 * because a proxy failure is only real if a proxy really refused.
 */

// First, before anything that includes <httplib.h>: see the header.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>
#include <httplib.h>

#include <atomic>
#include <chrono>
#include <string>
#include <thread>
#include <utility>

#include <nlohmann/json.hpp>

#include "nested_json.hpp"
#include "proxy_server.hpp"
#include "scoped_env.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/transport_policy.hpp"

namespace vayu::http::routes {
// Declared in diagnostics.cpp; returns {http_status, json_body}. No server
// owns these sends, so nothing cancels them.
std::pair<int, nlohmann::json> connection_test (const std::string& request_body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel = nullptr);
} // namespace vayu::http::routes

namespace {

using vayu::http::ProxyMode;
using vayu::http::TransportPolicy;
using vayu::http::routes::connection_test;
using vayu::tests::MockProxy;

/// A listener that answers HEAD - which is what the probe sends - and nothing
/// else it needs.
class MockTarget {
    public:
    MockTarget () {
        svr_.Get ("/ok", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("body the test must never see", "text/plain");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }
    ~MockTarget () {
        svr_.stop ();
        if (thread_.joinable ())
            thread_.join ();
    }
    MockTarget (const MockTarget&)            = delete;
    MockTarget& operator= (const MockTarget&) = delete;
    MockTarget (MockTarget&&)                 = delete;
    MockTarget& operator= (MockTarget&&)      = delete;
    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + path;
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

std::string test_body (const std::string& url) {
    return nlohmann::json{ { "url", url } }.dump ();
}

constexpr const char* PROXY_PASSWORD = "s3cret";

/// @p proxy_url with a `user:password@` authority, the shape a corporate proxy
/// is configured in and the shape that must never come back out.
std::string with_credentials (const std::string& proxy_url) {
    const std::string scheme = "http://";
    return scheme + "alice:" + PROXY_PASSWORD + "@" + proxy_url.substr (scheme.size ());
}

/// The fixture for a test that sets a proxy variable or reads the absence of
/// one.
class ConnectionTestEnvironment : public ::testing::Test {
    private:
    vayu::tests::ScopedProxyEnvironmentCleared cleared_;
};

TEST (ConnectionTest, RejectsInvalidJson) {
    auto [status, body] = connection_test ("not json", TransportPolicy{});
    EXPECT_EQ (status, 400);
    EXPECT_TRUE (body.contains ("error"));
}

// The deep value rides beside a url that would otherwise be probed, so a
// missing bound shows as a 200 outcome and a crash on the first copy.
TEST (ConnectionTest, RefusesABodyNestedPastTheBound) {
    constexpr std::size_t bound = vayu::core::constants::request_body::MAX_JSON_DEPTH;
    const std::string deep = vayu::tests::nested_array_text (100000);
    auto [status, body]    = connection_test (
    R"({"url":"http://127.0.0.1:1/x","extra":)" + deep + "}", TransportPolicy{});
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["message"].get<std::string> (),
    "request body is nested deeper than " + std::to_string (bound) + " levels");
}

TEST (ConnectionTest, RejectsANonHttpUrl) {
    auto [status, body] =
    connection_test (test_body ("ftp://files.example/x"), TransportPolicy{});
    EXPECT_EQ (status, 400);
}

TEST (ConnectionTest, RejectsAMissingUrl) {
    auto [status, body] = connection_test ("{}", TransportPolicy{});
    EXPECT_EQ (status, 400);
}

TEST (ConnectionTest, ReportsAReachableEndpoint) {
    MockTarget target;
    auto [status, body] =
    connection_test (test_body (target.url ("/ok")), TransportPolicy{});

    EXPECT_EQ (status, 200);
    EXPECT_EQ (body["outcome"].get<std::string> (), "ok");
    EXPECT_EQ (body["status"].get<int> (), 200);
}

TEST (ConnectionTest, NeverReturnsWhatCameBack) {
    // The scope guard from the issue, asserted rather than trusted: this is a
    // diagnostics surface on the localhost API and must not become a general
    // fetch proxy. A body key added here would make it one.
    MockTarget target;
    auto [status, body] =
    connection_test (test_body (target.url ("/ok")), TransportPolicy{});

    ASSERT_EQ (status, 200);
    for (const char* forbidden : { "body", "content", "headers", "response" }) {
        EXPECT_FALSE (body.contains (forbidden))
        << forbidden << " would make the connection test a fetch proxy";
    }
    EXPECT_EQ (body.dump ().find ("body the test must never see"), std::string::npos);
}

TEST (ConnectionTest, ReportsAnUnreachableEndpointAsAConnectionFailure) {
    // Port 1 is not listening. Distinctly *not* a proxy failure: the whole
    // point is that a user reads which hop broke.
    auto [status, body] =
    connection_test (test_body ("http://127.0.0.1:1/x"), TransportPolicy{});

    EXPECT_EQ (status, 200)
    << "the test answered; the connection is what failed";
    EXPECT_EQ (body["outcome"].get<std::string> (), "failed");
    EXPECT_EQ (body["errorCode"].get<std::string> (), "CONNECTION_FAILED");
    EXPECT_FALSE (body["detail"].get<std::string> ().empty ());
}

TEST (ConnectionTest, ReportsAProxyRefusalAsAProxyFailure) {
    // MockProxy answers every CONNECT with a 407, which is exactly the shape
    // that used to surface as INTERNAL_ERROR (issue #705). Reaching it needs an
    // https target, since that is what makes curl tunnel - nothing has to be
    // listening behind it, because the refusal happens at the proxy.
    MockProxy proxy;
    TransportPolicy policy;
    policy.proxy_mode = ProxyMode::Manual;
    policy.proxy_url  = proxy.url ();

    auto [status, body] = connection_test (test_body ("https://127.0.0.1:1/x"), policy);

    EXPECT_EQ (status, 200);
    EXPECT_EQ (body["outcome"].get<std::string> (), "proxy_failed");
    EXPECT_EQ (body["errorCode"].get<std::string> (), "PROXY_ERROR");
    EXPECT_GE (proxy.count (), 1u)
    << "the refusal has to have come from the proxy";
}

TEST (ConnectionTest, NamesTheProxyTheTestWentThrough) {
    // The card has to be able to say where the bytes went without re-deriving
    // each mode's rules - so the mode always travels, and the URL travels
    // whenever a proxy was in force. The URL comes back without its userinfo:
    // the body reaches a screen and an agent's context. Mutation check: drop
    // the `strip_url_secrets` in `proxy_node` and the password is in the body.
    MockProxy proxy;
    TransportPolicy policy;
    policy.proxy_mode = ProxyMode::Manual;
    policy.proxy_url  = with_credentials (proxy.url ());

    auto [status, body] = connection_test (test_body ("https://127.0.0.1:1/x"), policy);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["proxy"]["mode"].get<std::string> (), "manual");
    EXPECT_EQ (body["proxy"]["url"].get<std::string> (), proxy.url ());
    EXPECT_FALSE (body["proxy"].contains ("source"))
    << "the URL is the setting in force, not something the environment "
       "supplied";
    EXPECT_EQ (body.dump ().find (PROXY_PASSWORD), std::string::npos);
}

TEST_F (ConnectionTestEnvironment, OmitsTheProxyWhenTheProbeWentDirect) {
    // `environment` with nothing exported: libcurl sent the probe straight to
    // the target, so there is no proxy to name.
    MockTarget target;
    auto [status, body] =
    connection_test (test_body (target.url ("/ok")), TransportPolicy{});

    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["proxy"]["mode"].get<std::string> (), "environment");
    EXPECT_FALSE (body["proxy"].contains ("url"));
    EXPECT_FALSE (body["proxy"].contains ("source"));
}

TEST_F (ConnectionTestEnvironment, OmitsAConfiguredProxyThatProxyBypassSkipped) {
    // A `manual` proxy whose bypass list names the target: libcurl goes direct,
    // so naming the configured proxy would report a hop the probe never took.
    // Mutation check: drop the `completed && !proxy_used` return in
    // `proxy_node` and the configured URL is named.
    MockTarget target;
    MockProxy proxy;
    TransportPolicy policy;
    policy.proxy_mode   = ProxyMode::Manual;
    policy.proxy_url    = proxy.url ();
    policy.proxy_bypass = "127.0.0.1";

    auto [status, body] = connection_test (test_body (target.url ("/ok")), policy);

    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["outcome"].get<std::string> (), "ok");
    EXPECT_EQ (proxy.count (), 0u);
    EXPECT_EQ (body["proxy"]["mode"].get<std::string> (), "manual");
    EXPECT_FALSE (body["proxy"].contains ("url"));
}

TEST_F (ConnectionTestEnvironment, OmitsAnExportedProxyThatNoProxyExempted) {
    // The variable is set and names a live proxy, but `no_proxy` sends this
    // target direct: naming the exported proxy would report a hop the probe
    // never took. Mutation check: drop the `proxy_used` guard in `proxy_node`
    // and the exported proxy is named.
    MockTarget target;
    MockProxy proxy;
    vayu::tests::ScopedEnv exported ("http_proxy", proxy.url ());
    vayu::tests::ScopedEnv exempt ("no_proxy", "127.0.0.1");

    auto [status, body] =
    connection_test (test_body (target.url ("/ok")), TransportPolicy{});

    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["outcome"].get<std::string> (), "ok");
    EXPECT_EQ (proxy.count (), 0u);
    EXPECT_FALSE (body["proxy"].contains ("url"));
    EXPECT_FALSE (body["proxy"].contains ("source"));
}

TEST_F (ConnectionTestEnvironment, NamesTheEnvironmentsProxyWhenSystemResolvedNothing) {
    // `system` with an empty `proxySystemUrl` leaves CURLOPT_PROXY null, so the
    // proxy is whatever the environment exports - which the engine reports as
    // such, credentials removed. Mutation check: report no `source` or `url`
    // here (the old `proxy_node`) and both assertions fail.
    MockTarget target;
    MockProxy proxy;
    proxy.forward_every_target_to (target.url (""));
    vayu::tests::ScopedEnv exported ("http_proxy", with_credentials (proxy.url ()));

    TransportPolicy policy;
    policy.proxy_mode = ProxyMode::System;

    auto [status, body] = connection_test (test_body (target.url ("/ok")), policy);

    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["outcome"].get<std::string> (), "ok");
    EXPECT_EQ (proxy.count (), 1u) << "the probe has to have gone through it";
    EXPECT_EQ (body["proxy"]["mode"].get<std::string> (), "system");
    EXPECT_EQ (body["proxy"]["source"].get<std::string> (), "environment");
    EXPECT_EQ (body["proxy"]["url"].get<std::string> (), proxy.url ());
    EXPECT_EQ (body.dump ().find (PROXY_PASSWORD), std::string::npos);
}

TEST_F (ConnectionTestEnvironment, ReadsTheVariableTheTargetsSchemeSelects) {
    // An https target tunnels through `https_proxy`; the `http_proxy` beside it
    // names a host nothing listens on, so naming it would be the wrong hop.
    MockProxy proxy;
    vayu::tests::ScopedEnv unused ("http_proxy", "http://wrong-hop.invalid:1");
    vayu::tests::ScopedEnv exported ("https_proxy", proxy.url ());

    auto [status, body] =
    connection_test (test_body ("https://127.0.0.1:1/x"), TransportPolicy{});

    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["outcome"].get<std::string> (), "proxy_failed");
    EXPECT_EQ (body["proxy"]["source"].get<std::string> (), "environment");
    EXPECT_EQ (body["proxy"]["url"].get<std::string> (), proxy.url ());
}

TEST (ConnectionTest, ReportsAnUnresolvableProxyAsAProxyFailure) {
    // The failure a mistyped proxy host actually produces, and the one that
    // used to send users debugging an endpoint that was never reached. `.invalid`
    // is reserved by RFC 2606 and resolves nowhere, so this needs no listener.
    TransportPolicy policy;
    policy.proxy_mode = ProxyMode::Manual;
    policy.proxy_url  = "http://vayu-no-such-proxy.invalid:8080";

    auto [status, body] =
    connection_test (test_body ("http://example.invalid/x"), policy);

    EXPECT_EQ (status, 200);
    EXPECT_EQ (body["outcome"].get<std::string> (), "proxy_failed");
    EXPECT_EQ (body["errorCode"].get<std::string> (), "PROXY_ERROR");
}

TEST (ConnectionTest, ReportsAForwardingProxysChallengeAsAProxyFailure) {
    // An http:// target needs no CONNECT, so a proxy that wants credentials
    // answers the probe itself with a plain 407, which is `ok` with status 407
    // unless the client attributes it to the proxy (#3257). Mutation check:
    // drop `proxy_authentication_refusal` from `Client::send` and this reads
    // `ok`.
    MockProxy proxy;
    proxy.refuse_every_request ();
    TransportPolicy policy;
    policy.proxy_mode = ProxyMode::Manual;
    policy.proxy_url  = proxy.url ();

    auto [status, body] =
    connection_test (test_body ("http://example.invalid/x"), policy);

    EXPECT_EQ (status, 200);
    EXPECT_EQ (body["outcome"].get<std::string> (), "proxy_failed");
    EXPECT_EQ (body["errorCode"].get<std::string> (), "PROXY_ERROR");
    EXPECT_NE (body["detail"].get<std::string> ().find ("407"), std::string::npos)
    << body["detail"].get<std::string> ();
    EXPECT_FALSE (body.contains ("status"));
    EXPECT_GE (proxy.count (), 1u)
    << "the challenge has to have come from the proxy";
}

TEST (ConnectionTest, ReportsAProxyThatIsDownAsAProxyFailure) {
    // Nothing listens on the proxy's port. The refused socket is the proxy's,
    // and the target (reachable or not) was never dialled; reported as the
    // target's `failed` it sent users to a server that was fine (#3257).
    // Mutation check: map `CURLE_COULDNT_CONNECT` to `ConnectionFailed`
    // unconditionally and both targets read `failed`.
    TransportPolicy policy;
    policy.proxy_mode = ProxyMode::Manual;
    policy.proxy_url  = vayu::tests::closed_loopback_origin ();

    for (const char* target : { "http://example.invalid/x", "https://example.invalid/x" }) {
        auto [status, body] = connection_test (test_body (target), policy);

        EXPECT_EQ (status, 200) << target;
        EXPECT_EQ (body["outcome"].get<std::string> (), "proxy_failed") << target;
        EXPECT_EQ (body["errorCode"].get<std::string> (), "PROXY_ERROR") << target;
    }
}

TEST (ConnectionTest, CarriesTheClientCertificateKeyOnEveryAnswer) {
    // Sent always, "" included, the same way POST /execute sends it: a caller
    // can then tell "no certificate was used" from "this engine cannot say".
    MockTarget target;
    auto [status, body] =
    connection_test (test_body (target.url ("/ok")), TransportPolicy{});

    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("clientCertificate"));
    EXPECT_EQ (body["clientCertificate"].get<std::string> (), "");
}

} // namespace
