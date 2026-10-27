/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/if_match_route_test.cpp
 * @brief `ETag` and `If-Match` on the whole-record PUTs (#2433) and on
 *        `POST /globals` (#2988), driven through the registered handlers: the
 *        header is read there and handed to the core, so only a wire test sees
 *        a handler that drops it.
 *
 * The cores' own cases (stale, current, absent, `*`, a list, the lock) are in
 * resource_write_route_test.cpp, examples_route_test.cpp and
 * globals_route_test.cpp.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/entity_tag.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"

namespace {

using nlohmann::json;

enum class Resource : std::uint8_t {
    Collection,
    Request,
    Environment,
    Example
};

struct PutRoute {
    const char* name;
    Resource resource;
};

constexpr auto PUT_ROUTES = std::to_array<PutRoute> ({
{ "Collection", Resource::Collection },
{ "Request", Resource::Request },
{ "Environment", Resource::Environment },
{ "Example", Resource::Example },
});

/// What one wire call answered.
struct Answer {
    int status = 0;
    json body;
    std::string etag;
};

class IfMatchServerTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_if_match_route.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<vayu::http::SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr,
        authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
        mock_server_manager_, *manager_, run_summary_cache_ });
        vayu::http::routes::register_collection_routes (*ctx_);
        vayu::http::routes::register_request_routes (*ctx_);
        vayu::http::routes::register_environment_routes (*ctx_);
        vayu::http::routes::register_request_example_routes (*ctx_);
        vayu::http::routes::register_globals_routes (*ctx_);
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    void TearDown () override {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
        run_manager_.shutdown ();
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    Answer send (const std::string& method,
    const std::string& path,
    const httplib::Headers& headers = {},
    const json& body                = json::object ()) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        httplib::Result response;
        if (method == "GET") {
            response = client.Get (path, headers);
        } else if (method == "PUT") {
            response = client.Put (path, headers, body.dump (), "application/json");
        } else {
            response = client.Post (path, headers, body.dump (), "application/json");
        }
        if (!response) {
            ADD_FAILURE () << "no response from " << method << " " << path;
            return {};
        }
        return { response->status, json::parse (response->body, nullptr, false),
            response->get_header_value ("ETag") };
    }

    /**
     * Creates the row @p resource names, called "Before", and answers its
     * PUT path and the tag its create answered.
     */
    std::pair<std::string, std::string> seed (Resource resource) {
        const auto created = [this] (const std::string& path, const json& payload) {
            const Answer answer = send ("POST", path, {}, payload);
            EXPECT_EQ (answer.status, 200) << path << ": " << answer.body.dump ();
            return answer.body;
        };
        if (resource == Resource::Collection || resource == Resource::Environment) {
            const std::string path =
            resource == Resource::Collection ? "/collections" : "/environments";
            const json row = created (path, json{ { "name", "Before" } });
            return { path + "/" + row.value ("id", ""), tag_of (row) };
        }
        const json collection = created ("/collections", json{ { "name", "API" } });
        const json request = created ("/requests",
        json{ { "collectionId", collection.value ("id", "") }, { "name", "Before" },
        { "method", "GET" }, { "url", "https://example.com" } });
        const std::string request_path = "/requests/" + request.value ("id", "");
        if (resource == Resource::Request) {
            return { request_path, tag_of (request) };
        }
        const json example =
        created (request_path + "/examples", json{ { "name", "Before" } });
        return { request_path + "/examples/" + example.value ("id", ""), tag_of (example) };
    }

    /// The stored row's name, read past every route.
    std::string stored_name (Resource resource, const std::string& put_path) const {
        const std::string id = put_path.substr (put_path.rfind ('/') + 1);
        switch (resource) {
        case Resource::Collection: return name_of (db_->get_collection (id));
        case Resource::Request: return name_of (db_->get_request (id));
        case Resource::Environment: return name_of (db_->get_environment (id));
        case Resource::Example: return name_of (db_->get_request_example (id));
        }
        return {};
    }

    template <typename Row>
    static std::string name_of (const std::optional<Row>& row) {
        if (!row) {
            ADD_FAILURE () << "the row is gone";
            return {};
        }
        return row->name;
    }

    static std::string tag_of (const json& row) {
        const auto updated_at = row.find ("updatedAt");
        if (updated_at == row.end () || !updated_at->is_number_integer ()) {
            ADD_FAILURE () << "no updatedAt in " << row.dump ();
            return {};
        }
        return vayu::http::entity_tag (updated_at->get<int64_t> ());
    }

    static json rename (const std::string& name) {
        return json{ { "name", name } };
    }

    std::unique_ptr<vayu::db::Database> db_;
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    vayu::core::RunManager run_manager_;
    vayu::http::OAuth2AuthorizeManager authorize_manager_;
    vayu::http::CookieJar cookie_jar_;
    vayu::http::MockIssuerManager mock_issuer_manager_;
    vayu::http::InboxManager inbox_manager_;
    vayu::http::MockServerManager mock_server_manager_;
    vayu::http::RunSummaryCache run_summary_cache_;
    std::unique_ptr<vayu::http::SseStreamManager> manager_;
    std::unique_ptr<vayu::http::routes::RouteContext> ctx_;
};

class IfMatchRouteTest : public IfMatchServerTest,
                         public ::testing::WithParamInterface<PutRoute> {};

TEST_P (IfMatchRouteTest, APutNamingTheStoredTagLandsAndAnswersTheNextOne) {
    const auto [path, tag] = seed (GetParam ().resource);

    const Answer answer = send ("PUT", path, { { "If-Match", tag } }, rename ("After"));
    ASSERT_EQ (answer.status, 200) << answer.body.dump ();
    EXPECT_EQ (answer.etag, tag_of (answer.body));
    EXPECT_NE (answer.etag, tag);
    EXPECT_EQ (stored_name (GetParam ().resource, path), "After");
}

// Mutation check: hand the core `std::nullopt` instead of `*if_match` in this
// resource's PUT handler and the stale write answers 200.
TEST_P (IfMatchRouteTest, APutNamingAStaleTagIs412AndWritesNothing) {
    const auto [path, tag] = seed (GetParam ().resource);
    const Answer moved     = send ("PUT", path, {}, rename ("Moved"));
    ASSERT_EQ (moved.status, 200) << moved.body.dump ();

    const Answer answer = send ("PUT", path, { { "If-Match", tag } }, rename ("Stale"));
    ASSERT_EQ (answer.status, 412) << answer.body.dump ();
    EXPECT_EQ (answer.body["error"]["code"], "precondition_failed");
    EXPECT_EQ (answer.body["error"]["updatedAt"], moved.body["updatedAt"]);
    EXPECT_TRUE (answer.etag.empty ()) << "only a 200 carries the row's tag";
    EXPECT_EQ (stored_name (GetParam ().resource, path), "Moved");
}

TEST_P (IfMatchRouteTest, APutWithoutIfMatchWritesAsBeforeAndAnswersTheTag) {
    const auto [path, tag] = seed (GetParam ().resource);
    ASSERT_EQ (send ("PUT", path, {}, rename ("Moved")).status, 200);

    const Answer answer = send ("PUT", path, {}, rename ("After"));
    ASSERT_EQ (answer.status, 200) << answer.body.dump ();
    EXPECT_EQ (answer.etag, tag_of (answer.body));
    EXPECT_EQ (stored_name (GetParam ().resource, path), "After");
}

TEST_P (IfMatchRouteTest, AMalformedIfMatchIs400AndWritesNothing) {
    const auto [path, tag] = seed (GetParam ().resource);

    const Answer answer =
    send ("PUT", path, { { "If-Match", "1792359304908" } }, rename ("After"));
    ASSERT_EQ (answer.status, 400) << answer.body.dump ();
    EXPECT_EQ (answer.body["error"]["code"], "invalid_if_match");
    EXPECT_EQ (stored_name (GetParam ().resource, path), "Before");
}

// RFC 9110 5.3: repeated field lines are one comma-joined list.
TEST_P (IfMatchRouteTest, RepeatedIfMatchLinesAreOneList) {
    const auto [path, tag] = seed (GetParam ().resource);

    const Answer answer = send ("PUT", path,
    { { "If-Match", "W/\"1\"" }, { "If-Match", tag } }, rename ("After"));
    EXPECT_EQ (answer.status, 200) << answer.body.dump ();
}

INSTANTIATE_TEST_SUITE_P (PerResource,
IfMatchRouteTest,
::testing::ValuesIn (PUT_ROUTES),
[] (const ::testing::TestParamInfo<PutRoute>& info) {
    return std::string (info.param.name);
});

// The one whole-record resource with a single-row GET.
TEST_F (IfMatchServerTest, GetRequestByIdAnswersTheTagAPutWouldJudge) {
    const auto [path, tag] = seed (Resource::Request);

    const Answer read = send ("GET", path);
    ASSERT_EQ (read.status, 200) << read.body.dump ();
    EXPECT_EQ (read.etag, tag);
    EXPECT_TRUE (send ("GET", "/requests/req_missing").etag.empty ());
}

// MCP's merges read collections and environments from their list, which
// carries no per-row header, and build the tag from the row's `updatedAt`.
TEST_F (IfMatchServerTest, AListRowCarriesTheTagAPutWouldJudge) {
    for (const Resource resource : { Resource::Collection, Resource::Environment }) {
        const std::string path = seed (resource).first;
        ASSERT_EQ (send ("PUT", path, {}, rename ("Moved")).status, 200);
        const std::string list_path = path.substr (0, path.rfind ('/'));
        const std::string id        = path.substr (path.rfind ('/') + 1);

        const Answer list = send ("GET", list_path);
        ASSERT_TRUE (list.body.is_array ()) << list.body.dump ();
        const auto row = std::find_if (list.body.begin (), list.body.end (),
        [&id] (const json& r) { return r.value ("id", "") == id; });
        ASSERT_NE (row, list.body.end ()) << list_path;

        const Answer answer =
        send ("PUT", path, { { "If-Match", tag_of (*row) } }, rename ("After"));
        EXPECT_EQ (answer.status, 200) << list_path << ": " << answer.body.dump ();
        EXPECT_EQ (stored_name (resource, path), "After");
    }
}

// Globals is a singleton saved whole by `POST /globals`, not a `PUT` by id, so
// it is outside `PUT_ROUTES`. A never-written row is version 0.
TEST_F (IfMatchServerTest, GetGlobalsAnswersTheTagAPostWouldJudge) {
    const Answer empty = send ("GET", "/globals");
    ASSERT_EQ (empty.status, 200) << empty.body.dump ();
    EXPECT_EQ (empty.etag, "W/\"0\"");

    const Answer saved = send ("POST", "/globals",
    { { "If-Match", empty.etag } }, json{ { "variables", { { "host", "a" } } } });
    ASSERT_EQ (saved.status, 200) << saved.body.dump ();
    EXPECT_EQ (saved.etag, tag_of (saved.body));
    EXPECT_NE (saved.etag, empty.etag);

    const Answer read = send ("GET", "/globals");
    ASSERT_EQ (read.status, 200) << read.body.dump ();
    EXPECT_EQ (read.etag, saved.etag);
}

// Mutation check: hand the core `std::nullopt` instead of `*if_match` in the
// `POST /globals` handler and the stale save answers 200.
TEST_F (IfMatchServerTest, AGlobalsPostNamingAStaleTagIs412AndWritesNothing) {
    const Answer moved =
    send ("POST", "/globals", {}, json{ { "variables", { { "host", "moved" } } } });
    ASSERT_EQ (moved.status, 200) << moved.body.dump ();

    const Answer answer = send ("POST", "/globals", { { "If-Match", "W/\"0\"" } },
    json{ { "variables", { { "host", "stale" } } } });
    ASSERT_EQ (answer.status, 412) << answer.body.dump ();
    EXPECT_EQ (answer.body["error"]["code"], "precondition_failed");
    EXPECT_EQ (answer.body["error"]["updatedAt"], moved.body["updatedAt"]);
    EXPECT_TRUE (answer.etag.empty ()) << "only a 200 carries the row's tag";
    const auto stored = db_->get_globals ();
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (json::parse (stored->variables)["host"], "moved");
}

TEST_F (IfMatchServerTest, AMalformedIfMatchOnGlobalsIs400AndWritesNothing) {
    const Answer answer = send ("POST", "/globals",
    { { "If-Match", "1792359304908" } }, json{ { "variables", { { "host", "a" } } } });
    ASSERT_EQ (answer.status, 400) << answer.body.dump ();
    EXPECT_EQ (answer.body["error"]["code"], "invalid_if_match");
    EXPECT_FALSE (db_->get_globals ().has_value ());
}

} // namespace
