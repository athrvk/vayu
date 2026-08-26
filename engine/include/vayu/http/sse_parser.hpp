#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/sse_parser.hpp
 * @brief The `text/event-stream` line protocol (issue #573), as a pure parser.
 *
 * Pure in the sense that matters here: it holds only the bytes of the frame it
 * is still assembling, touches no clock, no socket and no database, and is
 * driven entirely by `feed()`. That is what lets the whole grammar - multi-line
 * data, comments, CRLF, a frame split across chunks, invalid UTF-8 - be tested
 * without a transfer.
 *
 * The grammar is WHATWG's event-stream interpretation, followed deliberately
 * rather than approximated, including the two rules that surprise people:
 * an event carrying no `data` field is **not dispatched**, and the last `id:`
 * seen persists onto later events that carry none.
 *
 * `retry:` is ignored like any other field the engine has no use for: it names
 * a reconnection delay, and the engine owns one transfer and never reconnects
 * it. A stream that ends is reported as ended rather than silently retried.
 */

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::http {

/** One dispatched `text/event-stream` event. */
struct SseEvent {
    /// The `event:` field, or `"message"` when the frame carried none - the
    /// spec's default, resolved here so no consumer has to re-derive it.
    std::string event = "message";
    /// The `data:` field(s), multiple lines joined with `\n` and the trailing
    /// newline removed. Never empty: a frame with no data is not dispatched.
    std::string data;
    /// The stream's last-event-id at dispatch time. Persists across events, so
    /// a frame carrying no `id:` reports the previous one - which is what a
    /// resuming client must send back.
    std::string id;
    /// True when this event hit the per-event byte cap and `data` is a prefix.
    /// Disclosed in band by every consumer rather than silently cut.
    bool truncated = false;
    /// How many bytes of `data` the stream actually sent, which is larger than
    /// `data.size()` exactly when `truncated`.
    std::size_t data_bytes = 0;
};

/**
 * Incremental parser over a `text/event-stream` body.
 *
 * **Bounded by construction.** `max_event_bytes` caps both the line being
 * assembled and the data buffer being accumulated, so a server that sends a
 * gigabyte without a newline - or a single event larger than memory - costs the
 * cap and a `truncated` flag rather than the process. This is the byte bound
 * `write_callback` on the design path never had.
 *
 * Not thread-safe: one parser belongs to one transfer, which libcurl drives
 * from one thread.
 */
class SseParser {
    public:
    /// @param max_event_bytes Bytes of `data` retained per event, and the cap on
    ///        any single unterminated line. Zero is treated as one, so the cap
    ///        can never disable itself into an unbounded buffer.
    explicit SseParser (std::size_t max_event_bytes);

    /**
     * Consume @p chunk and return every event it completed.
     *
     * A frame the chunk ends in the middle of is held until a later call
     * completes it, so an event split across TCP reads dispatches exactly once
     * and with its whole payload. Line terminators may be LF, CRLF or a lone
     * CR, including a CRLF whose halves land in different chunks.
     */
    std::vector<SseEvent> feed (std::string_view chunk);

    /**
     * Dispatch what a closed stream left behind.
     *
     * A server that ends its stream without the blank line that terminates the
     * last frame still sent that frame, and the spec's own EOF handling is to
     * discard it. We dispatch it instead: a truncated *stream* is already
     * disclosed by the run's termination reason, and dropping the last event of
     * every well-behaved-but-abrupt server would be a silent loss. An
     * unterminated frame with no `data` still does not dispatch.
     */
    std::vector<SseEvent> finish ();

    private:
    /// Append @p text to the line being assembled, dropping whatever exceeds
    /// the cap and counting what was dropped.
    void hold (std::string_view text);
    void consume_line (std::string_view line, std::vector<SseEvent>& out);
    void apply_field (std::string_view field, std::string_view value);
    void dispatch (std::vector<SseEvent>& out);

    std::size_t max_event_bytes_;
    /// The line cap: the event cap plus room for a field name, so a `data: `
    /// prefix is not charged to the payload's budget.
    std::size_t max_line_bytes_;

    /// The line being assembled, capped at `max_line_bytes_`.
    std::string line_;
    /// Bytes of the current line dropped by that cap.
    std::size_t line_dropped_ = 0;
    /// True when the previous chunk ended in CR, so a leading LF in the next
    /// one is the other half of a CRLF and not an empty line.
    bool pending_cr_ = false;

    std::string event_type_;
    std::string data_;
    std::size_t data_bytes_ = 0;
    bool data_truncated_    = false;
    bool has_data_          = false;
    std::string last_event_id_;
};

/**
 * @p text with every byte that is not part of a well-formed UTF-8 sequence
 * replaced by U+FFFD.
 *
 * An event stream is UTF-8 by definition, but nothing stops a server from
 * sending bytes that are not - and the parsed text goes on to be JSON-encoded
 * into a run's trace and handed to a script, both of which need valid UTF-8.
 * Replacing at the parse boundary means one sanitization rather than one per
 * consumer. Exposed for its own tests.
 */
[[nodiscard]] std::string sanitize_utf8 (std::string_view text);

} // namespace vayu::http
