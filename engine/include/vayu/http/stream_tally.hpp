#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/stream_tally.hpp
 * @brief One bounded stream's progress against its `StreamBounds` (#576).
 *
 * Both curl drivers that send a `Request::stream_bounds` keep one: the event
 * loop's `TransferData` and the single-request `Client` (a collection run's
 * sequential steps, #3235). It is the one place that decides when a cap is
 * reached and what the ended stream reports, so the two drivers cannot come
 * to disagree about either. It also keeps the run's live counters
 * (`StreamBounds::live`, #3236, #3304): it counts the events as they arrive,
 * so a live tick sees a stream's events while it is still open and the
 * settled live total equals the report's, and it holds the run's open-stream
 * gauge up from `start` until `report` or, on a path that never reports (a
 * cancelled or discarded transfer), its destructor.
 *
 * A request that asks to stream is not yet a stream (#3771): the reply is one
 * only when its final hop announces `text/event-stream`. A 429 or a 200 JSON
 * answer is counted as nothing here, so it is what it already is in the run's
 * status mix and never a stream that delivered 0 events.
 *
 * Not thread-safe: one tally belongs to one transfer, which libcurl drives
 * from one thread. The live counters it feeds are shared, and atomic.
 */

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "vayu/core/sample_capture.hpp"
#include "vayu/http/sse_frame_counter.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

/// Whether @p headers announce an event stream, whose bytes are its events
/// rather than a body. A missing `Content-Type` is not one. The one reading
/// of it: the design stream (`sse_stream.cpp`) and both load drivers' tallies.
inline bool announces_event_stream (const Headers& headers) {
    const auto found = headers.find ("content-type");
    return found != headers.end () && vayu::core::media_type (found->second) == "text/event-stream";
}

class StreamTally {
    public:
    using Clock = std::chrono::steady_clock;

    StreamTally () = default;
    ~StreamTally () {
        close_live ();
    }
    StreamTally (const StreamTally&)            = delete;
    StreamTally& operator= (const StreamTally&) = delete;
    StreamTally (StreamTally&&)                 = delete;
    StreamTally& operator= (StreamTally&&)      = delete;

    /// Bound this transfer by @p bounds, timed from @p started_at, the instant
    /// the transfer's latency is measured from, and count it open. A tally
    /// never started is inactive, and its owner calls nothing but `report` on
    /// it. Called at most once.
    void start (const StreamBounds& bounds, Clock::time_point started_at) {
        active_          = true;
        max_events_      = bounds.max_events;
        max_duration_ms_ = bounds.max_duration_ms;
        live_            = bounds.live;
        started_at_      = started_at;
        deadline_ = started_at + std::chrono::milliseconds (bounds.max_duration_ms);
        if (live_ != nullptr) {
            live_->open.fetch_add (1, std::memory_order_relaxed);
        }
    }

    [[nodiscard]] bool active () const {
        return active_;
    }

    /**
     * Count @p chunk; true once the event cap is reached. The whole chunk is
     * counted before the cap is tested: those events are on the wire either
     * way, and a tally that stopped mid-chunk would under-report the stream
     * it exists to measure. The events it completes reach the live tally
     * here rather than at completion, so a tick sees an open stream's events.
     *
     * @p headers are the hop's own, complete by its first body byte, which is
     * when the reply is judged a stream or not. A redirect hop's body never
     * reaches here (both drivers discard it), so the first chunk fed is the
     * final hop's. A reply that did not announce `text/event-stream` counts
     * nothing and never reaches the cap.
     *
     * A chunk that completed an event is an arrival, stamped at @p now: the
     * first one times the first event, and each later one closes a gap.
     * Callers pass nothing; a test passes its own clock.
     */
    bool feed (std::string_view chunk,
    const Headers& headers,
    Clock::time_point now = Clock::now ()) {
        if (!announced_) {
            announced_ = announces_event_stream (headers);
        }
        if (!*announced_) {
            return false;
        }
        const std::size_t before = counter_.events ();
        counter_.feed (chunk);
        publish_since (before);
        if (counter_.events () > before) {
            note_arrival (now);
        }
        return std::cmp_greater_equal (counter_.events (), max_events_);
    }

    /// Whether the duration cap has expired at @p now.
    [[nodiscard]] bool deadline_passed (Clock::time_point now) const {
        return now >= deadline_;
    }

    /// Record that a cap ended the transfer: when the reply announced an
    /// event stream its completion is a **success**, whatever libcurl calls
    /// the abort that delivered it; any other reply ends as
    /// `unannounced_cap_error` (#3771).
    void mark_cap_reached () {
        cap_reached_ = true;
    }

    [[nodiscard]] bool cap_reached () const {
        return cap_reached_;
    }

    /// The failure for a duration cap that passed on a reply that is not a
    /// stream (no answer yet, or one that announced another type): the cap
    /// still ends the transfer, but only a stream's end is a success.
    [[nodiscard]] Error unannounced_cap_error () const {
        return Error{ ErrorCode::Timeout,
            "No text/event-stream reply before the stream's " +
            std::to_string (max_duration_ms_) + " ms duration cap (maxStreamDurationMs)" };
    }

    /**
     * What the stream delivered, onto @p response, once the transfer has
     * ended - on every path, a failed one included: a stream the server killed
     * mid-way still delivered the events it delivered. Counts an unterminated
     * last frame the close completed, which leaves the first-event time unset
     * when it was the only one: no write delivered it at a time to measure.
     * For the same reason it closes no gap and is not in the event rate.
     * That frame reaches the live tally too, and the stream stops counting as
     * open. An inactive tally reports nothing, so an ordinary transfer's
     * `stream_events` stays absent rather than zero, and so does a reply
     * whose final hop (`response.headers`) did not announce
     * `text/event-stream`, a transfer that never got an answer included: it
     * only leaves the open gauge. Called once per transfer.
     */
    void report (Response& response) {
        if (!active_) {
            return;
        }
        if (!announces_event_stream (response.headers)) {
            close_live ();
            return;
        }
        const std::size_t before = counter_.events ();
        counter_.finish ();
        publish_since (before);
        close_live ();
        response.stream_events           = counter_.events ();
        response.stream_capped           = cap_reached_;
        response.stream_first_event_ms   = first_event_ms ();
        response.stream_max_event_gap_ms = max_event_gap_ms ();
        response.stream_event_rate       = event_rate ();
    }

    private:
    using Milliseconds = std::chrono::duration<double, std::milli>;

    /// Stamp a write that completed at least one event, on the clock latency
    /// is read from (#3234). libcurl cannot answer this: its start-transfer
    /// time ends at the response headers, which a stream sends long before
    /// its first event. Only the largest gap is kept (#3776): a histogram of
    /// every gap would be per-event work for a figure the maximum answers.
    void note_arrival (Clock::time_point now) {
        if (!first_arrival_) {
            first_arrival_           = now;
            events_at_first_arrival_ = counter_.events ();
        } else {
            // Parenthesized: the test target includes `windows.h` without
            // `NOMINMAX` (`core/constants.hpp` says why), whose `max` macro
            // would otherwise break this line with MSVC's C2589.
            max_gap_ = (std::max)(max_gap_.value_or (Clock::duration::zero ()),
            now - last_arrival_);
        }
        last_arrival_           = now;
        events_at_last_arrival_ = counter_.events ();
    }

    [[nodiscard]] std::optional<double> first_event_ms () const {
        if (!first_arrival_) {
            return std::nullopt;
        }
        return Milliseconds (*first_arrival_ - started_at_).count ();
    }

    /// Absent below two arrivals: one write has no gap to measure.
    [[nodiscard]] std::optional<double> max_event_gap_ms () const {
        if (!max_gap_) {
            return std::nullopt;
        }
        return Milliseconds (*max_gap_).count ();
    }

    /// The events delivered after the first arrival, over the first arrival
    /// to the last, in events per second. The first write's events are left
    /// out however many it carried: they took no measured time, so a backlog
    /// replayed in one write would otherwise inflate the rate. Absent below
    /// two arrivals or over a zero span, where it would be a division by
    /// nothing.
    [[nodiscard]] std::optional<double> event_rate () const {
        if (!first_arrival_ || !max_gap_) {
            return std::nullopt;
        }
        const auto span = std::chrono::duration<double> (last_arrival_ - *first_arrival_);
        if (span.count () <= 0.0) {
            return std::nullopt;
        }
        const std::size_t delivered = events_at_last_arrival_ - events_at_first_arrival_;
        return static_cast<double> (delivered) / span.count ();
    }

    /// Add what the counter counted since it read @p before to the run's live
    /// tally. Relaxed: the tick only needs each event counted once, not
    /// ordered against anything else the transfer wrote.
    void publish_since (std::size_t before) const {
        const std::size_t after = counter_.events ();
        if (after == before || live_ == nullptr) {
            return;
        }
        live_->events.fetch_add (after - before, std::memory_order_relaxed);
    }

    /// Take this stream off the run's open gauge, once: releasing the handle
    /// is what makes the second call (the destructor after `report`) a no-op.
    void close_live () noexcept {
        if (live_ == nullptr) {
            return;
        }
        live_->open.fetch_sub (1, std::memory_order_relaxed);
        live_.reset ();
    }

    bool active_             = false;
    int64_t max_events_      = 0;
    int64_t max_duration_ms_ = 0;
    /// Whether the reply announced an event stream, decided at its first
    /// body byte; empty until one arrives.
    std::optional<bool> announced_;
    /// Null unless the run reports stream metrics live, and once the stream
    /// has been reported.
    std::shared_ptr<LiveStreamCounts> live_;
    Clock::time_point started_at_;
    Clock::time_point deadline_;
    SseFrameCounter counter_;
    /// The first write that completed an event; empty until one has.
    std::optional<Clock::time_point> first_arrival_;
    Clock::time_point last_arrival_;
    /// The events counted by the first arrival, the rate's zero point.
    std::size_t events_at_first_arrival_ = 0;
    /// The events counted by the last arrival, so a frame `finish` completes
    /// at the close never enters the rate it took no time in.
    std::size_t events_at_last_arrival_ = 0;
    /// Empty until a second arrival.
    std::optional<Clock::duration> max_gap_;
    bool cap_reached_ = false;
};

} // namespace vayu::http
