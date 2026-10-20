/**
 * @file tests/reorder_route_test.cpp
 * @brief POST /reorder - the atomic batch reorder/move (issue #365).
 *
 * What is pinned here:
 *
 *  - **Atomicity.** A batch with one invalid member is a 400 and leaves every
 *    row exactly where it was. This is the assertion that would have caught
 *    what a reorder expressed as N sibling `PUT`s does when it fails halfway,
 *    so each failure case checks the stored positions, not just the status.
 *
 *  - **Validation is complete before the first write, and names the offender.**
 *    A missing row, a missing owner, a duplicate move, a bad `order` - each is
 *    a 400 carrying the id a client can act on.
 *
 *  - **The cycle check runs against the shape the batch would produce**, not
 *    the shape on disk. Two reparents that each look legal alone but form a
 *    loop together are rejected as one batch - the race `PUT /collections/:id`
 *    cannot close, because it validates and writes under different locks.
 *
 *  - **Normalization materializes the displayed order** of a legacy all-zeros
 *    parent as dense 0..n-1 over its sub-folders and requests together, in the
 *    sibling order of `vayu/db/sibling_order.hpp` (#2535), and is idempotent -
 *    a second call writes nothing.
 *
 *  - **The lock scope spans validate + stage + write** (issue #386). The three
 *    tests at the bottom of this file each drive a genuinely concurrent writer
 *    into the window between a batch's validation and its commit, through the
 *    `before_write` seam, and assert the writer cannot get in: a conflicting
 *    reparent batch waits and is then rejected against the committed graph, a
 *    create waits and appends past the renumbered range rather than into it,
 *    and a row deleted mid-batch fails the batch with a 409 instead of being
 *    resurrected by the write. Before #386 each of those held only within one
 *    batch, while the endpoint's contract claimed otherwise.
 *
 * Route cores are exercised directly, no in-process HTTP server, matching the
 * suite's other route tests.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "competing_writer.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/db/sibling_order.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in reorder.cpp / collections.cpp / requests.cpp; each returns
// {http_status, json_body} - the same pair the HTTP handler writes out.
// `before_write` is reorder.cpp's test seam: invoked inside the batch's lock
// scope once it has staged and immediately before it commits.
std::pair<int, nlohmann::json> reorder_response (vayu::db::Database& db,
const nlohmann::json& body,
const std::function<void ()>& before_write = nullptr);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::create_collection_response;
using vayu::http::routes::create_request_response;
using vayu::http::routes::reorder_response;

class ReorderRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_reorder_route.db";

    // One millisecond apart, which is the entire margin `now_ms()` fails to
    // guarantee between two rows written inside the same tick.
    static constexpr int64_t EARLIER = 1700000000000;
    static constexpr int64_t LATER   = EARLIER + 1;

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

    /** Creates a collection through the real create core and returns its id. */
    std::string make_collection (const std::string& name,
    const std::optional<std::string>& parent = std::nullopt) {
        json body{ { "name", name } };
        if (parent.has_value ()) {
            body["parentId"] = *parent;
        }
        auto [status, response] = create_collection_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response["id"].get<std::string> ();
    }

    /** Creates a request through the real create core and returns its id. */
    std::string make_request (const std::string& collection_id, const std::string& name) {
        auto [status, response] = create_request_response (*db_,
        json{ { "collectionId", collection_id }, { "name", name },
        { "method", "GET" }, { "url", "https://example.com" } });
        EXPECT_EQ (status, 200) << response.dump ();
        return response["id"].get<std::string> ();
    }

    /**
     * Forces a collection's stored `order` and `created_at`, bypassing the
     * routes.
     *
     * The create core stamps `created_at` with `now_ms()`, so two collections
     * created inside one millisecond carry the same stamp. Once `order` is tied
     * as well, the display order falls through to `id`, which is a random UUID.
     * A scope built by two bare `make_collection` calls therefore has no stated
     * order at all, and asserting which row normalization renumbers first is
     * asserting a coin flip (issue #559). Every test that cares which row wins
     * states both keys through this.
     */
    void set_collection_position (const std::string& id, int order, int64_t created_at) {
        auto row = db_->get_collection (id);
        ASSERT_HAS_VALUE (row);
        row->order      = order;
        row->created_at = created_at;
        db_->create_collection (*row);
    }

    /** Forces a row to a stored `order`, bypassing the routes - the legacy shape. */
    void set_request_order (const std::string& id, int order) {
        auto row = db_->get_request (id);
        ASSERT_HAS_VALUE (row);
        row->order = order;
        db_->save_request (*row);
    }

    /** Request ids of a collection, in the engine's pinned display order. */
    std::vector<std::string> request_ids (const std::string& collection_id) {
        std::vector<std::string> ids;
        for (const auto& r : db_->get_requests_in_collection (collection_id)) {
            ids.push_back (r.id);
        }
        return ids;
    }

    /** Stored `order` of each request in a collection, in display order. */
    std::vector<int> request_orders (const std::string& collection_id) {
        std::vector<int> orders;
        for (const auto& r : db_->get_requests_in_collection (collection_id)) {
            orders.push_back (r.order);
        }
        return orders;
    }

    /**
     * A parent's children as (id, stored order), sub-folders and requests
     * merged in sibling order - the one list the sidebar and a recursive run
     * read (#2535).
     */
    std::vector<std::pair<std::string, int>> children (const std::string& parent_id) {
        const std::vector<vayu::db::Collection> collections = db_->get_collections ();
        std::vector<const vayu::db::Collection*> folders;
        for (const auto& c : collections) {
            if (c.parent_id == parent_id) {
                folders.push_back (&c);
            }
        }
        const std::vector<vayu::db::Request> requests =
        db_->get_requests_in_collection (parent_id);
        std::vector<std::pair<std::string, int>> listed;
        for (const auto& slot : vayu::db::merge_siblings (folders, requests)) {
            if (slot.kind == vayu::db::SiblingKind::Folder) {
                listed.emplace_back (
                folders.at (slot.index)->id, folders.at (slot.index)->order);
            } else {
                listed.emplace_back (
                requests.at (slot.index).id, requests.at (slot.index).order);
            }
        }
        return listed;
    }

    static json move_request (const std::string& id, int order) {
        return json{ { "type", "request" }, { "id", id }, { "order", order } };
    }

    /** A scope: a parent's sub-folders and requests together (#2535). */
    static json normalize_parent (const json& parent_id) {
        return json{ { "parentId", parent_id } };
    }

    /** A collection move; `parent_id` is a collection id or `json(nullptr)`. */
    static json move_collection (const std::string& id, int order, const json& parent_id) {
        return json{ { "type", "collection" }, { "id", id }, { "order", order },
            { "parentId", parent_id } };
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

TEST_F (ReorderRouteTest, AnInvalidMemberWritesNothingAtAll) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");
    const std::string b   = make_request (col, "b");
    const std::string c   = make_request (col, "c");
    ASSERT_EQ (request_orders (col), (std::vector<int>{ 0, 1, 2 }));

    // The first two moves are perfectly legal; the third names a row that does
    // not exist. Nothing may land - including the two that would have.
    json body{ { "moves",
    json::array (
    { move_request (c, 0), move_request (a, 1), move_request ("req_missing", 2) }) } };
    auto [status, response] = reorder_response (*db_, body);

    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_NE (
    response["error"]["message"].get<std::string> ().find ("req_missing"), std::string::npos)
    << response.dump ();
    EXPECT_EQ (request_ids (col), (std::vector<std::string>{ a, b, c }));
    EXPECT_EQ (request_orders (col), (std::vector<int>{ 0, 1, 2 }));
}

TEST_F (ReorderRouteTest, ANormalizationIsAbandonedWhenAMoveIsInvalid) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");
    const std::string b   = make_request (col, "b");
    set_request_order (a, 0);
    set_request_order (b, 0); // The legacy all-zeros shape.

    json body{ { "normalize", json::array ({ normalize_parent (col) }) },
        { "moves", json::array ({ move_request (b, -1) }) } };
    auto [status, response] = reorder_response (*db_, body);

    ASSERT_EQ (status, 400) << response.dump ();
    // The renumber the normalize list would have performed must not survive the
    // move's rejection: validation completes before the first write.
    EXPECT_EQ (request_orders (col), (std::vector<int>{ 0, 0 }));
}

// ---------------------------------------------------------------------------
// Validation - each failure names the row a client can act on
// ---------------------------------------------------------------------------

TEST_F (ReorderRouteTest, RejectsAMoveIntoACollectionThatDoesNotExist) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");

    json body{ { "moves",
    json::array ({ json{ { "type", "request" }, { "id", a }, { "order", 0 },
    { "collectionId", "col_gone" } } }) } };
    auto [status, response] = reorder_response (*db_, body);

    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_NE (
    response["error"]["message"].get<std::string> ().find ("col_gone"), std::string::npos);
    // The row stays where it was rather than being stranded under a missing owner.
    const auto stored_request = db_->get_request (a);
    ASSERT_HAS_VALUE (stored_request);
    EXPECT_EQ (stored_request->collection_id, col);
}

TEST_F (ReorderRouteTest, RejectsTwoPositionsForOneRow) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");
    make_request (col, "b");

    json body{ { "moves", json::array ({ move_request (a, 0), move_request (a, 1) }) } };
    auto [status, response] = reorder_response (*db_, body);

    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_NE (response["error"]["message"].get<std::string> ().find (a), std::string::npos);
}

TEST_F (ReorderRouteTest, RejectsANonIntegerOrAbsentOrder) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");

    for (const json& bad : { json (1.5), json ("2"), json (nullptr) }) {
        json move{ { "type", "request" }, { "id", a }, { "order", bad } };
        auto [status, response] =
        reorder_response (*db_, json{ { "moves", json::array ({ move }) } });
        EXPECT_EQ (status, 400) << bad.dump () << " -> " << response.dump ();
    }
    json without{ { "type", "request" }, { "id", a } };
    auto [status, response] =
    reorder_response (*db_, json{ { "moves", json::array ({ without }) } });
    EXPECT_EQ (status, 400) << response.dump ();
}

TEST_F (ReorderRouteTest, RejectsAnUnknownTypeAndAMalformedNormalizeScope) {
    const std::string col = make_collection ("Billing");

    auto [type_status, type_body] = reorder_response (*db_,
    json{ { "moves",
    json::array ({ json{ { "type", "folder" }, { "id", col }, { "order", 0 } } }) } });
    EXPECT_EQ (type_status, 400) << type_body.dump ();

    // A scope must *state* parentId - absent cannot be read as "the roots"
    // without a renumber occasionally landing on the wrong folder.
    auto [scope_status, scope_body] = reorder_response (
    *db_, json{ { "normalize", json::array ({ json::object () }) } });
    EXPECT_EQ (scope_status, 400) << scope_body.dump ();
}

// The per-kind scopes from before #2535 are refused, naming the shape that
// replaced them, and nothing is renumbered: one kind renumbered alone would
// tie with the other kind's slots.
TEST_F (ReorderRouteTest, RefusesAPerKindNormalizeScopeNamingTheParentShape) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");
    const std::string b   = make_request (col, "b");
    set_request_order (a, 0);
    set_request_order (b, 0);

    for (const json& legacy : { json{ { "type", "request" }, { "collectionId", col } },
         json{ { "type", "collection" }, { "parentId", col } },
         json{ { "type", "collection" }, { "parentId", nullptr } } }) {
        auto [status, response] =
        reorder_response (*db_, json{ { "normalize", json::array ({ legacy }) } });
        ASSERT_EQ (status, 400) << legacy.dump () << " -> " << response.dump ();
        const auto message = response["error"]["message"].get<std::string> ();
        EXPECT_NE (message.find (R"({"parentId": )"), std::string::npos) << message;
    }
    EXPECT_EQ (request_orders (col), (std::vector<int>{ 0, 0 }));
}

// ---------------------------------------------------------------------------
// Cycles, validated against the post-move shape
// ---------------------------------------------------------------------------

TEST_F (ReorderRouteTest, RejectsACycleFormedOnlyByTheBatchAsAWhole) {
    const std::string a = make_collection ("A");
    const std::string b = make_collection ("B");

    // Each move alone is legal against the stored shape - A under B is fine
    // while B is a root, and B under A is fine while A is a root. Together they
    // are a loop, and only a validator that reads the post-move shape sees it.
    json body{ { "moves",
    json::array ({ json{ { "type", "collection" }, { "id", a }, { "order", 0 }, { "parentId", b } },
    json{ { "type", "collection" }, { "id", b }, { "order", 0 }, { "parentId", a } } }) } };
    auto [status, response] = reorder_response (*db_, body);

    ASSERT_EQ (status, 400) << response.dump ();
    const auto a_row = db_->get_collection (a);
    ASSERT_HAS_VALUE (a_row);
    EXPECT_FALSE (a_row->parent_id.has_value ());
    const auto b_row = db_->get_collection (b);
    ASSERT_HAS_VALUE (b_row);
    EXPECT_FALSE (b_row->parent_id.has_value ());
}

TEST_F (ReorderRouteTest, RejectsASelfParentAndAMoveIntoOwnDescendant) {
    const std::string parent = make_collection ("parent");
    const std::string child  = make_collection ("child", parent);

    auto [self_status, self_body] = reorder_response (*db_,
    json{ { "moves",
    json::array ({ json{ { "type", "collection" }, { "id", parent },
    { "order", 0 }, { "parentId", parent } } }) } });
    EXPECT_EQ (self_status, 400) << self_body.dump ();

    auto [desc_status, desc_body] = reorder_response (*db_,
    json{ { "moves",
    json::array ({ json{ { "type", "collection" }, { "id", parent },
    { "order", 0 }, { "parentId", child } } }) } });
    EXPECT_EQ (desc_status, 400) << desc_body.dump ();
    const auto stored_collection = db_->get_collection (parent);
    ASSERT_HAS_VALUE (stored_collection);
    EXPECT_FALSE (stored_collection->parent_id.has_value ());
}

TEST_F (ReorderRouteTest, AcceptsAReparentThatBreaksAnExistingChain) {
    const std::string root = make_collection ("root");
    const std::string mid  = make_collection ("mid", root);
    const std::string leaf = make_collection ("leaf", mid);

    // Moving `mid` under `leaf` is only legal because the same batch lifts
    // `leaf` out to the root first - the post-move shape is root/leaf/mid.
    json body{ { "moves",
    json::array ({ json{ { "type", "collection" }, { "id", leaf }, { "order", 0 }, { "parentId", root } },
    json{ { "type", "collection" }, { "id", mid }, { "order", 0 }, { "parentId", leaf } } }) } };
    auto [status, response] = reorder_response (*db_, body);

    ASSERT_EQ (status, 200) << response.dump ();
    const auto leaf_row = db_->get_collection (leaf);
    ASSERT_HAS_VALUE (leaf_row);
    ASSERT_HAS_VALUE (leaf_row->parent_id);
    EXPECT_EQ (*leaf_row->parent_id, root);
    const auto mid_row = db_->get_collection (mid);
    ASSERT_HAS_VALUE (mid_row);
    ASSERT_HAS_VALUE (mid_row->parent_id);
    EXPECT_EQ (*mid_row->parent_id, leaf);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

TEST_F (ReorderRouteTest, NormalizationMaterializesTheDisplayedOrderOfALegacyScope) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");
    const std::string b   = make_request (col, "b");
    const std::string c   = make_request (col, "c");
    for (const auto& id : { a, b, c }) {
        set_request_order (id, 0); // Every row created before explicit orders existed.
    }
    const std::vector<std::string> displayed = request_ids (col);

    auto [status, response] = reorder_response (
    *db_, json{ { "normalize", json::array ({ normalize_parent (col) }) } });

    ASSERT_EQ (status, 200) << response.dump ();
    // Dense, and in exactly the order the client was already showing - nothing
    // may visibly jump when the first drop lands.
    EXPECT_EQ (request_orders (col), (std::vector<int>{ 0, 1, 2 }));
    EXPECT_EQ (request_ids (col), displayed);
}

TEST_F (ReorderRouteTest, NormalizationIsIdempotent) {
    const std::string col = make_collection ("Billing");
    for (const auto& name : { "a", "b", "c" }) {
        set_request_order (make_request (col, name), 0);
    }
    json body{ { "normalize", json::array ({ normalize_parent (col) }) } };

    auto [first_status, first] = reorder_response (*db_, body);
    ASSERT_EQ (first_status, 200) << first.dump ();
    EXPECT_EQ (first["requests"].size (), 2u); // The row already at 0 needs no write.

    auto [second_status, second] = reorder_response (*db_, body);
    ASSERT_EQ (second_status, 200) << second.dump ();
    // Nothing left to change, so nothing is written - the observable form of
    // idempotence, and what keeps a repeated normalize off the write path.
    EXPECT_EQ (second["requests"].size (), 0u);
    EXPECT_EQ (request_orders (col), (std::vector<int>{ 0, 1, 2 }));
}

TEST_F (ReorderRouteTest, NormalizationRunsBeforeTheMovesAndTheMovesWin) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");
    const std::string b   = make_request (col, "b");
    const std::string c   = make_request (col, "c");
    for (const auto& id : { a, b, c }) {
        set_request_order (id, 0);
    }

    // The first drop into a legacy collection: normalize to 0,1,2 and, in the
    // same batch, move `c` to the head - which is only expressible because the
    // renumber gave the other two real slots to shift into.
    json body{ { "normalize", json::array ({ normalize_parent (col) }) },
        { "moves",
        json::array ({ move_request (c, 0), move_request (a, 1), move_request (b, 2) }) } };
    auto [status, response] = reorder_response (*db_, body);

    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (request_ids (col), (std::vector<std::string>{ c, a, b }));
    EXPECT_EQ (request_orders (col), (std::vector<int>{ 0, 1, 2 }));
}

TEST_F (ReorderRouteTest, NormalizesTheRootCollectionsWhenParentIdIsNull) {
    const std::string a     = make_collection ("A");
    const std::string b     = make_collection ("B");
    const std::string child = make_collection ("child", a);

    // Tie the two roots at the pre-#360 shape, and state the key that breaks
    // the tie rather than inheriting whatever the clock happened to give them.
    set_collection_position (a, 0, EARLIER);
    set_collection_position (b, 0, LATER);

    auto [status, response] = reorder_response (
    *db_, json{ { "normalize", json::array ({ normalize_parent (nullptr) }) } });

    ASSERT_EQ (status, 200) << response.dump ();
    const auto a_row = db_->get_collection (a);
    ASSERT_HAS_VALUE (a_row);
    EXPECT_EQ (a_row->order, 0);
    const auto b_row = db_->get_collection (b);
    ASSERT_HAS_VALUE (b_row);
    EXPECT_EQ (b_row->order, 1);
    // A nested collection is in a different scope and must be left alone.
    const auto child_row = db_->get_collection (child);
    ASSERT_HAS_VALUE (child_row);
    EXPECT_EQ (child_row->order, 0);
}

// A scope is a parent's sub-folders and requests together (#2535): the
// renumber walks the merged list, so the two kinds share one dense range.
// Mutation check: renumber each kind from 0 on its own in `normalize_scope`
// and the request comes out at 0, tied with the first folder.
TEST_F (ReorderRouteTest, TheDenseRenumberCoversFoldersAndRequestsAsOneList) {
    const std::string parent  = make_collection ("parent");
    const std::string first   = make_collection ("first", parent);
    const std::string second  = make_collection ("second", parent);
    const std::string between = make_request (parent, "between");
    set_collection_position (first, 5, EARLIER);
    set_collection_position (second, 9, EARLIER);
    set_request_order (between, 7);

    auto [status, response] = reorder_response (
    *db_, json{ { "normalize", json::array ({ normalize_parent (parent) }) } });

    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (children (parent),
    (std::vector<std::pair<std::string, int>>{ { first, 0 }, { between, 1 }, { second, 2 } }));
    EXPECT_EQ (response["collections"].size (), 2u) << response.dump ();
    EXPECT_EQ (response["requests"].size (), 1u) << response.dump ();
}

// A pre-#2535 parent with every row at the legacy 0: the tie rule ranks the
// sub-folders first, so the renumber writes the folders 0..m-1 and the
// requests after them - the display the sidebar already showed, now in real
// slots - and a second normalize writes nothing.
TEST_F (ReorderRouteTest, ALegacyAllZeroParentDensifiesItsFoldersFirstThenItsRequests) {
    const std::string parent = make_collection ("parent");
    const std::string fa     = make_collection ("fa", parent);
    const std::string fb     = make_collection ("fb", parent);
    const std::string ra     = make_request (parent, "ra");
    const std::string rb     = make_request (parent, "rb");
    set_collection_position (fa, 0, EARLIER);
    set_collection_position (fb, 0, LATER);
    set_request_order (ra, 0);
    set_request_order (rb, 0);
    const std::vector<std::string> requests_displayed = request_ids (parent);

    json body{ { "normalize", json::array ({ normalize_parent (parent) }) } };
    auto [status, response] = reorder_response (*db_, body);

    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (children (parent),
    (std::vector<std::pair<std::string, int>>{ { fa, 0 }, { fb, 1 },
    { requests_displayed.at (0), 2 }, { requests_displayed.at (1), 3 } }));

    auto [again_status, again] = reorder_response (*db_, body);
    ASSERT_EQ (again_status, 200) << again.dump ();
    EXPECT_EQ (again["collections"].size (), 0u);
    EXPECT_EQ (again["requests"].size (), 0u);
}

/**
 * The same tied scope with the stamps swapped, so the renumber must come out
 * the other way round.
 *
 * Without this the test above passes just as well against a normalization that
 * read no `created_at` at all and simply kept whatever order the rows were
 * created in - two rows and one direction cannot separate "renumbered in stored
 * order" from "renumbered in creation order".
 */
TEST_F (ReorderRouteTest, NormalizesTiedRootsInStoredOrderNotCreationOrder) {
    const std::string a = make_collection ("A");
    const std::string b = make_collection ("B");

    // `b` was created second and is stamped first, so stored order and creation
    // order disagree; stored order is the one normalization owes the client.
    set_collection_position (a, 0, LATER);
    set_collection_position (b, 0, EARLIER);

    auto [status, response] = reorder_response (
    *db_, json{ { "normalize", json::array ({ normalize_parent (nullptr) }) } });

    ASSERT_EQ (status, 200) << response.dump ();
    const auto b_row = db_->get_collection (b);
    ASSERT_HAS_VALUE (b_row);
    EXPECT_EQ (b_row->order, 0);
    const auto a_row = db_->get_collection (a);
    ASSERT_HAS_VALUE (a_row);
    EXPECT_EQ (a_row->order, 1);
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

TEST_F (ReorderRouteTest, AnAdjacentSwapWritesExactlyTwoRows) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");
    const std::string b   = make_request (col, "b");
    make_request (col, "c");

    auto [status, response] = reorder_response (*db_,
    json{ { "moves", json::array ({ move_request (b, 0), move_request (a, 1) }) } });

    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (response["requests"].size (), 2u);
    EXPECT_EQ (response["collections"].size (), 0u);
    EXPECT_EQ (request_orders (col), (std::vector<int>{ 0, 1, 2 }));
    EXPECT_EQ (request_ids (col)[0], b);
}

TEST_F (ReorderRouteTest, MovesARequestAcrossCollectionsInOneBatch) {
    const std::string source = make_collection ("source");
    const std::string target = make_collection ("target");
    const std::string a      = make_request (source, "a");
    const std::string b      = make_request (source, "b");
    const std::string t      = make_request (target, "t");

    // `a` lands at the head of `target`; `t` shifts down; `b` closes the gap.
    json body{ { "moves",
    json::array ({ json{ { "type", "request" }, { "id", a }, { "order", 0 }, { "collectionId", target } },
    move_request (t, 1), move_request (b, 0) }) } };
    auto [status, response] = reorder_response (*db_, body);

    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (request_ids (source), (std::vector<std::string>{ b }));
    EXPECT_EQ (request_ids (target), (std::vector<std::string>{ a, t }));
    EXPECT_EQ (request_orders (source), (std::vector<int>{ 0 }));
    EXPECT_EQ (request_orders (target), (std::vector<int>{ 0, 1 }));
}

// The drop #2535 makes possible: a request between two folders of one parent,
// and a recursive run follows it - the request runs between the two folders'
// subtrees instead of after both.
TEST_F (ReorderRouteTest, ADropPutsARequestBetweenTwoFolders) {
    const std::string parent    = make_collection ("parent");
    const std::string first     = make_collection ("first", parent);
    const std::string second    = make_collection ("second", parent);
    const std::string in_first  = make_request (first, "in first");
    const std::string in_second = make_request (second, "in second");
    const std::string dropped   = make_request (parent, "dropped");
    ASSERT_EQ (children (parent),
    (std::vector<std::pair<std::string, int>>{ { first, 0 }, { second, 1 }, { dropped, 2 } }));

    auto [status, response] = reorder_response (*db_,
    json{ { "moves",
    json::array ({ move_request (dropped, 1), move_collection (second, 2, parent) }) } });

    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (children (parent),
    (std::vector<std::pair<std::string, int>>{ { first, 0 }, { dropped, 1 }, { second, 2 } }));
    std::vector<std::string> run;
    for (const auto& r : db_->get_requests_in_subtree (parent)) {
        run.push_back (r.id);
    }
    EXPECT_EQ (run, (std::vector<std::string>{ in_first, dropped, in_second }));
}

TEST_F (ReorderRouteTest, AMoveWithoutAnOwnerKeepsTheOneItHas) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");

    auto [status, response] = reorder_response (
    *db_, json{ { "moves", json::array ({ move_request (a, 7) }) } });

    ASSERT_EQ (status, 200) << response.dump ();
    const auto a_row = db_->get_request (a);
    ASSERT_HAS_VALUE (a_row);
    EXPECT_EQ (a_row->collection_id, col);
    EXPECT_EQ (a_row->order, 7);
}

TEST_F (ReorderRouteTest, AnEmptyBatchIsANoOp) {
    const std::string col = make_collection ("Billing");
    make_request (col, "a");

    auto [status, response] = reorder_response (*db_, json::object ());

    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (response["collections"].size (), 0u);
    EXPECT_EQ (response["requests"].size (), 0u);
    EXPECT_EQ (request_orders (col), (std::vector<int>{ 0 }));
}

TEST_F (ReorderRouteTest, TheResponseCarriesTheRowsAsWritten) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");
    const std::string b   = make_request (col, "b");

    auto [status, response] = reorder_response (*db_,
    json{ { "moves", json::array ({ move_request (b, 0), move_request (a, 1) }) } });

    ASSERT_EQ (status, 200) << response.dump ();
    // The client draws the drop optimistically and settles its caches on these
    // rows, so they must be the full serialized shape a list entry carries.
    for (const auto& row : response["requests"]) {
        ASSERT_TRUE (row.contains ("id")) << row.dump ();
        EXPECT_EQ (row["collectionId"].get<std::string> (), col);
        const auto stored_request = db_->get_request (row["id"]);
        ASSERT_HAS_VALUE (stored_request);
        EXPECT_EQ (row["order"].get<int> (), stored_request->order);
    }
}

// The rows a client settles its caches on carry the file trust a list entry
// does, derived from the picked files (#2356). Mutation check: serialize the
// rows in `reorder_locked` against an empty `FileAccessPolicy` and the picked
// file reads unresolved.
TEST_F (ReorderRouteTest, TheResponseRowsDeriveTheirFileTrust) {
    const std::filesystem::path picked_path =
    std::filesystem::current_path () / "reorder_route_picked.bin";
    std::ofstream (picked_path) << "picked";
    vayu::FileGrant grant;
    grant.id   = "fgrant_reorder";
    grant.path = std::filesystem::canonical (picked_path).string ();
    db_->save_file_grant (grant);

    const std::string col = make_collection ("Uploads");
    const auto upload = [&] (const std::string& name, const std::string& src) {
        auto [status, response] = create_request_response (*db_,
        json{ { "collectionId", col }, { "name", name }, { "method", "POST" },
        { "url", "https://example.com" },
        { "body", { { "mode", "binary" }, { "file", { { "src", src } } } } } });
        EXPECT_EQ (status, 200) << response.dump ();
        return response["id"].get<std::string> ();
    };
    const std::string picked    = upload ("picked", picked_path.string ());
    const std::string elsewhere = upload ("elsewhere", "/no/such/b.bin");

    auto [status, response] = reorder_response (*db_,
    json{ { "moves",
    json::array ({ move_request (elsewhere, 0), move_request (picked, 1) }) } });
    std::filesystem::remove (picked_path);

    ASSERT_EQ (status, 200) << response.dump ();
    ASSERT_EQ (response["requests"].size (), 2u) << response.dump ();
    for (const auto& row : response["requests"]) {
        EXPECT_EQ (row["body"]["file"]["unresolved"], row["id"] == elsewhere)
        << row.dump ();
    }
}

// ---------------------------------------------------------------------------
// The lock scope: validate + stage + write (issue #386)
// ---------------------------------------------------------------------------

/**
 * The competing writer these three tests drive into the window is
 * `vayu::tests::CompetingWriter` (`competing_writer.hpp`), shared with the
 * resource PUTs' own lock-scope tests (#1440); its header carries why the
 * window makes each case decide in both directions.
 */
using vayu::tests::CompetingWriter;

TEST_F (ReorderRouteTest, AConflictingBatchWaitsAndIsRejectedAgainstTheCommittedGraph) {
    const std::string a = make_collection ("A");
    const std::string b = make_collection ("B");

    // The mirror image of RejectsACycleFormedOnlyByTheBatchAsAWhole, split
    // across two clients: A-under-B and B-under-A are each legal against the
    // shape both of them read, and only the loser revalidating against the
    // winner's committed graph rejects the second.
    int other_status = 0;
    json other_body;
    CompetingWriter other ([&] {
        auto result = reorder_response (
        *db_, json{ { "moves", json::array ({ move_collection (b, 0, a) }) } });
        other_status = result.first;
        other_body   = result.second;
    });

    auto [status, response] = reorder_response (*db_,
    json{ { "moves", json::array ({ move_collection (a, 0, b) }) } }, other.probe ());
    ASSERT_EQ (status, 200) << response.dump ();
    other.join ();

    EXPECT_EQ (other_status, 400) << other_body.dump ();
    const auto a_row = db_->get_collection (a);
    ASSERT_HAS_VALUE (a_row);
    EXPECT_EQ (a_row->parent_id, std::optional<std::string> (b));
    const auto b_row = db_->get_collection (b);
    ASSERT_HAS_VALUE (b_row);
    EXPECT_FALSE (b_row->parent_id.has_value ());
}

TEST_F (ReorderRouteTest, ACreateDuringABatchWaitsAndAppendsPastTheRenumberedRange) {
    const std::string col = make_collection ("Billing");
    for (const auto& name : { "a", "b", "c" }) {
        set_request_order (make_request (col, name), 0);
    }

    std::string late;
    CompetingWriter creator ([&] { late = make_request (col, "late"); });

    auto [status, response] = reorder_response (*db_,
    json{ { "normalize", json::array ({ normalize_parent (col) }) } }, creator.probe ());
    ASSERT_EQ (status, 200) << response.dump ();
    creator.join ();

    // The create's append scan reads `max_order + 1`. Let it run inside the
    // batch's window and it reads the pre-renumber rows - every one at 0 - and
    // takes slot 1, tying with the row the batch is renumbering to 1.
    const auto stored_request = db_->get_request (late);
    ASSERT_HAS_VALUE (stored_request);
    EXPECT_EQ (stored_request->order, 3);
    EXPECT_EQ (request_orders (col), (std::vector<int>{ 0, 1, 2, 3 }));
    EXPECT_EQ (request_ids (col).back (), late);
}

TEST_F (ReorderRouteTest, ARowDeletedAfterStagingFailsTheBatchRatherThanBeingResurrected) {
    const std::string col = make_collection ("Billing");
    const std::string a   = make_request (col, "a");
    const std::string b   = make_request (col, "b");
    ASSERT_EQ (request_orders (col), (std::vector<int>{ 0, 1 }));

    // No other thread can reach this window - that is the point of the lock -
    // so the delete runs on this one, from inside the seam. The DB mutex is
    // recursive, so it lands in the batch's own lock scope: the exact state
    // `apply_reorder` must refuse to write over, whoever produced it.
    json body{ { "moves", json::array ({ move_request (a, 1), move_request (b, 0) }) } };
    auto [status, response] =
    reorder_response (*db_, body, [&] { db_->delete_request (b); });

    ASSERT_EQ (status, 409) << response.dump ();
    EXPECT_NE (response["error"]["message"].get<std::string> ().find (b), std::string::npos)
    << response.dump ();
    // `replace` would have written the staged row straight back.
    EXPECT_FALSE (db_->get_request (b).has_value ());
    // And the rows the batch had already updated roll back with it.
    const auto stored_request = db_->get_request (a);
    ASSERT_HAS_VALUE (stored_request);
    EXPECT_EQ (stored_request->order, 0);
}

} // namespace
