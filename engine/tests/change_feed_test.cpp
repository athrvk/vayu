/**
 * @file tests/change_feed_test.cpp
 * @brief The workspace change feed (issue #3420): the ring and its resume
 *        rule, and what each `Database` write publishes and when.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/db/change_feed.hpp"
#include "vayu/db/database.hpp"

#include "optional_assert.hpp"
#include "temp_database.hpp"

namespace {

using nlohmann::json;
using vayu::db::Change;
using vayu::db::ChangeFeed;
using vayu::db::ChangeKind;
using vayu::db::ChangeOp;

namespace feed_constants = vayu::core::constants::change_feed;

Change request_change (const std::string& id, ChangeOp op = ChangeOp::Update) {
    return Change{ ChangeKind::Request, op, id, "col_1", std::nullopt };
}

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

TEST (ChangeFeedTest, IdsCountUpByOneFromTheBase) {
    ChangeFeed feed (1000);
    EXPECT_EQ (feed.last_id (), 1000);

    feed.publish (request_change ("req_a"));
    feed.publish (std::vector<Change>{ request_change ("req_b"), request_change ("req_c") });

    EXPECT_EQ (feed.last_id (), 1003);
    const auto read = feed.since (1000);
    EXPECT_FALSE (read.reset);
    ASSERT_EQ (read.events.size (), 3U);
    EXPECT_EQ (read.events[0].id, 1001);
    EXPECT_EQ (read.events[0].change.id, "req_a");
    EXPECT_EQ (read.events[2].id, 1003);
    EXPECT_EQ (read.events[2].change.id, "req_c");
    EXPECT_EQ (read.last_id, 1003);
}

TEST (ChangeFeedTest, AResumeInsideTheRingReplaysOnlyWhatCameAfterIt) {
    ChangeFeed feed (0, 4);
    for (const char* id : { "a", "b", "c", "d", "e", "f" }) {
        feed.publish (request_change (id));
    }
    // Holds 3..6; a reader at 2 has seen everything before the oldest kept.
    const auto from_two = feed.since (2);
    EXPECT_FALSE (from_two.reset);
    ASSERT_EQ (from_two.events.size (), 4U);
    EXPECT_EQ (from_two.events.front ().change.id, "c");

    const auto from_five = feed.since (5);
    ASSERT_EQ (from_five.events.size (), 1U);
    EXPECT_EQ (from_five.events.front ().id, 6);

    const auto current = feed.since (6);
    EXPECT_FALSE (current.reset);
    EXPECT_TRUE (current.events.empty ());
    EXPECT_EQ (current.last_id, 6);
}

TEST (ChangeFeedTest, AResumeFromAnEvictedIdIsAReset) {
    ChangeFeed feed (0, 4);
    for (const char* id : { "a", "b", "c", "d", "e", "f" }) {
        feed.publish (request_change (id));
    }
    // Event 2 was evicted: the reader at 1 cannot be told what it missed.
    const auto read = feed.since (1);
    EXPECT_TRUE (read.reset);
    EXPECT_TRUE (read.events.empty ());
    EXPECT_EQ (read.last_id, 6);
}

// An id from an earlier engine process sits below this one's base (the base
// is the start time in microseconds), and one past the newest is not an id
// this feed issued either.
TEST (ChangeFeedTest, AnIdThisFeedNeverIssuedIsAReset) {
    ChangeFeed feed (500, 4);
    EXPECT_TRUE (feed.since (499).reset) << "below the base, nothing published";
    EXPECT_FALSE (feed.since (500).reset) << "the base itself is current";
    feed.publish (request_change ("a"));
    EXPECT_TRUE (feed.since (499).reset);
    EXPECT_TRUE (feed.since (502).reset) << "past the newest id";
    EXPECT_FALSE (feed.since (500).reset);
}

TEST (ChangeFeedTest, AFeedRetainsAtLeastOneEvent) {
    EXPECT_THROW (ChangeFeed (0, 0), std::invalid_argument);
}

TEST (ChangeFeedTest, TheReaderSlotsAreBounded) {
    ChangeFeed feed (0);
    for (int slot = 0; slot < feed_constants::MAX_READERS; ++slot) {
        ASSERT_TRUE (feed.try_add_reader ()) << "slot " << slot;
    }
    EXPECT_FALSE (feed.try_add_reader ());
    feed.remove_reader ();
    EXPECT_TRUE (feed.try_add_reader ()) << "a released slot is taken again";
}

TEST (ChangeFeedTest, TheWireShapeCarriesOnlyTheOwnerTheKindNames) {
    EXPECT_EQ (vayu::db::change_json (request_change ("req_1", ChangeOp::Create)),
    json ({ { "kind", "request" }, { "id", "req_1" }, { "op", "create" },
    { "collectionId", "col_1" } }));
    EXPECT_EQ (vayu::db::change_json (Change{ ChangeKind::Example,
               ChangeOp::Delete, "exa_1", std::nullopt, "req_1" }),
    json ({ { "kind", "example" }, { "id", "exa_1" }, { "op", "delete" },
    { "requestId", "req_1" } }));
    EXPECT_EQ (vayu::db::change_json (Change{ ChangeKind::Globals,
               ChangeOp::Update, "globals", std::nullopt, std::nullopt }),
    json ({ { "kind", "globals" }, { "id", "globals" }, { "op", "update" } }));
    EXPECT_EQ (vayu::db::change_kind_of_trash_entry ("clientCertificate"),
    ChangeKind::ClientCertificate);
    EXPECT_THROW (
    static_cast<void> (vayu::db::change_kind_of_trash_entry ("run")), std::logic_error);
}

// ---------------------------------------------------------------------------
// What a `Database` write publishes
// ---------------------------------------------------------------------------

constexpr const char* DB_PATH = "test_change_feed.db";

/// A day in milliseconds, the unit `trashRetentionDays` counts in.
constexpr int64_t DAY_MS = 24LL * 60 * 60 * 1000;

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

class ChangeFeedDatabaseTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    vayu::db::Collection make_collection (const std::string& id,
    const std::optional<std::string>& parent = std::nullopt) {
        vayu::db::Collection collection;
        collection.id         = id;
        collection.name       = id;
        collection.parent_id  = parent;
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);
        return collection;
    }

    vayu::db::Request make_request (const std::string& id, const std::string& collection_id) {
        vayu::db::Request request;
        request.id            = id;
        request.collection_id = collection_id;
        request.name          = id;
        request.method        = vayu::HttpMethod::GET;
        request.url           = "https://example.test/" + id;
        request.created_at    = 1;
        request.updated_at    = 1;
        db_->save_request (request);
        return request;
    }

    vayu::db::RequestExample example_row (const std::string& id,
    const std::string& request_id,
    const char* origin = vayu::core::constants::request_example::ORIGIN_USER) {
        vayu::db::RequestExample example;
        example.id         = id;
        example.request_id = request_id;
        example.name       = id;
        example.status     = 200;
        example.headers    = "[]";
        example.origin     = origin;
        example.created_at = 1;
        example.updated_at = 1;
        return example;
    }

    /// What has been published since @p before, which must not be a reset.
    std::vector<vayu::db::ChangeEvent> published_since (int64_t before) {
        auto read = db_->change_feed ().since (before);
        EXPECT_FALSE (read.reset);
        return std::move (read.events);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// A cascade is one change, on the root: the client refetches the tree for it.
TEST_F (ChangeFeedDatabaseTest, ACascadePublishesOneChangeOnTheRootItNamed) {
    make_collection ("col_root");
    make_collection ("col_child", "col_root");
    make_request ("req_1", "col_child");
    db_->save_request_example (example_row ("exa_1", "req_1"));

    auto before = db_->change_feed ().last_id ();
    db_->delete_collection ("col_root");
    auto events = published_since (before);
    ASSERT_EQ (events.size (), 1U);
    EXPECT_EQ (vayu::db::change_json (events.front ().change),
    json ({ { "kind", "collection" }, { "id", "col_root" }, { "op", "delete" } }));

    before = db_->change_feed ().last_id ();
    ASSERT_TRUE (db_->restore_deleted ("col_root").has_value ());
    events = published_since (before);
    ASSERT_EQ (events.size (), 1U);
    EXPECT_EQ (events.front ().change.op, ChangeOp::Restore);
    EXPECT_EQ (events.front ().change.id, "col_root");

    db_->delete_collection ("col_root");
    before = db_->change_feed ().last_id ();
    ASSERT_TRUE (db_->purge_deleted ("col_root").has_value ());
    events = published_since (before);
    ASSERT_EQ (events.size (), 1U);
    EXPECT_EQ (events.front ().change.op, ChangeOp::Purge);
    EXPECT_EQ (events.front ().change.kind, ChangeKind::Collection);
}

// A delete that finds nothing live changed nothing, and says nothing.
TEST_F (ChangeFeedDatabaseTest, ADeleteOfARowAlreadyGonePublishesNothing) {
    make_collection ("col_1");
    make_request ("req_1", "col_1");
    db_->delete_request ("req_1");

    const auto before = db_->change_feed ().last_id ();
    db_->delete_request ("req_1");
    db_->delete_environment ("env_never");
    db_->delete_request_example ("exa_never");
    EXPECT_TRUE (published_since (before).empty ());
}

TEST_F (ChangeFeedDatabaseTest, AnImportPublishesEveryRowItWroteInOrder) {
    vayu::db::Collection collection;
    collection.id   = "col_imp";
    collection.name = "Imported";
    vayu::db::Request request;
    request.id            = "req_imp";
    request.collection_id = collection.id;
    request.name          = "Imported";
    request.url           = "https://example.test/";
    vayu::db::Environment environment;
    environment.id        = "env_imp";
    environment.name      = "Imported";
    environment.variables = "{}";

    const auto before = db_->change_feed ().last_id ();
    db_->import_apply ({ collection }, { request }, { environment },
    { example_row ("exa_imp", request.id) });

    const auto events = published_since (before);
    ASSERT_EQ (events.size (), 4U);
    EXPECT_EQ (events[0].id, before + 1);
    EXPECT_EQ (events[0].change.kind, ChangeKind::Collection);
    EXPECT_EQ (events[1].change.kind, ChangeKind::Request);
    EXPECT_EQ (events[1].change.collection_id, "col_imp");
    EXPECT_EQ (events[2].change.kind, ChangeKind::Example);
    EXPECT_EQ (events[2].change.request_id, "req_imp");
    EXPECT_EQ (events[3].change.kind, ChangeKind::Environment);
    for (const auto& event : events) {
        EXPECT_EQ (event.change.op, ChangeOp::Create) << event.change.id;
    }
}

TEST_F (ChangeFeedDatabaseTest, ASpecSyncPublishesEachRowItWrote) {
    auto binding       = make_collection ("col_bound");
    const auto kept    = make_request ("req_kept", "col_bound");
    const auto dropped = make_request ("req_dropped", "col_bound");
    db_->save_request_example (example_row (
    "exa_old", kept.id, vayu::core::constants::request_example::ORIGIN_IMPORT));

    vayu::db::SpecSyncBatch batch;
    batch.spec.id             = "spec_1";
    batch.spec.content        = "{}";
    batch.spec.hash           = "hash";
    binding.openapi           = R"({"specId":"spec_1"})";
    batch.binding             = binding;
    vayu::db::Request created = kept;
    created.id                = "req_new";
    batch.created             = { created };
    vayu::db::Request updated = kept;
    updated.name              = "renamed";
    batch.updated             = { updated };
    batch.deleted             = { dropped.id, "req_never_stored" };
    batch.examples            = { example_row ("exa_new", kept.id) };
    batch.deleted_examples    = { "exa_old" };

    const auto before = db_->change_feed ().last_id ();
    db_->spec_sync_apply (batch);

    const auto events = published_since (before);
    std::vector<std::pair<std::string, std::string>> seen;
    for (const auto& event : events) {
        seen.emplace_back (event.change.id, vayu::db::to_string (event.change.op));
    }
    // The id that was never stored is not a change.
    EXPECT_EQ (seen,
    (std::vector<std::pair<std::string, std::string>>{ { "req_dropped", "purge" },
    { "exa_old", "purge" }, { "col_bound", "update" }, { "req_new", "create" },
    { "req_kept", "update" }, { "exa_new", "create" } }));
}

// A reorder whose second row is gone rolls the first back with it, so the
// first row's write was never committed and must never be announced.
// Mutation check: publish each row as it is written, inside the transaction,
// and the collection's update is announced for a write that rolled back.
TEST_F (ChangeFeedDatabaseTest, ARolledBackCompositePublishesNothing) {
    auto collection = make_collection ("col_1");
    auto request    = make_request ("req_1", "col_1");
    db_->delete_request ("req_1");
    collection.order = 7;

    const auto before = db_->change_feed ().last_id ();
    db_->with_lock ([&] {
        EXPECT_THROW (db_->apply_reorder ({ collection }, { request }), vayu::db::MissingRowError);
    });
    EXPECT_TRUE (published_since (before).empty ());
    const auto stored = db_->get_collection ("col_1");
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->order, 0) << "the batch did not roll back";

    vayu::db::SpecSyncBatch batch;
    batch.spec.id          = "spec_1";
    batch.binding          = collection;
    batch.binding.id       = "col_missing";
    request.id             = "req_2";
    request.deleted_at     = std::nullopt;
    batch.created          = { request };
    const auto before_sync = db_->change_feed ().last_id ();
    EXPECT_THROW (db_->spec_sync_apply (batch), vayu::db::MissingRowError);
    EXPECT_TRUE (published_since (before_sync).empty ());
}

TEST_F (ChangeFeedDatabaseTest, RetentionPublishesOnePurgePerRootItDestroys) {
    make_collection ("col_1");
    make_request ("req_1", "col_1");
    make_collection ("col_2");
    db_->delete_collection ("col_1");
    db_->delete_collection ("col_2");

    const auto before = db_->change_feed ().last_id ();
    EXPECT_EQ (db_->purge_expired_trash (1, now_ms () + 2 * DAY_MS), 2);
    const auto events = published_since (before);
    ASSERT_EQ (events.size (), 2U);
    for (const auto& event : events) {
        EXPECT_EQ (event.change.kind, ChangeKind::Collection);
        EXPECT_EQ (event.change.op, ChangeOp::Purge);
    }
}

// The kinds whose writes have no route of their own in the route test below.
TEST_F (ChangeFeedDatabaseTest, ATombstoneAndACertificateDeleteEachPublishOne) {
    make_collection ("col_1");
    make_request ("req_1", "col_1");
    db_->save_request_example (example_row ("exa_imported", "req_1",
    vayu::core::constants::request_example::ORIGIN_IMPORT));

    auto before = db_->change_feed ().last_id ();
    db_->suppress_request_example ("exa_imported", now_ms ());
    auto events = published_since (before);
    ASSERT_EQ (events.size (), 1U);
    EXPECT_EQ (vayu::db::change_json (events.front ().change),
    json ({ { "kind", "example" }, { "id", "exa_imported" }, { "op", "delete" },
    { "requestId", "req_1" } }));

    vayu::db::ClientCertificate certificate;
    certificate.id        = "cert_1";
    certificate.host      = "api.example.test";
    certificate.cert_path = "/nowhere/client.pem";
    db_->save_client_certificate (certificate);
    before = db_->change_feed ().last_id ();
    db_->delete_client_certificate ("cert_1");
    events = published_since (before);
    ASSERT_EQ (events.size (), 1U);
    EXPECT_EQ (events.front ().change.kind, ChangeKind::ClientCertificate);
    EXPECT_EQ (events.front ().change.op, ChangeOp::Delete);
}

} // namespace
