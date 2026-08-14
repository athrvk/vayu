/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file sse_parser_test.cpp
 * @brief The `text/event-stream` line protocol (issue #573).
 *
 * The grammar is asserted here rather than through a transfer because these are
 * the cases a live endpoint will not reliably produce on demand: a frame split
 * across TCP reads, a lone CR, an invalid UTF-8 byte, an event larger than the
 * cap. Every one of them is a byte string this file hands the parser directly.
 */

#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "vayu/http/sse_parser.hpp"

namespace {

using vayu::http::sanitize_utf8;
using vayu::http::SseEvent;
using vayu::http::SseParser;

constexpr std::size_t GENEROUS = 1 << 20;

/// Feed a whole stream in one chunk and collect what it dispatched, including
/// whatever `finish()` releases.
std::vector<SseEvent> parse_all (const std::string& text, std::size_t cap = GENEROUS) {
    SseParser parser (cap);
    auto events = parser.feed (text);
    for (auto& trailing : parser.finish ()) {
        events.push_back (trailing);
    }
    return events;
}

// ---------------------------------------------------------------------------
// Field grammar
// ---------------------------------------------------------------------------

TEST (SseParser, DispatchesADataOnlyFrameAsAMessage) {
    const auto events = parse_all ("data: hello\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "hello");
    // The spec's default name, resolved here so no consumer re-derives it.
    EXPECT_EQ (events[0].event, "message");
    EXPECT_TRUE (events[0].id.empty ());
    EXPECT_FALSE (events[0].truncated);
}

TEST (SseParser, ReadsTheNamedEventAndId) {
    const auto events = parse_all ("event: token\nid: 42\ndata: hi\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].event, "token");
    EXPECT_EQ (events[0].id, "42");
    EXPECT_EQ (events[0].data, "hi");
}

TEST (SseParser, JoinsMultipleDataLinesWithNewlines) {
    const auto events = parse_all ("data: one\ndata: two\ndata: three\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "one\ntwo\nthree");
}

// The spec builds the data buffer as value + "\n" per field and strips one
// trailing newline at dispatch. Nothing else reproduces a *leading* blank data
// line, and an implementation that joins with "\n" instead loses it silently.
TEST (SseParser, KeepsALeadingEmptyDataLine) {
    const auto events = parse_all ("data:\ndata: body\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "\nbody");
}

TEST (SseParser, StripsExactlyOneSpaceAfterTheColon) {
    const auto events = parse_all ("data:  two spaces\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, " two spaces");
}

TEST (SseParser, TreatsAFieldWithNoColonAsAnEmptyValue) {
    const auto events = parse_all ("data\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "");
}

TEST (SseParser, SkipsCommentLines) {
    const auto events = parse_all (": keep-alive\ndata: real\n: another\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "real");
}

// A keep-alive between frames is the most common line on an idle stream; if it
// dispatched, every quiet second would produce a phantom event.
TEST (SseParser, ACommentAloneDispatchesNothing) {
    EXPECT_TRUE (parse_all (": keep-alive\n\n: keep-alive\n\n").empty ());
}

TEST (SseParser, IgnoresUnknownFields) {
    const auto events = parse_all ("unknown: value\ndata: kept\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "kept");
}

// The spec's rule, and the reason `has_data_` exists: a frame that carried only
// an id is a resume-point refresh, not an event.
TEST (SseParser, AFrameWithNoDataIsNotDispatched) {
    EXPECT_TRUE (parse_all ("id: 7\n\n").empty ());
}

// ...but the id it set persists onto the next event that carries none, which is
// what a resuming client must send back.
TEST (SseParser, TheLastIdPersistsAcrossEventsThatCarryNone) {
    const auto events = parse_all ("id: 7\n\ndata: a\n\ndata: b\n\n");
    ASSERT_EQ (events.size (), 2u);
    EXPECT_EQ (events[0].id, "7");
    EXPECT_EQ (events[1].id, "7");
}

TEST (SseParser, TheEventNameDoesNotPersistAcrossFrames) {
    const auto events = parse_all ("event: token\ndata: a\n\ndata: b\n\n");
    ASSERT_EQ (events.size (), 2u);
    EXPECT_EQ (events[0].event, "token");
    EXPECT_EQ (events[1].event, "message");
}

// `retry:` names a reconnection delay, and the engine owns one transfer and
// never reconnects it - so it is ignored like any other field with no consumer.
// Ignored, not mishandled: the frame around it still dispatches intact.
TEST (SseParser, IgnoresRetryWithoutDisturbingTheFrame) {
    const auto events = parse_all ("retry: 2500\ndata: a\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "a");
}

// ---------------------------------------------------------------------------
// Line terminators
// ---------------------------------------------------------------------------

TEST (SseParser, AcceptsCrlfTerminators) {
    const auto events = parse_all ("event: t\r\ndata: hi\r\n\r\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].event, "t");
    EXPECT_EQ (events[0].data, "hi");
}

TEST (SseParser, AcceptsLoneCrTerminators) {
    const auto events = parse_all ("data: hi\r\r");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "hi");
}

// The CRLF whose halves land in different reads. Without the pending-CR state
// the LF opening the second chunk reads as an empty line and dispatches a frame
// that has not finished arriving.
TEST (SseParser, ACrlfSplitAcrossChunksIsOneTerminator) {
    SseParser parser (GENEROUS);
    EXPECT_TRUE (parser.feed ("data: hi\r").empty ());
    EXPECT_TRUE (parser.feed ("\ndata: there\r\n\r\n").size () == 1u);
}

// ---------------------------------------------------------------------------
// Frames split across chunks - the mutation-check case
// ---------------------------------------------------------------------------

// Revert the held-partial-frame handling (dispatch per chunk, or drop what a
// chunk ends mid-line with) and this reddens: the event either arrives twice or
// arrives with half its payload.
TEST (SseParser, HoldsAPartialFrameAcrossChunksAndDispatchesItOnce) {
    SseParser parser (GENEROUS);
    EXPECT_TRUE (parser.feed ("ev").empty ());
    EXPECT_TRUE (parser.feed ("ent: tok").empty ());
    EXPECT_TRUE (parser.feed ("en\ndata: hel").empty ());
    EXPECT_TRUE (parser.feed ("lo wor").empty ());
    auto events = parser.feed ("ld\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].event, "token");
    EXPECT_EQ (events[0].data, "hello world");
    EXPECT_TRUE (parser.finish ().empty ()) << "the frame was dispatched twice";
}

TEST (SseParser, DispatchesMultipleEventsFromOneChunk) {
    const auto events = parse_all ("data: a\n\ndata: b\n\ndata: c\n\n");
    ASSERT_EQ (events.size (), 3u);
    EXPECT_EQ (events[0].data, "a");
    EXPECT_EQ (events[2].data, "c");
}

// A server that closes without the blank line still sent that frame. The spec
// discards it; we do not, because a truncated stream is already disclosed by
// the run's termination reason and dropping every abrupt server's last event
// would be a silent loss.
TEST (SseParser, FinishDispatchesAnUnterminatedFrame) {
    SseParser parser (GENEROUS);
    EXPECT_TRUE (parser.feed ("data: last words").empty ());
    const auto events = parser.finish ();
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "last words");
}

TEST (SseParser, FinishDispatchesNothingForAnEmptyStream) {
    SseParser parser (GENEROUS);
    EXPECT_TRUE (parser.finish ().empty ());
}

// ---------------------------------------------------------------------------
// The byte cap - what makes the parser itself bounded
// ---------------------------------------------------------------------------

TEST (SseParser, TruncatesAnOversizedEventAndSaysSo) {
    SseParser parser (8);
    const auto events = parser.feed ("data: 0123456789abcdef\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_TRUE (events[0].truncated);
    EXPECT_LE (events[0].data.size (), 8u);
    EXPECT_EQ (events[0].data, "01234567");
    // The size as received, so a reader can tell how much it is missing.
    EXPECT_EQ (events[0].data_bytes, 16u);
}

// The unbounded-buffer case this cap exists for: a server that never sends a
// line break at all. Before the cap this grew for as long as the server talked.
TEST (SseParser, ANeverTerminatedLineIsBoundedByTheCap) {
    SseParser parser (64);
    for (int i = 0; i < 1000; ++i) {
        EXPECT_TRUE (parser.feed (std::string (1024, 'x')).empty ());
    }
    const auto events = parser.finish ();
    ASSERT_EQ (events.size (), 0u) << "a line with no field name is not data";
}

TEST (SseParser, AnOversizedDataLineWithNoTerminatorIsStillBounded) {
    SseParser parser (64);
    parser.feed ("data: ");
    for (int i = 0; i < 100; ++i) {
        parser.feed (std::string (1024, 'y'));
    }
    const auto events = parser.finish ();
    ASSERT_EQ (events.size (), 1u);
    EXPECT_TRUE (events[0].truncated);
    EXPECT_LE (events[0].data.size (), 64u);
    EXPECT_GT (events[0].data_bytes, 100000u);
}

TEST (SseParser, AnUntruncatedEventReportsItsTrueSize) {
    const auto events = parse_all ("data: abcde\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_FALSE (events[0].truncated);
    EXPECT_EQ (events[0].data_bytes, events[0].data.size ());
}

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

TEST (SanitizeUtf8, PassesValidTextThrough) {
    const std::string text = "ascii, \xC3\xA9, \xE2\x82\xAC, \xF0\x9F\x8E\x89";
    EXPECT_EQ (sanitize_utf8 (text), text);
}

TEST (SanitizeUtf8, ReplacesALoneContinuationByte) {
    EXPECT_EQ (sanitize_utf8 ("a\x80z"),
    "a\xEF\xBF\xBD"
    "z");
}

TEST (SanitizeUtf8, ReplacesATruncatedSequenceWithoutSwallowingWhatFollows) {
    // A two-byte lead with no continuation: one bad byte, and the 'z' after it
    // must survive. Advancing by the announced length would eat it.
    EXPECT_EQ (sanitize_utf8 ("\xC3z"),
    "\xEF\xBF\xBD"
    "z");
}

TEST (SanitizeUtf8, RejectsAnOverlongEncoding) {
    // C0 80 is an overlong NUL - a byte pattern a decoder must reject rather
    // than pass through, which a length-only check would accept.
    EXPECT_EQ (sanitize_utf8 ("\xC0\x80"), "\xEF\xBF\xBD\xEF\xBF\xBD");
}

TEST (SanitizeUtf8, RejectsASurrogate) {
    // ED A0 80 encodes U+D800, which UTF-8 is not allowed to carry.
    EXPECT_EQ (sanitize_utf8 ("\xED\xA0\x80"), "\xEF\xBF\xBD\xEF\xBF\xBD\xEF\xBF\xBD");
}

TEST (SseParser, ReplacesInvalidUtf8InDispatchedText) {
    const auto events = parse_all ("event: t\xFFm\ndata: bad \xFF byte\n\n");
    ASSERT_EQ (events.size (), 1u);
    EXPECT_EQ (events[0].data, "bad \xEF\xBF\xBD byte");
    EXPECT_EQ (events[0].event,
    "t\xEF\xBF\xBD"
    "m");
}

} // namespace
