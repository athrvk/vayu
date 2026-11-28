/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/// OpenAPI documents (#637): storage, the orphan sweep (#718) and the
/// OpenAPI-sync transaction (#655) (#1614).

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
#include "vayu/utils/logger.hpp"

using namespace sqlite_orm;

namespace vayu::db {

// ============================================================================
// Spec documents (issue #637)
// ============================================================================

void Database::save_spec_document (const SpecDocument& s) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug (
    "db", "Saving spec document", { { "id", s.id }, { "hash", s.hash } });
    impl_->storage.replace (s);
}

std::optional<SpecDocument> Database::get_spec_document (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows =
    impl_->storage.get_all<SpecDocument> (where (c (&SpecDocument::id) == id));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

std::vector<Collection> Database::get_collections_bound_to_spec (const std::string& spec_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    std::vector<Collection> bound;
    if (spec_id.empty ()) {
        return bound;
    }
    // The binding is a JSON blob, so the match is made here, not in SQL. An
    // unparseable blob binds nothing (every serializer's reading) and must not
    // make the spec undeletable.
    //
    // Trashed collections count (#3446): a restore brings the binding back,
    // which would then name a deleted document.
    for (auto& col : impl_->storage.get_all<Collection> ()) {
        try {
            const auto parsed = nlohmann::json::parse (col.openapi);
            if (parsed.is_object () && parsed.value ("specId", std::string ()) == spec_id) {
                bound.push_back (std::move (col));
            }
        } catch (const std::exception&) {
            continue;
        }
    }
    return bound;
}

void Database::delete_spec_document (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting spec document", { { "id", id } });
    impl_->storage.remove_all<SpecDocument> (where (c (&SpecDocument::id) == id));
}

namespace {

/// The `specId` a JSON blob names at @p path, or "" for none. One reader for
/// both halves of the sweep's reference set, since the two blobs differ only in
/// where the id sits: a collection writes `{specId, specHash, syncedAt}` at the
/// root, a run's snapshot the same identity under `scenario.openapi`.
/// Unparseable text references nothing, every other reader's reading, and the
/// one that cannot let a corrupt row pin a document forever.
std::string spec_id_at (const std::string& blob, std::initializer_list<const char*> path) {
    try {
        auto node = nlohmann::json::parse (blob);
        for (const char* key : path) {
            if (!node.is_object ()) {
                return {};
            }
            const auto it = node.find (key);
            if (it == node.end ()) {
                return {};
            }
            node = *it;
        }
        if (!node.is_object ()) {
            return {};
        }
        return node.value ("specId", std::string ());
    } catch (const std::exception&) {
        return {};
    }
}

} // namespace

size_t Database::sweep_orphaned_spec_documents () {
    try {
        std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

        // Cheapest question first, each of the three asked only when the one
        // before left something at stake: this pass rides every run completion,
        // so its cost when there is nothing to reclaim, the ordinary case, is
        // its cost.
        //
        // 1. Which documents are old enough to consider? Two columns and never
        //    `content`, the one column here reaching `maxSpecDocumentBytes` (10
        //    MiB by default): this pass reads no byte of a document whose fate
        //    it is only deciding.
        const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                            .count ();
        const int64_t cutoff = now - vayu::core::constants::database::SPEC_DOCUMENT_SWEEP_GRACE_MS;

        std::vector<std::string> candidates;
        for (const auto& [id, fetched_at] : impl_->storage.select (
             columns (&SpecDocument::id, &SpecDocument::fetched_at))) {
            // A bind stores the document before the binding naming it, so a
            // document inside the window is a bind in flight (the grace
            // constant).
            if (fetched_at <= cutoff) {
                candidates.push_back (id);
            }
        }
        if (candidates.empty ()) {
            return 0;
        }

        // 2. Which does a collection still bind?
        //    `get_collections_bound_to_spec`'s parse, once over the
        //    sidebar-sized table, not once per candidate.
        //
        // Unfiltered by `deleted_at`, as that reader is (#988, #3446): a
        // trashed collection still binds its document, and reclaiming it would
        // leave the restore pointing at nothing.
        std::unordered_set<std::string> referenced;
        for (const auto& binding : impl_->storage.select (&Collection::openapi)) {
            auto spec_id = spec_id_at (binding, {});
            if (!spec_id.empty ()) {
                referenced.insert (std::move (spec_id));
            }
        }
        std::erase_if (candidates,
        [&] (const std::string& id) { return referenced.count (id) > 0; });
        if (candidates.empty ()) {
            return 0;
        }

        // 3. Which does a retained run still name? Last, as the expensive read:
        //    `config_snapshot` is wide, and there are up to `maxRunsRetained`
        //    plus `maxDesignRunsRetained` of them.
        std::unordered_set<std::string> pinned;
        for (const auto& snapshot : impl_->storage.select (&Run::config_snapshot)) {
            auto spec_id = spec_id_at (snapshot, { "scenario", "openapi" });
            if (!spec_id.empty ()) {
                pinned.insert (std::move (spec_id));
            }
        }
        std::erase_if (candidates,
        [&] (const std::string& id) { return pinned.count (id) > 0; });
        if (candidates.empty ()) {
            return 0;
        }

        // What survived all three questions is unreachable by definition.
        impl_->storage.transaction ([&] {
            for (const auto& id : candidates) {
                impl_->storage.remove_all<SpecDocument> (
                where (c (&SpecDocument::id) == id));
            }
            return true; // Commit
        });

        vayu::utils::log_info ("db",
        "Swept " + std::to_string (candidates.size ()) +
        " OpenAPI document(s) no collection binds and no retained run names");
        return candidates.size ();
    } catch (const std::exception& e) {
        // Best-effort by contract - see the header for why a caller must not
        // fail over this.
        vayu::utils::log_warning (
        "db", "OpenAPI document sweep failed: " + std::string (e.what ()));
        return 0;
    }
}

// ============================================================================
// Spec sync - the write half of an OpenAPI sync, in one transaction (#655)
// ============================================================================

// Owner-before-referrer write order, as import_apply, plus one rule the other
// two batches do not need: the document lands before the binding naming it, so
// no reader sees a collection pointing at a `spec_documents` row not there yet.
//
// Deletes run *before* inserts. A sync removing one operation's request and
// adding another must not depend on the caller's listing order, and an example
// refresh is "drop these imported rows, write these", two halves of one
// replacement, where writing first would briefly double the list and, on a
// reused id, lose the new row.
void Database::verify_spec_sync_rows_locked (const SpecSyncBatch& batch) {
    // Deleted rows are absent here too, as in `apply_reorder` and for its
    // reason: an `update` carrying the caller's struct would clear the stamp
    // with everything else (#988).
    if (impl_->storage.count<Collection> (where (
        c (&Collection::id) == batch.binding.id && is_null (&Collection::deleted_at))) == 0) {
        throw MissingRowError ("Collection", batch.binding.id);
    }
    verify_live_requests_locked (batch.updated);
}

std::vector<Change> Database::write_spec_sync_batch_locked (const SpecSyncBatch& batch) {
    std::vector<Change> written;
    // These deletes are **hard**, while every delete a person makes is soft
    // (#988, #1046, owner decision). A sync reconciles to a document rather
    // than removing a request, and its removals are the only ones shown before
    // they land: `POST /specs/diff` reports each, the app renders them as ticks
    // to untick, and `policy: "safe"` refuses deletions. Stamping them would
    // fill the trash with operations a document dropped, where a restore puts
    // back a request the current document cannot explain. A caller wanting them
    // recoverable omits them and calls `DELETE /requests/:id`. For the same
    // reason they record no declined operation (#3031): the document dropped
    // it, nobody declined it.
    purge_batch_requests_locked (batch.deleted, written);
    for (const auto& id : batch.deleted_examples) {
        for (auto& owner : impl_->storage.select (&RequestExample::request_id,
             where (c (&RequestExample::id) == id))) {
            written.push_back (Change{ ChangeKind::Example, ChangeOp::Purge, id,
            std::nullopt, std::move (owner) });
        }
        impl_->storage.remove_all<RequestExample> (where (c (&RequestExample::id) == id));
    }
    for (const auto id : batch.cleared_declines) {
        impl_->storage.remove_all<DeclinedOperation> (
        where (c (&DeclinedOperation::id) == id));
    }

    impl_->storage.replace (batch.spec);
    for (const auto& row : batch.new_collections) {
        written.push_back (
        collection_change (row, upsert_op<Collection> (impl_->storage, row.id)));
        impl_->storage.replace (row);
    }
    impl_->storage.update (batch.binding);
    written.push_back (collection_change (batch.binding, ChangeOp::Update));
    for (const auto& row : batch.created) {
        written.push_back (
        request_change (row, upsert_op<Request> (impl_->storage, row.id)));
        impl_->storage.replace (row);
    }
    for (const auto& row : batch.updated) {
        impl_->storage.update (row);
        written.push_back (request_change (row, ChangeOp::Update));
    }
    for (const auto& row : batch.examples) {
        written.push_back (
        example_change (row, upsert_op<RequestExample> (impl_->storage, row.id)));
        impl_->storage.replace (row);
    }
    return written;
}

void Database::spec_sync_apply (const SpecSyncBatch& batch) {
    // "spec write" rather than "sync": `POST /specs/bind` commits through this
    // same batch (issue #862), with its create and delete halves empty.
    vayu::utils::log_debug ("db", "Applying spec write",
    { { "collection", batch.binding.id }, { "spec", batch.spec.id },
    { "created", batch.created.size () }, { "updated", batch.updated.size () },
    { "deleted", batch.deleted.size () },
    { "newCollections", batch.new_collections.size () } });

    retry_on_busy ("apply spec sync", 5, std::chrono::milliseconds (100), [&] {
        std::vector<Change> written;
        impl_->storage.transaction ([&] {
            verify_spec_sync_rows_locked (batch);
            written = write_spec_sync_batch_locked (batch);
            return true; // Commit
        });
        changes_.publish (std::move (written));
    });

    // The binding moved off what it named, and a sync is the one operation that
    // does so on a schedule (weekly, for a document that may be 12 MB, #718).
    // Reclaimed here, not at the next startup, and outside the retried
    // transaction, because the sync has succeeded and housekeeping must not
    // undo it. Never throws; see the declaration.
    sweep_orphaned_spec_documents ();
}

} // namespace vayu::db
