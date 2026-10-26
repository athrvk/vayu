/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/script_response_redirects_test.cpp
 * @brief `pm.response.redirects` - the followed 3xx hops a post-request script
 *        reads (issue #2949).
 *
 * The engine records each hop's status, URL, headers and https-to-http flag; a
 * field nothing reads is the codebase's most repeated defect, and the script is
 * the reader a test author has. The decision pinned here is the one
 * `pm.response.events` makes, applied to a different fact: an empty array is a
 * recorded "nothing was redirected", and an *absent* property is "not recorded"
 * (the load path follows redirects without keeping the chain), so a script
 * asserting `redirects.length === 0` can never pass over a chain nobody saw.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <memory>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "step_elements_test_helper.hpp"
#include "task_queue.hpp"
#include "tls_server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace vayu::runtime {
namespace {

/// `pm.test` around one block, so a failed assertion reports its own message
/// rather than an execution error.
std::string asserting (const std::string& body) {
    return "pm.test(\"redirects\", function() { " + body + " });";
}

/// @p text as a JS string literal.
std::string quoted (const std::string& text) {
    return nlohmann::json (text).dump ();
}

void expect_single_pass (const ScriptResult& result) {
    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// ---------------------------------------------------------------------------
// The binding, over hops built by hand - which is the only way to reach the
// https-to-http branch without a TLS listener.
// ---------------------------------------------------------------------------

class ResponseRedirectsBindingTest : public ::testing::Test {
    protected:
    ScriptResult run (const std::string& script, const std::vector<RedirectHop>* hops) {
        ScriptContext ctx = ScriptContext::for_test (request, response);
        ctx.environment   = &env;
        ctx.redirect_hops = hops;
        return engine.execute (script, ctx);
    }

    ScriptEngine engine;
    Request request;
    Response response;
    Environment env;
};

// Mutation-check: skip `install_response_redirects` in `setup_pm_response` and
// every property below reads `undefined`.
TEST_F (ResponseRedirectsBindingTest, EachHopCarriesItsCodeStatusUrlAndDowngradeFlag) {
    const std::vector<RedirectHop> hops = {
        { 301, "Moved Permanently", {}, "https://a.test/start", true },
        { 302, "Found", {}, "http://a.test/next", false },
    };

    const auto result = run (asserting (R"JS(
        var hops = pm.response.redirects;
        pm.expect(hops.length).to.equal(2);
        pm.expect(hops[0].code).to.equal(301);
        pm.expect(hops[0].status).to.equal("Moved Permanently");
        pm.expect(hops[0].url).to.equal("https://a.test/start");
        pm.expect(hops[0].schemeDowngrade).to.equal(true);
        pm.expect(hops[1].code).to.equal(302);
        pm.expect(hops[1].url).to.equal("http://a.test/next");
        pm.expect(hops[1].schemeDowngrade).to.equal(false);
    )JS"),
    &hops);

    expect_single_pass (result);
}

// The headers are the hop's own, in the shape `pm.response.headers` has: a
// lower-cased key, get()/has() that ignore case, a repeated name folded.
// Mutation-check: build the object from `response.headers` instead of the hop's
// lines and the hop reads the final response's headers.
TEST_F (ResponseRedirectsBindingTest, AHopsHeadersAreItsOwnInTheShapeOfPmResponseHeaders) {
    response.headers                    = { { "x-final", "yes" } };
    const std::vector<RedirectHop> hops = { { 302, "Found",
    { { "Location", "/landing" }, { "Set-Cookie", "a=1" }, { "Set-Cookie", "b=2" } },
    "https://a.test/login", false } };

    const auto result = run (asserting (R"JS(
        var headers = pm.response.redirects[0].headers;
        pm.expect(headers.get("LOCATION")).to.equal("/landing");
        pm.expect(headers["location"]).to.equal("/landing");
        pm.expect(headers.has("set-cookie", "a=1, b=2")).to.equal(true);
        pm.expect(headers.has("x-final")).to.equal(false);
    )JS"),
    &hops);

    expect_single_pass (result);
}

// Mutation-check: bind `redirects` only when the vector is non-empty and this
// reads `undefined`.
TEST_F (ResponseRedirectsBindingTest, ARecordedChainOfNoHopsIsAnEmptyArray) {
    const std::vector<RedirectHop> hops;

    const auto result = run (asserting (R"JS(
        pm.expect(Array.isArray(pm.response.redirects)).to.equal(true);
        pm.expect(pm.response.redirects.length).to.equal(0);
    )JS"),
    &hops);

    expect_single_pass (result);
}

// Mutation-check: bind an empty array when the pointer is null and `typeof`
// answers "object".
TEST_F (ResponseRedirectsBindingTest, AnUnrecordedChainIsAbsentNotEmpty) {
    const auto result = run (asserting (R"JS(
        pm.expect(typeof pm.response.redirects).to.equal("undefined");
    )JS"),
    nullptr);

    expect_single_pass (result);
}

// Contexts are pooled, so the binding is rebuilt per execution: a chain read in
// one script must not be standing in the next one's `pm.response`.
TEST_F (ResponseRedirectsBindingTest, AChainDoesNotSurviveIntoTheNextExecution) {
    const std::vector<RedirectHop> hops = { { 302, "Found", {}, "https://a.test/x", false } };
    expect_single_pass (
    run (asserting ("pm.expect(pm.response.redirects.length).to.equal(1);"), &hops));

    expect_single_pass (
    run (asserting (
         "pm.expect(typeof pm.response.redirects).to.equal(\"undefined\");"),
    nullptr));
}

// ---------------------------------------------------------------------------
// The wiring: a real send through `execute_exchange`, the path a design send
// and a sequential collection run both take.
// ---------------------------------------------------------------------------

class RedirectingServer {
    public:
    RedirectingServer () {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (2);
        svr_.Get ("/chain", [] (const httplib::Request&, httplib::Response& res) {
            res.set_header ("Set-Cookie", "hop=1; Path=/");
            res.set_redirect ("/middle", 301);
        });
        svr_.Get ("/middle", [] (const httplib::Request&, httplib::Response& res) {
            res.set_redirect ("/end", 302);
        });
        svr_.Get ("/end", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("done", "text/plain");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }
    ~RedirectingServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    RedirectingServer (const RedirectingServer&)            = delete;
    RedirectingServer& operator= (const RedirectingServer&) = delete;
    RedirectingServer (RedirectingServer&&)                 = delete;
    RedirectingServer& operator= (RedirectingServer&&)      = delete;

    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + path;
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

class ResponseRedirectsExchangeTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<RedirectingServer> ();
    }
    void TearDown () override {
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    /// One exchange as the route runs it: a real send, then @p post_script
    /// against what came back.
    vayu::http::routes::ExchangeOutcome
    send (const std::string& url, const std::string& post_script, bool verify_ssl = true) {
        ScriptEngine engine;
        vayu::http::CookieJar jar;
        vayu::http::routes::ScriptVariableScopes scopes;

        Request request;
        request.method     = HttpMethod::GET;
        request.url        = url;
        request.verify_ssl = verify_ssl;

        vayu::http::routes::ExchangeInputs inputs;
        inputs.request = std::move (request);
        inputs.elements = vayu::tests::step_elements_with_post_script (post_script);
        return execute_exchange (engine, jar, "", scopes, std::move (inputs));
    }

    std::unique_ptr<RedirectingServer> server_;
};

// Mutation-check: drop `post_ctx.redirect_hops = ...` in request_exchange.cpp
// and `redirects` is absent here, though the client recorded both hops.
TEST_F (ResponseRedirectsExchangeTest, APostScriptReadsTheHopsTheClientFollowed) {
    const std::string first  = quoted (server_->url ("/chain"));
    const std::string second = quoted (server_->url ("/middle"));

    const auto outcome = send (server_->url ("/chain"), asserting (R"JS(
        var hops = pm.response.redirects;
        pm.expect(pm.response.code).to.equal(200);
        pm.expect(hops.length).to.equal(2);
        pm.expect(hops[0].code).to.equal(301);
        pm.expect(hops[0].url).to.equal()JS" + first + R"JS();
        pm.expect(hops[0].schemeDowngrade).to.equal(false);
        pm.expect(hops[0].headers.get("set-cookie")).to.equal("hop=1; Path=/");
        pm.expect(hops[1].code).to.equal(302);
        pm.expect(hops[1].url).to.equal()JS" + second + R"JS();
    )JS"));

    expect_single_pass (outcome.post_script_result);
}

TEST_F (ResponseRedirectsExchangeTest, ASendThatWasNotRedirectedReadsAnEmptyArray) {
    const auto outcome = send (server_->url ("/end"), asserting (R"JS(
        pm.expect(pm.response.redirects.length).to.equal(0);
    )JS"));

    expect_single_pass (outcome.post_script_result);
}

// The downgrade is the one hop a header-placed credential crosses in clear
// text, so the flag has to survive to the script the author would write the
// check in. The listener is TLS and its `/bounce` answers with a plain-http
// Location. Mutation-check: make `is_scheme_downgrade` answer false and the
// first hop reads `false`.
TEST_F (ResponseRedirectsExchangeTest, AnHttpsToHttpHopIsFlaggedForTheScript) {
    const vayu::tests::TestCertificateAuthority ca;
    const vayu::tests::TlsServer tls (ca);

    const auto outcome = send (tls.url ("/bounce?to=" + server_->url ("/end")), asserting (R"JS(
        var hops = pm.response.redirects;
        pm.expect(hops.length).to.equal(1);
        pm.expect(hops[0].schemeDowngrade).to.equal(true);
        pm.expect(hops[0].url.indexOf("https://")).to.equal(0);
    )JS"),
    /*verify_ssl=*/false);

    expect_single_pass (outcome.post_script_result);
}

} // namespace
} // namespace vayu::runtime
