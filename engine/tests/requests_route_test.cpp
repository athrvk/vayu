/**
 * @file tests/requests_route_test.cpp
 * @brief Tests for GET /requests/:id (get_request_response) and the
 * GET /requests list body (list_requests_body).
 *
 * Focus: the single-request lookup must return a *definitive* 404 when the
 * request does not exist, and 200 with the full serialized shape when it does.
 * That 404-vs-present distinction is what lets the app tell a real deletion
 * from an unreachable engine - the collection-list scan it replaces could not,
 * because a swallowed list failure looked the same as "not in any list".
 *
 * Covers the route's extracted core in isolation, matching the suite's other
 * route tests (no in-process HTTP server). Deleting the 404 branch, or pointing
 * the route at a different serializer, fails this file.
 */

#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "spec_move_fixture.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/list_page.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in requests.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
get_request_response (vayu::db::Database& db, const std::string& id);
// Defined in requests.cpp; returns the GET /requests JSON array body.
std::string list_requests_body (vayu::db::Database& db, const std::string& collection_id);
// Defined in requests.cpp; the GET /requests body with no `collectionId`.
std::string list_all_requests_body (vayu::db::Database& db);
// Defined in requests.cpp; the whole GET /requests route, {status, body_text}.
// The default names none of `q` / `limit` / `offset` (#2443).
std::pair<int, std::string> list_requests_response (vayu::db::Database& db,
const std::optional<std::string>& collection_id,
std::string_view fields,
const ListPageQuery& page_query = {});
// Defined in requests.cpp; returns {http_status, json_body}. The create core
// this file also calls is declared in spec_move_fixture.hpp.
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

// The keys a `fields=summary` row carries (#2546), and the only ones.
constexpr auto SUMMARY_KEYS = std::to_array<std::string_view> ({ "id",
"collectionId", "name", "method", "url", "order", "createdAt", "specOperation" });

// A full list projected onto the summary keys: what the summary must equal.
json project_onto_summary_keys (const json& full_rows) {
    json projected = json::array ();
    for (const auto& row : full_rows) {
        json kept = json::object ();
        for (const auto key : SUMMARY_KEYS) {
            kept[std::string (key)] = row.at (std::string (key));
        }
        projected.push_back (std::move (kept));
    }
    return projected;
}

class RequestsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_requests_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    // Persist a minimal request under a known collection and return its id.
    std::string seed_request () {
        vayu::db::Collection col;
        col.id    = "col_1";
        col.name  = "API";
        col.order = 0;
        db_->create_collection (col);

        vayu::db::Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "Get user";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/user";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 2;
        db_->save_request (r);
        return r.id;
    }

    void seed_collection_at (const std::string& id, const std::string& parent_id, int order) {
        vayu::db::Collection col;
        col.id   = id;
        col.name = id;
        col.parent_id = parent_id.empty () ? std::nullopt : std::optional (parent_id);
        col.order = order;
        db_->create_collection (col);
    }

    void seed_request_at (const std::string& id,
    const std::string& collection_id,
    int order,
    const std::string& name = {}) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = name.empty () ? id : name;
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/";
        r.order         = order;
        db_->save_request (r);
    }

    static json new_request (const std::string& collection_id) {
        return json{ { "collectionId", collection_id }, { "name", "new" },
            { "method", "GET" }, { "url", "https://example.test/" } };
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (RequestsRouteTest, MissingRequestIs404) {
    auto [status, body] = vayu::http::routes::get_request_response (*db_, "req_nope");
    EXPECT_EQ (status, 404);
    // The one error shape (issue #173): a nested object carrying a per-status
    // code and the message. The app's http-client reads `error.message`, so a
    // flat string here would surface as a bare "HTTP 404".
    ASSERT_TRUE (body.contains ("error"));
    EXPECT_EQ (body["error"]["code"], "not_found");
    EXPECT_EQ (body["error"]["message"], "Request not found");
}

// GET /requests must contain every row of the collection and preserve the
// DB layer's order-by-`order` sorting end to end - other API clients see this
// body directly, without the bundled app's client-side re-sort. Rows are
// seeded out of order so pass-through of insertion order fails.
TEST_F (RequestsRouteTest, ListBodyContainsAllRowsSortedByOrder) {
    vayu::db::Collection col;
    col.id    = "col_list";
    col.name  = "API";
    col.order = 0;
    db_->create_collection (col);

    for (const auto& [id, order] :
    { std::pair<const char*, int>{ "req_z", 2 }, { "req_x", 0 }, { "req_y", 1 } }) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = "col_list";
        r.name          = id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = std::string ("https://example.test/") + id;
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    const auto body =
    json::parse (vayu::http::routes::list_requests_body (*db_, "col_list"));

    ASSERT_TRUE (body.is_array ());
    ASSERT_EQ (body.size (), 3);
    EXPECT_EQ (body[0]["id"], "req_x");
    EXPECT_EQ (body[1]["id"], "req_y");
    EXPECT_EQ (body[2]["id"], "req_z");
    // Same serialized shape as a single-request lookup.
    EXPECT_TRUE (body[0]["params"].is_array ());
    EXPECT_TRUE (body[0]["headers"].is_array ());
}

// An unknown (or empty) collection is an empty list, not an error.
TEST_F (RequestsRouteTest, ListBodyForUnknownCollectionIsEmptyArray) {
    const auto body =
    json::parse (vayu::http::routes::list_requests_body (*db_, "col_nope"));
    ASSERT_TRUE (body.is_array ());
    EXPECT_TRUE (body.empty ());
}

// The launch fetch (one call, where the app used to make one per collection)
// must answer with exactly the union of the per-collection lists: every row of
// every live collection, each collection's rows in that collection's own
// order, and nothing the trash holds. Compared against `list_requests_body`
// rather than a hand-written expectation, so the two cannot drift apart.
TEST_F (RequestsRouteTest, AllRequestsBodyIsEveryLiveCollectionsListAndNothingTrashed) {
    for (const char* id : { "col_b", "col_a", "col_gone" }) {
        vayu::db::Collection col;
        col.id    = id;
        col.name  = id;
        col.order = 0;
        db_->create_collection (col);
    }
    const std::vector<std::tuple<const char*, const char*, int>> rows = {
        { "req_a2", "col_a", 1 }, { "req_b1", "col_b", 0 }, { "req_a1", "col_a", 0 },
        { "req_gone", "col_gone", 0 }, { "req_deleted", "col_b", 1 }
    };
    for (const auto& [id, collection, order] : rows) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection;
        r.name          = id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = std::string ("https://example.test/") + id;
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }
    db_->delete_request ("req_deleted");
    db_->delete_collection ("col_gone");

    const auto all = json::parse (vayu::http::routes::list_all_requests_body (*db_));
    ASSERT_TRUE (all.is_array ());

    json expected = json::array ();
    for (const char* collection : { "col_a", "col_b" }) {
        for (const auto& row :
        json::parse (vayu::http::routes::list_requests_body (*db_, collection))) {
            expected.push_back (row);
        }
    }
    ASSERT_EQ (expected.size (), 3u) << "the fixture seeded the wrong rows";
    EXPECT_EQ (all, expected);
}

// -- `fields=summary` (#2546) ------------------------------------------------

// The summary is the full list, row for row and in the same order, with each
// row cut to the tree keys: compared against the full body rather than a
// hand-written expectation, in both the all-live and the per-collection form.
// Mutation check: drop `deleted_at` from either summary read's filter, or
// order either by anything but the full read's keys, and this reds.
TEST_F (RequestsRouteTest, SummaryIsTheFullListCutToTheTreeKeys) {
    seed_collection_at ("col_b", "", 0);
    seed_collection_at ("col_a", "", 1);
    seed_collection_at ("col_gone", "", 2);
    struct Seed {
        const char* id;
        const char* collection;
        int order;
        int64_t created_at;
    };
    // `req_a_tie_*` tie on order and created_at, so only `id` places them.
    for (const auto& seed : { Seed{ "req_a1", "col_a", 1, 1 },
         Seed{ "req_a_tie_b", "col_a", 0, 5 }, Seed{ "req_a_tie_a", "col_a", 0, 5 },
         Seed{ "req_a_later", "col_a", 0, 9 }, Seed{ "req_b0", "col_b", 0, 1 },
         Seed{ "req_deleted", "col_b", 1, 1 }, Seed{ "req_gone", "col_gone", 0, 1 } }) {
        vayu::db::Request r;
        r.id            = seed.id;
        r.collection_id = seed.collection;
        r.name          = seed.id;
        r.method        = vayu::HttpMethod::POST;
        r.url           = std::string ("https://example.test/") + seed.id;
        r.headers       = R"([{"key":"Accept","value":"*/*","enabled":true}])";
        r.body          = R"({"mode":"raw","content":"{}"})";
        r.order         = seed.order;
        r.created_at    = seed.created_at;
        r.spec_operation = R"({"operationId":"op","method":"POST","path":"/x"})";
        db_->save_request (r);
    }
    db_->delete_request ("req_deleted");
    db_->delete_collection ("col_gone");

    auto [status, body] =
    vayu::http::routes::list_requests_response (*db_, std::nullopt, "summary");
    ASSERT_EQ (status, 200) << body;
    const auto summary = json::parse (body);
    EXPECT_EQ (summary,
    project_onto_summary_keys (
    json::parse (vayu::http::routes::list_all_requests_body (*db_))));

    std::vector<std::string> ids;
    ids.reserve (summary.size ());
    for (const auto& row : summary) {
        ids.push_back (row.at ("id").get<std::string> ());
    }
    EXPECT_EQ (ids,
    (std::vector<std::string>{ "req_a_tie_a", "req_a_tie_b", "req_a_later", "req_a1", "req_b0" }));
    ASSERT_FALSE (summary.empty ());
    EXPECT_EQ (summary[0]["method"], "POST");
    EXPECT_EQ (summary[0]["specOperation"]["operationId"], "op");

    for (const char* collection : { "col_a", "col_b", "col_gone" }) {
        auto [one_status, one_body] =
        vayu::http::routes::list_requests_response (*db_, collection, "summary");
        ASSERT_EQ (one_status, 200) << one_body;
        EXPECT_EQ (json::parse (one_body),
        project_onto_summary_keys (
        json::parse (vayu::http::routes::list_requests_body (*db_, collection))))
        << collection;
    }
}

// No `fields` is the route as it was before it took one.
TEST_F (RequestsRouteTest, NoFieldsAnswersTheFullListByteForByte) {
    seed_request ();

    // The handler reads an absent parameter as empty.
    EXPECT_EQ (vayu::http::routes::list_requests_response (*db_, std::nullopt, ""),
    std::make_pair (200, vayu::http::routes::list_all_requests_body (*db_)));
    EXPECT_EQ (vayu::http::routes::list_requests_response (*db_, "col_1", ""),
    std::make_pair (200, vayu::http::routes::list_requests_body (*db_, "col_1")));
}

// The point of the summary: a large body costs its row nothing. One row's
// summary is about 200 bytes and the full row carries the whole 5 MiB body;
// the bound sits between them. Mutation check: answer the summary with the
// full rows and this reds.
TEST_F (RequestsRouteTest, ALargeBodyDoesNotEnlargeTheSummary) {
    seed_collection_at ("col_big", "", 0);
    vayu::db::Request r;
    r.id            = "req_big";
    r.collection_id = "col_big";
    r.name          = "big";
    r.url           = "https://example.test/";
    r.body =
    json{ { "mode", "raw" }, { "content", std::string (5U << 20U, 'x') } }.dump ();
    db_->save_request (r);

    constexpr std::size_t SUMMARY_BOUND = 4096;
    for (const auto& collection_id :
    { std::optional<std::string>{}, std::optional<std::string>{ "col_big" } }) {
        auto [status, body] =
        vayu::http::routes::list_requests_response (*db_, collection_id, "summary");
        ASSERT_EQ (status, 200);
        EXPECT_LT (body.size (), SUMMARY_BOUND);
        EXPECT_EQ (json::parse (body).size (), 1U);
    }
}

// A `fields` the route does not know is refused, not served as the full list.
TEST_F (RequestsRouteTest, UnknownFieldsIs400) {
    seed_request ();

    for (const char* fields : { "full", "Summary", "summary,body" }) {
        for (const auto& collection_id :
        { std::optional<std::string>{}, std::optional<std::string>{ "col_1" } }) {
            auto [status, body] =
            vayu::http::routes::list_requests_response (*db_, collection_id, fields);
            EXPECT_EQ (status, 400) << fields;
            const auto error = json::parse (body);
            EXPECT_EQ (error["error"]["code"], "invalid_fields") << fields;
            EXPECT_NE (error["error"]["message"].get<std::string> ().find (fields),
            std::string::npos)
            << fields;
        }
    }
}

// -- `q` / `limit` / `offset` (#2443) ----------------------------------------

std::vector<std::string> ids_of (const json& rows) {
    std::vector<std::string> ids;
    for (const auto& row : rows) {
        ids.push_back (row.at ("id").get<std::string> ());
    }
    return ids;
}

std::pair<int, json> paged_requests (vayu::db::Database& db,
const std::optional<std::string>& collection_id,
std::string_view fields,
const vayu::http::routes::ListPageQuery& query) {
    auto [status, body] =
    vayu::http::routes::list_requests_response (db, collection_id, fields, query);
    return { status, json::parse (body) };
}

// `q` is a case-insensitive substring of the name, in both row shapes and both
// scopes, and a request in the trash (or under a trashed collection) never
// matches though its name does. Mutation check: drop the `matches` predicate
// from serialize_request_page and every row comes back.
TEST_F (RequestsRouteTest, PagedListMatchesQAgainstTheNameCaseInsensitively) {
    seed_collection_at ("col_a", "", 0);
    seed_collection_at ("col_gone", "", 1);
    seed_request_at ("req_get", "col_a", 0, "Get Users");
    seed_request_at ("req_order", "col_a", 1, "Create order");
    seed_request_at ("req_list", "col_a", 2, "list users by team");
    seed_request_at ("req_deleted", "col_a", 3, "Delete USERS");
    seed_request_at ("req_gone", "col_gone", 0, "users of a gone folder");
    db_->delete_request ("req_deleted");
    db_->delete_collection ("col_gone");

    for (const auto& collection_id :
    { std::optional<std::string>{}, std::optional<std::string>{ "col_a" } }) {
        for (const char* fields : { "", "summary" }) {
            auto [status, body] =
            paged_requests (*db_, collection_id, fields, { .q = "uSeRs" });
            ASSERT_EQ (status, 200) << body;
            EXPECT_EQ (ids_of (body["data"]),
            (std::vector<std::string>{ "req_get", "req_list" }))
            << fields;
            EXPECT_EQ (body["pagination"]["total"], 2) << fields;
            EXPECT_EQ (body["pagination"]["limit"], 50) << fields;
        }
    }
    // The trashed rows are invisible even to a `q` only they would match.
    auto [status, body] = paged_requests (*db_, std::nullopt, "", { .q = "delete" });
    ASSERT_EQ (status, 200) << body;
    EXPECT_TRUE (body["data"].empty ());
    EXPECT_EQ (body["pagination"]["total"], 0);
}

// Pages walk the documented order without a gap or a repeat, and each says
// how many it holds and whether another follows. Mutation check: drop the
// `index < page.offset` skip and every page restarts at the first row.
TEST_F (RequestsRouteTest, PagedListWalksTheOrderedRowsInStablePages) {
    seed_collection_at ("col_a", "", 0);
    for (int i = 4; i >= 0; --i) {
        seed_request_at ("req_" + std::to_string (i), "col_a", i);
    }
    const auto legacy =
    json::parse (vayu::http::routes::list_requests_body (*db_, "col_a"));

    for (const char* fields : { "", "summary" }) {
        json walked = json::array ();
        for (const auto& [offset, returned, has_more] : { std::tuple{ "0", 2, true },
             std::tuple{ "2", 2, true }, std::tuple{ "4", 1, false } }) {
            auto [status, body] = paged_requests (
            *db_, "col_a", fields, { .limit = "2", .offset = offset });
            ASSERT_EQ (status, 200) << body;
            EXPECT_EQ (body["pagination"]["returned"], returned) << offset;
            EXPECT_EQ (body["pagination"]["hasMore"], has_more) << offset;
            EXPECT_EQ (body["pagination"]["total"], 5) << offset;
            EXPECT_EQ (body["pagination"]["offset"], std::stoi (offset)) << offset;
            EXPECT_EQ (body["pagination"]["limit"], 2) << offset;
            for (const auto& row : body["data"]) {
                walked.push_back (row);
            }
        }
        EXPECT_EQ (ids_of (walked), ids_of (legacy)) << fields;
        if (std::string_view (fields).empty ()) {
            EXPECT_EQ (walked, legacy) << "a page row is not the list's row";
        }
    }

    auto [status, past] = paged_requests (*db_, "col_a", "", { .offset = "9" });
    ASSERT_EQ (status, 200) << past;
    EXPECT_TRUE (past["data"].empty ());
    EXPECT_FALSE (past["pagination"]["hasMore"].get<bool> ());
}

/// The summary list's text as the route wrote it before it took paging keys:
/// each row's own dump, comma-joined inside one array.
std::string summary_list_text (const std::vector<vayu::db::RequestSummary>& rows) {
    std::string text = "[";
    for (const auto& row : rows) {
        text += (text.size () > 1 ? "," : "") + vayu::json::serialize (row).dump ();
    }
    return text + "]";
}

// With none of the three keys the route answers exactly what it did before
// it took them, compared against text built without list_requests_response.
// Mutation check: route a call with no key through paged_requests_body and
// the bare array becomes an envelope.
TEST_F (RequestsRouteTest, NoPagingKeysAnswersTheBareListByteForByte) {
    seed_request ();
    const vayu::http::routes::ListPageQuery none{};
    const auto answer = [this, &none] (const std::optional<std::string>& collection_id,
                        std::string_view fields) {
        return vayu::http::routes::list_requests_response (*db_, collection_id, fields, none);
    };

    EXPECT_EQ (answer (std::nullopt, ""),
    std::make_pair (200, vayu::http::routes::list_all_requests_body (*db_)));
    EXPECT_EQ (answer ("col_1", ""),
    std::make_pair (200, vayu::http::routes::list_requests_body (*db_, "col_1")));
    EXPECT_EQ (answer (std::nullopt, "summary"),
    std::make_pair (
    200, summary_list_text (db_->get_request_summaries_in_live_collections ())));
    EXPECT_EQ (answer ("col_1", "summary"),
    std::make_pair (200,
    summary_list_text (db_->get_request_summaries_in_collection ("col_1"))));
}

TEST_F (RequestsRouteTest, PagedListRefusesABadLimitOrOffset) {
    seed_request ();
    for (const auto& [query, code] :
    { std::pair{ vayu::http::routes::ListPageQuery{ .limit = "0" }, "invalid_limit" },
    std::pair{ vayu::http::routes::ListPageQuery{ .limit = "501" }, "invalid_limit" },
    std::pair{ vayu::http::routes::ListPageQuery{ .offset = "-1" }, "invalid_offset" } }) {
        auto [status, body] = paged_requests (*db_, std::nullopt, "summary", query);
        EXPECT_EQ (status, 400) << body;
        EXPECT_EQ (body["error"]["code"], code);
    }
}

TEST_F (RequestsRouteTest, PresentRequestIs200WithSerializedShape) {
    const std::string id = seed_request ();

    auto [status, body] = vayu::http::routes::get_request_response (*db_, id);
    EXPECT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("error"));

    // The same shape a list entry carries: id/collectionId/name/method/url
    // plus the array-valued params/headers the transformer expects.
    EXPECT_EQ (body["id"], "req_1");
    EXPECT_EQ (body["collectionId"], "col_1");
    EXPECT_EQ (body["name"], "Get user");
    EXPECT_EQ (body["method"], "GET");
    EXPECT_EQ (body["url"], "https://example.test/user");
    EXPECT_TRUE (body["params"].is_array ());
    EXPECT_TRUE (body["headers"].is_array ());
}

// -- The append rule across kinds (#2535) -----------------------------------
//
// A request that states no `order` lands after every sibling of either kind.
// Mutation check: drop the sub-folder scan from `Database::next_sibling_order`
// and each of these lands among the folders instead.

TEST_F (RequestsRouteTest, ACreatedRequestAppendsAfterFoldersAndRequests) {
    seed_collection_at ("col_p", "", 0);
    seed_collection_at ("col_f", "col_p", 3);
    seed_request_at ("req_a", "col_p", 1);

    auto [status, body] =
    vayu::http::routes::create_request_response (*db_, new_request ("col_p"));

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"], 4);
}

TEST_F (RequestsRouteTest, AMoveWithNoOrderAppendsPastBothKindsOfTheDestination) {
    seed_collection_at ("col_s", "", 0);
    seed_collection_at ("col_d", "", 1);
    seed_collection_at ("col_f", "col_d", 2);
    seed_request_at ("req_d", "col_d", 0);
    seed_request_at ("req_moving", "col_s", 7);

    auto [status, body] = vayu::http::routes::update_request_response (
    *db_, "req_moving", json{ { "collectionId", "col_d" } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"], 3);
}

// An explicit null is "reset to the default", which is the append; the request
// itself holds the highest slot and is left out of the scan.
TEST_F (RequestsRouteTest, AnExplicitNullOrderLandsAfterTheOtherSiblings) {
    seed_collection_at ("col_p", "", 0);
    seed_collection_at ("col_f", "col_p", 2);
    seed_request_at ("req_a", "col_p", 1);
    seed_request_at ("req_reset", "col_p", 8);

    auto [status, body] = vayu::http::routes::update_request_response (
    *db_, "req_reset", json{ { "order", nullptr } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"], 3);
}

// An update that names neither an owner nor an `order` keeps the position.
TEST_F (RequestsRouteTest, ARenameKeepsTheStoredOrder) {
    seed_collection_at ("col_p", "", 0);
    seed_collection_at ("col_f", "col_p", 2);
    seed_request_at ("req_a", "col_p", 1);

    auto [status, body] = vayu::http::routes::update_request_response (
    *db_, "req_a", json{ { "name", "renamed" } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"], 1);
}

// -- `order` is an integer from 0 to INT_MAX (#3451) ------------------------
//
// Parsed from text, as a wire body is: nlohmann reads a non-negative literal
// as unsigned. Mutation checks: read `order` through `apply_int_field` again
// and `"3"` / `2.5` create at 0 and move at the old slot; read it with a bare
// `get<int> ()` and 2^31 stores a negative; drop the `MAX_SIBLING_ORDER` stop
// in `Database::next_sibling_order` and the append after INT_MAX stores a
// negative.

constexpr auto UNSTORABLE_ORDERS = std::to_array<std::string_view> (
{ "2147483648", "4294967296", "9223372036854775808", "-1", "\"3\"", "2.5" });

bool names_order (const json& body) {
    const auto message =
    body.value (json::json_pointer ("/error/message"), std::string ());
    return message.find ("'order'") != std::string::npos;
}

TEST_F (RequestsRouteTest, ACreateStatingAnUnstorableOrderIsRefusedAndWritesNothing) {
    seed_collection_at ("col_p", "", 0);
    for (const std::string_view text : UNSTORABLE_ORDERS) {
        json body     = new_request ("col_p");
        body["order"] = json::parse (text);

        auto [status, response] = vayu::http::routes::create_request_response (*db_, body);

        EXPECT_EQ (status, 400) << text << " -> " << response.dump ();
        EXPECT_TRUE (names_order (response)) << response.dump ();
    }
    EXPECT_TRUE (db_->get_requests_in_collection ("col_p").empty ());
}

TEST_F (RequestsRouteTest, AnUpdateStatingAnUnstorableOrderIsRefusedAndLeavesTheRow) {
    seed_collection_at ("col_s", "", 0);
    seed_collection_at ("col_d", "", 1);
    seed_request_at ("req_a", "col_s", 4);
    for (const std::string_view text : UNSTORABLE_ORDERS) {
        for (const json& move : { json::object (), json{ { "collectionId", "col_d" } } }) {
            json body     = move;
            body["order"] = json::parse (text);

            auto [status, response] =
            vayu::http::routes::update_request_response (*db_, "req_a", body);

            EXPECT_EQ (status, 400) << body.dump () << " -> " << response.dump ();
            EXPECT_TRUE (names_order (response)) << response.dump ();
        }
    }
    const auto row = db_->get_request ("req_a");
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (row->collection_id, "col_s");
    EXPECT_EQ (row->order, 4);
}

TEST_F (RequestsRouteTest, TheHighestOrderIsStoredOnBothVerbs) {
    seed_collection_at ("col_p", "", 0);
    json body     = new_request ("col_p");
    body["order"] = json::parse ("2147483647");
    auto [status, created] = vayu::http::routes::create_request_response (*db_, body);
    ASSERT_EQ (status, 200) << created.dump ();
    EXPECT_EQ (created["order"], 2147483647);

    seed_request_at ("req_a", "col_p", 0);
    auto [update_status, updated] = vayu::http::routes::update_request_response (
    *db_, "req_a", json{ { "order", json::parse ("2147483647") } });
    ASSERT_EQ (update_status, 200) << updated.dump ();
    const auto row = db_->get_request ("req_a");
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (row->order, 2147483647);
}

// A folder at the last slot leaves a request nothing to append after, on a
// create and on a move that states no `order` alike.
TEST_F (RequestsRouteTest, AnAppendAfterTheHighestOrderIsRefused) {
    seed_collection_at ("col_full", "", 0);
    seed_collection_at ("col_f", "col_full", 2147483647);
    seed_collection_at ("col_s", "", 1);
    seed_request_at ("req_moving", "col_s", 3);

    auto [status, created] =
    vayu::http::routes::create_request_response (*db_, new_request ("col_full"));
    EXPECT_EQ (status, 400) << created.dump ();
    EXPECT_TRUE (names_order (created)) << created.dump ();
    EXPECT_TRUE (db_->get_requests_in_collection ("col_full").empty ());

    auto [move_status, moved] = vayu::http::routes::update_request_response (
    *db_, "req_moving", json{ { "collectionId", "col_full" } });
    EXPECT_EQ (move_status, 400) << moved.dump ();
    EXPECT_TRUE (names_order (moved)) << moved.dump ();
    const auto row = db_->get_request ("req_moving");
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (row->collection_id, "col_s");
    EXPECT_EQ (row->order, 3);
}

// -- A stored auth names a known mode (#3464) -------------------------------
//
// Mutation check: drop `reject_unknown_auth_mode` from either core and the
// matching test reds (each case is a loop, so all of its rows go with it); make
// it fire on null or on an absent `auth` and the valid-write test reds.

// Every body here parsed as stored and sent with no credential before the check.
const std::vector<json>& unknown_auth_blocks () {
    static const std::vector<json> blocks = {
        json{ { "mode", "Inherit" } },
        json{ { "mode", "Bearer" }, { "token", "t" } },
        json{ { "mode", " inherit" } },
        json{ { "mode", "" } },
        json{ { "mode", 7 } },
        json{ { "mode", nullptr } },
        json{ { "mode", json::array ({ "inherit" }) } },
        json{ { "token", "t" } },
        json::object (),
    };
    return blocks;
}

TEST_F (RequestsRouteTest, ACreateWithAnUnknownAuthModeIsRefusedAndWritesNothing) {
    seed_collection_at ("col_p", "", 0);

    for (const json& auth : unknown_auth_blocks ()) {
        json write    = new_request ("col_p");
        write["auth"] = auth;
        auto [status, response] =
        vayu::http::routes::create_request_response (*db_, write);

        EXPECT_EQ (status, 400) << auth.dump () << " -> " << response.dump ();
        EXPECT_NE (
        response["error"]["message"].get<std::string> ().find ("auth.mode"), std::string::npos)
        << response.dump ();
    }
    EXPECT_TRUE (db_->get_requests_in_collection ("col_p").empty ());
}

TEST_F (RequestsRouteTest, AnUpdateWithAnUnknownAuthModeIsRefusedAndLeavesTheRowAlone) {
    const std::string id = seed_request ();
    const auto before    = db_->get_request (id);
    ASSERT_HAS_VALUE (before);

    for (const json& auth : unknown_auth_blocks ()) {
        auto [status, response] = vayu::http::routes::update_request_response (
        *db_, id, json{ { "name", "Renamed" }, { "auth", auth } });

        EXPECT_EQ (status, 400) << auth.dump () << " -> " << response.dump ();
        EXPECT_NE (
        response["error"]["message"].get<std::string> ().find ("auth.mode"), std::string::npos)
        << response.dump ();
    }
    const auto after = db_->get_request (id);
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->name, before->name);
    EXPECT_EQ (after->auth, before->auth);
    EXPECT_EQ (after->updated_at, before->updated_at);
}

// A bare array was already a 400 from `apply_json_field`; it must still store
// nothing on either verb now that the mode check sits ahead of it.
TEST_F (RequestsRouteTest, AnAuthThatIsNotAnObjectIsStillRefusedOnBothVerbs) {
    const std::string id = seed_request ();
    json write           = new_request ("col_1");
    write["auth"]        = json::array ({ "inherit" });

    auto [created_status, created] =
    vayu::http::routes::create_request_response (*db_, write);
    auto [status, response] = vayu::http::routes::update_request_response (
    *db_, id, json{ { "auth", json::array ({ "inherit" }) } });

    EXPECT_EQ (created_status, 400) << created.dump ();
    EXPECT_EQ (status, 400) << response.dump ();
    EXPECT_EQ (db_->get_requests_in_collection ("col_1").size (), 1U);
}

// `inherit` is a request's own default (a collection refuses it, #3445), and
// the modes Vayu stores without executing stay writable so an imported request
// can be edited.
TEST_F (RequestsRouteTest, EveryKnownAuthModeIsStoredOnBothVerbsAndNullResetsToInherit) {
    const std::string id = seed_request ();
    for (const std::string_view mode : vayu::http::AUTH_MODES) {
        json write    = new_request ("col_1");
        write["auth"] = { { "mode", std::string (mode) } };
        auto [created_status, created] =
        vayu::http::routes::create_request_response (*db_, write);
        auto [status, response] = vayu::http::routes::update_request_response (
        *db_, id, json{ { "auth", { { "mode", std::string (mode) } } } });

        EXPECT_EQ (created_status, 200) << mode << " -> " << created.dump ();
        EXPECT_EQ (status, 200) << mode << " -> " << response.dump ();
        EXPECT_EQ (response["auth"]["mode"], std::string (mode));
    }

    auto [reset_status, reset] = vayu::http::routes::update_request_response (
    *db_, id, json{ { "auth", nullptr } });
    ASSERT_EQ (reset_status, 200) << reset.dump ();
    EXPECT_EQ (reset["auth"]["mode"], "inherit");
}

// -- Leaving a spec binding (#3446) -----------------------------------------
//
// `PUT /requests/:id` with a `collectionId` is the other door a request moves
// through (MCP `update_request`, any API client); it answers as `POST /reorder`
// does.

class RequestMoveSpecBindingTest : public RequestsRouteTest {
    protected:
    void SetUp () override {
        RequestsRouteTest::SetUp ();
        trees_ = std::make_unique<vayu::tests::SpecMoveTrees> (*db_);
    }
    void TearDown () override {
        trees_.reset ();
        RequestsRouteTest::TearDown ();
    }

    json put (const std::string& id, const json& body) {
        auto [status, response] =
        vayu::http::routes::update_request_response (*db_, id, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response;
    }

    /// The operation ids declined under `pets`, in recorded order.
    std::vector<std::string> declined_at_pets () {
        std::vector<std::string> ids;
        for (const auto& record : db_->get_declined_operations (trees_->pets)) {
            ids.push_back (record.operation_id);
        }
        return ids;
    }

    std::unique_ptr<vayu::tests::SpecMoveTrees> trees_;
};

// Mutation checks: drop the `spec_operation` clear in `update_request_locked`
// and the stamp survives into `cars`, which lists it as removed; pass no
// `declined_under` to `save_request` and `pets` lists `listOwners` as added
// and a safe sync creates it again.
TEST_F (RequestMoveSpecBindingTest, AStampedRequestMovedToAnotherBindingIsDeclinedAtTheSource) {
    const json response =
    put (trees_->list_owners, json{ { "collectionId", trees_->cars } });

    EXPECT_TRUE (response["specOperation"].is_null ()) << response.dump ();
    const auto declined = db_->get_declined_operations (trees_->pets);
    ASSERT_EQ (declined.size (), 1u);
    EXPECT_EQ (declined.front ().operation_id, "listOwners");
    EXPECT_EQ (declined.front ().request_id, trees_->list_owners);

    const json pets = trees_->diff_pets ();
    EXPECT_TRUE (pets["added"].empty ()) << pets.dump ();
    EXPECT_EQ (pets["declined"].size (), 1u) << pets.dump ();
    const json cars = trees_->diff (trees_->cars, vayu::tests::CARS_DOC);
    EXPECT_TRUE (cars["removed"].empty ()) << "nothing foreign: " << cars.dump ();
    EXPECT_EQ (trees_->safe_sync_pets_created (), 0u);
}

TEST_F (RequestMoveSpecBindingTest,
AStampedRequestMovedToAnUnboundCollectionIsDeclinedAtTheSource) {
    const json response =
    put (trees_->list_owners, json{ { "collectionId", trees_->plain } });

    EXPECT_TRUE (response["specOperation"].is_null ()) << response.dump ();
    EXPECT_EQ (declined_at_pets (), (std::vector<std::string>{ "listOwners" }));
    EXPECT_TRUE (trees_->diff_pets ()["added"].empty ());
    EXPECT_EQ (trees_->safe_sync_pets_created (), 0u);
}

TEST_F (RequestMoveSpecBindingTest, AMoveWithinTheBindingOrNoMoveAtAllKeepsTheStamp) {
    const json moved =
    put (trees_->list_owners, json{ { "collectionId", trees_->pets } });
    EXPECT_TRUE (moved["specOperation"].is_object ()) << moved.dump ();

    const json renamed = put (trees_->list_pets, json{ { "name", "every pet" } });
    EXPECT_TRUE (renamed["specOperation"].is_object ()) << renamed.dump ();

    EXPECT_TRUE (declined_at_pets ().empty ());
    const json pets = trees_->diff_pets ();
    EXPECT_TRUE (pets["added"].empty ()) << pets.dump ();
    EXPECT_TRUE (pets["declined"].empty ()) << pets.dump ();
}

// Merge-patch: a field the body states is what the row records, so a move that
// also states `specOperation` keeps the stated value. The source still loses
// the request. Mutation check: drop the `json.contains ("specOperation")`
// guard and the stated stamp is cleared.
TEST_F (RequestMoveSpecBindingTest, AMoveThatStatesItsStampKeepsTheStatedOne) {
    const json cars_stamp{ { "operationId", "listCars" }, { "method", "GET" },
        { "path", "/cars" } };
    const json response = put (trees_->list_owners,
    json{ { "collectionId", trees_->cars }, { "specOperation", cars_stamp } });

    EXPECT_EQ (response["specOperation"], cars_stamp) << response.dump ();
    EXPECT_EQ (declined_at_pets (), (std::vector<std::string>{ "listOwners" }));
}


// Mutation check: compare the two bindings' `specId` alone in
// `declined_by_move` and the stamp survives the move.
TEST_F (RequestMoveSpecBindingTest, AMoveToASiblingRootBoundToTheSameDocumentIsDeclined) {
    const std::string twin = trees_->create_bound ("Pets copy", trees_->pets_spec);

    const json response = put (trees_->list_owners, json{ { "collectionId", twin } });

    EXPECT_TRUE (response["specOperation"].is_null ()) << response.dump ();
    EXPECT_EQ (declined_at_pets (), (std::vector<std::string>{ "listOwners" }));
    EXPECT_TRUE (trees_->diff_pets ()["added"].empty ());
    EXPECT_EQ (trees_->safe_sync_pets_created (), 0u);
}

// Mutation check: keep a move only between identical binding collections in
// `declined_by_move` and both moves decline.
TEST_F (RequestMoveSpecBindingTest, AMoveBetweenTheRootAndASameDocumentSubFolderKeepsTheStamp) {
    const std::string inner =
    trees_->create_bound ("pets again", trees_->pets_spec, trees_->pets);

    const json in = put (trees_->list_owners, json{ { "collectionId", inner } });
    EXPECT_TRUE (in["specOperation"].is_object ()) << in.dump ();
    const json out = put (trees_->list_owners, json{ { "collectionId", trees_->pets } });
    EXPECT_TRUE (out["specOperation"].is_object ()) << out.dump ();

    EXPECT_TRUE (declined_at_pets ().empty ());
    EXPECT_TRUE (db_->get_declined_operations (inner).empty ());
}

} // namespace
