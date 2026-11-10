/**
 * @file tests/change_feed_test.cpp
 * @brief The workspace change feed, `GET /changes` (issue #3420): the ring and
 *        its resume rule, what each `Database` write publishes and when, and
 *        the SSE route that relays it.
 *
 * Mutation checks, each named at the test that catches it: drop the publish
 * from `save_request`; publish a reorder's rows as they are written instead of
 * after the commit; drop `stopping` from the relay loop.
 */

#include <gtest/gtest.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/change_feed.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/server.hpp"
#include "vayu/utils/parse.hpp"

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "wait_until.hpp"

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

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/// A port nothing holds once this returns, for a `Server` to bind. The holder
/// listens so that `stop` closes its socket, as `server_bind_test.cpp`'s does.
int released_port () {
    httplib::Server holder;
    const int port = holder.bind_to_any_port ("127.0.0.1");
    std::thread listener ([&holder] () { holder.listen_after_bind (); });
    holder.wait_until_ready ();
    holder.stop ();
    listener.join ();
    return port;
}

/// One SSE frame as a reader sees it.
struct Frame {
    std::string event;
    std::optional<int64_t> id;
    std::string data;
};

/// Every complete frame in @p text, keep-alive comments left out.
std::vector<Frame> parse_frames (std::string_view text) {
    std::vector<Frame> frames;
    for (std::size_t end = text.find ("\n\n"); end != std::string_view::npos;
    end                  = text.find ("\n\n")) {
        Frame frame;
        std::string_view block = text.substr (0, end);
        text.remove_prefix (end + 2);
        while (!block.empty ()) {
            const auto line_end = block.find ('\n');
            const auto line     = block.substr (0, line_end);
            block = line_end == std::string_view::npos ? std::string_view{} :
                                                         block.substr (line_end + 1);
            const auto field_value = [&line] (std::string_view field) {
                return line.substr (field.size ());
            };
            if (line.starts_with ("event: ")) {
                frame.event = field_value ("event: ");
            } else if (line.starts_with ("id: ")) {
                frame.id =
                vayu::utils::parse_number<int64_t> (field_value ("id: "));
            } else if (line.starts_with ("data: ")) {
                frame.data = field_value ("data: ");
            }
        }
        if (!frame.event.empty ()) {
            frames.push_back (std::move (frame));
        }
    }
    return frames;
}

/// A client reading `GET /changes` on a thread of its own until it is
/// destroyed, which hangs up.
class FeedReader {
    public:
    /// Past the 15s keep-alive, so an idle stream is never read as broken.
    static constexpr int READ_TIMEOUT_S = 40;

    FeedReader (int port, std::string path, httplib::Headers headers = {})
    : client_ ("127.0.0.1", port) {
        client_.set_read_timeout (READ_TIMEOUT_S, 0);
        thread_ = std::thread (
        [this, path = std::move (path), headers = std::move (headers)] () {
            static_cast<void> (
            client_.Get (path, headers, [this] (const char* data, size_t length) {
                const std::lock_guard<std::mutex> lock (mutex_);
                text_.append (data, length);
                return true;
            }));
        });
    }

    ~FeedReader () {
        hang_up ();
    }

    FeedReader (const FeedReader&)            = delete;
    FeedReader& operator= (const FeedReader&) = delete;
    FeedReader (FeedReader&&)                 = delete;
    FeedReader& operator= (FeedReader&&)      = delete;

    /// Close the connection and wait for the reading thread.
    void hang_up () {
        client_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }

    [[nodiscard]] std::vector<Frame> frames () const {
        const std::lock_guard<std::mutex> lock (mutex_);
        return parse_frames (text_);
    }

    /// The first @p count frames, once that many have arrived; fewer, with
    /// the failure recorded, when they never do.
    std::vector<Frame> await_frames (std::size_t count) const {
        const bool arrived =
        vayu::tests::wait_until ([&] () { return frames ().size () >= count; });
        auto read = frames ();
        if (!arrived) {
            ADD_FAILURE () << "expected " << count << " frames, read " << read.size ();
        }
        return read;
    }

    private:
    httplib::Client client_;
    std::thread thread_;
    mutable std::mutex mutex_;
    std::string text_;
};

class ChangeFeedRouteTest : public ChangeFeedDatabaseTest {
    protected:
    void SetUp () override {
        ChangeFeedDatabaseTest::SetUp ();
        port_ = released_port ();
        ASSERT_GT (port_, 0);
        server_ = std::make_unique<vayu::http::Server> (*db_, run_manager_, port_);
        ASSERT_TRUE (server_->start ());
    }

    void TearDown () override {
        server_->stop ();
        server_.reset ();
        ChangeFeedDatabaseTest::TearDown ();
    }

    /// The JSON answer to one call, which must succeed.
    json call (const std::string& method, const std::string& path, const json& body = nullptr) {
        httplib::Client client ("127.0.0.1", port_);
        const std::string text = body.is_null () ? std::string{} : body.dump ();
        httplib::Result result = method == "POST" ?
        client.Post (path, text, "application/json") :
        method == "PUT" ? client.Put (path, text, "application/json") :
                          client.Delete (path);
        if (!result) {
            ADD_FAILURE () << method << " " << path << ": "
                           << httplib::to_string (result.error ());
            return nullptr;
        }
        EXPECT_GE (result->status, 200)
        << method << " " << path << ": " << result->body;
        EXPECT_LT (result->status, 300)
        << method << " " << path << ": " << result->body;
        return json::parse (result->body, nullptr, false);
    }

    /// Runs @p write and checks it published exactly one change, naming
    /// @p kind, @p op and @p id. Answers the body @p write returned.
    template <typename Write>
    json expect_one_change (const char* what, ChangeKind kind, ChangeOp op, Write&& write) {
        const auto before = db_->change_feed ().last_id ();
        json body         = write ();
        const auto events = published_since (before);
        EXPECT_EQ (events.size (), 1U) << what;
        if (events.size () == 1) {
            EXPECT_EQ (events.front ().change.kind, kind) << what;
            EXPECT_EQ (events.front ().change.op, op) << what;
        }
        return body;
    }

    std::string last_change_id () {
        const auto read = db_->change_feed ().since (db_->change_feed ().last_id () - 1);
        return read.events.empty () ? std::string{} : read.events.back ().change.id;
    }

    vayu::core::RunManager run_manager_;
    std::unique_ptr<vayu::http::Server> server_;
    int port_ = 0;
};

// Every route that writes one row publishes one change for it, and a cascade
// publishes one for its root. Mutation check: drop the publish from
// `save_request`, and the request create and update both publish nothing.
TEST_F (ChangeFeedRouteTest, EveryWriteRoutePublishesExactlyOneChange) {
    const auto collection = expect_one_change ("create collection",
    ChangeKind::Collection, ChangeOp::Create,
    [&] { return call ("POST", "/collections", { { "name", "API" } }); });
    const std::string col = collection.value ("id", "");
    ASSERT_FALSE (col.empty ());
    expect_one_change ("update collection", ChangeKind::Collection, ChangeOp::Update, [&] {
        return call ("PUT", "/collections/" + col, { { "name", "Renamed" } });
    });

    const auto request =
    expect_one_change ("create request", ChangeKind::Request, ChangeOp::Create, [&] {
        return call ("POST", "/requests",
        { { "collectionId", col }, { "name", "Ping" }, { "method", "GET" },
        { "url", "https://example.test/ping" } });
    });
    const std::string req = request.value ("id", "");
    ASSERT_FALSE (req.empty ());
    EXPECT_EQ (last_change_id (), req);
    expect_one_change ("update request", ChangeKind::Request, ChangeOp::Update,
    [&] { return call ("PUT", "/requests/" + req, { { "method", "POST" } }); });
    expect_one_change ("reorder", ChangeKind::Request, ChangeOp::Update, [&] {
        return call ("POST", "/reorder",
        { { "moves",
        json::array ({ { { "type", "request" }, { "id", req }, { "order", 3 } } }) } });
    });

    const auto example =
    expect_one_change ("create example", ChangeKind::Example, ChangeOp::Create, [&] {
        return call ("POST", "/requests/" + req + "/examples",
        { { "name", "200" }, { "origin", "user" } });
    });
    const std::string exa = example.value ("id", "");
    ASSERT_FALSE (exa.empty ());
    expect_one_change ("update example", ChangeKind::Example, ChangeOp::Update, [&] {
        return call ("PUT", "/requests/" + req + "/examples/" + exa, { { "name", "OK" } });
    });
    expect_one_change ("delete example", ChangeKind::Example, ChangeOp::Delete,
    [&] { return call ("DELETE", "/requests/" + req + "/examples/" + exa); });
    expect_one_change ("restore example", ChangeKind::Example, ChangeOp::Restore,
    [&] { return call ("POST", "/trash/" + exa + "/restore"); });

    const auto environment = expect_one_change ("create environment",
    ChangeKind::Environment, ChangeOp::Create,
    [&] { return call ("POST", "/environments", { { "name", "Dev" } }); });
    const std::string env  = environment.value ("id", "");
    ASSERT_FALSE (env.empty ());
    expect_one_change (
    "update environment", ChangeKind::Environment, ChangeOp::Update, [&] {
        return call ("PUT", "/environments/" + env, { { "name", "Staging" } });
    });
    expect_one_change ("delete environment", ChangeKind::Environment,
    ChangeOp::Delete, [&] { return call ("DELETE", "/environments/" + env); });
    expect_one_change ("purge environment", ChangeKind::Environment,
    ChangeOp::Purge, [&] { return call ("DELETE", "/trash/" + env); });

    const ChangeOp globals_op =
    db_->get_globals ().has_value () ? ChangeOp::Update : ChangeOp::Create;
    expect_one_change ("save globals", ChangeKind::Globals, globals_op, [&] {
        return call ("POST", "/globals", { { "variables", json::object () } });
    });

    expect_one_change ("delete request", ChangeKind::Request, ChangeOp::Delete,
    [&] { return call ("DELETE", "/requests/" + req); });
    expect_one_change ("restore request", ChangeKind::Request, ChangeOp::Restore,
    [&] { return call ("POST", "/trash/" + req + "/restore"); });
    expect_one_change ("delete collection", ChangeKind::Collection,
    ChangeOp::Delete, [&] { return call ("DELETE", "/collections/" + col); });
    expect_one_change ("restore collection", ChangeKind::Collection, ChangeOp::Restore,
    [&] { return call ("POST", "/trash/" + col + "/restore"); });

    expect_one_change ("import", ChangeKind::Collection, ChangeOp::Create, [&] {
        return call ("POST", "/import/apply",
        { { "collections",
        json::array ({ { { "tempId", "c1" }, { "name", "Imported" } } }) } });
    });
}

// Mutation check: drop the publish from `save_request`, and the change frame
// never arrives.
TEST_F (ChangeFeedRouteTest, AStreamOpensReadyThenRelaysAChangeAsItCommits) {
    make_collection ("col_1");
    make_request ("req_1", "col_1");
    const auto newest = db_->change_feed ().last_id ();

    FeedReader reader (port_, "/changes");
    const auto opening = reader.await_frames (1);
    ASSERT_EQ (opening.size (), 1U);
    EXPECT_EQ (opening.front ().event, "ready");
    EXPECT_EQ (opening.front ().id, newest);
    EXPECT_EQ (json::parse (opening.front ().data), json ({ { "lastEventId", newest } }));

    call ("PUT", "/requests/req_1", { { "name", "Renamed" } });
    const auto frames = reader.await_frames (2);
    ASSERT_EQ (frames.size (), 2U);
    EXPECT_EQ (frames[1].event, "change");
    EXPECT_EQ (frames[1].id, newest + 1);
    EXPECT_EQ (json::parse (frames[1].data),
    json ({ { "kind", "request" }, { "id", "req_1" }, { "op", "update" },
    { "collectionId", "col_1" } }));
}

TEST_F (ChangeFeedRouteTest, AResumeReplaysTheChangesMissedWhileAway) {
    make_collection ("col_1");
    const auto seen = db_->change_feed ().last_id ();
    make_request ("req_1", "col_1");
    make_request ("req_2", "col_1");

    FeedReader reader (port_, "/changes", { { "Last-Event-ID", std::to_string (seen) } });
    const auto frames = reader.await_frames (3);
    ASSERT_EQ (frames.size (), 3U);
    EXPECT_EQ (frames[0].event, "ready");
    EXPECT_EQ (frames[0].id, seen);
    EXPECT_EQ (frames[1].id, seen + 1);
    EXPECT_EQ (json::parse (frames[1].data).value ("id", ""), "req_1");
    EXPECT_EQ (frames[2].id, seen + 2);
    EXPECT_EQ (json::parse (frames[2].data).value ("id", ""), "req_2");
}

TEST_F (ChangeFeedRouteTest, AReaderTooFarBehindIsToldToResetAndThenTails) {
    const auto seen = db_->change_feed ().last_id ();
    std::vector<Change> flood (
    feed_constants::MAX_RETAINED_EVENTS + 1, request_change ("req_flood"));
    db_->change_feed ().publish (std::move (flood));
    const auto newest = db_->change_feed ().last_id ();

    FeedReader reader (port_, "/changes?lastEventId=" + std::to_string (seen));
    const auto opening = reader.await_frames (1);
    ASSERT_EQ (opening.size (), 1U);
    EXPECT_EQ (opening.front ().event, "reset");
    EXPECT_EQ (opening.front ().id, newest);

    make_collection ("col_after");
    const auto frames = reader.await_frames (2);
    ASSERT_EQ (frames.size (), 2U);
    EXPECT_EQ (frames[1].event, "change");
    EXPECT_EQ (frames[1].id, newest + 1);
}

// A connected reader that falls a whole ring behind between two polls is told
// so mid-stream, rather than handed a gap.
TEST_F (ChangeFeedRouteTest, AConnectedReaderOverrunByABulkWriteIsToldToReset) {
    FeedReader reader (port_, "/changes");
    ASSERT_EQ (reader.await_frames (1).size (), 1U);

    // One publish, so the relay sees the whole flood or none of it.
    db_->change_feed ().publish (std::vector<Change> (
    feed_constants::MAX_RETAINED_EVENTS + 1, request_change ("req_flood")));
    const auto frames = reader.await_frames (2);
    ASSERT_EQ (frames.size (), 2U);
    EXPECT_EQ (frames[1].event, "reset");
    EXPECT_EQ (frames[1].id, db_->change_feed ().last_id ());
}

TEST_F (ChangeFeedRouteTest, AMalformedLastEventIdIsRefused) {
    httplib::Client client ("127.0.0.1", port_);
    const auto result =
    client.Get ("/changes", httplib::Headers{ { "Last-Event-ID", "soon" } });
    ASSERT_TRUE (result) << httplib::to_string (result.error ());
    EXPECT_EQ (result->status, 400);
    EXPECT_EQ (json::parse (result->body)["error"].value ("code", ""), "invalid_last_event_id");
}

TEST_F (ChangeFeedRouteTest, AFeedWithEveryReaderSlotTakenRefusesAnother) {
    for (int slot = 0; slot < feed_constants::MAX_READERS; ++slot) {
        ASSERT_TRUE (db_->change_feed ().try_add_reader ());
    }
    httplib::Client client ("127.0.0.1", port_);
    const auto refused = client.Get ("/changes");
    ASSERT_TRUE (refused) << httplib::to_string (refused.error ());
    EXPECT_EQ (refused->status, 503);
    EXPECT_EQ (json::parse (refused->body)["error"].value ("code", ""), "change_feed_full");
    EXPECT_EQ (refused->get_header_value ("Retry-After"),
    std::to_string (vayu::core::constants::sse::RELAY_KEEPALIVE_MS / 1000));

    db_->change_feed ().remove_reader ();
    FeedReader reader (port_, "/changes");
    EXPECT_EQ (reader.await_frames (1).size (), 1U)
    << "a freed slot did not admit a stream";
}

TEST_F (ChangeFeedRouteTest, EveryOpenStreamReceivesTheSameChange) {
    FeedReader first (port_, "/changes");
    FeedReader second (port_, "/changes");
    ASSERT_EQ (first.await_frames (1).size (), 1U);
    ASSERT_EQ (second.await_frames (1).size (), 1U);

    make_collection ("col_1");
    const auto one   = first.await_frames (2);
    const auto other = second.await_frames (2);
    ASSERT_EQ (one.size (), 2U);
    ASSERT_EQ (other.size (), 2U);
    EXPECT_EQ (one[1].id, other[1].id);
    EXPECT_EQ (one[1].data, other[1].data);
}

// A stream ends when the server stops instead of holding the handler join
// open for as long as its client reads (#2683). Healthy: within one 50ms
// poll. Mutation check: drop `stopping` from the relay loop, and `stop()`
// returns only once the reader hangs up after the 20s wait.
TEST_F (ChangeFeedRouteTest, StopEndsAStreamItsClientIsStillReading) {
    FeedReader reader (port_, "/changes");
    ASSERT_EQ (reader.await_frames (1).size (), 1U);

    auto stopped =
    std::async (std::launch::async, [this] () { server_->stop (); });
    const bool returned = vayu::tests::wait_until ([&stopped] () {
        return stopped.wait_for (std::chrono::seconds (0)) == std::future_status::ready;
    });
    if (!returned) {
        reader.hang_up (); // What lets a broken stop() return at all.
    }
    stopped.get ();
    EXPECT_TRUE (returned)
    << "stop() did not end a change stream still being read";
}

} // namespace
