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
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/json.hpp"
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
    const ChangeOp op = upsert_op<Collection> (impl_->storage, c.id);
    impl_->storage.replace (c);
    changes_.publish (collection_change (c, op));
}

void Database::rebind_collection (const Collection& collection) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Rebinding collection", { { "id", collection.id } });
    const ChangeOp op = upsert_op<Collection> (impl_->storage, collection.id);
    impl_->storage.transaction ([&] {
        impl_->storage.replace (collection);
        impl_->storage.remove_all<DeclinedOperation> (
        where (c (&DeclinedOperation::collection_id) == collection.id));
        return true; // Commit
    });
    changes_.publish (collection_change (collection, op));
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
    // docs/engine/api-reference.md. This is the within-kind half of the
    // sibling order in vayu/db/sibling_order.hpp, which ranks a sub-folder
    // and a request against each other (#2535); the renderer's comparator
    // applies the same rule, pinned by tests/fixtures/tree-order-conformance.json.
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

int Database::next_sibling_order (const std::optional<std::string>& parent_id,
const std::string& excluded_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    int highest      = -1;
    const auto raise = [&highest] (const std::unique_ptr<int>& found) {
        if (found) {
            highest = std::max (highest, *found);
        }
    };
    if (!parent_id) {
        raise (impl_->storage.max (&Collection::order,
        where (c (&Collection::id) != excluded_id &&
        is_null (&Collection::parent_id) && is_null (&Collection::deleted_at))));
        return highest + 1;
    }
    raise (impl_->storage.max (&Collection::order,
    where (c (&Collection::id) != excluded_id &&
    c (&Collection::parent_id) == *parent_id && is_null (&Collection::deleted_at))));
    raise (impl_->storage.max (&Request::order,
    where (c (&Request::id) != excluded_id &&
    c (&Request::collection_id) == *parent_id && is_null (&Request::deleted_at))));
    return highest + 1;
}

bool Database::collection_is_trashed (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<Collection> (where (c (&Collection::id) == id &&
           is_not_null (&Collection::deleted_at))) > 0;
}

namespace {

/// The breadth-first walk behind every "subtree" read: @p root_id first, then
/// what `children_of (id)` answers for each id reached, each id once. The
/// visited set is load-bearing (see `collection_subtree_locked`). The walk is
/// one definition with two sources: the table, one statement per node, and the
/// rows the trash listing has already read (#2972).
template <typename ChildrenOf>
std::vector<std::string>
walk_subtree (const std::string& root_id, const ChildrenOf& children_of) {
    std::vector<std::string> subtree{ root_id };
    std::unordered_set<std::string> visited{ root_id };
    for (size_t idx = 0; idx < subtree.size (); ++idx) {
        for (const auto& child : children_of (subtree[idx])) {
            if (visited.insert (child).second) {
                subtree.push_back (child);
            }
        }
    }
    return subtree;
}

} // namespace

std::vector<std::string>
Database::collection_subtree_locked (const std::string& root_id, SubtreeRows rows) {
    return walk_subtree (root_id, [this, rows] (const std::string& parent_id) {
        std::vector<std::string> children;
        for (const auto& [id, deleted_at] :
        impl_->storage.select (columns (&Collection::id, &Collection::deleted_at),
        where (c (&Collection::parent_id) == parent_id))) {
            if (rows == SubtreeRows::StampedOnly && !deleted_at.has_value ()) {
                continue;
            }
            children.push_back (id);
        }
        return children;
    });
}

void Database::purge_collection_locked (const std::string& id) {
    // Stamped rows only (#1883): a live collection under a stamped one was
    // never listed in the trash, so destroying it would be a delete nobody
    // asked for. It stops the walk and goes to the root instead.
    const auto subtree = collection_subtree_locked (id, SubtreeRows::StampedOnly);

    // Deepest-first so foreign-key integrity holds at each step, wrapped in a
    // single transaction so a crash mid-cascade cannot leave a half-deleted
    // subtree. Safe under the recursive mutex already held - the lambda only
    // calls sqlite_orm on the same storage handle (same pattern as
    // spec_sync_apply).
    impl_->storage.transaction ([&] {
        for (const auto& collection_id : subtree) {
            for (auto& spared : impl_->storage.get_all<Collection> (
                 where (c (&Collection::parent_id) == collection_id &&
                 is_null (&Collection::deleted_at)))) {
                vayu::utils::log_warning ("db", "Purge re-parented a live collection to the root",
                { { "id", spared.id }, { "purgedParent", collection_id } });
                spared.parent_id.reset ();
                impl_->storage.update (spared);
            }
        }
        for (auto it = subtree.rbegin (); it != subtree.rend (); ++it) {
            // Examples first, and by request id rather than by collection: they
            // hang off the request, so deleting the requests before them would
            // leave rows no read can reach and no later delete can find.
            for (const auto& request_id : impl_->storage.select (
                 &Request::id, where (c (&Request::collection_id) == *it))) {
                impl_->storage.remove_all<RequestExample> (
                where (c (&RequestExample::request_id) == request_id));
            }
            impl_->storage.remove_all<Request> (
            where (c (&Request::collection_id) == *it));
            // A purged bound collection's declined operations go with it; the
            // records of a purged *request* stay, the decision outliving the
            // row it was made on (#3031).
            impl_->storage.remove_all<DeclinedOperation> (
            where (c (&DeclinedOperation::collection_id) == *it));
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
void Database::delete_collection (const std::string& id,
const std::optional<std::string>& declined_under) {
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
    // The cascade publishes one change, on the root, and only when this call
    // stamps it: a root already in the trash changes nothing.
    const auto live_root = impl_->storage.get_all<Collection> (
    where (c (&Collection::id) == id && is_null (&Collection::deleted_at)));
    impl_->storage.transaction ([&] {
        for (const auto& collection_id : subtree) {
            for (auto& request : impl_->storage.get_all<Request> (
                 where (c (&Request::collection_id) == collection_id &&
                 is_null (&Request::deleted_at)))) {
                request.deleted_at = stamp;
                impl_->storage.update (request);
                // Only the rows this delete stamps: one an earlier delete took
                // recorded its own decision then, or none.
                if (declined_under) {
                    record_declined_operation_locked (*declined_under, request);
                }
            }
            for (auto& collection : impl_->storage.get_all<Collection> (where (
                 c (&Collection::id) == collection_id && is_null (&Collection::deleted_at)))) {
                collection.deleted_at = stamp;
                impl_->storage.update (collection);
            }
        }
        return true; // Commit
    });
    if (!live_root.empty ()) {
        changes_.publish (collection_change (live_root.front (), ChangeOp::Delete));
    }

    // No spec-document sweep here, deliberately: a stamped collection still
    // binds its document, and reclaiming it now would leave a restore pointing
    // at a document that is gone. The sweep runs on the purge instead.
}

// ============================================================================
// Trash - the rows soft delete stamped, and the three things one can do with
// them: look at them, put them back, destroy them (issue #988)
// ============================================================================

namespace {

constexpr const char* STAMPED =
"a row read under is_not_null(deleted_at) carries a stamp";

// Each kind's entry is built from the columns it shows and nothing else, so
// neither the listing nor a restore loads a body, a script or a header blob
// to name a row (#2972). Where a builder takes clauses they say which rows.

/// An entry with what only some kinds carry left at its default: no counts, no
/// variables, no owner name.
TrashEntry entry_of (std::string id,
const char* kind,
std::string name,
const std::optional<int64_t>& deleted_at,
std::optional<std::string> parent_id) {
    TrashEntry entry;
    entry.id         = std::move (id);
    entry.kind       = kind;
    entry.name       = std::move (name);
    entry.deleted_at = vayu::utils::invariant_value (deleted_at, STAMPED);
    entry.parent_id  = std::move (parent_id);
    return entry;
}

template <typename... Clauses>
std::vector<TrashEntry> request_entries (Storage& storage, Clauses&&... clauses) {
    std::vector<TrashEntry> entries;
    for (auto& [id, name, collection_id, deleted_at] : storage.select (
         columns (&Request::id, &Request::name, &Request::collection_id, &Request::deleted_at),
         std::forward<Clauses> (clauses)...)) {
        entries.push_back (entry_of (std::move (id), "request",
        std::move (name), deleted_at, std::move (collection_id)));
    }
    return entries;
}

template <typename... Clauses>
std::vector<TrashEntry> environment_entries (Storage& storage, Clauses&&... clauses) {
    std::vector<TrashEntry> entries;
    for (auto& [id, name, variables, deleted_at] :
    storage.select (columns (&Environment::id, &Environment::name,
                    &Environment::variables, &Environment::deleted_at),
    std::forward<Clauses> (clauses)...)) {
        // Counted through the reader composition uses, so the number is the
        // variables a restore gives back to every `{{name}}` that names one.
        auto entry = entry_of (std::move (id), "environment", std::move (name),
        deleted_at, std::nullopt);
        entry.variables =
        static_cast<int64_t> (vayu::json::parse_variables (variables).size ());
        entries.push_back (std::move (entry));
    }
    return entries;
}

/// The one example, stamped, that @p id names: its owner's name is the
/// caller's to look up, because the request row may be gone.
std::optional<TrashEntry> example_entry (Storage& storage, const std::string& id) {
    auto rows = storage.select (
    columns (&RequestExample::name, &RequestExample::request_id, &RequestExample::deleted_at),
    where (c (&RequestExample::id) == id && is_not_null (&RequestExample::deleted_at)));
    if (rows.empty ()) {
        return std::nullopt;
    }
    auto& [name, request_id, deleted_at] = rows.front ();
    return entry_of (id, "example", std::move (name), deleted_at, std::move (request_id));
}

/// Every stamped example under a live request, named by that request: the
/// join keeps neither one under a trashed request, which is part of that
/// request's entry, nor one whose request row is gone, which has nothing to
/// come back under (#2971) - the rule `request_is_absent_locked` states.
std::vector<TrashEntry> listed_example_entries (Storage& storage) {
    std::vector<TrashEntry> entries;
    for (auto& [id, name, request_id, deleted_at, request_name] :
    storage.select (columns (&RequestExample::id, &RequestExample::name,
                    &RequestExample::request_id, &RequestExample::deleted_at, &Request::name),
    inner_join<Request> (on (c (&Request::id) == &RequestExample::request_id)),
    where (and_ (is_not_null (&RequestExample::deleted_at), is_null (&Request::deleted_at))))) {
        auto entry = entry_of (std::move (id), "example", std::move (name),
        deleted_at, std::move (request_id));
        entry.parent_name = std::move (request_name);
        entries.push_back (std::move (entry));
    }
    return entries;
}

template <typename... Clauses>
std::vector<TrashEntry> client_certificate_entries (Storage& storage, Clauses&&... clauses) {
    std::vector<TrashEntry> entries;
    for (auto& [id, host, port, deleted_at] :
    storage.select (columns (&ClientCertificate::id, &ClientCertificate::host,
                    &ClientCertificate::port, &ClientCertificate::deleted_at),
    std::forward<Clauses> (clauses)...)) {
        // Named by its target, which is how the Settings card and a trace name
        // it too; `?q=` matches that.
        entries.push_back (entry_of (std::move (id), "clientCertificate",
        vayu::http::client_cert_label (host, port), deleted_at, std::nullopt));
    }
    return entries;
}

std::optional<TrashEntry> first_entry (std::vector<TrashEntry> entries) {
    if (entries.empty ()) {
        return std::nullopt;
    }
    return std::move (entries.front ());
}

/// Every collection's place in the tree and its stamp, plus how many stamped
/// requests each collection holds per stamp: what a collection entry's cohort
/// counts are computed from. Read in a fixed number of statements however
/// many folders a trashed subtree holds (#2972).
struct TrashGraph {
    struct Node {
        std::string name;
        std::optional<std::string> parent_id;
        std::optional<int64_t> deleted_at;
    };
    std::unordered_map<std::string, Node> collections;
    std::unordered_map<std::string, std::vector<std::string>> children;
    /// collection id -> stamp -> how many requests carry it there.
    std::unordered_map<std::string, std::unordered_map<int64_t, int64_t>> stamped_requests;

    const std::vector<std::string>& children_of (const std::string& id) const {
        static const std::vector<std::string> none;
        const auto it = children.find (id);
        return it == children.end () ? none : it->second;
    }

    void count_stamped_request (const std::string& collection_id, int64_t stamp) {
        ++stamped_requests[collection_id][stamp];
    }

    int64_t stamped_requests_in (const std::string& collection_id, int64_t stamp) const {
        const auto by_collection = stamped_requests.find (collection_id);
        if (by_collection == stamped_requests.end ()) {
            return 0;
        }
        const auto by_stamp = by_collection->second.find (stamp);
        return by_stamp == by_collection->second.end () ? 0 : by_stamp->second;
    }

    /// Every stamped request in @p collection_id, whichever delete stamped it.
    int64_t stamped_requests_in (const std::string& collection_id) const {
        const auto by_collection = stamped_requests.find (collection_id);
        if (by_collection == stamped_requests.end ()) {
            return 0;
        }
        int64_t total = 0;
        for (const auto& [stamp, count] : by_collection->second) {
            total += count;
        }
        return total;
    }

    /// @p id's stamped children: the step `SubtreeRows::StampedOnly` takes.
    std::vector<std::string> stamped_children_of (const std::string& id) const {
        std::vector<std::string> stamped;
        for (const auto& child : children_of (id)) {
            if (collections.at (child).deleted_at.has_value ()) {
                stamped.push_back (child);
            }
        }
        return stamped;
    }

    /// The name of the collection @p id names, or nothing when no row has it.
    std::optional<std::string> name_of (const std::string& id) const {
        const auto it = collections.find (id);
        if (it == collections.end ()) {
            return std::nullopt;
        }
        return it->second.name;
    }

    /// A row whose owner is missing entirely is a root as much as one whose
    /// owner is live: there is nothing above it a restore could come back
    /// under. The tree root (no owner) is not a deleted one either.
    bool owner_is_deleted (const std::optional<std::string>& owner_id) const {
        if (!owner_id.has_value ()) {
            return false;
        }
        const auto it = collections.find (*owner_id);
        return it != collections.end () && it->second.deleted_at.has_value ();
    }
};

/// The collections half of a `TrashGraph`; the caller adds the requests it
/// wants counted.
TrashGraph read_collection_graph (Storage& storage) {
    TrashGraph graph;
    for (auto& [id, name, parent_id, deleted_at] : storage.select (columns (&Collection::id,
         &Collection::name, &Collection::parent_id, &Collection::deleted_at))) {
        if (parent_id.has_value ()) {
            graph.children[*parent_id].push_back (id);
        }
        graph.collections.emplace (std::move (id),
        TrashGraph::Node{ std::move (name), std::move (parent_id), deleted_at });
    }
    return graph;
}

/// The entry for the stamped collection @p root_id, which @p graph holds.
TrashEntry collection_entry (const TrashGraph& graph, const std::string& root_id) {
    const auto& root = graph.collections.at (root_id);
    auto entry =
    entry_of (root_id, "collection", root.name, root.deleted_at, root.parent_id);
    const int64_t stamp = entry.deleted_at;
    // The cohort counts are not the subtree's: what this delete took is what
    // restoring it puts back, and a row an earlier delete already held is
    // neither. The walk is `collection_subtree_locked`'s, over the rows the
    // graph already holds.
    const auto children_of = [&graph] (const std::string& id) -> const auto& {
        return graph.children_of (id);
    };
    for (const auto& id : walk_subtree (root_id, children_of)) {
        if (id != root_id && graph.collections.at (id).deleted_at == stamp) {
            ++entry.collections;
        }
        entry.requests += graph.stamped_requests_in (id, stamp);
    }
    // The purge counts are every stamped row `purge_collection_locked` reaches.
    const auto stamped_children_of = [&graph] (const std::string& id) {
        return graph.stamped_children_of (id);
    };
    const auto purged       = walk_subtree (root_id, stamped_children_of);
    entry.purge_collections = static_cast<int64_t> (purged.size ()) - 1;
    for (const auto& id : purged) {
        entry.purge_requests += graph.stamped_requests_in (id);
    }
    return entry;
}

/// The name of the collection @p id names, or nothing when no row has it.
std::optional<std::string> collection_name (Storage& storage, const std::string& id) {
    auto names = storage.select (&Collection::name, where (c (&Collection::id) == id));
    if (names.empty ()) {
        return std::nullopt;
    }
    return std::move (names.front ());
}

/// The name of the request @p id names, or nothing when no row has it.
std::optional<std::string> request_name (Storage& storage, const std::string& id) {
    auto names = storage.select (&Request::name, where (c (&Request::id) == id));
    if (names.empty ()) {
        return std::nullopt;
    }
    return std::move (names.front ());
}

/// Whether the row @p entry names is still stamped: one indexed count on its
/// own kind's table, for a caller that needs the answer and not the entry.
bool still_trashed (Storage& storage, const TrashEntry& entry) {
    const std::string& id = entry.id;
    if (entry.kind == "collection") {
        return storage.count<Collection> (where (c (&Collection::id) == id &&
               is_not_null (&Collection::deleted_at))) > 0;
    }
    if (entry.kind == "request") {
        return storage.count<Request> (where (
               c (&Request::id) == id && is_not_null (&Request::deleted_at))) > 0;
    }
    if (entry.kind == "environment") {
        return storage.count<Environment> (where (c (&Environment::id) == id &&
               is_not_null (&Environment::deleted_at))) > 0;
    }
    if (entry.kind == "example") {
        return storage.count<RequestExample> (where (c (&RequestExample::id) == id &&
               is_not_null (&RequestExample::deleted_at))) > 0;
    }
    if (entry.kind == "clientCertificate") {
        return storage.count<ClientCertificate> (where (c (&ClientCertificate::id) == id &&
               is_not_null (&ClientCertificate::deleted_at))) > 0;
    }
    throw std::logic_error (
    "Trash entry '" + id + "' has unknown kind '" + entry.kind + "'");
}

} // namespace

std::optional<TrashEntry> Database::trash_entry_locked (const std::string& id) {
    auto& storage = impl_->storage;

    // One root, so its subtree is walked through the parent_id and
    // collection_id indexes rather than read whole the way the listing reads
    // every root's: a restore, a purge or retention's re-check of one entry
    // must not cost a scan of either table. `TheListingAndTheRestoreCountTheSameCohort`
    // holds the two to the same counts.
    const auto collections = storage.select (
    columns (&Collection::name, &Collection::parent_id, &Collection::deleted_at),
    where (c (&Collection::id) == id && is_not_null (&Collection::deleted_at)));
    if (!collections.empty ()) {
        const auto& [name, parent_id, deleted_at] = collections.front ();
        auto entry = entry_of (id, "collection", name, deleted_at, parent_id);
        // The cohort's counts, as `collection_entry` takes them.
        for (const auto& descendant_id : collection_subtree_locked (id)) {
            if (descendant_id != id) {
                entry.collections +=
                storage.count<Collection> (where (c (&Collection::id) == descendant_id &&
                c (&Collection::deleted_at) == entry.deleted_at));
            }
            entry.requests +=
            storage.count<Request> (where (c (&Request::collection_id) == descendant_id &&
            c (&Request::deleted_at) == entry.deleted_at));
        }
        // And the purge's, as `collection_entry` takes them too.
        const auto purged = collection_subtree_locked (id, SubtreeRows::StampedOnly);
        entry.purge_collections = static_cast<int64_t> (purged.size ()) - 1;
        for (const auto& descendant_id : purged) {
            entry.purge_requests +=
            storage.count<Request> (where (c (&Request::collection_id) == descendant_id &&
            is_not_null (&Request::deleted_at)));
        }
        return entry;
    }
    if (auto entry = first_entry (request_entries (storage,
        where (c (&Request::id) == id && is_not_null (&Request::deleted_at))))) {
        entry->parent_name = collection_name (storage,
        vayu::utils::invariant_value (entry->parent_id, "a request has a collection"));
        return entry;
    }
    if (auto entry = first_entry (environment_entries (storage,
        where (c (&Environment::id) == id && is_not_null (&Environment::deleted_at))))) {
        return entry;
    }
    if (auto entry = example_entry (storage, id)) {
        entry->parent_name = request_name (storage,
        vayu::utils::invariant_value (entry->parent_id, "an example has a request"));
        return entry;
    }
    return first_entry (client_certificate_entries (storage,
    where (c (&ClientCertificate::id) == id && is_not_null (&ClientCertificate::deleted_at))));
}

std::vector<TrashEntry> Database::get_trash () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto& storage = impl_->storage;

    // Every stamped request is read once: as a candidate root, and as what the
    // collection entries count.
    auto graph = read_collection_graph (storage);
    auto requests =
    request_entries (storage, where (is_not_null (&Request::deleted_at)));
    for (const auto& request : requests) {
        graph.count_stamped_request (
        vayu::utils::invariant_value (request.parent_id, "a request has a collection"),
        request.deleted_at);
    }

    std::vector<TrashEntry> entries;
    for (const auto& [id, node] : graph.collections) {
        // A cascade took a row whose owner is stamped too; its root is further up.
        if (node.deleted_at.has_value () && !graph.owner_is_deleted (node.parent_id)) {
            entries.push_back (collection_entry (graph, id));
        }
    }
    for (auto& request : requests) {
        if (!graph.owner_is_deleted (request.parent_id)) {
            request.parent_name = graph.name_of (vayu::utils::invariant_value (
            request.parent_id, "a request has a collection"));
            entries.push_back (std::move (request));
        }
    }
    // Nothing owns an environment, so every stamped one is a root.
    for (auto& environment :
    environment_entries (storage, where (is_not_null (&Environment::deleted_at)))) {
        entries.push_back (std::move (environment));
    }
    for (auto& example : listed_example_entries (storage)) {
        entries.push_back (std::move (example));
    }
    // Nothing owns a client certificate either (#2973).
    for (auto& certificate : client_certificate_entries (
         storage, where (is_not_null (&ClientCertificate::deleted_at)))) {
        entries.push_back (std::move (certificate));
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

std::optional<Database::TrashRootRef> Database::collection_trash_root_locked (
const std::string& collection_id) {
    std::optional<TrashRootRef> root;
    std::optional<std::string> next = collection_id;
    std::unordered_set<std::string> visited;
    while (next.has_value () && visited.insert (*next).second) {
        auto rows =
        impl_->storage.select (columns (&Collection::name, &Collection::parent_id),
        where (c (&Collection::id) == *next && is_not_null (&Collection::deleted_at)));
        if (rows.empty ()) {
            break;
        }
        auto& [name, parent_id] = rows.front ();

        root = TrashRootRef{ *next, std::move (name) };
        next = std::move (parent_id);
    }
    return root;
}

std::optional<Database::TrashRootRef> Database::request_trash_root_locked (
const std::string& request_id) {
    auto rows = impl_->storage.select (columns (&Request::name, &Request::collection_id),
    where (c (&Request::id) == request_id));
    if (rows.empty ()) {
        return std::nullopt;
    }
    auto& [name, collection_id] = rows.front ();
    if (auto root = collection_trash_root_locked (collection_id)) {
        return root;
    }
    return TrashRootRef{ request_id, std::move (name) };
}

RestoreFailure Database::owner_not_live_refusal (std::string_view what,
std::string_view owner_noun,
const TrashEntry& entry,
const std::optional<TrashRootRef>& root) {
    std::string message = std::string (what) + " '" + entry.name +
    "' cannot be restored on its own - the " + std::string (owner_noun) + " it belongs to";
    if (!root.has_value ()) {
        return RestoreFailure{ RestoreRefusal::OwnerGone, message + " is gone" };
    }
    message += ", '" +
    vayu::utils::invariant_value (
    entry.parent_name, "trash_entry_locked names an owner row that exists") +
    "'";
    if (root->id == entry.parent_id) {
        message += " (" + root->id + "), is in the trash";
    } else {
        message += ", is in the trash under '" + root->name + "' (" + root->id + ")";
    }
    return RestoreFailure{ RestoreRefusal::OwnerGone, message + ", so restore that first" };
}

std::expected<TrashOutcome, RestoreFailure> Database::restore_request_locked (
const TrashEntry& entry) {
    // A request has no root to come back to: `collection_id` is NOT NULL, so
    // "re-parent to the tree root" - what a collection does - is not a shape
    // this row has. Its owner going away is only reachable by deleting the
    // collection after the request, and the answer is the restore that *does*
    // work, named rather than guessed at.
    if (owner_is_absent_locked (entry.parent_id)) {
        return std::unexpected (owner_not_live_refusal ("Request", "collection", entry,
        collection_trash_root_locked (vayu::utils::invariant_value (
        entry.parent_id, "a request has a collection"))));
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
            // Back in the subtree, the request claims its operation again, and
            // the decision its delete recorded is taken back with it (#3031).
            forget_declined_by_locked (request);
        }
        return true; // Commit
    });
    changes_.publish (trash_change (entry, ChangeOp::Restore));
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
                forget_declined_by_locked (request); // As `restore_request_locked`.
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
    // One change for the cohort, on the root, which a re-parent moved to the
    // tree root.
    Change restored = trash_change (entry, ChangeOp::Restore);
    if (reparented) {
        restored.collection_id.reset ();
    }
    changes_.publish (std::move (restored));

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
    if (entry->kind == "request") {
        return restore_request_locked (*entry);
    }
    if (entry->kind == "collection") {
        return restore_collection_locked (*entry);
    }
    if (entry->kind == "environment") {
        return restore_environment_locked (*entry);
    }
    if (entry->kind == "example") {
        return restore_example_locked (*entry);
    }
    if (entry->kind == "clientCertificate") {
        return restore_client_certificate_locked (*entry);
    }
    throw std::logic_error (
    "Trash entry '" + id + "' has unknown kind '" + entry->kind + "'");
}

void Database::purge_trash_entry_locked (const TrashEntry& entry) {
    if (entry.kind == "collection") {
        purge_collection_locked (entry.id);
    } else if (entry.kind == "request") {
        purge_request_locked (entry.id);
    } else if (entry.kind == "environment") {
        purge_environment_locked (entry.id);
    } else if (entry.kind == "example") {
        purge_example_locked (entry.id);
    } else if (entry.kind == "clientCertificate") {
        purge_client_certificate_locked (entry.id);
    } else {
        throw std::logic_error (
        "Trash entry '" + entry.id + "' has unknown kind '" + entry.kind + "'");
    }
    // The one place both an explicit purge and retention destroy an entry,
    // so each publishes exactly once; a collection's cascade rides on its root.
    changes_.publish (trash_change (entry, ChangeOp::Purge));
}

std::optional<TrashOutcome> Database::purge_deleted (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    auto entry = trash_entry_locked (id);
    if (!entry) {
        return std::nullopt;
    }
    // The purge takes every stamped row under the root, whichever delete
    // stamped it - a row left under a removed collection is reachable by no
    // read and restorable by nothing, so "the cohort" is the wrong unit here
    // even though it is the right one for a restore. A live collection is not
    // taken; see purge_collection_locked.
    purge_trash_entry_locked (*entry);
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
    std::vector<TrashEntry> expired;
    for (auto& entry : get_trash ()) {
        if (entry.deleted_at <= cutoff) {
            expired.push_back (std::move (entry));
        }
    }

    int64_t purged = 0;
    for (const auto& entry : expired) {
        // A root purged as part of an ancestor's subtree is already gone. It
        // cannot happen to a *root* by construction, but the re-read is what
        // says so rather than assuming it, with a count rather than a whole
        // entry: this runs once per expired root before `/health` answers.
        if (!still_trashed (impl_->storage, entry)) {
            continue;
        }
        purge_trash_entry_locked (entry);
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
const std::vector<Request>& requests,
const std::unordered_map<std::string, std::string>& declined_under) {
    if (collections.empty () && requests.empty ()) {
        return;
    }

    vayu::utils::log_debug ("db",
    "Applying reorder: " + std::to_string (collections.size ()) +
    " collections, " + std::to_string (requests.size ()) + " requests");

    retry_on_busy ("apply reorder", 5, std::chrono::milliseconds (100), [&] {
        std::vector<Change> moved;
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
                moved.push_back (collection_change (row, ChangeOp::Update));
            }
            for (const auto& row : requests) {
                if (impl_->storage.count<Request> (where (
                    c (&Request::id) == row.id && is_null (&Request::deleted_at))) == 0) {
                    throw MissingRowError ("Request", row.id);
                }
                // Read off the stored row, before the write clears its stamp.
                if (const auto under = declined_under.find (row.id);
                under != declined_under.end ()) {
                    for (const auto& stored : impl_->storage.get_all<Request> (
                         where (c (&Request::id) == row.id))) {
                        record_declined_operation_locked (under->second, stored);
                    }
                }
                impl_->storage.update (row);
                moved.push_back (request_change (row, ChangeOp::Update));
            }
            return true; // Commit
        });
        changes_.publish (std::move (moved));
    });
}

} // namespace vayu::db
