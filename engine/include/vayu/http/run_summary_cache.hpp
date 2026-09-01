/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL-3.0 license found in the
 * LICENSE file in the "engine" directory of this source tree.
 */

#pragma once

#include <cstddef>
#include <list>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>

#include <nlohmann/json.hpp>

namespace vayu::http {

/**
 * @brief The compact `summary` object of a `GET /runs` row, kept between calls.
 *
 * `GET /runs` is the polled endpoint (issue #1150): the history sidebar, the
 * welcome screen and the command palette each re-ask every 5 seconds while they
 * are on screen, and every call rebuilt the same nine-key summary for every row
 * by re-parsing that run's stored `config_snapshot` - up to 50 JSON parses a
 * tick, all producing what the previous tick already produced.
 *
 * **Keyed by run id, and that is exact rather than merely likely.** A run's
 * `config_snapshot` is written once, by `Database::create_run`, from the two
 * call sites in `execution.cpp` that start a run. Every later write to a run
 * row - status, end time, report summary, baseline, the startup reconcile -
 * is a read-modify-write that puts back the snapshot string it just read.
 * Nothing edits a snapshot in place, so a run id names one snapshot for the
 * whole life of the row, and an entry can never go stale. Deleting or pruning
 * a run leaves an entry no request can reach again; capacity, not
 * invalidation, is what reclaims it, and ids are never reused.
 *
 * **Threading: one mutex, held only around the map** - the same discipline
 * `CookieJar` runs on, and deliberately *not* the database mutex, which
 * `/health`, this poll and SSE all serialize on (see `Database::with_lock`).
 * `summary_for` returns a copy, so no reference into the storage escapes the
 * lock and a caller cannot read an entry another thread is evicting.
 */
class RunSummaryCache {
    public:
    /// Two full pages of the largest `limit` the route allows (500), so one
    /// page can never evict rows of the page it is serializing, and a client
    /// that pages back and forth still finds its recent rows warm.
    static constexpr std::size_t DEFAULT_CAPACITY = 1000;

    explicit RunSummaryCache (std::size_t capacity = DEFAULT_CAPACITY)
    : capacity_ (capacity == 0 ? 1 : capacity) {
    }

    /**
     * @brief The summary for @p run_id, calling @p build only on a miss.
     * @param run_id  The run whose summary is wanted.
     * @param build   Builds the summary from scratch; invoked at most once per
     *                run id for as long as the entry survives eviction.
     * @return A copy of the cached summary.
     */
    template <typename Build>
    nlohmann::json summary_for (const std::string& run_id, Build&& build) {
        const std::lock_guard<std::mutex> lock (mutex_);

        if (const auto found = index_.find (run_id); found != index_.end ()) {
            // Most recently used goes to the front; the back is what evicts.
            entries_.splice (entries_.begin (), entries_, found->second);
            return found->second->second;
        }

        nlohmann::json summary = build ();
        ++build_count_;
        entries_.emplace_front (run_id, summary);
        index_[run_id] = entries_.begin ();

        while (entries_.size () > capacity_) {
            index_.erase (entries_.back ().first);
            entries_.pop_back ();
        }
        return summary;
    }

    /// How many entries are held. Never above the configured capacity.
    std::size_t size () const {
        const std::lock_guard<std::mutex> lock (mutex_);
        return index_.size ();
    }

    /// How many times a summary has actually been built. The seam the tests
    /// assert on: a poll that re-parses nothing leaves this unchanged.
    std::size_t build_count () const {
        const std::lock_guard<std::mutex> lock (mutex_);
        return build_count_;
    }

    private:
    mutable std::mutex mutex_;
    std::size_t capacity_;

    /// Front is most recently used. The map holds iterators into this list,
    /// which `std::list` keeps valid across every insertion and every erase
    /// but its own.
    using Entry = std::pair<std::string, nlohmann::json>;
    std::list<Entry> entries_;
    std::unordered_map<std::string, std::list<Entry>::iterator> index_;
    std::size_t build_count_ = 0;
};

} // namespace vayu::http
