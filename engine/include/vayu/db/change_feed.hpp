#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db/change_feed.hpp
 * @brief What `GET /changes` relays (issue #3420): one event per committed
 *        write to the workspace rows a client caches, in a bounded ring.
 *
 * `Database` owns the feed and is its only producer: every public write of a
 * collection, request, example, environment, the globals or a trash entry
 * publishes after its own transaction has committed, so an event never names
 * a write that rolled back. No write runs inside another's transaction, and
 * `with_lock` opens none, so "after its own commit" is "committed".
 *
 * Publishing is an append under the feed's own mutex, a leaf lock: it is taken
 * with the DB mutex held, so events are numbered in commit order, and nothing
 * holding it takes the DB mutex or touches a socket.
 */

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/core/constants.hpp"

namespace vayu::db {

/// Which row an event names. The wire spellings are `GET /trash`'s `kind`s.
enum class ChangeKind : std::uint8_t {
    Collection,
    Request,
    Example,
    Environment,
    Globals,
    /// Only for what changes the trash: a delete, a restore, a purge. A
    /// certificate's create and update are not workspace rows a client caches
    /// from this feed.
    ClientCertificate,
};

/// What happened to it.
enum class ChangeOp : std::uint8_t {
    Create,
    Update,
    /// Gone from every live read: moved to the trash, or an imported example
    /// kept as a tombstone.
    Delete,
    /// Back from the trash.
    Restore,
    /// Destroyed for good: from the trash, by retention, or a spec sync's hard
    /// delete of a live request.
    Purge,
};

[[nodiscard]] const char* to_string (ChangeKind kind);
[[nodiscard]] const char* to_string (ChangeOp op);

/// The kind a trash entry's `kind` names. Throws `std::logic_error` on one it
/// does not know, the rule `purge_trash_entry_locked` dispatches by.
[[nodiscard]] ChangeKind change_kind_of_trash_entry (std::string_view trash_kind);

/**
 * One committed write. A cascade is one change on the row the caller named:
 * deleting, restoring or purging a collection names the collection, and the
 * sub-folders, requests and examples that went or came with it ride on it.
 */
struct Change {
    ChangeKind kind = ChangeKind::Collection;
    ChangeOp op     = ChangeOp::Update;
    std::string id;
    /// The collection the row sits in: a request's owner, a sub-folder's
    /// parent. Absent for a root collection and for every other kind.
    std::optional<std::string> collection_id;
    /// An example's request. Absent for every other kind.
    std::optional<std::string> request_id;
};

/// `{kind, id, op, collectionId?, requestId?}`, the `data` of a `change` frame.
[[nodiscard]] nlohmann::json change_json (const Change& change);

/// A change and the feed id it was published under.
struct ChangeEvent {
    int64_t id = 0;
    Change change;
};

/**
 * The bounded ring of published changes, and how many streams read it.
 *
 * Ids are contiguous and increase by one per event, from a base the owner
 * chooses: `Database` takes the start time in microseconds, so an id a client
 * kept from an earlier engine process is below every id this one hands out,
 * and its resume answers `reset` instead of replaying the wrong process's
 * events. Microseconds since 1970 stay below 2^53 until the 23rd century, so
 * an id is exact as a JavaScript number.
 */
class ChangeFeed {
    public:
    /// @param id_base the id `last_id ()` answers before anything is
    ///        published; the first event is `id_base + 1`.
    /// @param capacity events retained, at least one.
    explicit ChangeFeed (int64_t id_base,
    std::size_t capacity = vayu::core::constants::change_feed::MAX_RETAINED_EVENTS);

    /// Append @p change, evicting the oldest event once the ring is full.
    void publish (Change change);
    /// Append every one of @p changes under one acquisition, so a bulk write's
    /// events are numbered contiguously.
    void publish (std::vector<Change> changes);

    /// What a reader that has seen everything up to @p after_id is owed.
    struct Read {
        /// The events after @p after_id, oldest first. Empty on a reset.
        std::vector<ChangeEvent> events;
        /// The newest id published, where the reader stands once it has
        /// taken this read.
        int64_t last_id = 0;
        /// The events after @p after_id are not all retained (evicted, or
        /// @p after_id is not one this feed issued): the reader must refetch
        /// everything and continue from `last_id`.
        bool reset = false;
    };
    [[nodiscard]] Read since (int64_t after_id) const;

    /// The newest id published, or the base when nothing has been.
    [[nodiscard]] int64_t last_id () const;

    /// Take one of `MAX_READERS` stream slots; false when all are held.
    [[nodiscard]] bool try_add_reader ();
    /// Give back a slot `try_add_reader` took.
    void remove_reader ();

    private:
    void append_locked (Change change);

    const std::size_t capacity_;
    mutable std::mutex mutex_;
    /// Guarded by `mutex_`; ids contiguous, the newest at the back.
    std::deque<ChangeEvent> ring_;
    /// Guarded by `mutex_`.
    int64_t last_id_ = 0;
    std::atomic<int> readers_{ 0 };
};

/// The id base `Database` constructs its feed with: now, in microseconds.
[[nodiscard]] int64_t change_feed_id_base_now ();

} // namespace vayu::db
