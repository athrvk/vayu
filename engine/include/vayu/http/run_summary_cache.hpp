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
 * @brief What a `GET /runs` row derives from stored JSON, kept between calls.
 *
 * `GET /runs` is the polled endpoint (issue #1150): the history sidebar, the
 * welcome screen and the command palette each re-ask every 5 seconds while they
 * are on screen. Two parts of a row are rebuilt from a stored JSON column, and
 * each is kept here in its own bounded, run-id-keyed table:
 *
 * - **The compact `summary`**, built from `config_snapshot`. Every call used to
 *   re-parse it - one JSON parse per row, so 50 a tick at the default page size
 *   and up to 500 at the largest the route allows, all producing what the
 *   previous tick already produced.
 * - **A load or collection run's `resultSummary`** (#2130, #2954), built from
 *   the stored run `summary`, the whole-run results that are far larger than
 *   the snapshot.
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
 * **A run's stored `summary` is write-once too, but only from terminal status
 * on.** Its three writers (`Database::update_run_summary`, called from
 * `run_manager.cpp`'s finish and failure paths and from `scenario_runner.cpp`)
 * each store it *before* the terminal status, so a row read with a terminal
 * status already holds its final summary - or none, when that write failed or
 * the run never got far enough to make one. The exception is a stop that finds
 * no registered worker: it writes Stopped with an empty summary and the worker
 * stores its own afterwards. A Pending or Running row's summary is not final,
 * and neither is an empty one, so `outcome_for` must only be asked about a
 * terminal run that holds a summary.
 *
 * **Threading: one mutex per table, held only around that table** - the same
 * discipline `CookieJar` runs on, and deliberately *not* the database mutex,
 * which `/health`, this poll and SSE all serialize on (see
 * `Database::with_lock`). A `build` callable runs under the table's mutex, so
 * it only parses the string it was handed: it must never touch the database.
 * Both lookups return a copy, so no reference into the storage escapes the
 * lock and a caller cannot read an entry another thread is evicting.
 */
class RunSummaryCache {
    public:
    /// Two full pages of the largest `limit` the route allows (500), so one
    /// page can never evict rows of the page it is serializing, and a client
    /// that pages back and forth still finds its recent rows warm.
    static constexpr std::size_t DEFAULT_CAPACITY = 1000;

    explicit RunSummaryCache (std::size_t capacity = DEFAULT_CAPACITY)
    : summaries_ (capacity), outcomes_ (capacity) {
    }

    /**
     * @brief The compact summary for @p run_id, calling @p build only on a miss.
     * @param run_id  The run whose summary is wanted.
     * @param build   Builds the summary from the run's `config_snapshot`;
     *                invoked at most once per run id for as long as the entry
     *                survives eviction.
     * @return A copy of the cached summary.
     */
    template <typename Build>
    nlohmann::json summary_for (const std::string& run_id, Build&& build) {
        return summaries_.get_or_build (run_id, std::forward<Build> (build));
    }

    /**
     * @brief A terminal load or collection run's `resultSummary`, calling
     *        @p build only on a miss.
     * @param run_id  A run whose status is Completed, Failed or Stopped; see
     *                the class comment for why nothing earlier may be cached.
     * @param build   Builds the outcome from the run's stored `summary`;
     *                invoked at most once per run id for as long as the entry
     *                survives eviction.
     * @return A copy of the cached outcome.
     */
    template <typename Build>
    nlohmann::json outcome_for (const std::string& run_id, Build&& build) {
        return outcomes_.get_or_build (run_id, std::forward<Build> (build));
    }

    /// How many compact summaries are held. Never above the configured capacity.
    std::size_t size () const {
        return summaries_.size ();
    }

    /// How many times a compact summary has actually been built. The seam the
    /// tests assert on: a poll that re-parses nothing leaves this unchanged.
    std::size_t build_count () const {
        return summaries_.build_count ();
    }

    /// The same seam for load and collection run outcomes, counted apart so a
    /// test of either table is not thrown off by the other.
    std::size_t outcome_build_count () const {
        return outcomes_.build_count ();
    }

    private:
    /// One bounded least-recently-used table of JSON values by run id.
    class Table {
        public:
        explicit Table (std::size_t capacity)
        : capacity_ (capacity == 0 ? 1 : capacity) {
        }

        template <typename Build>
        nlohmann::json get_or_build (const std::string& run_id, Build&& build) {
            const std::lock_guard<std::mutex> lock (mutex_);

            if (const auto found = index_.find (run_id); found != index_.end ()) {
                // Most recently used goes to the front; the back is what evicts.
                entries_.splice (entries_.begin (), entries_, found->second);
                return found->second->second;
            }

            nlohmann::json value = std::forward<Build> (build) ();
            ++build_count_;
            entries_.emplace_front (run_id, value);
            index_[run_id] = entries_.begin ();

            while (entries_.size () > capacity_) {
                index_.erase (entries_.back ().first);
                entries_.pop_back ();
            }
            return value;
        }

        std::size_t size () const {
            const std::lock_guard<std::mutex> lock (mutex_);
            return index_.size ();
        }

        std::size_t build_count () const {
            const std::lock_guard<std::mutex> lock (mutex_);
            return build_count_;
        }

        private:
        mutable std::mutex mutex_;
        std::size_t capacity_;

        /// Front is most recently used. The map holds iterators into this
        /// list, which `std::list` keeps valid across every insertion and
        /// every erase but its own.
        using Entry = std::pair<std::string, nlohmann::json>;
        std::list<Entry> entries_;
        std::unordered_map<std::string, std::list<Entry>::iterator> index_;
        std::size_t build_count_ = 0;
    };

    Table summaries_;
    Table outcomes_;
};

} // namespace vayu::http
