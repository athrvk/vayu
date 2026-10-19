/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/sse_parser.cpp
 * @brief The `text/event-stream` line protocol (issue #573).
 */

#include "vayu/http/sse_parser.hpp"

#include <algorithm>

#include "vayu/utils/encoding.hpp"

namespace vayu::http {

namespace {

/// The replacement character, as the three bytes UTF-8 spells it with.
constexpr std::string_view REPLACEMENT = "\xEF\xBF\xBD";

} // namespace

std::string sanitize_utf8 (std::string_view text) {
    std::string out;
    out.reserve (text.size ());
    std::size_t i = 0;
    while (i < text.size ()) {
        const std::size_t length = vayu::utils::utf8_sequence_length (text, i);
        if (length > 0) {
            out.append (text.substr (i, length));
            i += length;
            continue;
        }
        // One replacement per bad *byte*, not per announced sequence: a lead
        // byte truncated by the cap is one bad byte, and skipping the length it
        // claimed would swallow whatever legitimately follows it.
        out.append (REPLACEMENT);
        ++i;
    }
    return out;
}

namespace {
/// U+FEFF as UTF-8, which the EventSource spec says a stream may open with.
constexpr std::string_view UTF8_BOM = "\xEF\xBB\xBF";

/// Headroom the line buffer gets over the event cap, so a field name is not
/// paid for out of the payload's budget: `data: ` is six bytes, and without
/// this a cap of 8 would keep two bytes of an event and call it truncated. It
/// bounds nothing on its own - the data cap below still trims the value - it
/// only keeps the two caps from measuring different things.
constexpr std::size_t FIELD_NAME_HEADROOM = 64;
} // namespace

SseParser::SseParser (std::size_t max_event_bytes)
: max_event_bytes_ (max_event_bytes == 0 ? 1 : max_event_bytes),
  max_line_bytes_ (max_event_bytes_ + FIELD_NAME_HEADROOM) {
}

std::vector<SseEvent> SseParser::feed (std::string_view chunk) {
    std::vector<SseEvent> out;
    std::size_t start = 0;
    for (std::size_t i = 0; i < chunk.size (); ++i) {
        const char c = chunk[i];
        if (pending_cr_) {
            pending_cr_ = false;
            if (c == '\n') {
                // The other half of a CRLF whose halves landed in different
                // chunks - or in different loop iterations. The line already
                // ended at the CR, so this LF is a separator, not an empty line.
                start = i + 1;
                continue;
            }
        }
        if (c != '\n' && c != '\r') {
            continue;
        }
        hold (chunk.substr (start, i - start));
        consume_line (line_, out);
        line_.clear ();
        line_dropped_    = 0;
        pending_cr_      = (c == '\r');
        start            = i + 1;
        at_stream_start_ = false;
    }
    if (start < chunk.size ()) {
        hold (chunk.substr (start));
    }
    return out;
}

std::vector<SseEvent> SseParser::finish () {
    std::vector<SseEvent> out;
    if (!line_.empty ()) {
        consume_line (line_, out);
        line_.clear ();
        line_dropped_ = 0;
    }
    dispatch (out);
    return out;
}

void SseParser::hold (std::string_view text) {
    const std::size_t room =
    max_line_bytes_ > line_.size () ? max_line_bytes_ - line_.size () : 0;
    const std::size_t kept = std::min (room, text.size ());
    line_.append (text.substr (0, kept));
    line_dropped_ += text.size () - kept;
    drop_leading_bom ();
}

void SseParser::drop_leading_bom () {
    if (!at_stream_start_) {
        return;
    }
    // The line is held across chunks, so its front is the BOM however the three
    // bytes were split. Still a prefix of the BOM means more bytes may complete it.
    const std::string_view front = std::string_view (line_).substr (0, UTF8_BOM.size ());
    if (front == UTF8_BOM) {
        line_.erase (0, UTF8_BOM.size ());
    } else if (UTF8_BOM.starts_with (front)) {
        return;
    }
    at_stream_start_ = false;
}

void SseParser::consume_line (std::string_view line, std::vector<SseEvent>& out) {
    if (line.empty ()) {
        dispatch (out);
        return;
    }
    if (line.front () == ':') {
        // A comment. Servers send these as keep-alives, so they are the most
        // common line on an idle stream and must not disturb the frame being
        // assembled.
        return;
    }
    const auto colon = line.find (':');
    if (colon == std::string_view::npos) {
        apply_field (line, {});
        return;
    }
    std::string_view value = line.substr (colon + 1);
    if (!value.empty () && value.front () == ' ') {
        value.remove_prefix (1);
    }
    apply_field (line.substr (0, colon), value);
}

void SseParser::apply_field (std::string_view field, std::string_view value) {
    if (field == "data") {
        has_data_ = true;
        // The buffer carries the joining `\n` after every data line and loses
        // the last one at dispatch, exactly as the spec builds it - which is
        // what makes a leading empty `data:` line survive as a leading newline
        // rather than vanishing.
        //
        // `line_dropped_` is the part of *this* line the line cap refused to
        // hold; counting it here is what lets a truncated event still report
        // the size the stream actually sent.
        data_bytes_ += value.size () + 1 + line_dropped_;
        if (line_dropped_ > 0) {
            data_truncated_ = true;
        }
        const std::size_t room =
        max_event_bytes_ > data_.size () ? max_event_bytes_ - data_.size () : 0;
        if (value.size () + 1 > room) {
            data_.append (value.substr (0, std::min (room, value.size ())));
            data_truncated_ = true;
        } else {
            data_.append (value);
            data_.push_back ('\n');
        }
        return;
    }
    if (field == "event") {
        event_type_.assign (value);
        return;
    }
    if (field == "id") {
        // The spec drops an id containing a NUL rather than storing it: a
        // resume point that cannot round-trip through a header is worse than
        // none.
        if (value.find ('\0') == std::string_view::npos) {
            last_event_id_.assign (value);
        }
        return;
    }
    // Every other field name - `retry:` included, see the header - is ignored,
    // as the spec requires: a stream that invents one must not derail the frame
    // around it.
}

void SseParser::dispatch (std::vector<SseEvent>& out) {
    if (!has_data_) {
        // A frame with no `data` is not an event. Its `id:` still persists - it
        // was recorded when the field was read - which is how a server keeps a
        // resume point alive across a quiet period.
        event_type_.clear ();
        return;
    }

    if (!data_.empty () && data_.back () == '\n') {
        data_.pop_back ();
    }

    SseEvent event;
    event.event = event_type_.empty () ? "message" : sanitize_utf8 (event_type_);
    event.data      = sanitize_utf8 (data_);
    event.id        = sanitize_utf8 (last_event_id_);
    event.truncated = data_truncated_;
    // Every data line contributed a joining newline and the last one is not
    // part of the payload, so the count sheds it too.
    event.data_bytes = data_bytes_ > 0 ? data_bytes_ - 1 : 0;
    out.push_back (std::move (event));

    event_type_.clear ();
    data_.clear ();
    data_bytes_     = 0;
    data_truncated_ = false;
    has_data_       = false;
}

} // namespace vayu::http
