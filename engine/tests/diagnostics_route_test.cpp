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

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <string>
#include <thread>
#include <utility>

#include <nlohmann/json.hpp>

#include "proxy_server.hpp"
#include "vayu/http/transport_policy.hpp"

namespace vayu::http::routes {
// Declared in diagnostics.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> connection_test (const std::string& request_body,
const vayu::http::TransportPolicy& transport);
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

TEST (ConnectionTest, RejectsInvalidJson) {
    auto [status, body] = connection_test ("not json", TransportPolicy{});
    EXPECT_EQ (status, 400);
    EXPECT_TRUE (body.contains ("error"));
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
    // whenever this engine is the one that knows it.
    MockProxy proxy;
    TransportPolicy policy;
    policy.proxy_mode = ProxyMode::Manual;
    policy.proxy_url  = proxy.url ();

    auto [status, body] = connection_test (test_body ("https://127.0.0.1:1/x"), policy);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["proxy"]["mode"].get<std::string> (), "manual");
    EXPECT_EQ (body["proxy"]["url"].get<std::string> (), proxy.url ());
}

TEST (ConnectionTest, OmitsTheProxyUrlWhenTheEngineDoesNotKnowIt) {
    // `environment` is libcurl's own variable pickup: this engine never reads
    // those variables, so it must not print a URL it does not have. An absent
    // key means "not this engine's to say", never "no proxy".
    MockTarget target;
    auto [status, body] =
    connection_test (test_body (target.url ("/ok")), TransportPolicy{});

    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["proxy"]["mode"].get<std::string> (), "environment");
    EXPECT_FALSE (body["proxy"].contains ("url"));
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
