/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db_collections.cpp
 * @brief Collections: the tree, the trash (issue #988) and batch reorder
 * (issue #365) (issue #1614).
 */

#include "database_impl.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <expected>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/logger.hpp"

using namespace sqlite_orm;

namespace vayu::db {

// ============================================================================
// Collections - Folder structure for organizing requests
// ============================================================================

void Database::create_collection (const Collection& c) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug (
    "db", "Creating collection", { { "id", c.id }, { "name", c.name } });
    impl_->storage.replace (c);
}

std::vector<Collection> Database::get_collections () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // The tie rule is pinned to three keys, not left to the implicit rowid.
    // `INSERT OR REPLACE` on a TEXT primary key reassigns the rowid on every
    // edit, so a single-key ORDER BY let an unrelated rename silently reshuffle
    // a collection among its equal-`order` siblings - and the sidebar, the MCP
    // smoke tool and a scenario plan each saw a different shuffle. `created_at`
    // second matches what the renderer displays; `id` last makes the result a
    // total order even for rows written in the same millisecond. That last leg
    // compares random UUIDs, so it is stable across reads but arbitrary with
    // respect to the order the caller meant - which is why the contract puts
    // the duty on the writer (issue #565): anything producing several siblings
    // at once owes them distinct `order`s, as build_collection_rows and the
    // examples import already do. A finer timestamp was rejected: it still ties
    // under a fast enough writer, and it would make row identity depend on
    // clock resolution across three platforms. See the Ordering section of
    // docs/engine/api-reference.md. The renderer's comparator applies the
    // identical rule, pinned by tests/fixtures/tree-order-conformance.json.
    //
    // Deleted rows are excluded here rather than at each caller (issue #988):
    // this is what the sidebar, the MCP tools, every export and every plan
    // resolution read, and a filter one of them forgot is a ghost row
    // resurfacing in exactly one place.
    return impl_->storage.get_all<Collection> (where (is_null (&Collection::deleted_at)),
    multi_order_by (order_by (&Collection::order),
    order_by (&Collection::created_at), order_by (&Collection::id)));
}

std::optional<Collection> Database::get_collection (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto cols = impl_->storage.get_all<Collection> (
    where (c (&Collection::id) == id && is_null (&Collection::deleted_at)));
    if (cols.empty ())
        return std::nullopt;
    return cols.front ();
}

std::vector<std::string> Database::collection_subtree_locked (const std::string& root_id) {
    std::vector<std::string> subtree;
    std::unordered_set<std::string> visited;
    subtree.push_back (root_id);
    visited.insert (root_id);
    size_t idx = 0;
    while (idx < subtree.size ()) {
        auto children = impl_->storage.get_all<Collection> (
        where (c (&Collection::parent_id) == subtree[idx]));
        for (const auto& child : children) {
            if (visited.insert (child.id).second) {
                subtree.push_back (child.id);
            }
        }
        ++idx;
    }
    return subtree;
}

void Database::purge_collection_locked (const std::string& id) {
    const auto subtree = collection_subtree_locked (id);

    // Deepest-first so foreign-key integrity holds at each step, wrapped in a
    // single transaction so a crash mid-cascade cannot leave a half-deleted
    // subtree. Safe under the recursive mutex already held - the lambda only
    // calls sqlite_orm on the same storage handle (same pattern as
    // add_results_batch).
    impl_->storage.transaction ([&] {
        for (auto it = subtree.rbegin (); it != subtree.rend (); ++it) {
            // Examples first, and by request id rather than by collection: they
            // hang off the request, so deleting the requests before them would
            // leave rows no read can reach and no later delete can find.
            for (const auto& r : impl_->storage.get_all<Request> (
                 where (c (&Request::collection_id) == *it))) {
                impl_->storage.remove_all<RequestExample> (
                where (c (&RequestExample::request_id) == r.id));
            }
            impl_->storage.remove_all<Request> (
            where (c (&Request::collection_id) == *it));
            impl_->storage.remove_all<Collection> (where (c (&Collection::id) == *it));
        }
        return true; // Commit
    });

    // The cascade above is deliberately not a cascade *to* the document a
    // purged collection was bound to - several collections may bind one, so the
    // binding going away is not the document going away. It is the moment to
    // ask whether anything still holds it, though, and that is what the sweep
    // answers (issue #718). Outside the transaction: the subtree is gone either
    // way, and this must not be able to roll it back. Never throws; see the
    // declaration.
    sweep_orphaned_spec_documents ();
}

// Soft delete (issue #988): the subtree is stamped, not removed. Every read
// filters the stamp out, so the tree the user sees is the same tree a hard
// cascade left - but `GET /trash` can still find it, `POST /trash/:id/restore`
// can put it back, and only a purge (explicit, or retention at startup) is
// what finally destroys it.
void Database::delete_collection (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting collection (soft, cascade)", { { "id", id } });

    const auto subtree = collection_subtree_locked (id);

    // The stamp is this delete's cohort key, and a cohort has to be
    // distinguishable from an *earlier* delete inside the same subtree - that
    // is what stops restoring a collection from also resurrecting a request the
    // user deleted separately beforehand. Sharing a millisecond with such a row
    // would erase the distinction, so the one case where it can happen is
    // stepped over rather than left to chance.
    int64_t stamp = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                    .count ();
    const auto collides_with_an_earlier_delete = [&] (int64_t candidate) {
        for (const auto& collection_id : subtree) {
            if (impl_->storage.count<Collection> (where (c (&Collection::id) == collection_id &&
                c (&Collection::deleted_at) == candidate)) > 0) {
                return true;
            }
            if (impl_->storage.count<Request> (where (c (&Request::collection_id) == collection_id &&
                c (&Request::deleted_at) == candidate)) > 0) {
                return true;
            }
        }
        return false;
    };
    while (collides_with_an_earlier_delete (stamp)) {
        ++stamp;
    }

    // Only rows that are still live are stamped. A row an earlier delete
    // already took keeps that delete's stamp, so restoring this collection
    // leaves it in the trash - as its own root, since its owner is live again.
    impl_->storage.transaction ([&] {
        for (const auto& collection_id : subtree) {
            for (auto& request : impl_->storage.get_all<Request> (
                 where (c (&Request::collection_id) == collection_id &&
                 is_null (&Request::deleted_at)))) {
                request.deleted_at = stamp;
                impl_->storage.update (request);
            }
            for (auto& collection : impl_->storage.get_all<Collection> (where (
                 c (&Collection::id) == collection_id && is_null (&Collection::deleted_at)))) {
                collection.deleted_at = stamp;
                impl_->storage.update (collection);
            }
        }
        return true; // Commit
    });

    // No spec-document sweep here, deliberately: a stamped collection still
    // binds its document, and reclaiming it now would leave a restore pointing
    // at a document that is gone. The sweep runs on the purge instead.
}

// ============================================================================
// Trash - the rows soft delete stamped, and the three things one can do with
// them: look at them, put them back, destroy them (issue #988)
// ============================================================================

std::optional<TrashEntry> Database::trash_entry_locked (const std::string& id) {
    constexpr const char* STAMPED =
    "a row read under is_not_null(deleted_at) carries a stamp";

    auto collections = impl_->storage.get_all<Collection> (
    where (c (&Collection::id) == id && is_not_null (&Collection::deleted_at)));
    if (!collections.empty ()) {
        const auto& collection = collections.front ();
        const int64_t stamp = vayu::utils::invariant_value (collection.deleted_at, STAMPED);
        TrashEntry entry{ collection.id, "collection", collection.name, stamp,
            collection.parent_id, 0, 0 };
        // The counts are the *cohort's*, not the subtree's: what this delete
        // took is what restoring it puts back, and a row an earlier delete
        // already held is neither.
        for (const auto& descendant_id : collection_subtree_locked (collection.id)) {
            if (descendant_id != collection.id) {
                entry.collections += impl_->storage.count<Collection> (
                where (c (&Collection::id) == descendant_id &&
                c (&Collection::deleted_at) == stamp));
            }
            entry.requests += impl_->storage.count<Request> (
            where (c (&Request::collection_id) == descendant_id &&
            c (&Request::deleted_at) == stamp));
        }
        return entry;
    }

    auto requests = impl_->storage.get_all<Request> (
    where (c (&Request::id) == id && is_not_null (&Request::deleted_at)));
    if (!requests.empty ()) {
        const auto& request = requests.front ();
        return TrashEntry{ request.id, "request", request.name,
            vayu::utils::invariant_value (request.deleted_at, STAMPED),
            request.collection_id, 0, 0 };
    }
    return std::nullopt;
}

std::vector<TrashEntry> Database::get_trash () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    // "Is this row's owner deleted too?" is asked once per candidate, so the
    // owning table is read once here rather than once per question.
    std::unordered_map<std::string, bool> collection_is_deleted;
    for (const auto& [id, deleted_at] :
    impl_->storage.select (columns (&Collection::id, &Collection::deleted_at))) {
        collection_is_deleted[id] = deleted_at.has_value ();
    }
    // A row whose owner is missing entirely is a root as much as one whose owner
    // is live: there is nothing above it that a restore could come back under.
    const auto owner_is_deleted = [&] (const std::string& owner_id) {
        const auto it = collection_is_deleted.find (owner_id);
        return it != collection_is_deleted.end () && it->second;
    };
    const auto push_root = [&] (std::vector<TrashEntry>& into, const std::string& id) {
        if (auto entry = trash_entry_locked (id)) {
            into.push_back (std::move (*entry));
        }
    };

    std::vector<TrashEntry> entries;
    for (const auto& collection : impl_->storage.get_all<Collection> (
         where (is_not_null (&Collection::deleted_at)))) {
        if (collection.parent_id.has_value () && owner_is_deleted (*collection.parent_id)) {
            continue; // A cascade took it; its root is further up.
        }
        push_root (entries, collection.id);
    }
    for (const auto& request :
    impl_->storage.get_all<Request> (where (is_not_null (&Request::deleted_at)))) {
        if (owner_is_deleted (request.collection_id)) {
            continue;
        }
        push_root (entries, request.id);
    }

    // Newest first - what a trash view shows at the top - with `id` as the
    // tiebreak so a page of same-millisecond deletes is a total order rather
    // than whatever the two table scans happened to produce.
    std::sort (entries.begin (), entries.end (),
    [] (const TrashEntry& a, const TrashEntry& b) {
        return a.deleted_at != b.deleted_at ? a.deleted_at > b.deleted_at :
                                              a.id < b.id;
    });
    return entries;
}

std::expected<TrashOutcome, RestoreFailure> Database::restore_request_locked (
const TrashEntry& entry) {
    // A request has no root to come back to: `collection_id` is NOT NULL, so
    // "re-parent to the tree root" - what a collection does - is not a shape
    // this row has. Its owner going away is only reachable by deleting the
    // collection after the request, and the answer is the restore that *does*
    // work, named rather than guessed at.
    if (owner_is_absent_locked (entry.parent_id)) {
        const bool gone = !entry.parent_id.has_value () ||
        impl_->storage.count<Collection> (
        where (c (&Collection::id) == *entry.parent_id)) == 0;
        return std::unexpected (RestoreFailure{ RestoreRefusal::OwnerGone,
        "Request '" + entry.id + "' cannot be restored on its own - the collection it belongs to is " +
        (gone ? "gone" : "in the trash, so restore that first") });
    }

    impl_->storage.transaction ([&] {
        for (auto& request : impl_->storage.get_all<Request> (where (
             c (&Request::id) == entry.id && c (&Request::deleted_at) == entry.deleted_at))) {
            request.deleted_at.reset ();
            // A row trashed before the startup pass ever reached it (issue
            // #1491: trash is skipped there) gets the same disable-and-mark
            // treatment on the way back, rather than coming back exactly as
            // it went in.
            if (auto rewritten =
                vayu::http::strip_legacy_managed_headers (request.headers)) {
                request.headers = std::move (*rewritten);
            }
            impl_->storage.update (request);
        }
        return true; // Commit
    });
    vayu::utils::log_info ("db", "Restored request from trash", { { "id", entry.id } });
    return TrashOutcome{ entry, false };
}

TrashOutcome Database::restore_collection_locked (const TrashEntry& entry) {
    const auto subtree = collection_subtree_locked (entry.id);
    // Only the root can be orphaned: every other row in this walk has a parent
    // inside the same subtree, restored with it. Decided before the write so
    // the transaction below stays one pass over the cohort.
    const bool reparented = owner_is_absent_locked (entry.parent_id);

    impl_->storage.transaction ([&] {
        for (const auto& collection_id : subtree) {
            for (auto& request : impl_->storage.get_all<Request> (
                 where (c (&Request::collection_id) == collection_id &&
                 c (&Request::deleted_at) == entry.deleted_at))) {
                request.deleted_at.reset ();
                // See the same call in `restore_request_locked`: a row
                // trashed before the startup pass ever reached it comes back
                // through the same disable-and-mark treatment.
                if (auto rewritten =
                    vayu::http::strip_legacy_managed_headers (request.headers)) {
                    request.headers = std::move (*rewritten);
                }
                impl_->storage.update (request);
            }
            for (auto& collection : impl_->storage.get_all<Collection> (
                 where (c (&Collection::id) == collection_id &&
                 c (&Collection::deleted_at) == entry.deleted_at))) {
                collection.deleted_at.reset ();
                if (reparented && collection.id == entry.id) {
                    collection.parent_id.reset ();
                }
                impl_->storage.update (collection);
            }
        }
        return true; // Commit
    });

    vayu::utils::log_info ("db", "Restored collection from trash",
    { { "id", entry.id }, { "subCollections", entry.collections },
    { "requests", entry.requests }, { "reparented", reparented } });
    return TrashOutcome{ entry, reparented };
}

std::expected<TrashOutcome, RestoreFailure> Database::restore_deleted (
const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    // By id, not by root: a row a cascade took is restorable on its own - that
    // is what the re-parent rule is for - and only a row that is not deleted at
    // all is a 404.
    auto entry = trash_entry_locked (id);
    if (!entry) {
        return std::unexpected (RestoreFailure{
        RestoreRefusal::NotFound, "Nothing in the trash with id '" + id + "'" });
    }
    return entry->kind == "request" ?
    restore_request_locked (*entry) :
    std::expected<TrashOutcome, RestoreFailure>{ restore_collection_locked (*entry) };
}

std::optional<TrashOutcome> Database::purge_deleted (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    auto entry = trash_entry_locked (id);
    if (!entry) {
        return std::nullopt;
    }
    // The purge takes the whole subtree, stamp or no stamp - a row left under a
    // removed collection is reachable by no read and restorable by nothing, so
    // "the cohort" is the wrong unit here even though it is the right one for a
    // restore.
    if (entry->kind == "collection") {
        purge_collection_locked (id);
    } else {
        purge_request_locked (id);
    }
    vayu::utils::log_info (
    "db", "Purged item from trash", { { "kind", entry->kind }, { "id", id } });
    return TrashOutcome{ std::move (*entry), false };
}

int64_t Database::purge_expired_trash (int retention_days, int64_t now) {
    if (retention_days <= 0) {
        return 0; // Keep forever - the reading `runRetentionDays` gives 0.
    }
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    const int64_t cutoff =
    now - (static_cast<int64_t> (retention_days) * 24 * 60 * 60 * 1000);
    std::vector<std::pair<std::string, std::string>> expired; // (kind, id)
    for (const auto& entry : get_trash ()) {
        if (entry.deleted_at <= cutoff) {
            expired.emplace_back (entry.kind, entry.id);
        }
    }

    int64_t purged = 0;
    for (const auto& [kind, id] : expired) {
        // A root purged as part of an ancestor's subtree is already gone. It
        // cannot happen to a *root* by construction, but the walk below is what
        // says so rather than assuming it.
        if (kind == "collection") {
            if (impl_->storage.count<Collection> (where (c (&Collection::id) == id)) == 0) {
                continue;
            }
            purge_collection_locked (id);
        } else {
            if (impl_->storage.count<Request> (where (c (&Request::id) == id)) == 0) {
                continue;
            }
            purge_request_locked (id);
        }
        ++purged;
    }
    if (purged > 0) {
        vayu::utils::log_info ("db",
        "Purged " + std::to_string (purged) + " item(s) deleted more than " +
        std::to_string (retention_days) + " day(s) ago");
    }
    return purged;
}

int64_t Database::purge_expired_trash_configured () {
    const int retention_days = get_config_int (
    "trashRetentionDays", vayu::core::constants::database::TRASH_RETENTION_DAYS);
    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
    return purge_expired_trash (retention_days, now);
}

// ============================================================================
// Batch reorder - repositioned collections + requests in one transaction
// ============================================================================

// Same shape as import_apply: retry_on_busy holds the recursive mutex while the
// lambda runs, and the lambda only touches the same storage handle. Collections
// first so a request that moved into a collection this batch also reparented
// still lands after its owner's row.
//
// `update` behind an existence check rather than `replace` (issue #386): a
// reorder only repositions rows that already exist, so the upsert half of
// `replace` could only ever re-create a row something else deleted - silently,
// and inside a transaction the endpoint advertises as all-or-nothing. Throwing
// out of the transaction lambda leaves the guard uncommitted, so the rows
// updated before the missing one roll back with it.
void Database::apply_reorder (const std::vector<Collection>& collections,
const std::vector<Request>& requests) {
    if (collections.empty () && requests.empty ()) {
        return;
    }

    vayu::utils::log_debug ("db",
    "Applying reorder: " + std::to_string (collections.size ()) +
    " collections, " + std::to_string (requests.size ()) + " requests");

    retry_on_busy ("apply reorder", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            // A deleted row does not exist to this batch (issue #988): the
            // caller is repositioning the tree it can see, and writing the row
            // it named would both resurrect it - `update` carries the caller's
            // whole struct, `deleted_at` included - and move something nobody
            // is looking at.
            for (const auto& row : collections) {
                if (impl_->storage.count<Collection> (where (
                    c (&Collection::id) == row.id && is_null (&Collection::deleted_at))) == 0) {
                    throw MissingRowError ("Collection", row.id);
                }
                impl_->storage.update (row);
            }
            for (const auto& row : requests) {
                if (impl_->storage.count<Request> (where (
                    c (&Request::id) == row.id && is_null (&Request::deleted_at))) == 0) {
                    throw MissingRowError ("Request", row.id);
                }
                impl_->storage.update (row);
            }
            return true; // Commit
        });
    });
}

} // namespace vayu::db
