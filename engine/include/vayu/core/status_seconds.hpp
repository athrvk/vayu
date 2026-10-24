#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/status_seconds.hpp
 * @brief Status-class counts keyed by the second each response completed in
 *        (#2866).
 *
 * A rate diffed between two ticks counts what landed between the ticks, so a
 * batch of completions near a window edge reads in or out depending on where
 * the ticks fell. Counting each response in the second it completed removes
 * the tick from the answer. `MetricsCollector` stamps the second on the
 * completion path; the metrics thread drains the closed seconds once per gate
 * and hands the same entries to the gate frame and the stored row.
 */

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace vayu::core {

/// The classes a status chart draws, and the order an entry's `counts` lists
/// them in: the app's `classifyCumulative`. `Error` is every code outside
/// 200-599, which is a transport failure's synthetic 0 and any 1xx.
enum class StatusClass : std::uint8_t {
    Success     = 0, ///< 2xx
    Redirect    = 1, ///< 3xx
    ClientError = 2, ///< 4xx
    ServerError = 3, ///< 5xx
    Error       = 4, ///< no response (code 0), or a code outside 200-599
};

inline constexpr size_t STATUS_CLASS_COUNT = 5;

[[nodiscard]] constexpr StatusClass status_class_of (int status_code) noexcept {
    if (status_code < 200 || status_code >= 600) {
        return StatusClass::Error;
    }
    return static_cast<StatusClass> ((status_code / 100) - 2);
}

using StatusClassCounts = std::array<uint64_t, STATUS_CLASS_COUNT>;

/**
 * @brief The responses that completed in `span` consecutive seconds starting
 *        at `second`, counted from load start, by class.
 *
 * A drained entry spans 1; a downsampled tick's entry spans its bucket, so
 * `count / span` is responses per second at any resolution (#2547).
 */
struct StatusSecondEntry {
    int64_t second = 0;
    int64_t span   = 1;
    StatusClassCounts counts{};

    bool operator== (const StatusSecondEntry&) const = default;
};

/// `[{second, span, counts: [2xx, 3xx, 4xx, 5xx, error]}]`: the stored row's
/// `status_seconds` and the gate frame's `statusSeconds`.
[[nodiscard]] inline nlohmann::json status_seconds_json (
const std::vector<StatusSecondEntry>& entries) {
    nlohmann::json out = nlohmann::json::array ();
    for (const auto& entry : entries) {
        out.push_back ({ { "second", entry.second }, { "span", entry.span },
        { "counts", entry.counts } });
    }
    return out;
}

/// @p value as an entry, or nullopt when it does not have an entry's shape.
[[nodiscard]] inline std::optional<StatusSecondEntry>
status_second_entry_from_json (const nlohmann::json& value) {
    const auto whole = [] (const nlohmann::json& number, int64_t floor) {
        return number.is_number_integer () && number.get<int64_t> () >= floor;
    };
    const auto whole_at = [&] (const char* key, int64_t floor) {
        const auto field = value.find (key);
        return field != value.end () && whole (*field, floor);
    };
    if (!value.is_object () || !whole_at ("second", 0) || !whole_at ("span", 1)) {
        return std::nullopt;
    }
    const auto counts = value.find ("counts");
    if (counts == value.end () || !counts->is_array () || counts->size () != STATUS_CLASS_COUNT ||
    !std::ranges::all_of (
    *counts, [&] (const nlohmann::json& n) { return whole (n, 0); })) {
        return std::nullopt;
    }
    StatusSecondEntry entry;
    entry.second = value.at ("second").get<int64_t> ();
    entry.span   = value.at ("span").get<int64_t> ();
    for (size_t i = 0; i < STATUS_CLASS_COUNT; ++i) {
        entry.counts.at (i) = counts->at (i).get<uint64_t> ();
    }
    return entry;
}

/// Fold @p next, a later entry, into @p into: counts summed per class and the
/// spans added, so the result is still a rate over the seconds both counted.
inline void merge_status_seconds (StatusSecondEntry& into,
const StatusSecondEntry& next) noexcept {
    into.span += next.span;
    for (size_t i = 0; i < STATUS_CLASS_COUNT; ++i) {
        into.counts.at (i) += next.counts.at (i);
    }
}

/**
 * @brief Lock-free per-second status-class counts over a fixed ring of
 *        seconds.
 *
 * Writers (every event-loop worker) call `record`, one relaxed `fetch_add` on
 * the slot of the second the response completed in. One reader (the metrics
 * thread) calls `drain`, which takes each closed second's counts with an
 * `exchange (0)` and so frees the slot for the second `SLOTS` later. Memory is
 * fixed at `SLOTS * STATUS_CLASS_COUNT` counters (5 KiB) however long the run.
 *
 * **When a second is closed.** A writer reads the clock, then increments: a
 * worker preempted between the two can increment a second the reader has
 * already drained. So a second is closed only `CLOSE_MARGIN_MS` after it
 * ended, which is the stall between those two adjacent instructions it takes
 * to miss it. An increment that does land after its second was drained is not
 * lost: each drain that emits an entry first sweeps the seconds earlier drains
 * emitted (the last `LATE_SWEEP_SECONDS` of them) and adds what it finds to its
 * first entry, about a second later than it completed.
 *
 * **When the reader falls behind.** A reader more than `SLOTS` seconds behind
 * drains a slot the second `SLOTS` later has already written into, so the
 * older entry carries both and the newer one only what landed after; nothing
 * is lost or counted twice. The metrics thread gates about once a second, so
 * this takes a two-minute stall of it.
 */
class StatusSecondCounter {
    public:
    static constexpr int64_t SLOTS              = 128;
    static constexpr int64_t CLOSE_MARGIN_MS    = 250;
    static constexpr int64_t LATE_SWEEP_SECONDS = SLOTS / 2;
    // The sweep reaches back half the ring, so a slot it empties is never
    // one a writer of the current second, or the next, can be using.
    static_assert (LATE_SWEEP_SECONDS + 2 < SLOTS);

    /// Count one response of @p status_code that completed @p elapsed_ms
    /// after load start. Lock-free.
    void record (int status_code, int64_t elapsed_ms) noexcept {
        const int64_t second = std::max<int64_t> (elapsed_ms, 0) / 1000;
        slot (second).at (std::to_underlying (status_class_of (status_code))).fetch_add (1, std::memory_order_relaxed);
    }

    /**
     * @brief One entry per second closed at @p elapsed_ms (milliseconds since
     *        load start) that no earlier drain emitted, oldest first.
     *
     * Contiguous across calls, starting at second 0, and a second nothing
     * completed in is an entry of zeros. Empty until the first second is
     * closed. Single reader: call it from one thread only.
     */
    [[nodiscard]] std::vector<StatusSecondEntry> drain (int64_t elapsed_ms) {
        const int64_t closed_before =
        std::max<int64_t> (elapsed_ms - CLOSE_MARGIN_MS, 0) / 1000;
        const int64_t first_new = next_second_;
        std::vector<StatusSecondEntry> entries;
        for (; next_second_ < closed_before; ++next_second_) {
            entries.push_back ({ next_second_, 1, take (slot (next_second_)) });
        }
        if (entries.empty ()) {
            return entries;
        }
        for (int64_t late = std::max<int64_t> (first_new - LATE_SWEEP_SECONDS, 0);
        late < first_new; ++late) {
            const StatusClassCounts found = take (slot (late));
            for (size_t i = 0; i < STATUS_CLASS_COUNT; ++i) {
                entries.front ().counts.at (i) += found.at (i);
            }
        }
        return entries;
    }

    private:
    using Slot = std::array<std::atomic<uint64_t>, STATUS_CLASS_COUNT>;
    std::array<Slot, static_cast<size_t> (SLOTS)> slots_{};
    /// The oldest second no drain has emitted. Reader-owned.
    int64_t next_second_ = 0;

    Slot& slot (int64_t second) noexcept {
        return slots_.at (static_cast<size_t> (second % SLOTS));
    }

    static StatusClassCounts take (Slot& from) noexcept {
        StatusClassCounts counts{};
        for (size_t i = 0; i < STATUS_CLASS_COUNT; ++i) {
            counts.at (i) = from.at (i).exchange (0, std::memory_order_relaxed);
        }
        return counts;
    }
};

} // namespace vayu::core
