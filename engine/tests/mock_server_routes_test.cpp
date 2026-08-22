/**
 * @file tests/mock_server_routes_test.cpp
 * @brief Tests for the collection mock server (issue #481 phase 2): payload
 *        validation, the path-template conformance fixture the app shares,
 *        route-table construction over a collection tree, match resolution and
 *        its two near-miss answers, a live listener serving real examples with
 *        latency and error injection, teardown while running, and one load run
 *        pointed at a mock end to end.
 *
 * The pure halves (normalize, segment, resolve, the miss body) are driven
 * directly rather than through a socket, matching the suite's other route-core
 * tests; only the behaviours that need a bound port open one.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/mock_server.hpp"

using nlohmann::json;
using vayu::http::MockMissKind;
using vayu::http::MockServerManager;
using vayu::http::MockStartRequest;

namespace {

namespace mock_constants = vayu::core::constants::mock_server;

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

// ---------------------------------------------------------------------------
// Payload validation - no listener, no database
// ---------------------------------------------------------------------------

TEST (MockParseStart, RequiresACollectionAndDefaultsTheRest) {
    MockStartRequest out;
    ASSERT_FALSE (
    vayu::http::parse_mock_start (json{ { "collectionId", "col_1" } }, out).has_value ());
    EXPECT_EQ (out.collection_id, "col_1");
    EXPECT_EQ (out.port, 0);
    EXPECT_EQ (out.latency_ms, 0);
    EXPECT_EQ (out.error_rate_pct, 0);

    // A mock with no collection has nothing to serve, so absence is a 400
    // rather than a listener that 404s everything.
    EXPECT_TRUE (vayu::http::parse_mock_start (json::object (), out).has_value ());
    EXPECT_TRUE (
    vayu::http::parse_mock_start (json{ { "collectionId", "" } }, out).has_value ());
    EXPECT_TRUE (
    vayu::http::parse_mock_start (json{ { "collectionId", 7 } }, out).has_value ());
    EXPECT_TRUE (vayu::http::parse_mock_start (json ("not an object"), out).has_value ());
}

TEST (MockParseStart, ReadsAndBoundsEveryTuningField) {
    MockStartRequest out;
    ASSERT_FALSE (
    vayu::http::parse_mock_start (json{ { "collectionId", "col_1" }, { "port", 41234 },
                                  { "latencyMs", 25 }, { "errorRatePct", 10 } },
    out)
    .has_value ());
    EXPECT_EQ (out.port, 41234);
    EXPECT_EQ (out.latency_ms, 25);
    EXPECT_EQ (out.error_rate_pct, 10);

    // Out of range is refused rather than clamped: a mock silently answering
    // with no delay when one was asked for is a mock doing something other than
    // what its caller configured.
    const json base = { { "collectionId", "col_1" } };
    for (const json& bad : { json{ { "port", -1 } }, json{ { "port", 70000 } },
         json{ { "latencyMs", -1 } },
         json{ { "latencyMs", mock_constants::MAX_LATENCY_MS + 1 } },
         json{ { "errorRatePct", -1 } }, json{ { "errorRatePct", 101 } },
         json{ { "latencyMs", "fast" } } }) {
        json body = base;
        body.update (bad);
        EXPECT_TRUE (vayu::http::parse_mock_start (body, out).has_value ())
        << body.dump ();
    }
}

// ---------------------------------------------------------------------------
// Path templates - the half the app shares
// ---------------------------------------------------------------------------

json load_conformance_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "path-template-conformance.json";
    std::ifstream file (path);
    EXPECT_TRUE (file.is_open ()) << "cannot open " << path;
    json fixture;
    file >> fixture;
    return fixture;
}

TEST (MockPathTemplate, MatchesTheSharedConformanceFixture) {
    const json fixture = load_conformance_fixture ();

    // A fixture that read as an empty list would pass every assertion below
    // while checking nothing - the failure mode a source-scanning guard in this
    // repo shipped with for weeks.
    ASSERT_TRUE (fixture.contains ("templateCases"));
    ASSERT_GE (fixture["templateCases"].size (), 5u);
    ASSERT_GE (fixture["urlCases"].size (), 5u);

    for (const auto& section : { "templateCases", "urlCases" }) {
        for (const auto& item : fixture[section]) {
            const auto input    = item["input"].get<std::string> ();
            const auto expected = item["expected"].get<std::string> ();
            EXPECT_EQ (vayu::http::normalize_mock_path (input), expected)
            << section << ": " << item["name"].get<std::string> ();
        }
    }
}

TEST (MockPathTemplate, SegmentsMarkTemplatesAsWildcards) {
    const auto segments =
    vayu::http::mock_path_segments ("/users/{{userId}}/pets");
    ASSERT_EQ (segments.size (), 3u);
    EXPECT_FALSE (segments[0].templated);
    EXPECT_EQ (segments[0].literal, "users");
    EXPECT_TRUE (segments[1].templated);
    EXPECT_EQ (segments[1].literal, "userId");
    EXPECT_FALSE (segments[2].templated);
    EXPECT_TRUE (vayu::http::mock_path_segments ("/").empty ());
}

// ---------------------------------------------------------------------------
// The route table and match resolution
// ---------------------------------------------------------------------------

class MockServerTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_mock_server.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        seed_collection ("col_root", std::nullopt, "Pet Store");
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void seed_collection (const std::string& id,
    const std::optional<std::string>& parent,
    const std::string& name) {
        vayu::db::Collection col;
        col.id         = id;
        col.parent_id  = parent;
        col.name       = name;
        col.order      = 0;
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    void seed_request (const std::string& id,
    const std::string& collection_id,
    vayu::HttpMethod method,
    const std::string& url,
    const std::string& name = {},
    int order               = 0) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = name.empty () ? id : name;
        r.method        = method;
        r.url           = url;
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    void seed_example (const std::string& id,
    const std::string& request_id,
    int status,
    const std::string& body,
    const std::string& content_type = "application/json",
    const json& headers             = json::array (),
    int order                       = 0) {
        vayu::db::RequestExample x;
        x.id           = id;
        x.request_id   = request_id;
        x.name         = id;
        x.status       = status;
        x.headers      = headers.dump ();
        x.body         = body;
        x.content_type = content_type;
        x.order        = order;
        x.created_at   = 1;
        x.updated_at   = 1;
        db_->save_request_example (x);
    }

    /// The canonical fixture: one request with an example, one templated, one
    /// method-sharing sibling, all under a sub-collection so the walk matters.
    void seed_pet_store () {
        seed_collection ("col_pets", "col_root", "Pets");
        seed_request ("req_list", "col_pets", vayu::HttpMethod::GET,
        "{{baseUrl}}/pets", "List pets");
        seed_example ("exa_list", "req_list", 200, R"([{"id":1}])");
        seed_request ("req_one", "col_pets", vayu::HttpMethod::GET,
        "{{baseUrl}}/pets/{petId}", "Get pet");
        seed_example ("exa_one", "req_one", 200, R"({"id":7})");
        seed_request ("req_create", "col_pets", vayu::HttpMethod::POST,
        "{{baseUrl}}/pets", "Create pet");
        seed_example ("exa_create", "req_create", 201, R"({"id":8})");
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (MockServerTest, TheTableCoversTheWholeCollectionSubtree) {
    seed_pet_store ();
    // A request directly on the root, and one two levels down - an OpenAPI
    // import files everything under a folder per tag, so a table built from
    // direct children alone would serve nothing at all.
    seed_request ("req_root", "col_root", vayu::HttpMethod::GET, "{{baseUrl}}/health");
    seed_example ("exa_root", "req_root", 200, "ok", "text/plain");
    seed_collection ("col_deep", "col_pets", "Toys");
    seed_request ("req_deep", "col_deep", vayu::HttpMethod::GET, "{{baseUrl}}/toys");
    seed_example ("exa_deep", "req_deep", 200, "[]");

    const auto routes = vayu::http::build_mock_routes (*db_, "col_root");
    ASSERT_EQ (routes.size (), 5u);

    std::vector<std::string> served;
    for (const auto& route : routes) {
        served.push_back (route.method + " " + route.path_template);
        EXPECT_TRUE (route.has_response) << route.request_id;
    }
    EXPECT_NE (std::find (served.begin (), served.end (), "GET /health"), served.end ());
    EXPECT_NE (std::find (served.begin (), served.end (), "GET /pets/{{petId}}"),
    served.end ());
    EXPECT_NE (std::find (served.begin (), served.end (), "POST /pets"), served.end ());
    EXPECT_NE (std::find (served.begin (), served.end (), "GET /toys"), served.end ());

    // A mock of the sub-collection is exactly its own subtree.
    EXPECT_EQ (vayu::http::build_mock_routes (*db_, "col_pets").size (), 4u);
}

TEST_F (MockServerTest, TheFirstExampleInStoredOrderIsTheOneServed) {
    seed_request ("req_list", "col_root", vayu::HttpMethod::GET, "{{baseUrl}}/pets");
    // Written newest-first on purpose: the ordering phase 1 made a contract is
    // `order`, not insertion, and this is the read that depends on it.
    seed_example ("exa_b", "req_list", 500, "boom", "text/plain", json::array (), 1);
    seed_example ("exa_a", "req_list", 200, "[]", "application/json", json::array (), 0);

    const auto routes = vayu::http::build_mock_routes (*db_, "col_root");
    ASSERT_EQ (routes.size (), 1u);
    EXPECT_EQ (routes[0].response.status, 200);
    EXPECT_EQ (routes[0].response.body, "[]");
}

TEST_F (MockServerTest, ARequestWithNoExampleStaysInTheTableAsUnservable) {
    seed_request ("req_list", "col_root", vayu::HttpMethod::GET, "{{baseUrl}}/pets");

    const auto routes = vayu::http::build_mock_routes (*db_, "col_root");
    ASSERT_EQ (routes.size (), 1u);
    EXPECT_FALSE (routes[0].has_response);

    // "matched, but nothing to serve" is a different answer from "no route",
    // and it is the one an import that dropped its examples produces.
    const auto match = vayu::http::resolve_mock_route (routes, "GET", "/pets");
    EXPECT_FALSE (match.route_index.has_value ());
    EXPECT_EQ (match.miss, MockMissKind::NoExample);
    const auto body = vayu::http::mock_miss_body (routes, match, "GET", "/pets");
    EXPECT_EQ (body["error"]["code"], "mock_no_example");
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("req_list"),
    std::string::npos);
}

TEST_F (MockServerTest, DisabledExampleHeadersAreNotServedAndDuplicatesSurvive) {
    seed_request ("req_list", "col_root", vayu::HttpMethod::GET, "{{baseUrl}}/pets");
    seed_example ("exa_list", "req_list", 200, "[]", "application/json",
    json::array ({ json{ { "key", "Set-Cookie" }, { "value", "a=1" }, { "enabled", true } },
    json{ { "key", "Set-Cookie" }, { "value", "b=2" }, { "enabled", true } },
    json{ { "key", "X-Dropped" }, { "value", "no" }, { "enabled", false } } }));

    const auto routes = vayu::http::build_mock_routes (*db_, "col_root");
    ASSERT_EQ (routes.size (), 1u);
    const auto& headers = routes[0].response.headers;
    ASSERT_EQ (headers.size (), 2u);
    EXPECT_EQ (headers[0].first, "Set-Cookie");
    EXPECT_EQ (headers[0].second, "a=1");
    EXPECT_EQ (headers[1].second, "b=2");
}

TEST_F (MockServerTest, AnExampleWithNoContentTypeColumnFallsBackToItsHeader) {
    seed_request ("req_list", "col_root", vayu::HttpMethod::GET, "{{baseUrl}}/pets");
    seed_example ("exa_list", "req_list", 200, "[]", /*content_type=*/"",
    json::array ({ json{ { "key", "content-type" },
    { "value", "application/hal+json" }, { "enabled", true } } }));

    const auto routes = vayu::http::build_mock_routes (*db_, "col_root");
    ASSERT_EQ (routes.size (), 1u);
    EXPECT_EQ (routes[0].response.content_type, "application/hal+json");
}

TEST_F (MockServerTest, ALiteralRouteBeatsATemplatedOneWhateverOrderTheyWereWritten) {
    // `/pets/mine` sits *after* `/pets/{petId}` in the table (the collection's
    // own `order` decides), so taking the first match rather than the most
    // specific one would give the wildcard both paths and shadow the literal
    // permanently.
    seed_request ("req_one", "col_root", vayu::HttpMethod::GET,
    "{{baseUrl}}/pets/{petId}", "Get pet", /*order=*/0);
    seed_example ("exa_one", "req_one", 200, "wildcard", "text/plain");
    seed_request ("req_mine", "col_root", vayu::HttpMethod::GET,
    "{{baseUrl}}/pets/mine", "My pets", /*order=*/1);
    seed_example ("exa_mine", "req_mine", 200, "literal", "text/plain");

    const auto routes = vayu::http::build_mock_routes (*db_, "col_root");
    ASSERT_EQ (routes.size (), 2u);
    ASSERT_EQ (routes[0].path_template, "/pets/{{petId}}")
    << "the wildcard must come first";
    const auto mine = vayu::http::resolve_mock_route (routes, "GET", "/pets/mine");
    ASSERT_TRUE (mine.route_index.has_value ());
    EXPECT_EQ (routes[*mine.route_index].response.body, "literal");

    const auto other = vayu::http::resolve_mock_route (routes, "GET", "/pets/42");
    ASSERT_TRUE (other.route_index.has_value ());
    EXPECT_EQ (routes[*other.route_index].response.body, "wildcard");
}

TEST_F (MockServerTest, AMethodMismatchIsNamedRatherThanReportedAsAMissingPath) {
    seed_pet_store ();
    const auto routes = vayu::http::build_mock_routes (*db_, "col_root");

    const auto match = vayu::http::resolve_mock_route (routes, "DELETE", "/pets");
    EXPECT_FALSE (match.route_index.has_value ());
    EXPECT_EQ (match.miss, MockMissKind::MethodMismatch);
    ASSERT_EQ (match.allowed_methods.size (), 2u);
    EXPECT_EQ (match.allowed_methods[0], "GET");
    EXPECT_EQ (match.allowed_methods[1], "POST");

    const auto body = vayu::http::mock_miss_body (routes, match, "DELETE", "/pets");
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_EQ (body["error"]["code"], "mock_method_mismatch");
    EXPECT_NE (message.find ("GET, POST"), std::string::npos) << message;
    EXPECT_NE (message.find ("/pets"), std::string::npos) << message;
}

TEST_F (MockServerTest, AnUnknownPathSaysSoAndCountsWhatIsServed) {
    seed_pet_store ();
    const auto routes = vayu::http::build_mock_routes (*db_, "col_root");

    const auto match = vayu::http::resolve_mock_route (routes, "GET", "/orders/1");
    EXPECT_EQ (match.miss, MockMissKind::NoPath);
    EXPECT_FALSE (match.matched_route.has_value ());

    const auto message = vayu::http::mock_miss_body (
    routes, match, "GET", "/orders/1")["error"]["message"]
                         .get<std::string> ();
    EXPECT_NE (message.find ("/orders/1"), std::string::npos) << message;
    EXPECT_NE (message.find ("3 served"), std::string::npos) << message;
}

TEST_F (MockServerTest, ATrailingSlashIsTheSameRoute) {
    seed_pet_store ();
    const auto routes = vayu::http::build_mock_routes (*db_, "col_root");
    EXPECT_TRUE (
    vayu::http::resolve_mock_route (routes, "GET", "/pets/").route_index.has_value ());
}

// ---------------------------------------------------------------------------
// The manager and a live listener
// ---------------------------------------------------------------------------

TEST_F (MockServerTest, StartRefusesACollectionThatCannotBeServed) {
    MockServerManager manager;

    MockStartRequest missing;
    missing.collection_id = "col_gone";
    const auto not_found  = manager.start (*db_, missing);
    EXPECT_FALSE (not_found.ok);
    EXPECT_EQ (not_found.http_status, 404);

    // A collection with no requests would bind a port and 404 everything, which
    // is never what the caller meant.
    MockStartRequest empty;
    empty.collection_id  = "col_root";
    const auto no_routes = manager.start (*db_, empty);
    EXPECT_FALSE (no_routes.ok);
    EXPECT_EQ (no_routes.http_status, 400);
    EXPECT_EQ (no_routes.error_code, "mock_no_requests");
    EXPECT_TRUE (manager.list ().empty ());
}

TEST_F (MockServerTest, AStartedMockServesItsExamplesAndReportsItsTable) {
    seed_pet_store ();
    // One request with no example, so the report's second number is not 0.
    seed_request ("req_bare", "col_pets", vayu::HttpMethod::GET, "{{baseUrl}}/bare");

    MockServerManager manager;
    MockStartRequest request;
    request.collection_id = "col_root";
    const auto started    = manager.start (*db_, request);
    ASSERT_TRUE (started.ok) << started.error_message;
    EXPECT_EQ (started.info.collection_name, "Pet Store");
    EXPECT_EQ (started.info.route_count, 4);
    EXPECT_EQ (started.info.routes_without_example, 1);
    EXPECT_EQ (
    started.info.url, "http://127.0.0.1:" + std::to_string (started.info.port));

    httplib::Client client ("127.0.0.1", started.info.port);
    client.set_connection_timeout (2);
    client.set_read_timeout (5);

    const auto listed = client.Get ("/pets");
    ASSERT_TRUE (listed) << "no response from the mock";
    EXPECT_EQ (listed->status, 200);
    EXPECT_EQ (listed->body, R"([{"id":1}])");
    EXPECT_EQ (listed->get_header_value ("Content-Type"), "application/json");

    // A templated segment matches any single value, and the query is not part
    // of the route.
    const auto one = client.Get ("/pets/42?expand=owner");
    ASSERT_TRUE (one);
    EXPECT_EQ (one->status, 200);
    EXPECT_EQ (one->body, R"({"id":7})");

    const auto created = client.Post ("/pets", "{}", "application/json");
    ASSERT_TRUE (created);
    EXPECT_EQ (created->status, 201);

    // The two near-misses, over the wire.
    const auto wrong_method = client.Delete ("/pets");
    ASSERT_TRUE (wrong_method);
    EXPECT_EQ (wrong_method->status, 404);
    EXPECT_EQ (json::parse (wrong_method->body)["error"]["code"], "mock_method_mismatch");

    const auto unknown = client.Get ("/orders");
    ASSERT_TRUE (unknown);
    EXPECT_EQ (unknown->status, 404);
    EXPECT_EQ (json::parse (unknown->body)["error"]["code"], "mock_no_route");

    // A route with no example is a 501 naming the request, not a 404 that sends
    // the user looking for a path they can see in the list.
    const auto bare = client.Get ("/bare");
    ASSERT_TRUE (bare);
    EXPECT_EQ (bare->status, 501);
    EXPECT_EQ (json::parse (bare->body)["error"]["code"], "mock_no_example");

    const auto table = manager.routes (started.info.mock_id);
    ASSERT_TRUE (table.has_value ());
    EXPECT_EQ (table->size (), 4u);
    EXPECT_FALSE (manager.routes ("mock_nope").has_value ());
}

TEST_F (MockServerTest, LatencyAndTheTwoExactErrorRates) {
    seed_pet_store ();
    MockServerManager manager;

    MockStartRequest slow;
    slow.collection_id = "col_root";
    slow.latency_ms    = 120;
    const auto delayed = manager.start (*db_, slow);
    ASSERT_TRUE (delayed.ok) << delayed.error_message;

    httplib::Client slow_client ("127.0.0.1", delayed.info.port);
    slow_client.set_read_timeout (5);
    const auto before   = std::chrono::steady_clock::now ();
    const auto answered = slow_client.Get ("/pets");
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - before)
                         .count ();
    ASSERT_TRUE (answered);
    EXPECT_EQ (answered->status, 200);
    // A bound assert, not an equality: the sleep is a floor and the scheduler
    // owns the ceiling.
    EXPECT_GE (elapsed, 100);

    // 0 and 100 are exact by construction; nothing in between is tested,
    // because a probability is not an assertion.
    MockStartRequest broken;
    broken.collection_id  = "col_root";
    broken.error_rate_pct = 100;
    const auto failing    = manager.start (*db_, broken);
    ASSERT_TRUE (failing.ok) << failing.error_message;
    httplib::Client failing_client ("127.0.0.1", failing.info.port);
    failing_client.set_read_timeout (5);
    for (int i = 0; i < 5; ++i) {
        const auto response = failing_client.Get ("/pets");
        ASSERT_TRUE (response);
        EXPECT_EQ (response->status, 500);
        EXPECT_EQ (json::parse (response->body)["error"]["code"], "mock_injected_error");
    }

    // The default rate never fires, however many completions it sees.
    httplib::Client healthy ("127.0.0.1", delayed.info.port);
    healthy.set_read_timeout (5);
    for (int i = 0; i < 5; ++i) {
        const auto response = healthy.Get ("/pets");
        ASSERT_TRUE (response);
        EXPECT_EQ (response->status, 200);
    }
}

TEST_F (MockServerTest, StopEndsTheListenerAndDropsTheRecord) {
    seed_pet_store ();
    MockServerManager manager;
    MockStartRequest request;
    request.collection_id = "col_root";
    const auto started    = manager.start (*db_, request);
    ASSERT_TRUE (started.ok) << started.error_message;
    const int port = started.info.port;

    ASSERT_EQ (manager.list ().size (), 1u);
    ASSERT_TRUE (manager.get (started.info.mock_id).has_value ());

    EXPECT_TRUE (manager.stop (started.info.mock_id));
    // A stop is a delete: a mock holds nothing that outlives its listener, so
    // there is no stopped record left to read.
    EXPECT_TRUE (manager.list ().empty ());
    EXPECT_FALSE (manager.get (started.info.mock_id).has_value ());
    EXPECT_FALSE (manager.stop (started.info.mock_id));

    httplib::Client client ("127.0.0.1", port);
    client.set_connection_timeout (1);
    EXPECT_FALSE (client.Get ("/pets"))
    << "the listener is still accepting after stop";
}

TEST_F (MockServerTest, TeardownWhileALatentResponseIsInFlightStillJoins) {
    seed_pet_store ();
    int port = 0;
    {
        MockServerManager manager;
        MockStartRequest request;
        request.collection_id = "col_root";
        request.latency_ms    = 300;
        const auto started    = manager.start (*db_, request);
        ASSERT_TRUE (started.ok) << started.error_message;
        port = started.info.port;

        std::thread caller ([port] () {
            httplib::Client client ("127.0.0.1", port);
            client.set_read_timeout (5);
            client.Get ("/pets");
        });
        // Long enough for the request to be inside the handler's sleep.
        std::this_thread::sleep_for (std::chrono::milliseconds (80));
        // The destructor runs here, joining a thread that is mid-response.
        caller.detach ();
    }
    // Reaching this line at all is the assertion: a teardown that did not join
    // would have hung or torn state out from under the handler.
    httplib::Client client ("127.0.0.1", port);
    client.set_connection_timeout (1);
    EXPECT_FALSE (client.Get ("/pets"));
}

TEST_F (MockServerTest, TheServerBudgetIsEnforced) {
    seed_pet_store ();
    MockServerManager manager;
    MockStartRequest request;
    request.collection_id = "col_root";
    for (std::size_t i = 0; i < mock_constants::MAX_SERVERS; ++i) {
        ASSERT_TRUE (manager.start (*db_, request).ok) << "start " << i;
    }
    const auto refused = manager.start (*db_, request);
    EXPECT_FALSE (refused.ok);
    EXPECT_EQ (refused.http_status, 409);
    EXPECT_EQ (refused.error_code, "mock_limit_reached");
}

// ---------------------------------------------------------------------------
// The workflow this feature exists for: a load run against the mock
// ---------------------------------------------------------------------------

TEST_F (MockServerTest, ALoadRunCanTargetAMockEndToEnd) {
    seed_pet_store ();
    MockServerManager manager;
    MockStartRequest request;
    request.collection_id = "col_root";
    const auto started    = manager.start (*db_, request);
    ASSERT_TRUE (started.ok) << started.error_message;

    vayu::db::Run row;
    row.id              = "run_mock";
    row.type            = vayu::RunType::Load;
    row.status          = vayu::RunStatus::Pending;
    row.config_snapshot = "{}";
    row.start_time      = now_ms ();
    row.end_time        = 0;
    db_->create_run (row);

    const json config = { { "mode", "constant_rps" }, { "duration", "2s" },
        { "targetRps", 20.0 }, { "url", started.info.url + "/pets" },
        { "method", "GET" }, { "timeout", 5000 }, { "workers", 1 } };

    vayu::core::RunManager run_manager;
    ASSERT_TRUE (run_manager.start_run (row.id, config, *db_, false));

    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (30);
    while (std::chrono::steady_clock::now () < deadline) {
        const auto stored = db_->get_run (row.id);
        if (stored && stored->status != vayu::RunStatus::Running &&
        stored->status != vayu::RunStatus::Pending) {
            break;
        }
        std::this_thread::sleep_for (std::chrono::milliseconds (50));
    }
    run_manager.shutdown (std::chrono::milliseconds (15000));

    const auto stored = db_->get_run (row.id);
    ASSERT_TRUE (stored.has_value ());
    ASSERT_FALSE (stored->summary.empty ()) << "the run produced no summary";
    const json summary = json::parse (stored->summary);
    // The point of the workflow: a realistic, zero-cost upstream that actually
    // answers, rather than a run whose every request failed to connect. The
    // status histogram is the assertion - a run against a dead port still
    // records total_requests, but it records no 200s.
    ASSERT_TRUE (summary.contains ("status_codes")) << summary.dump ();
    EXPECT_GT (summary["status_codes"].value ("200", 0), 0)
    << "no request to the mock was answered 200: " << summary.dump ();
    EXPECT_GT (summary.value ("total_requests", 0), 0) << summary.dump ();
}

} // namespace
