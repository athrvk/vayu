/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/mock_activity.hpp"

#include <gtest/gtest.h>

using vayu::http::MockActivityEntry;
using vayu::http::MockActivityLog;

TEST (MockActivityLog, EmptyLogSnapshotsEmpty) {
    MockActivityLog log (10);
    EXPECT_TRUE (log.snapshot (50).empty ());
}

TEST (MockActivityLog, SnapshotIsNewestFirst) {
    MockActivityLog log (10);
    for (int i = 0; i < 3; ++i) {
        MockActivityEntry entry;
        entry.method = "GET";
        entry.path   = "/pets/" + std::to_string (i);
        log.record (entry);
    }
    const auto snap = log.snapshot (10);
    ASSERT_EQ (snap.size (), 3u);
    EXPECT_EQ (snap[0].path, "/pets/2");
    EXPECT_EQ (snap[1].path, "/pets/1");
    EXPECT_EQ (snap[2].path, "/pets/0");
}

TEST (MockActivityLog, SnapshotRespectsTheCallersLimit) {
    MockActivityLog log (10);
    for (int i = 0; i < 5; ++i) {
        MockActivityEntry entry;
        entry.path = std::to_string (i);
        log.record (entry);
    }
    EXPECT_EQ (log.snapshot (2).size (), 2u);
}

TEST (MockActivityLog, PastCapacityDropsTheOldest) {
    MockActivityLog log (3);
    for (int i = 0; i < 5; ++i) {
        MockActivityEntry entry;
        entry.path = std::to_string (i);
        log.record (entry);
    }
    // Mutation check: drop the `while` loop in record() and this fails - the
    // snapshot would hold all 5 rather than the newest 3.
    const auto snap = log.snapshot (10);
    ASSERT_EQ (snap.size (), 3u);
    EXPECT_EQ (snap[0].path, "4");
    EXPECT_EQ (snap[1].path, "3");
    EXPECT_EQ (snap[2].path, "2");
}

TEST (MockActivityLog, UnmatchedRequestRecordsWithNoRequestId) {
    MockActivityLog log (10);
    MockActivityEntry entry;
    entry.method = "GET";
    entry.path   = "/nowhere";
    log.record (entry);
    const auto snap = log.snapshot (1);
    ASSERT_EQ (snap.size (), 1u);
    EXPECT_FALSE (snap[0].request_id.has_value ());
}

TEST (MockActivityEntryJson, RendersNullForEveryUnsetOptional) {
    MockActivityEntry entry;
    entry.method    = "GET";
    entry.path      = "/pets";
    entry.status    = 200;
    const auto json = vayu::http::mock_activity_entry_json (entry);
    EXPECT_TRUE (json["requestId"].is_null ());
    EXPECT_TRUE (json["requestName"].is_null ());
    EXPECT_TRUE (json["exampleId"].is_null ());
    EXPECT_TRUE (json["exampleName"].is_null ());
    EXPECT_EQ (json["method"], "GET");
    EXPECT_EQ (json["path"], "/pets");
    EXPECT_EQ (json["status"], 200);
    EXPECT_EQ (json["injectedError"], false);
}
