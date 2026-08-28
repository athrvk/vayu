/**
 * @file tests/script_send_request_test.cpp
 * @brief `pm.sendRequest` (issue #302): the capability gate, the argument
 *        shapes, and the two boundaries that bound a blocking call - the
 *        script's wall-clock budget and the per-script request cap.
 *
 * The failure paths carry most of the weight here. `pm.sendRequest` is the
 * first thing in the sandbox that blocks on the network, and the ways that can
 * go wrong are the ways a user actually meets it: a refused connection, a host
 * that does not resolve, a server that never answers. Each has to reach the
 * callback as an error rather than throw out of the script or hang the thread,
 * and none of them may outlive the budget the user set for the script.
 *
 * A local mock server rather than `mock_server.hpp`'s `SlowMockServer`: these
 * cases need routes it has no reader for (a token payload, a request echo, a
 * hit counter), and the suite's convention is that test-specific routes live
 * with their tests - `curl_transfer_test.cpp` does the same.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <string>
#include <thread>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "task_queue.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

using vayu::runtime::ScriptConfig;
using vayu::runtime::ScriptContext;
using vayu::runtime::ScriptEngine;

namespace {

constexpr int REQUEST_CAP = vayu::core::constants::script_engine::SEND_REQUEST_LIMIT;

// How long /slow holds a connection. Comfortably longer than every "this
// returned promptly" assertion below, so a missing clamp shows up as a failure
// rather than as a slow pass.
constexpr int SLOW_MS = 3000;

class SendRequestServer {
    public:
    SendRequestServer () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (16);

        svr.Get ("/token", [this] (const httplib::Request&, httplib::Response& res) {
            hits.fetch_add (1, std::memory_order_relaxed);
            res.set_content (R"({"access_token":"tok_123","expires_in":3600})",
            "application/json");
        });

        // Echoes what arrived, so a test can assert the method, body and
        // headers the script asked for are the ones that went on the wire.
        svr.Post ("/echo", [this] (const httplib::Request& req, httplib::Response& res) {
            hits.fetch_add (1, std::memory_order_relaxed);
            nlohmann::json echo;
            echo["method"] = req.method;
            echo["body"]   = req.body;
            echo["marker"] = req.get_header_value ("X-Marker");
            echo["type"]   = req.get_header_value ("Content-Type");
            // The three an auth block can land in: the composed Authorization
            // line, an api key's own header, and the target with its query,
            // which is where an api key sent as a parameter shows up.
            echo["auth"]   = req.get_header_value ("Authorization");
            echo["apikey"] = req.get_header_value ("X-Api-Key");
            echo["target"] = req.target;
            res.set_content (echo.dump (), "application/json");
        });

        svr.Get ("/slow", [this] (const httplib::Request&, httplib::Response& res) {
            hits.fetch_add (1, std::memory_order_relaxed);
            auto deadline =
            std::chrono::steady_clock::now () + std::chrono::milliseconds (SLOW_MS);
            while (!released.load (std::memory_order_relaxed) &&
            std::chrono::steady_clock::now () < deadline) {
                std::this_thread::sleep_for (std::chrono::milliseconds (10));
            }
            res.set_content ("{}", "application/json");
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~SendRequestServer () {
        // httplib's stop() does not interrupt a handler already running, so
        // /slow is released first or teardown waits out SLOW_MS.
        released.store (true, std::memory_order_relaxed);
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }
    SendRequestServer (const SendRequestServer&)            = delete;
    SendRequestServer& operator= (const SendRequestServer&) = delete;
    SendRequestServer (SendRequestServer&&)                 = delete;
    SendRequestServer& operator= (SendRequestServer&&)      = delete;

    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    int hit_count () const {
        return hits.load (std::memory_order_relaxed);
    }

    private:
    httplib::Server svr;
    std::thread thread;
    int port = 0;
    std::atomic<int> hits{ 0 };
    std::atomic<bool> released{ false };
};

// Port 1: connection refused, fast fail. The suite's existing spelling for an
// unreachable endpoint (`http_client_test.cpp`, `event_loop_test.cpp`) rather
// than a locally bound-then-dropped port - httplib's Server leaves its listener
// open when it was never started, so connections to it queue in the backlog and
// time out instead of being refused.
constexpr const char* REFUSED_URL = "http://127.0.0.1:1/";

class SendRequestTest : public ::testing::Test {
    protected:
    // A test script, run with pm.sendRequest allowed. The default is deny, so
    // every test that expects a send has to say so - which is the point.
    vayu::ScriptResult run (const std::string& script, uint64_t timeout_ms = 5000) {
        ScriptConfig config;
        config.timeout_ms         = timeout_ms;
        config.allow_send_request = true;
        ScriptEngine engine (config);
        return execute (engine, script);
    }

    // The same script with the engine left at its defaults - what a caller
    // that never asked for the capability gets, MCP included.
    vayu::ScriptResult run_denied (const std::string& script) {
        ScriptEngine engine{ ScriptConfig{} };
        return execute (engine, script);
    }

    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;

    private:
    vayu::ScriptResult execute (ScriptEngine& engine, const std::string& script) {
        response.status_code = 200;
        auto ctx             = ScriptContext::for_test (request, response);
        ctx.environment      = &env;
        return engine.execute (script, ctx);
    }
};

// Milliseconds a callable took, for the assertions that a bounded call really
// is bounded.
template <typename Fn> int64_t elapsed_ms (Fn&& fn) {
    const auto start = std::chrono::steady_clock::now ();
    fn ();
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - start)
    .count ();
}

// ============================================================================
// The capability gate
// ============================================================================

// The whole security argument in one test: the MCP allowlist is checked in the
// MCP server before it calls the engine, so a script-issued request would
// bypass it. A caller that does not ask for the capability - MCP never does -
// must get nothing on the wire.
TEST_F (SendRequestTest, DeniedByDefaultAndNothingReachesTheServer) {
    SendRequestServer server;

    auto result = run_denied ("pm.sendRequest('" + server.url ("/token") +
    "', function (err, res) { pm.test('unreachable', function () {}); });");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.sendRequest is not available"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (server.hit_count (), 0)
    << "a denied script still reached the network";
    EXPECT_TRUE (result.tests.empty ())
    << "the callback ran despite the denial";
}

// A missing global would report "TypeError: not a function", which names
// nothing (issue #134). The binding exists so the denial can explain itself.
TEST_F (SendRequestTest, IsBoundEvenWhenDenied) {
    auto result =
    run_denied ("pm.test('bound', function () { "
                "  pm.expect(typeof pm.sendRequest).to.equal('function'); "
                "});");

    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// ============================================================================
// The success path
// ============================================================================

TEST_F (SendRequestTest, DeliversTheResponseToTheCallback) {
    SendRequestServer server;

    auto result = run ("var seen = {}; "
                       "pm.sendRequest('" +
    server.url ("/token") +
    "', function (err, res) { "
    "  seen.err = err; seen.code = res.code; seen.status = res.status; "
    "  seen.token = res.json().access_token; "
    "  seen.text = res.text(); "
    "  seen.type = res.headers.get('content-type'); "
    "}); "
    "pm.test('shape', function () { "
    "  pm.expect(seen.err).to.equal(null); "
    "  pm.expect(seen.code).to.equal(200); "
    "  pm.expect(seen.status).to.equal(200); "
    "  pm.expect(seen.token).to.equal('tok_123'); "
    "  pm.expect(seen.type).to.equal('application/json'); "
    "  pm.expect(seen.text.length > 0).to.equal(true); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (server.hit_count (), 1);
}

TEST_F (SendRequestTest, TheCallbackResponseCarriesTheHeaderPropertyListReads) {
    // The third header object. It is built by the same `install_header_methods`
    // the two pm.* ones are, so this is the assertion that keeps that true
    // rather than a second surface drifting behind.
    SendRequestServer server;

    auto result = run ("var seen = {}; "
                       "pm.sendRequest('" +
    server.url ("/token") +
    "', function (err, res) { "
    "  seen.count = res.headers.count(); "
    "  seen.keys = res.headers.all().map(function (h) { return h.key; }); "
    "  seen.type = res.headers.toObject()['content-type']; "
    "  seen.one = res.headers.one('CONTENT-TYPE').value; "
    "  seen.index = res.headers.indexOf('X-Absent'); "
    "  seen.walked = []; "
    "  res.headers.each(function (h) { seen.walked.push(h.key); }); "
    "  seen.enumerated = Object.keys(res.headers).length; "
    "}); "
    "pm.test('reads', function () { "
    "  pm.expect(seen.count > 0).to.equal(true); "
    "  pm.expect(seen.keys.length).to.equal(seen.count); "
    "  pm.expect(seen.walked.length).to.equal(seen.count); "
    // The methods are non-enumerable here too, so enumerating the object sees
    // the headers and nothing else - the guard the two pm.* objects have.
    "  pm.expect(seen.enumerated).to.equal(seen.count); "
    "  pm.expect(seen.type).to.equal('application/json'); "
    "  pm.expect(seen.one).to.equal('application/json'); "
    "  pm.expect(seen.index).to.equal(-1); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (SendRequestTest, OptionsObjectCarriesMethodHeadersAndBody) {
    SendRequestServer server;

    auto result = run ("var echo = null; "
                       "pm.sendRequest({ url: '" +
    server.url ("/echo") +
    "', method: 'post', "
    "  header: { 'X-Marker': 'from-script', 'Content-Type': 'application/json' "
    "}, "
    "  body: { mode: 'raw', raw: '{\"a\":1}' } "
    "}, function (err, res) { echo = res.json(); }); "
    "pm.test('sent', function () { "
    "  pm.expect(echo.method).to.equal('POST'); "
    "  pm.expect(echo.body).to.equal('{\"a\":1}'); "
    "  pm.expect(echo.marker).to.equal('from-script'); "
    "  pm.expect(echo.type).to.equal('application/json'); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Postman's array form, which is what a script copied out of Postman carries.
TEST_F (SendRequestTest, PostmanArrayHeaderFormIsAccepted) {
    SendRequestServer server;

    auto result = run ("var echo = null; "
                       "pm.sendRequest({ url: '" +
    server.url ("/echo") +
    "', method: 'POST', "
    "  header: [{ key: 'X-Marker', value: 'array-form' }], "
    "  body: 'plain' "
    "}, function (err, res) { echo = res.json(); }); "
    "pm.test('sent', function () { "
    "  pm.expect(echo.marker).to.equal('array-form'); "
    "  pm.expect(echo.body).to.equal('plain'); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// `pm.request.url` is a Url object since #991, and "send this request again" is
// the idiom that reads it - so the whole-argument form has to take one. Pinned
// here because nothing asserted it in either direction (issue #1001).
TEST_F (SendRequestTest, PmRequestUrlIsAcceptedAsTheWholeArgument) {
    SendRequestServer server;
    request.url = server.url ("/token");

    auto result = run ("var body = null; "
                       "pm.sendRequest(pm.request.url, function (err, res) { "
                       "  body = res.json(); "
                       "}); "
                       "pm.test('sent', function () { "
                       "  pm.expect(body.access_token).to.equal('tok_123'); "
                       "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (server.hit_count (), 1);
}

// ============================================================================
// options.auth - composed by the engine's own resolver, refused by name where
// it cannot be composed (issue #1001)
// ============================================================================

TEST_F (SendRequestTest, AuthBasicComposesTheAuthorizationHeader) {
    SendRequestServer server;

    auto result = run ("var echo = null; "
                       "pm.sendRequest({ url: '" +
    server.url ("/echo") +
    "', method: 'POST', "
    "  auth: { type: 'basic', basic: { username: 'alice', password: 's3cret' } "
    "} "
    "}, function (err, res) { echo = res.json(); }); "
    "pm.test('sent', function () { "
    "  pm.expect(echo.auth).to.equal('Basic YWxpY2U6czNjcmV0'); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Postman's array spelling of the parameter block, and the token written as a
// variable the same script set two lines earlier - the two halves an imported
// token-refresh script depends on.
TEST_F (SendRequestTest, AuthBearerReadsTheArrayFormAndResolvesTheToken) {
    SendRequestServer server;

    auto result = run ("pm.environment.set('tok', 'tok_123'); "
                       "var echo = null; "
                       "pm.sendRequest({ url: '" +
    server.url ("/echo") +
    "', method: 'POST', "
    "  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}' }] } "
    "}, function (err, res) { echo = res.json(); }); "
    "pm.test('sent', function () { "
    "  pm.expect(echo.auth).to.equal('Bearer tok_123'); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (SendRequestTest, AuthApiKeyGoesWhereItsInSays) {
    SendRequestServer server;

    auto result = run ("var header = null; var query = null; "
                       "pm.sendRequest({ url: '" +
    server.url ("/echo") +
    "', method: 'POST', "
    "  auth: { type: 'apikey', apikey: { key: 'X-Api-Key', value: 'k123' } } "
    "}, function (err, res) { header = res.json(); }); "
    "pm.sendRequest({ url: '" +
    server.url ("/echo") +
    "', method: 'POST', "
    "  auth: { type: 'apikey', apikey: [{ key: 'key', value: 'api_key' }, "
    "    { key: 'value', value: 'k 1&2' }, { key: 'in', value: 'query' }] } "
    "}, function (err, res) { query = res.json(); }); "
    "pm.test('sent', function () { "
    "  pm.expect(header.apikey).to.equal('k123'); "
    // Percent-encoded by the same append_query_param every other send writes a
    // query credential with - a raw '&' here would start a parameter of its own.
    "  pm.expect(query.target.indexOf('api_key=k%201%262') >= "
    "0).to.equal(true); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The engine's rule, reached rather than restated: a header the caller wrote
// wins over the credential auth would compose into the same line.
TEST_F (SendRequestTest, AHeaderTheScriptSetWinsOverTheAuthOption) {
    SendRequestServer server;

    auto result = run ("var echo = null; "
                       "pm.sendRequest({ url: '" +
    server.url ("/echo") +
    "', method: 'POST', "
    "  header: { 'Authorization': 'Token abc' }, "
    "  auth: { type: 'bearer', bearer: { token: 'tok_123' } } "
    "}, function (err, res) { echo = res.json(); }); "
    "pm.test('sent', function () { "
    "  pm.expect(echo.auth).to.equal('Token abc'); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The silent drop this issue exists to close: before #1001 an `auth` block the
// sandbox could not compose was ignored and the request went out
// unauthenticated. Restore the drop and this reddens - the send succeeds.
TEST_F (SendRequestTest, AnAuthTypeTheSandboxCannotComposeIsRefusedByName) {
    SendRequestServer server;

    auto result = run ("pm.sendRequest({ url: '" + server.url ("/echo") +
    "', method: 'POST', "
    "  auth: { type: 'oauth2', oauth2: { accessToken: 'x' } } "
    "}, function () {});");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("oauth2"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (server.hit_count (), 0)
    << "an auth block the sandbox cannot compose was dropped and the request "
       "sent unauthenticated";
}

TEST_F (SendRequestTest, AnAuthBlockMissingItsCredentialIsRefused) {
    SendRequestServer server;

    auto result = run ("pm.sendRequest({ url: '" + server.url ("/echo") +
    "', method: 'POST', auth: { type: 'bearer', bearer: {} } "
    "}, function () {});");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("token"), std::string::npos) << result.error_message;
    EXPECT_EQ (server.hit_count (), 0);
}

// Basic is the type with no required parameter - Postman sends an empty half as
// the empty string - so a block that is not there at all has to be caught by
// its absence, or a misspelled key composes `Basic Og==` and sends it.
TEST_F (SendRequestTest, AnAuthTypeWithNoBlockToReadIsRefused) {
    SendRequestServer server;

    auto result = run ("pm.sendRequest({ url: '" + server.url ("/echo") +
    "', method: 'POST', auth: { type: 'basic', Basic: { username: 'alice' } } "
    "}, function () {});");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("no options.auth.basic block"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (server.hit_count (), 0)
    << "a credential the script misspelled was sent as an empty one";
}

// ============================================================================
// {{variables}} in script-supplied strings (issue #1001)
// ============================================================================

TEST_F (SendRequestTest, ScriptSuppliedStringsResolveAsTheCallIsMade) {
    SendRequestServer server;

    auto result = run ("pm.environment.set('base', '" + server.url ("") +
    "'); "
    "pm.environment.set('marker', 'from-variable'); "
    "pm.environment.set('payload', 'body-from-variable'); "
    "var text = null; var raw = null; "
    "pm.sendRequest({ url: '{{base}}/echo', method: 'POST', "
    "  header: { 'X-Marker': '{{marker}}' }, body: '{{payload}}' "
    "}, function (err, res) { text = res.json(); }); "
    // The same body under Postman's object spelling, which is the shape an
    // imported script carries.
    "pm.sendRequest({ url: '{{base}}/echo', method: 'POST', "
    "  body: { mode: 'raw', raw: '{{payload}}' } "
    "}, function (err, res) { raw = res.json(); }); "
    "pm.test('sent', function () { "
    "  pm.expect(text.marker).to.equal('from-variable'); "
    "  pm.expect(text.body).to.equal('body-from-variable'); "
    "  pm.expect(raw.body).to.equal('body-from-variable'); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (server.hit_count (), 2);
}

// #1009's pass-through rule, which this resolution inherits rather than
// replaces: a name nothing defines keeps its braces instead of becoming empty.
TEST_F (SendRequestTest, ANameNothingDefinesKeepsItsBraces) {
    SendRequestServer server;

    // A defined name beside the undefined one, so this reddens if resolution
    // stops running at all rather than only when the pass-through rule breaks.
    auto result = run ("pm.environment.set('type', 'application/json'); "
                       "var echo = null; "
                       "pm.sendRequest({ url: '" +
    server.url ("/echo") +
    "', method: 'POST', header: { 'X-Marker': '{{nothing_defines_this}}', "
    "  'Content-Type': '{{type}}' } "
    "}, function (err, res) { echo = res.json(); }); "
    "pm.test('sent', function () { "
    "  pm.expect(echo.marker).to.equal('{{nothing_defines_this}}'); "
    "  pm.expect(echo.type).to.equal('application/json'); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Resolution makes a variable's bytes header text, so the line-forging refusal
// has to cover them - it does, because the send goes through the same
// `validate_transferable` gate every other transfer does.
TEST_F (SendRequestTest, AResolvedValueThatWouldForgeAHeaderIsRefused) {
    SendRequestServer server;

    auto result =
    run ("pm.environment.set('marker', 'ok\\r\\nX-Injected: yes'); "
         "var seen = ''; "
         "pm.sendRequest({ url: '" +
    server.url ("/echo") +
    "', method: 'POST', header: { 'X-Marker': '{{marker}}' } "
    "}, function (err) { seen = err ? err.message : ''; }); "
    "pm.test('refused', function () { "
    "  pm.expect(seen.indexOf('forging a header') >= 0).to.equal(true); "
    "});");

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (server.hit_count (), 0);
}

// ============================================================================
// Arguments that cannot be honoured fail loudly rather than sending something
// the script did not write
// ============================================================================

TEST_F (SendRequestTest, BothHeaderSpellingsAtOnceIsRejected) {
    SendRequestServer server;

    auto result = run ("pm.sendRequest({ url: '" + server.url ("/echo") +
    "', header: {}, headers: {} }, function () {});");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("one slot under two names"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (server.hit_count (), 0);
}

TEST_F (SendRequestTest, AnUnsupportedBodyModeIsRejected) {
    SendRequestServer server;

    auto result = run ("pm.sendRequest({ url: '" +
    server.url ("/echo") + "', method: 'POST', body: { mode: 'formdata', formdata: [] } }, function () {});");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("'raw'"), std::string::npos) << result.error_message;
    EXPECT_EQ (server.hit_count (), 0)
    << "an unreadable body was sent as nothing at all";
}

TEST_F (SendRequestTest, AnUnknownMethodIsRejected) {
    SendRequestServer server;

    auto result = run ("pm.sendRequest({ url: '" + server.url ("/token") +
    "', method: 'FETCH' }, function () {});");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("FETCH"), std::string::npos) << result.error_message;
    EXPECT_EQ (server.hit_count (), 0);
}

// There is no promise form - the sandbox has a Promise but nothing drains its
// job queue - so a missing callback has to say that rather than return one.
TEST_F (SendRequestTest, ACallbackIsRequired) {
    SendRequestServer server;

    auto result = run ("pm.sendRequest('" + server.url ("/token") + "');");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("callback"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (server.hit_count (), 0);
}

TEST_F (SendRequestTest, ANonFunctionCallbackIsRejected) {
    SendRequestServer server;

    auto result = run ("pm.sendRequest('" + server.url ("/token") + "', 'not a function');");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("promise form"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (server.hit_count (), 0);
}

TEST_F (SendRequestTest, AnUnusableFirstArgumentIsRejected) {
    auto result = run ("pm.sendRequest(42, function () {});");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("URL string or an options object"), std::string::npos)
    << result.error_message;
}

// ============================================================================
// Transport failures reach the callback - they are the network's answer, not
// the script's mistake
// ============================================================================

TEST_F (SendRequestTest, ConnectionRefusedReachesTheCallbackAsAnError) {
    auto result = run ("var seen = {}; "
                       "pm.sendRequest('" +
    std::string (REFUSED_URL) +
    "', function (err, res) { seen.err = err; seen.res = res; }); "
    "pm.test('refused', function () { "
    "  pm.expect(seen.err === null).to.equal(false); "
    "  pm.expect(seen.res).to.equal(null); "
    "  pm.expect(seen.err.code).to.equal('CONNECTION_FAILED'); "
    "  pm.expect(seen.err.message.length > 0).to.equal(true); "
    "});");

    EXPECT_TRUE (result.success)
    << "a refused connection threw out of the script: " << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// `.invalid` is reserved by RFC 2606 and never resolves. The error code is not
// asserted, only that one arrived: a runner behind a proxy fails this at the
// proxy rather than in the resolver, and either way the script must see an
// error and keep running.
TEST_F (SendRequestTest, DnsFailureReachesTheCallbackAsAnError) {
    auto result =
    run ("var seen = {}; "
         "pm.sendRequest('http://vayu-no-such-host.invalid/token', "
         "function (err, res) { seen.err = err; seen.res = res; }); "
         "pm.test('unresolvable', function () { "
         "  pm.expect(seen.err === null).to.equal(false); "
         "  pm.expect(seen.res).to.equal(null); "
         "  pm.expect(seen.err.message.length > 0).to.equal(true); "
         "});");

    EXPECT_TRUE (result.success)
    << "an unresolvable host threw out of the script: " << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (SendRequestTest, ARequestTimeoutReachesTheCallbackAsAnError) {
    SendRequestServer server;

    auto result = run ("var seen = {}; "
                       "pm.sendRequest({ url: '" +
    server.url ("/slow") +
    "', timeout: 150 }, function (err, res) { seen.err = err; seen.res = res; "
    "}); "
    "pm.test('timed out', function () { "
    "  pm.expect(seen.err === null).to.equal(false); "
    "  pm.expect(seen.res).to.equal(null); "
    "  pm.expect(seen.err.code).to.equal('TIMEOUT'); "
    "});",
    /*timeout_ms=*/30000);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// ============================================================================
// The script's budget bounds a blocking call
// ============================================================================

// The defect this clamp exists for: QuickJS only calls its interrupt handler
// between bytecode operations, so a blocking C function never yields to it.
// Without the clamp a script with a 400ms budget holds its thread for the
// request's timeout - the mutation check is the elapsed assertion, since
// removing the clamp makes this wait out SLOW_MS instead.
TEST_F (SendRequestTest, AnAuxiliaryRequestCannotOutliveTheScriptBudget) {
    SendRequestServer server;

    vayu::ScriptResult result;
    const int64_t took = elapsed_ms ([&] {
        result = run ("pm.sendRequest('" + server.url ("/slow") + "', function () {});",
        /*timeout_ms=*/400);
    });

    EXPECT_LT (took, SLOW_MS / 2) << "the request outlived the script budget - "
                                     "is the deadline clamp still there?";
    EXPECT_EQ (server.hit_count (), 1)
    << "the request never went out, so nothing was bounded";
}

// A budget already spent must not turn into an unbounded request. The clamp
// alone would compute a timeout of zero or less, and libcurl reads a timeout
// of zero as "no timeout at all" - so the guard above it is load-bearing, and
// removing it makes this wait out SLOW_MS.
TEST_F (SendRequestTest, ASpentBudgetDoesNotIssueAnUnboundedRequest) {
    SendRequestServer server;

    vayu::ScriptResult result;
    const int64_t took = elapsed_ms ([&] {
        result = run ("pm.sendRequest('" + server.url ("/slow") + "', function () {});",
        /*timeout_ms=*/1);
    });

    EXPECT_FALSE (result.success)
    << "a script with no budget left reported success";
    EXPECT_LT (took, SLOW_MS / 2)
    << "an exhausted budget still issued an unbounded request";
}

// Turning the budget off entirely (timeout_ms == 0) must not be read as "no
// time left" - there is simply nothing to clamp to.
TEST_F (SendRequestTest, NoConfiguredBudgetMeansNoClamp) {
    SendRequestServer server;

    auto result = run ("var code = 0; "
                       "pm.sendRequest('" +
    server.url ("/token") +
    "', function (err, res) { code = res.code; }); "
    "pm.test('sent', function () { pm.expect(code).to.equal(200); });",
    /*timeout_ms=*/0);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// ============================================================================
// The per-script request cap
// ============================================================================

// Asserted at the cap rather than by counting side effects: the message names
// the limit and the offending call, and the server confirms exactly the cap
// went out.
TEST_F (SendRequestTest, TheRequestCapIsEnforcedAtTheCap) {
    SendRequestServer server;

    auto result = run ("for (var i = 0; i < " + std::to_string (REQUEST_CAP + 1) +
    "; i++) { pm.sendRequest('" + server.url ("/token") + "', function () {}); }",
    /*timeout_ms=*/30000);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("at most " + std::to_string (REQUEST_CAP)),
    std::string::npos)
    << result.error_message;
    EXPECT_EQ (server.hit_count (), REQUEST_CAP);
}

// A failed request still spends budget, or a loop against a refusing host
// would never reach the cap - and that loop is the one that spins a run's
// worker thread.
TEST_F (SendRequestTest, AFailedRequestStillSpendsBudget) {
    auto result = run ("for (var i = 0; i < " + std::to_string (REQUEST_CAP + 1) +
    "; i++) { pm.sendRequest('" + REFUSED_URL + "', function () {}); }",
    /*timeout_ms=*/30000);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("at most " + std::to_string (REQUEST_CAP)),
    std::string::npos)
    << result.error_message;
}

// Contexts are pooled and reused, so a counter living on the context rather
// than on the execution would let the first script spend the second's budget.
// Both scripts run on the same engine, which is what makes the reuse real.
TEST_F (SendRequestTest, TheCapResetsBetweenExecutions) {
    SendRequestServer server;

    ScriptConfig config;
    config.timeout_ms         = 30000;
    config.allow_send_request = true;
    ScriptEngine engine (config);

    response.status_code = 200;
    auto ctx             = ScriptContext::for_test (request, response);
    ctx.environment      = &env;

    const std::string spend_the_cap = "for (var i = 0; i < " +
    std::to_string (REQUEST_CAP) + "; i++) { pm.sendRequest('" +
    server.url ("/token") + "', function () {}); }";
    auto first = engine.execute (spend_the_cap, ctx);
    ASSERT_TRUE (first.success) << first.error_message;
    ASSERT_EQ (server.hit_count (), REQUEST_CAP);

    auto second = engine.execute ("var code = 0; pm.sendRequest('" + server.url ("/token") +
    "', function (err, res) { code = res.code; }); "
    "pm.test('fresh budget', function () { pm.expect(code).to.equal(200); });",
    ctx);

    EXPECT_TRUE (second.success) << second.error_message;
    ASSERT_EQ (second.tests.size (), 1u);
    EXPECT_TRUE (second.tests[0].passed) << second.tests[0].error_message;
    EXPECT_EQ (server.hit_count (), REQUEST_CAP + 1);
}

// ============================================================================
// The callback is the script's code, so its failures are the script's
// ============================================================================

TEST_F (SendRequestTest, AThrowingCallbackSurfacesAsTheScriptsError) {
    SendRequestServer server;

    auto result = run ("pm.sendRequest('" + server.url ("/token") +
    "', function () { throw new Error('from the callback'); });");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("from the callback"), std::string::npos)
    << result.error_message;
}

} // namespace
