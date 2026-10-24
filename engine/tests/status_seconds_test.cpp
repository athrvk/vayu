/**
 * @file status_seconds_test.cpp
 * @brief Status-class counts keyed by each response's completion second
 *        (#2866): the counter, its JSON shape and the collector's feed.
 */

#include "vayu/core/status_seconds.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <ostream>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/metrics_collector.hpp"

using vayu::core::MetricsCollector;
using vayu::core::StatusClass;
using vayu::core::StatusClassCounts;
using vayu::core::StatusSecondCounter;
using vayu::core::StatusSecondEntry;

namespace {

constexpr size_t SUCCESS = 0;
constexpr size_t SERVER  = 3;
constexpr size_t ERROR   = 4;

/// Counts with @p n at @p index and nothing elsewhere.
StatusClassCounts only (size_t index, uint64_t n) {
    StatusClassCounts counts{};
    counts.at (index) = n;
    return counts;
}

uint64_t total_of (const std::vector<StatusSecondEntry>& entries) {
    uint64_t total = 0;
    for (const auto& entry : entries) {
        for (const auto count : entry.counts) {
            total += count;
        }
    }
    return total;
}

int64_t steady_now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now ().time_since_epoch ())
    .count ();
}

} // namespace

namespace vayu::core {
/// Read as `{second, span, [counts]}` in a failure, not as raw bytes.
void PrintTo (const StatusSecondEntry& entry, std::ostream* out) {
    *out << "{" << entry.second << ", " << entry.span << ", [";
    for (size_t i = 0; i < entry.counts.size (); ++i) {
        *out << (i == 0 ? "" : ", ") << entry.counts.at (i);
    }
    *out << "]}";
}
} // namespace vayu::core

// The metrics thread gates about every 1.05 s, so the gate that first sees a
// burst at the edge of second 1 is a second away from it. Each response is
// counted in the second it completed, whatever tick follows it. Mutation
// check: key `record` by the second the next drain emits (`next_second_`)
// instead of by `elapsed_ms`, which is keying by tick time, and the whole
// burst lands in second 0.
TEST (StatusSecondCounter, ABurstStraddlingASecondEdgeCountsInTheSecondEachResponseCompleted) {
    StatusSecondCounter counter;
    for (int64_t ms = 990; ms < 995; ++ms) {
        counter.record (200, ms);
    }
    for (int64_t ms = 1001; ms < 1006; ++ms) {
        counter.record (200, ms);
    }
    counter.record (503, 1002);

    EXPECT_TRUE (counter.drain (1050).empty ())
    << "second 0 is not closed at 1.05 s";
    EXPECT_EQ (counter.drain (2100),
    (std::vector<StatusSecondEntry>{ { 0, 1, only (SUCCESS, 5) } }));
    StatusClassCounts second_one = only (SUCCESS, 5);
    second_one.at (SERVER)       = 1;
    EXPECT_EQ (counter.drain (3150),
    (std::vector<StatusSecondEntry>{ { 1, 1, second_one } }));
}

// A worker reads the clock and then increments, so a second is closed only a
// margin after it ended: 250 ms, the figure the docs give. Mutation check: set
// CLOSE_MARGIN_MS to 0 and the first drain emits second 0 (and so does the
// burst test's gate at 1.05 s).
TEST (StatusSecondCounter, ASecondClosesOnlyAMarginAfterItEnds) {
    StatusSecondCounter counter;
    counter.record (200, 500);
    EXPECT_TRUE (counter.drain (1249).empty ());
    EXPECT_EQ (counter.drain (1250),
    (std::vector<StatusSecondEntry>{ { 0, 1, only (SUCCESS, 1) } }));
    EXPECT_TRUE (counter.drain (2249).empty ());
}

// A second with no completion is a measured zero, not a hole, and a drain
// that closes two seconds emits both.
TEST (StatusSecondCounter, AQuietSecondIsAnEntryOfZeros) {
    StatusSecondCounter counter;
    counter.record (200, 100);
    counter.record (200, 2100);
    EXPECT_EQ (counter.drain (3300),
    (std::vector<StatusSecondEntry>{ { 0, 1, only (SUCCESS, 1) },
    { 1, 1, StatusClassCounts{} }, { 2, 1, only (SUCCESS, 1) } }));
}

// The classes are the app's `classifyCumulative`: 2xx to 5xx by hundred, and
// everything else, a transport failure's 0 included, as an error.
TEST (StatusSecondCounter, ClassesAreTheStatusChartsAndEverythingElseIsAnError) {
    EXPECT_EQ (vayu::core::status_class_of (200), StatusClass::Success);
    EXPECT_EQ (vayu::core::status_class_of (299), StatusClass::Success);
    EXPECT_EQ (vayu::core::status_class_of (301), StatusClass::Redirect);
    EXPECT_EQ (vayu::core::status_class_of (404), StatusClass::ClientError);
    EXPECT_EQ (vayu::core::status_class_of (599), StatusClass::ServerError);
    for (const int code : { 0, -1, 101, 199, 600, 999 }) {
        EXPECT_EQ (vayu::core::status_class_of (code), StatusClass::Error) << code;
    }

    StatusSecondCounter counter;
    for (const int code : { 0, 101, 204, 302, 418, 500, 999 }) {
        counter.record (code, 10);
    }
    EXPECT_EQ (counter.drain (2000),
    (std::vector<StatusSecondEntry>{ { 0, 1, StatusClassCounts{ 1, 1, 1, 1, 3 } } }));
}

// A worker stalled between its clock read and its increment past the margin
// increments a second already emitted. The next drain finds it and counts it
// in its first entry, rather than leaving it for the second that reuses the
// slot. Mutation check: drop the sweep loop in `drain` and the late response
// is missing from second 1.
TEST (StatusSecondCounter, AnIncrementAfterItsSecondWasEmittedReachesTheNextEntry) {
    StatusSecondCounter counter;
    counter.record (200, 900);
    EXPECT_EQ (counter.drain (1300),
    (std::vector<StatusSecondEntry>{ { 0, 1, only (SUCCESS, 1) } }));
    counter.record (0, 950); // Read its clock before 1 s, incremented after 1.3 s.
    counter.record (200, 1500);
    StatusClassCounts second_one = only (SUCCESS, 1);
    second_one.at (ERROR)        = 1;
    EXPECT_EQ (counter.drain (2300),
    (std::vector<StatusSecondEntry>{ { 1, 1, second_one } }));
}

// A reader more than the ring behind reads seconds that share a slot as one,
// in the older entry. What the documented bound gives up is placement, never
// a count: every response is still in exactly one entry.
TEST (StatusSecondCounter, AReaderFarBehindMisplacesCountsButLosesNone) {
    StatusSecondCounter counter;
    constexpr int64_t SECONDS = 3 * StatusSecondCounter::SLOTS;
    for (int64_t second = 0; second < SECONDS; ++second) {
        counter.record (200, (second * 1000) + 10);
    }
    const auto entries = counter.drain ((SECONDS * 1000) + 1000);
    ASSERT_EQ (entries.size (), static_cast<size_t> (SECONDS));
    for (size_t i = 0; i < entries.size (); ++i) {
        ASSERT_EQ (entries.at (i).second, static_cast<int64_t> (i));
    }
    EXPECT_EQ (total_of (entries), static_cast<uint64_t> (SECONDS));
}

// Writers on many threads share one slot per class; a relaxed fetch_add loses
// none of their increments. Mutation check: replace the fetch_add with a load
// and a store and the per-second totals come up short (and TSan reports it).
TEST (StatusSecondCounter, ConcurrentWritersLoseNoCount) {
    StatusSecondCounter counter;
    constexpr int THREADS             = 8;
    constexpr uint64_t PER_SECOND     = 5000;
    constexpr int64_t SECONDS_WRITTEN = 4;
    std::vector<std::thread> writers;
    writers.reserve (THREADS);
    for (int t = 0; t < THREADS; ++t) {
        writers.emplace_back ([&counter] {
            for (uint64_t i = 0; i < PER_SECOND * SECONDS_WRITTEN; ++i) {
                counter.record (200, static_cast<int64_t> (i % SECONDS_WRITTEN) * 1000);
            }
        });
    }
    for (auto& writer : writers) {
        writer.join ();
    }
    const auto entries = counter.drain (10'000);
    ASSERT_GE (entries.size (), static_cast<size_t> (SECONDS_WRITTEN));
    for (int64_t s = 0; s < SECONDS_WRITTEN; ++s) {
        EXPECT_EQ (entries.at (static_cast<size_t> (s)).counts,
        only (SUCCESS, PER_SECOND * THREADS))
        << "second " << s;
    }
}

// The same writers racing the reader. Every writer's time is unrelated to how
// far the reader has drained, so many increments land after their second was
// emitted; the sweep still accounts for every one of them.
TEST (StatusSecondCounter, WritersRacingTheReaderLoseNoCount) {
    StatusSecondCounter counter;
    constexpr int THREADS        = 4;
    constexpr uint64_t PER_WRITE = 20'000;
    std::atomic<int> writing{ THREADS };
    std::vector<std::thread> writers;
    writers.reserve (THREADS);
    for (int t = 0; t < THREADS; ++t) {
        writers.emplace_back ([&counter, &writing] {
            for (uint64_t i = 0; i < PER_WRITE; ++i) {
                counter.record (200, static_cast<int64_t> (i % 4000));
            }
            writing.fetch_sub (1);
        });
    }
    uint64_t drained  = 0;
    int64_t reader_ms = 0;
    while (writing.load () > 0) {
        reader_ms = std::min<int64_t> (reader_ms + 50, 8000);
        drained += total_of (counter.drain (reader_ms));
    }
    for (auto& writer : writers) {
        writer.join ();
    }
    // Past every earlier drain, so this one emits entries and sweeps.
    drained += total_of (counter.drain (20'000));
    EXPECT_EQ (drained, PER_WRITE * THREADS);
}

// The wire shape both the stored row and the gate frame carry, and its reader.
TEST (StatusSecondsJson, AnEntryRoundTripsAndAMalformedOneIsRefused) {
    const std::vector<StatusSecondEntry> entries{ { 3, 1, { 50, 0, 1, 2, 3 } } };
    const auto json = vayu::core::status_seconds_json (entries);
    EXPECT_EQ (json,
    nlohmann::json::parse (R"([{"second":3,"span":1,"counts":[50,0,1,2,3]}])"));
    const auto parsed = vayu::core::status_second_entry_from_json (
    nlohmann::json::parse (json.at (0).dump ()));
    ASSERT_HAS_VALUE (parsed);
    EXPECT_EQ (*parsed, entries.at (0));
    EXPECT_EQ (vayu::core::status_seconds_json ({}), nlohmann::json::array ());

    for (const auto* text : { R"(7)", R"({"second":1,"span":1})",
         R"({"second":-1,"span":1,"counts":[0,0,0,0,0]})", R"({"second":1,"span":0,"counts":[0,0,0,0,0]})",
         R"({"second":1,"span":1,"counts":[0,0,0,0]})", R"({"second":1,"span":1,"counts":[0,0,0,0,-1]})",
         R"({"second":1.5,"span":1,"counts":[0,0,0,0,0]})" }) {
        EXPECT_FALSE (
        vayu::core::status_second_entry_from_json (nlohmann::json::parse (text)).has_value ())
        << text;
    }
}

// The collector counts nothing per second before load start, which is what
// keeps a gate during `script.setup` from emitting seconds no load ran in.
TEST (MetricsCollectorStatusSeconds, NothingIsCountedBeforeLoadStart) {
    MetricsCollector collector ("run_before_start");
    collector.record_success (200, 5.0, 0.0);
    EXPECT_TRUE (collector.drain_status_seconds (steady_now_ms () + 5000).empty ());
    EXPECT_EQ (collector.status_code_distribution (),
    (std::map<int, size_t>{ { 200, 1 } }));
}

// Through the collector's own entry points: the second is read from the
// clock when the completion is recorded, a transport failure counts as an
// error, and the cumulative distribution is unchanged beside it. Load
// "started" ten seconds ago, so the completions belong to second 10 (or the
// next, if the recording straddles an edge). Mutation check: pass 0 as the
// elapsed time in `record_status_code` and they land in second 0.
TEST (MetricsCollectorStatusSeconds, ACompletionCountsInTheSecondItWasRecordedIn) {
    MetricsCollector collector ("run_seconds");
    const int64_t load_start = steady_now_ms () - 10'000;
    collector.set_load_start (load_start);

    const int64_t before = steady_now_ms ();
    for (int i = 0; i < 3; ++i) {
        collector.record_success (200, 5.0, 0.0);
    }
    collector.record_success (503, 5.0, 0.0);
    collector.record_error (vayu::ErrorCode::Timeout, "timed out");
    const int64_t after = steady_now_ms ();

    const auto entries  = collector.drain_status_seconds (after + 3000);
    const int64_t first = (before - load_start) / 1000;
    const int64_t last  = (after - load_start) / 1000;
    ASSERT_GE (first, 10);
    StatusClassCounts sum{};
    for (const auto& entry : entries) {
        const bool recorded_then = entry.second >= first && entry.second <= last;
        for (size_t i = 0; i < sum.size (); ++i) {
            if (!recorded_then) {
                EXPECT_EQ (entry.counts.at (i), 0u) << "second " << entry.second;
            }
            sum.at (i) += entry.counts.at (i);
        }
    }
    StatusClassCounts expected = only (SUCCESS, 3);
    expected.at (SERVER)       = 1;
    expected.at (ERROR)        = 1;
    EXPECT_EQ (sum, expected);
    EXPECT_EQ (collector.status_code_distribution (),
    (std::map<int, size_t>{ { 0, 1 }, { 200, 3 }, { 503, 1 } }));
    EXPECT_TRUE (collector.drain_status_seconds (after + 3000).empty ())
    << "a drained second was emitted twice";
}
