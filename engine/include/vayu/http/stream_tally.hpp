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
 * to disagree about either.
 *
 * Not thread-safe: one tally belongs to one transfer, which libcurl drives
 * from one thread.
 */

#include <chrono>
#include <cstdint>
#include <optional>
#include <string_view>
#include <utility>

#include "vayu/http/sse_frame_counter.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

class StreamTally {
    public:
    using Clock = std::chrono::steady_clock;

    /// Bound this transfer by @p bounds, timed from @p started_at, the instant
    /// the transfer's latency is measured from. A tally never started is
    /// inactive, and its owner calls nothing but `report` on it.
    void start (const StreamBounds& bounds, Clock::time_point started_at) {
        active_     = true;
        max_events_ = bounds.max_events;
        started_at_ = started_at;
        deadline_ = started_at + std::chrono::milliseconds (bounds.max_duration_ms);
    }

    [[nodiscard]] bool active () const {
        return active_;
    }

    /**
     * Count @p chunk; true once the event cap is reached. The whole chunk is
     * counted before the cap is tested: those events are on the wire either
     * way, and a tally that stopped mid-chunk would under-report the stream
     * it exists to measure.
     */
    bool feed (std::string_view chunk) {
        counter_.feed (chunk);
        // Stamped on the clock latency is read from (#3234). libcurl cannot
        // answer this: its start-transfer time ends at the response headers,
        // which a stream sends long before its first event.
        if (!first_event_ms_ && counter_.events () > 0) {
            first_event_ms_ =
            std::chrono::duration<double, std::milli> (Clock::now () - started_at_)
            .count ();
        }
        return std::cmp_greater_equal (counter_.events (), max_events_);
    }

    /// Whether the duration cap has expired at @p now.
    [[nodiscard]] bool deadline_passed (Clock::time_point now) const {
        return now >= deadline_;
    }

    /// Record that a cap ended the transfer: its completion is a **success**,
    /// whatever libcurl calls the abort that delivered it.
    void mark_cap_reached () {
        cap_reached_ = true;
    }

    [[nodiscard]] bool cap_reached () const {
        return cap_reached_;
    }

    /**
     * What the stream delivered, onto @p response, once the transfer has
     * ended - on every path, a failed one included: a stream the server killed
     * mid-way still delivered the events it delivered. Counts an unterminated
     * last frame the close completed, which leaves the first-event time unset
     * when it was the only one: no write delivered it at a time to measure.
     * An inactive tally reports nothing, so an ordinary transfer's
     * `stream_events` stays absent rather than zero.
     */
    void report (Response& response) {
        if (!active_) {
            return;
        }
        counter_.finish ();
        response.stream_events         = counter_.events ();
        response.stream_capped         = cap_reached_;
        response.stream_first_event_ms = first_event_ms_;
    }

    private:
    bool active_        = false;
    int64_t max_events_ = 0;
    Clock::time_point started_at_;
    Clock::time_point deadline_;
    SseFrameCounter counter_;
    std::optional<double> first_event_ms_;
    bool cap_reached_ = false;
};

} // namespace vayu::http
