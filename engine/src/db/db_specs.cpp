/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db_specs.cpp
 * @brief OpenAPI documents (issue #637): storage, the orphan sweep (issue
 * #718), and the OpenAPI-sync transaction (issue #655) (issue #1614).
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
    // The binding is a JSON blob, so the match is made here rather than in SQL.
    // An unparseable blob binds nothing - the same reading every serializer
    // gives it - and must not make the spec undeletable.
    //
    // Deleted collections are excluded (issue #988): this backs the "N
    // collections still bind this document" refusal and the list beside it,
    // and a collection in the trash is not something a user can act on. The
    // *sweep* deliberately reads the unfiltered table instead - see there.
    for (auto& col :
    impl_->storage.get_all<Collection> (where (is_null (&Collection::deleted_at)))) {
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

/**
 * The `specId` a JSON blob names at @p path, or "" when it names none.
 *
 * One reader for both halves of the sweep's reference set, because the two
 * blobs disagree about where the id sits and about nothing else: a collection
 * writes `{specId, specHash, syncedAt}` at the root, a run's snapshot writes
 * the same identity under `scenario.openapi`. Unparseable text references
 * nothing - the reading every other reader of these two columns gives it, and
 * the one that cannot make a corrupt row pin a document forever.
 */
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

        // Cheapest question first, and each of the three below is asked only
        // when the one before it left something at stake. This pass rides on
        // every run completion, so what it costs when there is nothing to
        // reclaim - the ordinary case - is what it costs.
        //
        // 1. Which documents are even old enough to consider? Two columns and
        //    never `content`: that is the one column here that reaches
        //    `maxSpecDocumentBytes` (10 MiB by default), and this pass reads no
        //    byte of a document whose fate it is only deciding.
        const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                            .count ();
        const int64_t cutoff = now - vayu::core::constants::database::SPEC_DOCUMENT_SWEEP_GRACE_MS;

        std::vector<std::string> candidates;
        for (const auto& [id, fetched_at] : impl_->storage.select (
             columns (&SpecDocument::id, &SpecDocument::fetched_at))) {
            // A bind stores the document before the binding that names it, so a
            // document inside the window is a bind in flight - see the grace
            // constant.
            if (fetched_at <= cutoff) {
                candidates.push_back (id);
            }
        }
        if (candidates.empty ()) {
            return 0;
        }

        // 2. Which of those does a collection still bind? The same parse
        //    `get_collections_bound_to_spec` makes, once over the sidebar-sized
        //    table rather than once per candidate.
        //
        //    Unfiltered by `deleted_at`, unlike that reader (issue #988): a
        //    collection in the trash still binds its document, and reclaiming
        //    the document now would leave the restore pointing at nothing.
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

        // 3. And which does a retained run still name? Last, because it is the
        //    expensive read: `config_snapshot` is wide and there are up to
        //    `maxRunsRetained` of them.
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

// Write order is owner-before-referrer, exactly like import_apply, with one
// addition the other two batches do not need: the document lands before the
// binding that names it, so no reader can observe a collection pointing at a
// `spec_documents` row that is not there yet.
//
// The deletes run *before* the inserts. A sync that removes one operation's
// request and adds another cannot be allowed to depend on which order the
// caller listed them in, and an example refresh is expressed as "drop these
// imported rows, write these" - two halves of one replacement, where writing
// first would briefly double the list and, on a re-used id, lose the new row.
void Database::verify_spec_sync_rows_locked (const SpecSyncBatch& batch) {
    // Deleted rows are absent here too - same rule as `apply_reorder`, and the
    // same reason: an `update` carrying the caller's struct would clear the
    // stamp along with everything else (issue #988).
    if (impl_->storage.count<Collection> (where (
        c (&Collection::id) == batch.binding.id && is_null (&Collection::deleted_at))) == 0) {
        throw MissingRowError ("Collection", batch.binding.id);
    }
    for (const auto& row : batch.updated) {
        if (impl_->storage.count<Request> (where (
            c (&Request::id) == row.id && is_null (&Request::deleted_at))) == 0) {
            throw MissingRowError ("Request", row.id);
        }
    }
}

void Database::write_spec_sync_batch_locked (const SpecSyncBatch& batch) {
    // These deletes are **hard**, and stay hard now that every delete a person
    // makes is soft (issues #988, #1046 - owner decision). A sync is a
    // reconciliation to a document, not somebody removing a request, and it is
    // the one delete path whose removals are shown before they land: `POST
    // /specs/diff` reports each one, the app renders them as ticks to untick,
    // and `policy: "safe"` refuses deletions outright. Stamping them would fill
    // the trash with operations a document dropped, where restoring one puts
    // back a request the current document cannot explain. A caller that wants
    // them recoverable omits them here and calls `DELETE /requests/:id`.
    for (const auto& id : batch.deleted) {
        impl_->storage.remove_all<RequestExample> (
        where (c (&RequestExample::request_id) == id));
        impl_->storage.remove_all<Request> (where (c (&Request::id) == id));
    }
    for (const auto& id : batch.deleted_examples) {
        impl_->storage.remove_all<RequestExample> (where (c (&RequestExample::id) == id));
    }

    impl_->storage.replace (batch.spec);
    for (const auto& row : batch.new_collections) {
        impl_->storage.replace (row);
    }
    impl_->storage.update (batch.binding);
    for (const auto& row : batch.created) {
        impl_->storage.replace (row);
    }
    for (const auto& row : batch.updated) {
        impl_->storage.update (row);
    }
    for (const auto& row : batch.examples) {
        impl_->storage.replace (row);
    }
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
        impl_->storage.transaction ([&] {
            verify_spec_sync_rows_locked (batch);
            write_spec_sync_batch_locked (batch);
            return true; // Commit
        });
    });

    // The binding moved off whatever it named before, and a sync is the one
    // operation that does that on a schedule - weekly, for a document that may
    // be 12 MB (issue #718). Reclaimed here rather than left to the next
    // startup, and outside the retried transaction because the sync has already
    // succeeded and must not be undone by housekeeping. Never throws; see the
    // declaration.
    sweep_orphaned_spec_documents ();
}

} // namespace vayu::db
