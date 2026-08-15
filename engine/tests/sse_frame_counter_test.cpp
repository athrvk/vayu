/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file sse_frame_counter_test.cpp
 * @brief The load path's event counter (issue #576).
 *
 * The counter exists because `SseParser` is too expensive to run per byte per
 * virtual user, and it is only useful if it *agrees* with that parser about
 * what an event is - a load run whose event count disagreed with the design
 * run's for the same stream would be a metric nobody could check.
 *
 * So the centrepiece here is `AgreesWithTheParser`, a table driven through both
 * over the same bytes. Everything above it names one rule that table depends
 * on; everything below covers what only the counter has (chunk splits, the
 * unterminated tail).
 */

#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/http/sse_frame_counter.hpp"
#include "vayu/http/sse_parser.hpp"

using vayu::http::SseFrameCounter;
using vayu::http::SseParser;

namespace {

/// Events the counter reports for @p body fed as one chunk.
std::size_t counted (const std::string& body) {
    SseFrameCounter counter;
    counter.feed (body);
    counter.finish ();
    return counter.events ();
}

/// Events `SseParser` dispatches for the same body - the number `counted` must
/// match. Deliberately built from the parser's own output rather than from a
/// hand-written expectation, so the two cannot be kept in step by editing the
/// expectation.
std::size_t parsed (const std::string& body) {
    SseParser parser (vayu::core::constants::sse::MAX_EVENT_BYTES);
    std::size_t events = parser.feed (body).size ();
    events += parser.finish ().size ();
    return events;
}

} // namespace

// ---------------------------------------------------------------------------
// What counts as an event
// ---------------------------------------------------------------------------

TEST (SseFrameCounterTest, CountsFramesTerminatedByABlankLine) {
    EXPECT_EQ (counted ("data: one\n\ndata: two\n\ndata: three\n\n"), 3u);
}

TEST (SseFrameCounterTest, DoesNotCountACommentOnlyKeepAlive) {
    // The reason the counter tests fields at all rather than just scanning for
    // `\n\n`: a server holding a connection open sends these between events,
    // and counting them would inflate events/sec on exactly the idle-ish
    // streams the metric is for.
    EXPECT_EQ (counted (": keep-alive\n\n: keep-alive\n\ndata: real\n\n"), 1u);
}

TEST (SseFrameCounterTest, DoesNotCountAFrameCarryingOnlyOtherFields) {
    // An `id:`-only frame is a resume point, not an event - the spec does not
    // dispatch it and neither does the parser.
    EXPECT_EQ (counted ("id: 7\n\nevent: ping\nretry: 500\n\n"), 0u);
}

TEST (SseFrameCounterTest, CountsAColonlessDataLine) {
    // A line with no colon is a field with an empty value, so a bare `data`
    // line carries the data field and dispatches.
    EXPECT_EQ (counted ("data\n\n"), 1u);
}

TEST (SseFrameCounterTest, DoesNotMistakeALongerFieldNameForData) {
    EXPECT_EQ (counted ("database: rows\n\ndat: x\n\ndatax: y\n\n"), 0u);
}

TEST (SseFrameCounterTest, CountsAMultiLineFrameOnce) {
    EXPECT_EQ (counted ("event: msg\ndata: a\ndata: b\ndata: c\n\n"), 1u);
}

// ---------------------------------------------------------------------------
// The contract: the two readers agree
// ---------------------------------------------------------------------------

TEST (SseFrameCounterTest, AgreesWithTheParser) {
    const std::vector<std::string> bodies = {
        "",
        "\n\n",
        "data: one\n\n",
        "data: one\n\ndata: two\n\n",
        ": keep-alive\n\ndata: one\n\n: keep-alive\n\n",
        "id: 1\n\ndata: one\n\nid: 2\n\n",
        "event: tick\ndata: 1\ndata: 2\n\n",
        "data: crlf\r\n\r\n",
        "data: cr\r\r",
        "data: mixed\r\n\r\ndata: again\n\n",
        "data\n\n",
        "data:\n\n",
        "database: no\n\n",
        "retry: 500\n\ndata: yes\n\n",
        // No terminating blank line: both dispatch the trailing frame.
        "data: tail",
        "data: one\n\ndata: tail",
        // A trailing frame with no data: neither dispatches it.
        "data: one\n\nid: 9",
        ":\n\n",
    };

    for (const auto& body : bodies) {
        EXPECT_EQ (counted (body), parsed (body))
        << "counter and parser disagree on: " << ::testing::PrintToString (body);
    }
}

// ---------------------------------------------------------------------------
// Chunk boundaries - what only the counter has to survive
// ---------------------------------------------------------------------------

TEST (SseFrameCounterTest, CountsAFrameSplitAcrossChunks) {
    SseFrameCounter counter;
    counter.feed ("da");
    counter.feed ("ta: hel");
    counter.feed ("lo\n");
    counter.feed ("\n");
    counter.finish ();
    EXPECT_EQ (counter.events (), 1u);
}

TEST (SseFrameCounterTest, CountsACrlfWhoseHalvesLandInDifferentChunks) {
    // The CR ended the line; the LF that opens the next chunk is the other half
    // of that terminator, not an empty line ending the frame early.
    SseFrameCounter counter;
    counter.feed ("data: split\r");
    counter.feed ("\n\r");
    counter.feed ("\n");
    counter.finish ();
    EXPECT_EQ (counter.events (), 1u);
}

TEST (SseFrameCounterTest, CountsEachChunkOnceWhenOneChunkHoldsManyFrames) {
    SseFrameCounter counter;
    counter.feed ("data: a\n\ndata: b\n\ndata: c\n\ndata: d\n\n");
    EXPECT_EQ (counter.events (), 4u);
    // `finish` on a body that ended cleanly adds nothing.
    counter.finish ();
    EXPECT_EQ (counter.events (), 4u);
}

TEST (SseFrameCounterTest, EventsIsReadableMidStreamForTheCapCheck) {
    // write_callback tests the count before the transfer ends, so the running
    // total has to be exact for every terminated frame - this is the read the
    // event cap is enforced from.
    SseFrameCounter counter;
    counter.feed ("data: a\n\n");
    EXPECT_EQ (counter.events (), 1u);
    counter.feed ("data: b\n\n");
    EXPECT_EQ (counter.events (), 2u);
    counter.feed ("data: partial\n");
    EXPECT_EQ (counter.events (), 2u) << "an unterminated frame is not yet an event";
}

TEST (SseFrameCounterTest, FinishCountsAnUnterminatedTrailingFrame) {
    SseFrameCounter counter;
    counter.feed ("data: a\n\ndata: cut off");
    EXPECT_EQ (counter.events (), 1u);
    counter.finish ();
    EXPECT_EQ (counter.events (), 2u);
}

TEST (SseFrameCounterTest, FinishAddsNothingForATrailingFrameWithNoData) {
    SseFrameCounter counter;
    counter.feed ("data: a\n\nid: 9");
    counter.finish ();
    EXPECT_EQ (counter.events (), 1u);
}
