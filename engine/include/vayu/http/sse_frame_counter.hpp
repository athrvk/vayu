#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/sse_frame_counter.hpp
 * @brief Counting `text/event-stream` events on the load hot path (issue #576).
 *
 * `SseParser` is the design path's reader: it assembles every field, sanitizes
 * UTF-8 and hands back the events themselves. Under load none of that is wanted
 * - the answer a load run needs from a stream is *how many events*, once per
 * completion, for a histogram - and paying for the rest per byte per virtual
 * user would put string building in `write_callback`.
 *
 * So this counts and holds nothing else. It allocates never, copies no payload,
 * and its whole state is the nine bytes below, which is what makes it safe to
 * run inside the curl write callback for every transfer of a 60k-RPS run.
 *
 * **It agrees with `SseParser` on what an event is**, which is the one property
 * that matters: a frame carrying no `data` field is not an event (a comment-only
 * keep-alive is the common case, and counting those would inflate events/sec on
 * exactly the idle-ish streams this metric is for). That agreement is a
 * contract, not a coincidence - `sse_frame_counter_test.cpp` drives both over
 * the same inputs and asserts the counts match, so a change to either parser's
 * dispatch rule fails there rather than in a report nobody can check.
 *
 * The cheap part is that agreeing costs a per-*line* test, not a per-field
 * parse: a line is a `data` field iff its first bytes are `data` followed by
 * `:` or the line's end, and that is decidable from a 3-byte state machine
 * carried across chunk boundaries.
 *
 * Not thread-safe: one counter belongs to one transfer, which libcurl drives
 * from one thread.
 */

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace vayu::http {

/**
 * @brief Incremental event counter over a `text/event-stream` body.
 *
 * Feed it every byte libcurl delivers, in order; read `events()` when the
 * transfer ends. Line terminators may be LF, CRLF or a lone CR, including a
 * CRLF whose halves land in different chunks - the same three `SseParser`
 * accepts, because the two must not disagree about where a frame ended either.
 */
class SseFrameCounter {
    public:
    /// Consume @p chunk, counting every frame it completed.
    void feed (std::string_view chunk) {
        for (std::size_t i = 0; i < chunk.size (); ++i) {
            const char c = chunk[i];
            if (pending_cr_) {
                pending_cr_ = false;
                if (c == '\n') {
                    // The other half of a CRLF split across chunks or loop
                    // iterations. The line ended at the CR, so this LF
                    // separates lines rather than being an empty one.
                    continue;
                }
            }
            if (c == '\n' || c == '\r') {
                pending_cr_ = (c == '\r');
                end_line ();
                continue;
            }
            // Only the first five bytes of a line can decide whether it is a
            // `data` field, so every line longer than that costs one compare.
            if (field_match_ != FieldMatch::Decided) {
                advance_field_match (c);
            }
            line_empty_ = false;
        }
    }

    /**
     * @brief Count what a closed stream left behind.
     *
     * A server that ends without the blank line terminating its last frame
     * still sent that frame, and `SseParser::finish` dispatches it for that
     * reason. This counts it for the same one - a stream whose last event
     * vanished from the tally because the connection closed politely would
     * under-report every well-behaved-but-abrupt server by exactly one.
     */
    void finish () {
        // The trailing line has no terminator, so `end_line` never ran for it;
        // run its field decision now, then dispatch the frame it belonged to.
        if (!line_empty_) {
            resolve_line ();
        }
        if (frame_has_data_) {
            ++events_;
            frame_has_data_ = false;
        }
    }

    /// Events completed so far. Exact after `finish()`; a lower bound before it.
    [[nodiscard]] std::size_t events () const {
        return events_;
    }

    private:
    /// How much of a leading `data` this line has matched. `Decided` means the
    /// question is settled either way and the rest of the line is skipped.
    enum class FieldMatch : std::uint8_t { Matching, MatchedName, Decided };

    void advance_field_match (char c) {
        static constexpr char FIELD[]          = "data";
        static constexpr std::size_t FIELD_LEN = 4;

        if (field_match_ == FieldMatch::MatchedName) {
            // `data:` is the field; `database:` is a different one whose name
            // merely starts the same way.
            line_is_data_ = (c == ':');
            field_match_  = FieldMatch::Decided;
            return;
        }
        if (matched_ < FIELD_LEN && c == FIELD[matched_]) {
            ++matched_;
            if (matched_ == FIELD_LEN) {
                // A colonless line is a field with an empty value, so a line
                // that is exactly `data` is one - resolved here in case the
                // line ends before another byte arrives.
                line_is_data_ = true;
                field_match_  = FieldMatch::MatchedName;
            }
            return;
        }
        field_match_ = FieldMatch::Decided;
    }

    /// Fold the finished line into the frame, then reset the per-line state.
    void resolve_line () {
        frame_has_data_ = frame_has_data_ || line_is_data_;
        line_is_data_   = false;
        matched_        = 0;
        field_match_    = FieldMatch::Matching;
        line_empty_     = true;
    }

    void end_line () {
        if (line_empty_) {
            // A blank line terminates the frame. Only a frame that carried a
            // `data` field is an event - see the file comment.
            if (frame_has_data_) {
                ++events_;
                frame_has_data_ = false;
            }
            resolve_line ();
            return;
        }
        resolve_line ();
    }

    std::size_t events_     = 0;
    bool pending_cr_        = false;
    bool line_empty_        = true;
    bool frame_has_data_    = false;
    bool line_is_data_      = false;
    std::uint8_t matched_   = 0;
    FieldMatch field_match_ = FieldMatch::Matching;
};

} // namespace vayu::http
