/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/spec_sync.cpp
 * @brief `POST /specs/sync` - apply an OpenAPI diff to a bound collection, whole
 *        or not at all (issue #655, the write half of #627).
 *
 * The comparison is the engine's (`POST /specs/diff`, #854) and the caller
 * decides which of it to apply; this applies exactly that. What it owns is every
 * rule a client must not be trusted with:
 *
 * - **The whole thing is one transaction.** The new document, the binding that
 *   moves to it, the created, updated and deleted requests, and the examples
 *   land together or not at all. A half-applied sync leaves a collection bound
 *   to a document its requests do not reflect - the one state binding exists to
 *   make impossible - so it is refused structurally rather than apologised for.
 * - **Nothing outside the bound subtree is touched.** Every request updated or
 *   deleted, and every collection an added operation lands in, must live
 *   beneath the collection being synced. A sync is an operation on one
 *   collection's contract; a payload naming a request elsewhere is a client bug,
 *   and honouring it would make this route a way to delete arbitrary rows.
 * - **The engine mints every id** (#97), as `POST /import/apply` does, and for
 *   the same reason - so new rows are named by `tempId` and translated through
 *   the returned `idMap`.
 * - **The examples written are the ones the stored document documents** (issue
 *   #869). The payload carries a decision per updated request - refresh this
 *   request's imported examples, or leave them - and the rows come off the
 *   document this call is storing. A caller used to send the rows themselves,
 *   having read them out of the diff two calls earlier, which made it possible
 *   to write examples for responses the document does not describe.
 *
 * Deliberately **not** an extension of `/import/apply`: that route creates, and
 * only creates, which is what lets it assign every id and validate a payload
 * with nothing stored behind it. A sync updates and deletes rows that already
 * exist, against a subtree it must first prove it owns. Folding the two
 * together would put "POST creates" - the rule the whole resource API is built
 * on (#95) - inside a conditional.
 */

#include "vayu/core/constants.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/core/spec_diff.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <functional>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::http::routes {

/**
 * Every collection at or beneath @p root, from one read of the table.
 *
 * A walk rather than a repeated `parent_id` query because the answer is needed
 * for every item in the payload and the collections table is the small,
 * sidebar-sized one - the same reasoning `get_collections_bound_to_spec`
 * scans on. A cycle among stored rows cannot loop it: `seen` gates the descent.
 *
 * Shared with `POST /specs/match` and `POST /specs/export` (declared in
 * routes.hpp), which have to gather the same subtree for the same reason a sync
 * refuses to leave it: a spec-bound root usually owns no requests directly, so
 * anything that answers for a collection's contract has to mean the subtree by
 * "the collection".
 *
 * @p descend_into is where one caller's contract stops early - the export's
 * boundary at a collection bound to a *different* document (issue #721). Empty
 * for the two that take the whole subtree, and the child it refuses takes its
 * own descendants with it, which is what makes it a boundary rather than a
 * filter.
 */
std::unordered_set<std::string> collection_subtree_ids (
const std::vector<vayu::db::Collection>& all,
const std::string& root,
const std::function<bool (const vayu::db::Collection&)>& descend_into) {
    std::unordered_map<std::string, const vayu::db::Collection*> rows;
    for (const auto& col : all) {
        rows.emplace (col.id, &col);
    }
    std::unordered_map<std::string, std::vector<std::string>> children;
    for (const auto& col : all) {
        if (col.parent_id && !col.parent_id->empty ()) {
            children[*col.parent_id].push_back (col.id);
        }
    }
    std::unordered_set<std::string> seen{ root };
    std::vector<std::string> stack{ root };
    while (!stack.empty ()) {
        const std::string cursor = stack.back ();
        stack.pop_back ();
        auto kids = children.find (cursor);
        if (kids == children.end ()) {
            continue;
        }
        for (const auto& child : kids->second) {
            if (descend_into) {
                const auto row = rows.find (child);
                if (row != rows.end () && !descend_into (*row->second)) {
                    continue;
                }
            }
            if (seen.insert (child).second) {
                stack.push_back (child);
            }
        }
    }
    return seen;
}

/**
 * Every request stored beneath @p subtree, in the order the collections table
 * lists their collections and each collection lists its own.
 *
 * The order is the contract, not a convenience: `POST /specs/match` reports its
 * answer as indices into this list and `POST /specs/bind` matches the same set
 * again to decide what to stamp, so the two must walk the requests the same way
 * or a preview would describe a pairing the bind then did not make. One walk
 * rather than two is what makes that impossible rather than merely true today.
 *
 * @param all The collections table, already read - both callers need it for the
 *        subtree walk itself, and reading it twice under one lock would only
 *        add a scan.
 */
std::vector<vayu::db::Request> collection_subtree_requests (vayu::db::Database& db,
const std::vector<vayu::db::Collection>& all,
const std::unordered_set<std::string>& subtree) {
    std::vector<vayu::db::Request> requests;
    for (const auto& collection : all) {
        if (!subtree.contains (collection.id)) {
            continue;
        }
        for (auto& request : db.get_requests_in_collection (collection.id)) {
            requests.push_back (std::move (request));
        }
    }
    return requests;
}

/**
 * The `specId` a collection's own binding names, or "" when it binds nothing.
 *
 * The collection's *own* column, deliberately not `nearest_spec_binding`'s walk
 * up the ancestry: a sync and a diff write to and describe the collection they
 * were given, and answering for a document only its parent binds would report
 * an inherited contract as this collection's own. Shared with
 * `POST /specs/diff` (declared in routes.hpp) so the route that says what would
 * change and the route that changes it cannot come to disagree about which
 * collections are syncable at all.
 *
 * An unparseable or non-object column binds nothing, the reading every other
 * reader of it gives.
 */
std::string bound_spec_id (const std::string& openapi) {
    try {
        const auto parsed = nlohmann::json::parse (openapi);
        if (!parsed.is_object ()) {
            return {};
        }
        return parsed.value ("specId", std::string ());
    } catch (const std::exception&) {
        return {};
    }
}

namespace {

/**
 * Cap on rows per call, the same bound and the same reasoning as
 * `/import/apply`'s: the whole payload becomes rows in memory before anything
 * is written, and a sync of a collection larger than this is not a sync.
 */
constexpr size_t MAX_SYNC_ITEMS = 10000;

RouteError body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/**
 * An error that names the offending item, in the same place `/import/apply`
 * puts it (inside the error object, next to the code and message) so a client
 * reads one shape for both bulk endpoints. The name is a `tempId` for a row
 * being created and the real id for one being updated or deleted - in both
 * cases the only handle the caller has on it.
 */
RouteError item_error (int status, const std::string& message, const std::string& item) {
    auto body             = error_body (status, message);
    body["error"]["item"] = item;
    return { .status = status, .body = body };
}

/** Reads one optional top-level array; anything else that is not an array is a 400. */
RouteResult
read_items (const nlohmann::json& body, const char* key, const nlohmann::json*& out) {
    // Built on the first call rather than before `main`, and outliving the call
    // because `out` hands back its address - the same reasoning as
    // `/import/apply`'s copy of this function carries.
    static const nlohmann::json empty_items = nlohmann::json::array ();
    out                                     = &empty_items;
    if (!body.contains (key) || body[key].is_null ()) {
        return {};
    }
    if (!body[key].is_array ()) {
        return std::unexpected (
        body_error (std::string ("Invalid '") + key + "': must be an array"));
    }
    out = &body[key];
    return {};
}

/** Turns an applier's failure - its own error body, or a json type error - into a 400. */
template <typename Apply>
RouteResult apply_item_fields (Apply apply, const char* kind, const std::string& item) {
    RouteResult outcome;
    try {
        outcome = apply ();
    } catch (const nlohmann::json::exception& e) {
        return std::unexpected (
        item_error (400, std::string ("Invalid ") + kind + ": " + e.what (), item));
    }
    if (!outcome) {
        RouteError refused            = outcome.error ();
        refused.body["error"]["item"] = item;
        return std::unexpected (refused);
    }
    return {};
}

/** Validates a `tempId`, rejects a client-supplied `id`, and claims a real one. */
RouteResult claim_temp_id (const nlohmann::json& item,
const char* kind,
const char* prefix,
size_t index,
std::unordered_map<std::string, std::string>& id_map,
std::string& temp_id_out) {
    const std::string at = std::string (kind) + " at index " + std::to_string (index);
    if (!item.is_object ()) {
        return std::unexpected (body_error ("Invalid " + at + ": must be an object"));
    }
    if (item.contains ("id")) {
        return std::unexpected (body_error ("Invalid " +
        at + ": 'id' is not accepted - the engine assigns ids; reference items by 'tempId'"));
    }
    if (!item.contains ("tempId") || !item["tempId"].is_string () ||
    item["tempId"].get<std::string> ().empty ()) {
        return std::unexpected (
        body_error ("Invalid " + at + ": 'tempId' must be a non-empty string"));
    }
    temp_id_out = item["tempId"].get<std::string> ();
    if (id_map.contains (temp_id_out)) {
        return std::unexpected (
        item_error (400, "Duplicate tempId '" + temp_id_out + "'", temp_id_out));
    }
    id_map.emplace (temp_id_out, vayu::utils::generate_id (prefix));
    return {};
}

/**
 * The example rows a request's documented responses become, through the same
 * applier every other example write uses.
 *
 * @p examples is the engine's own answer since issue #869 - the rows
 * `draft_example_rows` builds from the document being stored - rather than a
 * list the caller sent. `origin` is fixed to `import` here for the reason it
 * always was: a sync writes what the document says, and a row claiming `user`
 * would be one the *next* sync then refuses to replace.
 *
 * @param suppressed_statuses the statuses this request holds a tombstone for
 * (issue #722) - the document's example for one of them is validated like any
 * other and then dropped, because the user deleted it and a sync that wrote it
 * back would make that delete a suggestion. Empty on the create path: a
 * request being created now has nothing behind it to have deleted.
 */
RouteResult build_example_rows (const nlohmann::json& examples,
const std::string& request_id,
const std::string& owner,
int base_order,
int64_t now,
std::vector<vayu::db::RequestExample>& out,
size_t surviving,
const std::unordered_set<int>& suppressed_statuses = {}) {
    // Against what will be written rather than what was offered: a tombstoned
    // example never lands, so counting it here would refuse a sync that fits.
    std::vector<vayu::db::RequestExample> rows;
    rows.reserve (examples.size ());

    for (const auto& example : examples) {
        vayu::db::RequestExample x;
        x.id         = vayu::utils::generate_id ("exa_");
        x.request_id = request_id;
        x.created_at = now;
        x.updated_at = now;

        // Through the applier every other example write goes through, although
        // these rows are the engine's own: a field the applier learns - the way
        // `origin` and `suppressed` were learned - must reach a sync's rows too,
        // and a second construction here is how it would not.
        if (auto outcome = apply_item_fields (
            [&] {
                return apply_request_example_fields (x, example, /*is_create=*/true);
            },
            "example", owner);
        !outcome) {
            return outcome;
        }
        if (suppressed_statuses.contains (x.status)) {
            continue;
        }
        // Document order from the block this refresh occupies - see
        // `refresh_examples` for what decides where the block starts. Counted
        // over what is kept, so a dropped example leaves no hole in the block.
        x.order = base_order + static_cast<int> (rows.size ());
        rows.push_back (std::move (x));
    }

    if (rows.size () + surviving > vayu::core::constants::request_example::MAX_PER_REQUEST) {
        return std::unexpected (item_error (400,
        "Too many examples: " + std::to_string (rows.size () + surviving) + " exceeds the limit of " +
        std::to_string (vayu::core::constants::request_example::MAX_PER_REQUEST) + " per request",
        owner));
    }
    out.insert (out.end (), std::make_move_iterator (rows.begin ()),
    std::make_move_iterator (rows.end ()));
    return {};
}

/**
 * What the document being stored documents, per operation (issue #869).
 *
 * A sync writes the examples the document describes rather than rows the caller
 * states: the payload carries the *decision* - refresh this request's imported
 * examples, or leave them - and the rows come from here. Before that, a client
 * could write example rows the document does not describe, and the responses it
 * was echoing back had come from the engine on the diff two calls earlier.
 *
 * **Read on the first request that needs it, then reused.** A sync that ticks no
 * examples - a binding move, a rename with the examples left alone - pays
 * nothing for it, while a sync of a 4000-operation document reads once however
 * many requests refresh. The DOM comes from the index derivation, so the whole
 * route is still one read of the stored bytes.
 *
 * Identity resolution is `core::OperationIndex` - the coverage rule, by
 * `operationId` first and method-and-path second - so the operation whose
 * responses are written here is the operation a run will later credit the
 * request with.
 */
class DocumentedExamples {
    public:
    explicit DocumentedExamples (const nlohmann::ordered_json& document)
    : document_ (document) {
    }

    /**
     * The rows @p spec_operation - a request's stored `requests.spec_operation`
     * text - documents, or nothing when the document declares no such operation.
     */
    std::optional<nlohmann::json> rows_for (const std::string& spec_operation) {
        if (!index_) {
            drafts_ = vayu::core::spec_request_drafts_of (document_);
            std::vector<vayu::core::DeclaredOperation> declared;
            declared.reserve (drafts_.size ());
            for (const vayu::core::SpecRequestDraft& draft : drafts_) {
                declared.push_back (draft.operation);
            }
            index_.emplace (declared);
        }
        const std::optional<size_t> found = index_->resolve (spec_operation);
        if (!found) {
            return {};
        }
        // `make_optional` rather than a bare return: copy-initializing an
        // `optional<json>` from a `json` puts nlohmann's `operator ValueType()`
        // up against `optional`'s converting constructor, which GCC reports as
        // -Wconversion. Direct-initializing considers the constructor alone.
        return std::make_optional (draft_example_rows (drafts_[*found].draft.examples));
    }

    private:
    const nlohmann::ordered_json& document_;
    std::vector<vayu::core::SpecRequestDraft> drafts_;
    std::optional<vayu::core::OperationIndex> index_;
};

/**
 * What an example refresh replaces, and where the replacements sit.
 *
 * The rule, stated once because a mock server answers with the *first* example
 * and so the order is a contract rather than a display choice: **a sync never
 * moves a row a person saved, and never promotes an imported row past one that
 * was already ahead of it.** The imported rows are dropped and the new ones
 * take a consecutive block starting where the lowest of them sat; a request
 * whose examples were all user-saved gets the block after the last of them.
 *
 * **A deleted imported example is not written back** (issue #722). Deleting one
 * leaves a tombstone rather than nothing, and the statuses those name are the
 * one thing a refresh must not restore - otherwise any later sync of any field
 * re-creates what the user removed, and the delete meant nothing.
 */
struct ExampleRefresh {
    std::vector<std::string> replaced; ///< Imported row ids, to delete.
    int base_order   = 0;              ///< Where the replacement block starts.
    size_t surviving = 0; ///< User rows, which stay exactly as they are.
    /**
     * Statuses the user deleted, from this request's tombstones.
     *
     * The status is the identity, not the name: an imported example is the
     * document's account of one response code, while its name carries the
     * response *description* (`"404 - Not found"`) and moves whenever the
     * document rewords it - so a name-keyed tombstone would resurrect the
     * example on the first reworded description, which is the defect itself.
     */
    std::unordered_set<int> suppressed_statuses;
};

ExampleRefresh refresh_examples (const std::vector<vayu::db::RequestExample>& stored,
const std::vector<vayu::db::RequestExample>& tombstones) {
    ExampleRefresh plan;
    for (const auto& row : tombstones) {
        plan.suppressed_statuses.insert (row.status);
    }
    std::optional<int> lowest_import;
    int highest = -1;
    for (const auto& row : stored) {
        highest = std::max (highest, row.order);
        if (row.origin == vayu::core::constants::request_example::ORIGIN_IMPORT) {
            plan.replaced.push_back (row.id);
            lowest_import =
            lowest_import ? std::min (*lowest_import, row.order) : row.order;
        } else {
            plan.surviving += 1;
        }
    }
    plan.base_order = lowest_import ? *lowest_import : highest + 1;
    return plan;
}

/**
 * Where an added operation's request goes, and which folders that needs.
 *
 * An import files its operations under one sub-collection per tag, so a sync
 * that added them to the bound collection itself would reshape a collection
 * every time it caught up with its contract. A folder is matched by name among
 * the bound collection's **direct children** - a same-named folder deeper down
 * is somebody else's - and created at most once per payload however many
 * operations name it, because two folders called `pets` would both land and the
 * next sync would have to choose between them.
 */
class FolderResolver {
    public:
    FolderResolver (std::string root_id, const std::vector<vayu::db::Collection>& collections)
    : root_id_ (std::move (root_id)) {
        for (const auto& collection : collections) {
            if (!collection.parent_id || *collection.parent_id != root_id_) {
                continue;
            }
            existing_.try_emplace (collection.name, collection.id);
        }
    }

    /** The owner fields one created request carries - a stored id or a claimed one. */
    nlohmann::json owner_of (const std::string& folder) {
        if (folder.empty ()) {
            return { { "collectionId", root_id_ } };
        }
        if (const auto stored = existing_.find (folder); stored != existing_.end ()) {
            return { { "collectionId", stored->second } };
        }
        const auto claimed = claimed_.find (folder);
        if (claimed != claimed_.end ()) {
            return { { "collectionTempId", claimed->second } };
        }
        const std::string temp = "tmp_col_" + std::to_string (created_.size ());
        claimed_.emplace (folder, temp);
        created_.push_back (
        { { "tempId", temp }, { "name", folder }, { "parentId", root_id_ } });
        return { { "collectionTempId", temp } };
    }

    [[nodiscard]] const nlohmann::json& created () const {
        return created_;
    }

    private:
    std::string root_id_;
    nlohmann::json created_ = nlohmann::json::array ();
    std::unordered_map<std::string, std::string> existing_;
    std::unordered_map<std::string, std::string> claimed_;
};

/**
 * The rows a `"safe"` sync writes, as the payload an explicit one would send
 * (issue #871).
 *
 * The *decision* is `core::safe_spec_apply`, shared with the marks
 * `POST /specs/diff` reports, so a caller that ticks nothing and a caller that
 * ticks exactly what the diff called safe send the same write. What is here is
 * only the translation into payload rows - which is deliberate: building the
 * payload rather than a second write path means everything below (the id
 * minting, the subtree bounds, the example refresh, the transaction itself) is
 * the one code path both kinds of caller go through.
 *
 * Two rules ride in this translation rather than in the policy, because they are
 * about what a *write* looks like rather than about what is safe to write:
 *
 * - **The identity travels with every applied change**, ticked fields or not. An
 *   operation is its method and path template, so a request left carrying the
 *   old identity after the document renamed it would be compared against the
 *   wrong operation on the next sync.
 * - **An applied change refreshes that request's imported examples.** The
 *   comparison does not cover examples, so the rule is stated rather than
 *   derived: the rows come off the document being stored (issue #869), a saved
 *   example is never touched, and a status the user deleted is never written
 *   back.
 *
 * The `skipped` key rides back with the rows and is **not** a section: it is
 * what the policy declined, counted. A sync that reported only what it wrote
 * would read as "applied the drift" to a caller that cannot see the ticks, and
 * the whole reason there are ticks is that some of a drift must not be applied.
 */
nlohmann::json safe_sync_payload (const std::string& root_id,
const std::vector<vayu::db::Collection>& collections,
const SpecComparison& comparison) {
    const vayu::core::SpecDiff& diff     = comparison.diff;
    const vayu::core::SafeSpecApply safe = vayu::core::safe_spec_apply (diff);
    FolderResolver folders (root_id, collections);

    nlohmann::json create = nlohmann::json::array ();
    for (size_t i = 0; i < diff.added.size (); ++i) {
        if (!safe.create[i]) {
            continue;
        }
        const vayu::core::SpecRequestDraft& entry = comparison.fetched[diff.added[i]];
        // The same builder the diff reports its `draft` with, so the request an
        // apply creates is the one the preview described. `auth`, the two scripts
        // and the rest are left to the create defaults, which are what an OpenAPI
        // import writes for every operation of every document.
        nlohmann::json item = draft_request_fields_json (entry.draft);
        item["tempId"]      = "tmp_req_" + std::to_string (create.size ());
        // Derived here because the engine never derives it from `body`.
        item["bodyType"]      = entry.draft.body.mode;
        item["specOperation"] = spec_operation_json (entry.operation);
        item.update (folders.owner_of (entry.folder));
        create.push_back (std::move (item));
    }

    nlohmann::json update = nlohmann::json::array ();
    for (size_t i = 0; i < diff.changed.size (); ++i) {
        if (!safe.update[i].apply) {
            continue;
        }
        const vayu::core::ChangedRequest& changed = diff.changed[i];
        const vayu::core::SpecRequestDraft& entry = comparison.fetched[changed.draft];
        const nlohmann::json fields = draft_request_fields_json (entry.draft);

        nlohmann::json item{ { "id", comparison.requests[changed.request].id },
            { "specOperation", spec_operation_json (entry.operation) },
            { "examples", true } };
        for (const vayu::core::SpecField field : safe.update[i].fields) {
            const std::string key (vayu::core::spec_field_name (field));
            item[key] = fields.at (key);
            if (field == vayu::core::SpecField::Body) {
                item["bodyType"] = entry.draft.body.mode;
            }
        }
        update.push_back (std::move (item));
    }

    // Read from the policy rather than written as an empty list: "a safe apply
    // deletes nothing" is a rule with one author, and a route that spelled it
    // here would be a second one.
    nlohmann::json remove = nlohmann::json::array ();
    size_t kept           = 0;
    for (size_t i = 0; i < diff.removed.size (); ++i) {
        if (safe.remove[i]) {
            remove.push_back (comparison.requests[diff.removed[i]].id);
        } else {
            kept += 1;
        }
    }

    size_t offered_fields = 0;
    size_t written_fields = 0;
    size_t left_alone     = 0;
    for (size_t i = 0; i < diff.changed.size (); ++i) {
        offered_fields += diff.changed[i].fields.size ();
        written_fields += safe.update[i].fields.size ();
        if (!safe.update[i].apply) {
            left_alone += 1;
        }
    }

    return { { "collections", folders.created () }, { "create", std::move (create) },
        { "update", std::move (update) }, { "delete", std::move (remove) },
        { "skipped",
        nlohmann::json{ { "requests", left_alone },
        // Every field the document moved that this apply does not write -
        // whether its request was left alone whole or applied around it.
        { "fields", offered_fields - written_fields }, { "deletions", kept } } } };
}

/**
 * One payload's temp-id namespace.
 *
 * Flat across the two sections that claim into it, for `/import/apply`'s
 * reason: the response's `idMap` is one map, so a `tempId` reused between a
 * folder and a request would make it ambiguous.
 */
struct ClaimedIds {
    std::unordered_map<std::string, std::string> real; ///< tempId -> engine id.
    std::unordered_set<std::string> collections; ///< Which of them are folders.
};

/**
 * The payload a sync applies, after every check that needs no database.
 *
 * The four section pointers are borrowed - into the request body, or into the
 * `policy_rows` the applier below builds - so this outlives neither.
 */
struct SyncRequest {
    std::string collection_id;
    const nlohmann::json* spec_item = nullptr;
    std::string content;
    std::string policy; ///< Empty unless the caller asked for a policy sync.
    const nlohmann::json* new_collections = nullptr;
    const nlohmann::json* creates         = nullptr;
    const nlohmann::json* updates         = nullptr;
    const nlohmann::json* deletes         = nullptr;
    size_t stated                         = 0; ///< Rows the payload asks for.
};

/** What the payload is being applied to, read once under the lock. */
struct SyncScope {
    std::vector<vayu::db::Collection> stored_collections;
    vayu::db::Collection root;
    std::string bound_id;
    std::unordered_set<std::string> subtree;
    size_t cap  = 0; ///< The document size limit this installation sets.
    int64_t now = 0;
};

/** The rows the sections below accumulate, and the ids they hand out. */
struct SyncPlan {
    vayu::db::SpecSyncBatch batch;
    ClaimedIds claimed;
    /**
     * Parent id -> the next `order` to hand out, seeded from the stored
     * siblings by the applier and advanced here: the applier computes its
     * default from rows that exist, so two folders created in one payload
     * would otherwise land on the same number (the same reason
     * `/import/apply` hands out its own slots).
     */
    std::unordered_map<std::string, int> next_folder_order;
    std::unordered_map<std::string, int> next_request_order;
    /// Request ids this payload has already updated or deleted.
    std::unordered_set<std::string> touched;
};

/**
 * The `policy` field, and the rule that it excludes the row sections.
 *
 * `policy` is the alternative to stating rows (issue #871): the caller says
 * *apply the safe ticks* and the engine works out which they are, from the
 * same `core::safe_spec_apply` whose answer `POST /specs/diff` reports per
 * entry. It exists because those rules - never overwrite a field somebody
 * edited, never delete, leave a request nothing can be told apart about
 * alone - used to live in the renderer alone, which put every apply out of
 * reach of anything that is not the Spec tab and made any second caller a
 * second opinion about which of a user's fields a sync may destroy.
 *
 * Mutually exclusive with the row sections rather than merged with them: a
 * payload that stated both would be two answers to one question, and there
 * is no reading of "the safe ticks, plus these" that is not a guess.
 */
RouteResult read_sync_policy (const nlohmann::json& body, std::string& policy) {
    const auto stated_policy = body.find ("policy");
    if (stated_policy == body.end () || stated_policy->is_null ()) {
        return {};
    }
    if (!stated_policy->is_string ()) {
        return std::unexpected (body_error ("Invalid 'policy': must be a string"));
    }
    policy = stated_policy->get<std::string> ();
    if (policy != "safe") {
        return std::unexpected (body_error ("Invalid 'policy': '" + policy +
        "' is not a policy this engine has; the only one is \"safe\" - "
        "everything the "
        "document adds, every field it moved that nobody here had edited, "
        "and no deletions"));
    }
    for (const char* section : { "collections", "create", "update", "delete" }) {
        if (body.contains (section) && !body[section].is_null ()) {
            return std::unexpected (body_error (std::string ("Invalid '") + section +
            "': a policy sync decides its own rows; send 'policy' or the rows, not both"));
        }
    }
    return {};
}

/** Everything a sync can refuse before it takes the lock. */
RouteResult read_sync_request (const nlohmann::json& body, SyncRequest& out) {
    if (!body.is_object ()) {
        return std::unexpected (body_error ("Body must be a JSON object"));
    }

    if (auto outcome = apply_required_string_field (
        body, "collectionId", out.collection_id, /*is_create=*/true);
    !outcome) {
        return outcome;
    }
    if (out.collection_id.empty ()) {
        return std::unexpected (
        body_error ("Invalid 'collectionId': must be a non-empty string"));
    }

    if (!body.contains ("spec") || !body["spec"].is_object ()) {
        return std::unexpected (body_error (
        "Invalid 'spec': must be an object with the re-fetched document"));
    }
    out.spec_item = &body["spec"];
    for (const char* engine_owned : { "id", "hash", "fetchedAt" }) {
        if (out.spec_item->contains (engine_owned)) {
            return std::unexpected (body_error (std::string ("Invalid 'spec.") +
            engine_owned + "': computed by the engine; omit it"));
        }
    }
    if (auto outcome = apply_required_string_field (
        *out.spec_item, "content", out.content, /*is_create=*/true);
    !outcome) {
        return outcome;
    }
    if (out.content.empty ()) {
        return std::unexpected (
        body_error ("Invalid 'spec.content': an empty document is not a spec"));
    }

    if (auto outcome = read_sync_policy (body, out.policy); !outcome) {
        return outcome;
    }

    if (auto outcome = read_items (body, "collections", out.new_collections); !outcome) {
        return outcome;
    }
    if (auto outcome = read_items (body, "create", out.creates); !outcome) {
        return outcome;
    }
    if (auto outcome = read_items (body, "update", out.updates); !outcome) {
        return outcome;
    }
    if (auto outcome = read_items (body, "delete", out.deletes); !outcome) {
        return outcome;
    }

    // The rows the payload asks for. The example rows a refresh writes are the
    // engine's own now (issue #869) and are counted against the same limit once
    // they exist, below - refusing here on a number the caller stated would let a
    // payload understate what it is about to write.
    // Recomputed inside the lock for a policy sync, whose rows are not known
    // until the comparison is made - this early check is the one that keeps a
    // caller's own oversized payload from being parsed row by row first.
    out.stated = out.new_collections->size () + out.creates->size () +
    out.updates->size () + out.deletes->size ();
    if (out.stated > MAX_SYNC_ITEMS) {
        return std::unexpected (
        body_error ("Sync too large: " + std::to_string (out.stated) +
        " items exceeds the limit of " + std::to_string (MAX_SYNC_ITEMS) + " per call"));
    }
    return {};
}

/**
 * The subtree, the binding and the size limit this payload is applied against.
 *
 * Read here rather than by the caller because all of it comes out of the
 * database and so has to be inside the lock: a subtree gathered outside it
 * could have moved before the batch is written.
 */
RouteResult
resolve_sync_scope (vayu::db::Database& db, const SyncRequest& request, SyncScope& out) {
    out.stored_collections = db.get_collections ();
    auto root = std::find_if (out.stored_collections.begin (),
    out.stored_collections.end (), [&] (const vayu::db::Collection& c) {
        return c.id == request.collection_id;
    });
    if (root == out.stored_collections.end ()) {
        return std::unexpected (
        RouteError{ 404, error_body (404, "Collection not found") });
    }
    out.root     = *root;
    out.bound_id = bound_spec_id (out.root.openapi);
    if (out.bound_id.empty ()) {
        return std::unexpected (body_error ("Collection '" + request.collection_id +
        "' is not bound to a spec; bind it before syncing"));
    }
    out.subtree =
    collection_subtree_ids (out.stored_collections, request.collection_id);

    out.cap = spec_size_cap (db);
    if (request.content.size () > out.cap) {
        return std::unexpected (body_error ("Spec document is " +
        std::to_string (request.content.size ()) + " bytes, over the limit of " +
        std::to_string (out.cap) +
        " (raise the 'maxSpecDocumentBytes' setting to allow more)"));
    }
    out.now = now_ms ();
    return {};
}

/**
 * The document row this sync stores, and the parsed document behind it.
 *
 * The document itself comes back with the indexes, because a refresh writes the
 * responses *these* bytes document (issue #869) and reading them a second time
 * would be a second answer about them.
 */
RouteResult read_sync_document (const SyncRequest& request,
const SyncScope& scope,
vayu::db::SpecDocument& spec,
nlohmann::ordered_json& document) {
    spec.id         = vayu::utils::generate_id ("spec_");
    spec.content    = request.content;
    spec.hash       = spec_content_hash (request.content);
    spec.fetched_at = scope.now;
    if (auto reason = read_spec_indexes (*request.spec_item, spec, scope.cap, &document)) {
        return std::unexpected (body_error (*reason));
    }
    const auto& spec_item = *request.spec_item;
    if (spec_item.contains ("sourceUrl") && !spec_item["sourceUrl"].is_null ()) {
        if (!spec_item["sourceUrl"].is_string ()) {
            return std::unexpected (
            body_error ("Invalid 'spec.sourceUrl': must be a string or null"));
        }
        const auto url = spec_item["sourceUrl"].get<std::string> ();
        if (!url.empty ()) {
            spec.source_url = url;
        }
    }
    return {};
}

/**
 * What a policy sync writes, for the caller that stated no rows.
 *
 * Inside the lock because the answer is read out of the database: the bound
 * document, the subtree's requests and this collection's folders are all part
 * of it, and a comparison made outside the lock could be applied against a tree
 * that has since moved. @p policy_rows owns the arrays @p request then points
 * into, so it has to outlive the sections below.
 */
RouteResult plan_policy_rows (vayu::db::Database& db,
const SyncScope& scope,
const nlohmann::ordered_json& document,
SyncRequest& request,
nlohmann::json& policy_rows) {
    if (request.policy.empty ()) {
        return {};
    }
    SpecComparison comparison;
    if (auto outcome = compare_bound_spec (db, scope.stored_collections,
        scope.subtree, scope.bound_id, document, comparison);
    !outcome) {
        return outcome;
    }
    policy_rows =
    safe_sync_payload (request.collection_id, scope.stored_collections, comparison);
    request.new_collections = &policy_rows["collections"];
    request.creates         = &policy_rows["create"];
    request.updates         = &policy_rows["update"];
    request.deletes         = &policy_rows["delete"];
    request.stated = request.new_collections->size () + request.creates->size () +
    request.updates->size () + request.deletes->size ();
    if (request.stated > MAX_SYNC_ITEMS) {
        return std::unexpected (
        body_error ("Sync too large: " + std::to_string (request.stated) +
        " items exceeds the limit of " + std::to_string (MAX_SYNC_ITEMS) + " per call"));
    }
    return {};
}

/** One new tag folder, claimed and built. */
RouteResult plan_folder (vayu::db::Database& db,
const nlohmann::json& item,
size_t index,
const SyncRequest& request,
const SyncScope& scope,
SyncPlan& plan) {
    std::string temp;
    if (auto outcome =
        claim_temp_id (item, "collection", "col_", index, plan.claimed.real, temp);
    !outcome) {
        return outcome;
    }
    plan.claimed.collections.insert (temp);

    if (item.contains ("openapi")) {
        return std::unexpected (item_error (400,
        "Invalid 'openapi': a folder a sync creates is part of the "
        "document being "
        "synced, not a document of its own",
        temp));
    }

    nlohmann::json fields = item;
    std::string parent    = request.collection_id;
    if (item.contains ("parentId") && !item["parentId"].is_null ()) {
        if (!item["parentId"].is_string ()) {
            return std::unexpected (
            item_error (400, "Invalid 'parentId': must be a string", temp));
        }
        parent = item["parentId"].get<std::string> ();
        if (!scope.subtree.contains (parent)) {
            return std::unexpected (item_error (400,
            "Invalid 'parentId': '" + parent + "' is not the collection being synced or one beneath it",
            temp));
        }
    }
    fields["parentId"] = parent;

    vayu::db::Collection folder;
    folder.id         = plan.claimed.real.at (temp);
    folder.created_at = scope.now;
    folder.updated_at = scope.now;
    if (auto outcome = apply_item_fields (
        [&] { return apply_collection_fields (db, folder, fields, /*is_create=*/true); },
        "collection", temp);
    !outcome) {
        return outcome;
    }
    if (!item.contains ("order") || item["order"].is_null ()) {
        auto slot = plan.next_folder_order.try_emplace (parent, folder.order).first;
        folder.order = slot->second++;
    }
    plan.batch.new_collections.push_back (std::move (folder));
    return {};
}

/** Which collection a created request lands in, stored or claimed here. */
RouteResult resolve_create_owner (vayu::db::Database& db,
const nlohmann::json& item,
const std::string& temp,
const SyncScope& scope,
SyncPlan& plan,
std::string& owner) {
    if (item.contains ("collectionTempId") && !item["collectionTempId"].is_null ()) {
        if (!item["collectionTempId"].is_string ()) {
            return std::unexpected (item_error (
            400, "Invalid 'collectionTempId': must be a string", temp));
        }
        const auto named = item["collectionTempId"].get<std::string> ();
        if (!plan.claimed.collections.contains (named)) {
            return std::unexpected (
            item_error (400, "Unknown collectionTempId '" + named + "'", temp));
        }
        if (item.contains ("collectionId")) {
            return std::unexpected (item_error (400,
            "Invalid request: send either 'collectionTempId' (a folder "
            "in this "
            "payload) or 'collectionId' (one already stored), not both",
            temp));
        }
        owner = plan.claimed.real.at (named);
        // A folder this payload creates has no stored siblings to scan.
        plan.next_request_order.try_emplace (owner, 0);
        return {};
    }
    if (!item.contains ("collectionId") || !item["collectionId"].is_string ()) {
        return std::unexpected (item_error (400,
        "Invalid 'collectionId': must name a collection beneath "
        "the one being "
        "synced, or use 'collectionTempId'",
        temp));
    }
    owner = item["collectionId"].get<std::string> ();
    if (!scope.subtree.contains (owner)) {
        return std::unexpected (item_error (400,
        "Invalid 'collectionId': '" + owner + "' is not the collection being synced or one beneath it",
        temp));
    }
    if (!plan.next_request_order.contains (owner)) {
        int highest = -1;
        for (const auto& existing : db.get_requests_in_collection (owner)) {
            highest = std::max (highest, existing.order);
        }
        plan.next_request_order.emplace (owner, highest + 1);
    }
    return {};
}

/**
 * A created request's example rows.
 *
 * A created request is the request an import of this document would build,
 * examples included, so its rows are read off the document rather than sent
 * (issue #869) - and there is no decision to make, the way there is on an
 * update: nothing exists behind it to leave alone. A request the payload creates
 * with no identity is not an operation of anything and documents nothing.
 */
RouteResult plan_created_examples (const vayu::db::Request& row,
const std::string& temp,
int64_t now,
DocumentedExamples& documented,
SyncPlan& plan) {
    if (!row.spec_operation) {
        return {};
    }
    const auto rows = documented.rows_for (*row.spec_operation);
    if (!rows) {
        return std::unexpected (item_error (400,
        "Invalid 'specOperation': the document being synced "
        "declares no such "
        "operation, so there is nothing to create for it",
        temp));
    }
    return build_example_rows (*rows, row.id, temp,
    /*base_order=*/0, now, plan.batch.examples, /*surviving=*/0);
}

/** One created request, claimed and built. */
RouteResult plan_created_request (vayu::db::Database& db,
const nlohmann::json& item,
size_t index,
const SyncScope& scope,
DocumentedExamples& documented,
SyncPlan& plan) {
    std::string temp;
    if (auto outcome =
        claim_temp_id (item, "request", "req_", index, plan.claimed.real, temp);
    !outcome) {
        return outcome;
    }
    if (item.contains ("examples")) {
        return std::unexpected (item_error (400,
        "Invalid 'examples': a sync writes the responses the document "
        "it stores "
        "documents; omit it",
        temp));
    }

    std::string owner;
    if (auto outcome = resolve_create_owner (db, item, temp, scope, plan, owner); !outcome) {
        return outcome;
    }

    nlohmann::json fields  = item;
    fields["collectionId"] = owner;
    fields.erase ("collectionTempId");

    vayu::db::Request row;
    row.id         = plan.claimed.real.at (temp);
    row.created_at = scope.now;
    row.updated_at = scope.now;
    if (auto outcome = apply_item_fields (
        [&] { return apply_request_fields (db, row, fields, /*is_create=*/true); },
        "request", temp);
    !outcome) {
        return outcome;
    }
    if (!item.contains ("order") || item["order"].is_null ()) {
        row.order = plan.next_request_order[owner]++;
    }
    if (auto outcome = plan_created_examples (row, temp, scope.now, documented, plan); !outcome) {
        return outcome;
    }
    plan.batch.created.push_back (std::move (row));
    return {};
}

/**
 * Whether an updated request's imported examples are refreshed from the
 * document being stored.
 *
 * `examples` is a decision, not a list (issue #869): true refreshes this
 * request's imported examples from the document being stored, and absent - or
 * false - leaves every one of them alone. Absence is the default because it is
 * the state that touches nothing: a caller that forgets the key leaves a user's
 * rows where they are, where a forgotten list used to mean "the document
 * documents nothing".
 */
RouteResult
read_examples_decision (const nlohmann::json& item, const std::string& id, bool& refresh) {
    refresh = false;
    const auto decision = item.find ("examples");
    if (decision == item.end () || decision->is_null ()) {
        return {};
    }
    if (!decision->is_boolean ()) {
        return std::unexpected (item_error (400,
        "Invalid 'examples': must be true to refresh this "
        "request's imported "
        "examples from the document being synced, or absent to "
        "leave them - a "
        "sync writes the responses the document documents, not "
        "rows you state",
        id));
    }
    refresh = decision->get<bool> ();
    return {};
}

/** The example rows a refreshed request's replace, and the ones they retire. */
RouteResult plan_refreshed_examples (vayu::db::Database& db,
const vayu::db::Request& row,
const std::string& id,
int64_t now,
DocumentedExamples& documented,
SyncPlan& plan) {
    if (!row.spec_operation) {
        return std::unexpected (item_error (400,
        "Invalid 'examples': this request records no operation, so "
        "the document "
        "documents no responses for it",
        id));
    }
    const auto rows = documented.rows_for (*row.spec_operation);
    if (!rows) {
        return std::unexpected (item_error (400,
        "Invalid 'examples': the document being synced declares no "
        "operation "
        "this request records, so it documents no responses for it",
        id));
    }
    const auto plan_for_examples = refresh_examples (
    db.get_request_examples (id), db.get_suppressed_request_examples (id));
    plan.batch.deleted_examples.insert (plan.batch.deleted_examples.end (),
    plan_for_examples.replaced.begin (), plan_for_examples.replaced.end ());
    return build_example_rows (*rows, id, id, plan_for_examples.base_order, now,
    plan.batch.examples, plan_for_examples.surviving,
    plan_for_examples.suppressed_statuses);
}

/** One updated request: the row it names, merge-patched. */
RouteResult plan_updated_request (vayu::db::Database& db,
const nlohmann::json& item,
size_t index,
const SyncScope& scope,
DocumentedExamples& documented,
SyncPlan& plan) {
    if (!item.is_object ()) {
        return std::unexpected (body_error (
        "Invalid update at index " + std::to_string (index) + ": must be an object"));
    }
    if (!item.contains ("id") || !item["id"].is_string () ||
    item["id"].get<std::string> ().empty ()) {
        return std::unexpected (body_error ("Invalid update at index " +
        std::to_string (index) + ": 'id' must be the id of a stored request"));
    }
    const std::string id = item["id"].get<std::string> ();
    if (!plan.touched.insert (id).second) {
        return std::unexpected (item_error (
        400, "Request '" + id + "' appears twice in this sync", id));
    }
    auto stored = db.get_request (id);
    if (!stored) {
        // The diff was computed against a row that has since gone. A
        // conflict, not a bad request: nothing about the payload is
        // malformed, the ground moved under it.
        return std::unexpected (
        item_error (409, "Request '" + id + "' no longer exists", id));
    }
    if (!scope.subtree.contains (stored->collection_id)) {
        return std::unexpected (item_error (400,
        "Request '" + id + "' is not beneath the collection being synced", id));
    }
    if (item.contains ("collectionId")) {
        return std::unexpected (item_error (400,
        "Invalid 'collectionId': a sync updates a request where it is; "
        "move it with "
        "PUT /requests/:id",
        id));
    }

    vayu::db::Request row = *stored;
    row.updated_at        = scope.now;
    if (auto outcome = apply_item_fields (
        [&] { return apply_request_fields (db, row, item, /*is_create=*/false); },
        "request", id);
    !outcome) {
        return outcome;
    }

    bool refresh = false;
    if (auto outcome = read_examples_decision (item, id, refresh); !outcome) {
        return outcome;
    }
    if (refresh) {
        if (auto outcome = plan_refreshed_examples (db, row, id, scope.now, documented, plan);
        !outcome) {
            return outcome;
        }
    }
    plan.batch.updated.push_back (std::move (row));
    return {};
}

/** One deleted request id, checked against the subtree it must live in. */
RouteResult plan_deleted_request (vayu::db::Database& db,
const nlohmann::json& item,
size_t index,
const SyncScope& scope,
SyncPlan& plan) {
    if (!item.is_string () || item.get<std::string> ().empty ()) {
        return std::unexpected (body_error ("Invalid delete at index " +
        std::to_string (index) + ": must be the id of a stored request"));
    }
    const std::string id = item.get<std::string> ();
    if (!plan.touched.insert (id).second) {
        return std::unexpected (item_error (
        400, "Request '" + id + "' appears twice in this sync", id));
    }
    auto stored = db.get_request (id);
    if (!stored) {
        // Already gone is the state the caller asked for. Skipped rather
        // than refused: a delete is the one item whose goal a concurrent
        // write can only have achieved.
        return {};
    }
    if (!scope.subtree.contains (stored->collection_id)) {
        return std::unexpected (item_error (400,
        "Request '" + id + "' is not beneath the collection being synced", id));
    }
    plan.batch.deleted.push_back (id);
    return {};
}

/** Every section of the payload, in the order the batch is built. */
RouteResult plan_sync_rows (vayu::db::Database& db,
const SyncRequest& request,
const SyncScope& scope,
DocumentedExamples& documented,
SyncPlan& plan) {
    for (size_t i = 0; i < request.new_collections->size (); ++i) {
        if (auto outcome = plan_folder (
            db, (*request.new_collections)[i], i, request, scope, plan);
        !outcome) {
            return outcome;
        }
    }
    for (size_t i = 0; i < request.creates->size (); ++i) {
        if (auto outcome = plan_created_request (
            db, (*request.creates)[i], i, scope, documented, plan);
        !outcome) {
            return outcome;
        }
    }
    for (size_t i = 0; i < request.updates->size (); ++i) {
        if (auto outcome = plan_updated_request (
            db, (*request.updates)[i], i, scope, documented, plan);
        !outcome) {
            return outcome;
        }
    }
    for (size_t i = 0; i < request.deletes->size (); ++i) {
        if (auto outcome =
            plan_deleted_request (db, (*request.deletes)[i], i, scope, plan);
        !outcome) {
            return outcome;
        }
    }
    return {};
}

/**
 * The whole write, under the lock its caller holds.
 *
 * Read-decide-write in one scope, on `delete_spec_document`'s rule (#386): the
 * subtree this payload is allowed to touch, the rows it says exist and the write
 * itself have to be one scope, or a concurrent delete lands between the check
 * and the commit and the batch writes against a tree that has moved.
 */
std::pair<int, nlohmann::json>
apply_sync_locked (vayu::db::Database& db, SyncRequest& request) {
    SyncScope scope;
    if (auto outcome = resolve_sync_scope (db, request, scope); !outcome) {
        return as_response (outcome.error ());
    }

    SyncPlan plan;
    nlohmann::ordered_json document;
    if (auto outcome = read_sync_document (request, scope, plan.batch.spec, document);
    !outcome) {
        return as_response (outcome.error ());
    }
    DocumentedExamples documented (document);

    nlohmann::json policy_rows;
    if (auto outcome = plan_policy_rows (db, scope, document, request, policy_rows);
    !outcome) {
        return as_response (outcome.error ());
    }

    if (auto outcome = plan_sync_rows (db, request, scope, documented, plan); !outcome) {
        return as_response (outcome.error ());
    }

    // The same limit as the payload check before the lock, applied to what will
    // actually be written: the example rows are derived rather than sent (issue
    // #869), so this is where their number is finally known, and a cap that
    // stopped counting them would bound a smaller transaction than the one it
    // was written for.
    if (const size_t writing = request.stated + plan.batch.examples.size ();
    writing > MAX_SYNC_ITEMS) {
        return as_response (body_error ("Sync too large: " + std::to_string (writing) +
        " items exceeds the limit of " + std::to_string (MAX_SYNC_ITEMS) + " per call"));
    }

    // The binding moves with the rows.
    plan.batch.binding         = scope.root;
    plan.batch.binding.openapi = nlohmann::json{ { "specId", plan.batch.spec.id },
        { "specHash", plan.batch.spec.hash }, { "syncedAt", scope.now } }
                                 .dump ();
    plan.batch.binding.updated_at = scope.now;

    db.spec_sync_apply (plan.batch);
    nlohmann::json response{ { "idMap", plan.claimed.real },
        { "specId", plan.batch.spec.id }, { "specHash", plan.batch.spec.hash },
        { "syncedAt", scope.now }, { "created", plan.batch.created.size () },
        { "updated", plan.batch.updated.size () },
        { "deleted", plan.batch.deleted.size () } };
    if (!request.policy.empty ()) {
        // What the policy declined, for a caller that stated no ticks and so
        // cannot see what it did not tick. Absent for an explicit payload,
        // where nothing was declined - the caller chose the rows itself.
        response["skipped"] = policy_rows["skipped"];
    }
    return { 200, std::move (response) };
}

} // namespace

/**
 * Testable core of `POST /specs/sync`, returning {http_status, json_body}.
 */
std::pair<int, nlohmann::json>
spec_sync_response (vayu::db::Database& db, const nlohmann::json& body) {
    SyncRequest request;
    if (auto outcome = read_sync_request (body, request); !outcome) {
        return as_response (outcome.error ());
    }

    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] { result = apply_sync_locked (db, request); });
    return result;
}

void register_spec_sync_routes (RouteContext& ctx) {
    /**
     * POST /specs/sync
     * Applies a re-fetched OpenAPI document to the collection bound to it, in
     * one transaction: the document is stored, the binding moves to it, and the
     * requests the caller selected are created, updated and deleted together.
     * Body params: collectionId (the bound collection), spec ({content,
     * sourceUrl?} - `id`, `hash` and `fetchedAt` are engine-computed and
     * rejected), policy ("safe" - apply the ticks a caller with no opinion would
     * make, which is every operation the document adds, every field it moved
     * that nobody here had edited, and no deletions; the engine works the rows
     * out itself and the four sections below are then rejected), collections
     * (new tag folders, each with a `tempId` and an
     * optional `parentId` inside the synced subtree), create (requests, each
     * with a `tempId` and either `collectionId` or `collectionTempId`; the
     * examples come from the document, so `examples` is rejected), update
     * (requests by `id`, merge-patch, with an optional boolean `examples` -
     * true refreshes this request's imported examples from the document being
     * stored, never the saved ones and never a status the user deleted; absent
     * leaves every example alone), delete (request ids).
     * Returns: 200 `{idMap, specId, specHash, syncedAt, created, updated,
     * deleted}`; 400 (with `error.item`) for a payload this cannot apply, 404
     * for an unknown collection, 409 when a row the diff was computed against
     * has since gone. Nothing is written unless all of it is.
     */
    ctx.server.Post (
    "/specs/sync", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const std::exception& e) {
            vayu::utils::log_warning (
            "POST /specs/sync - invalid JSON body: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON body");
            return;
        }
        try {
            auto [status, response] = spec_sync_response (ctx.db, body);
            if (status != 200) {
                vayu::utils::log_warning ("POST /specs/sync - " +
                std::to_string (status) + ": " + error_message_of (response));
            } else {
                vayu::utils::log_info ("POST /specs/sync - applied to spec " +
                response["specId"].get<std::string> () + ": +" +
                std::to_string (response["created"].get<size_t> ()) + " ~" +
                std::to_string (response["updated"].get<size_t> ()) + " -" +
                std::to_string (response["deleted"].get<size_t> ()));
            }
            res.status = status;
            res.set_content (response.dump (), "application/json");
        } catch (const vayu::db::MissingRowError& e) {
            // The existence checks run under the same lock as the write, so this
            // is the narrow window a retry after a busy database opens. Still a
            // conflict rather than a 500: nothing was written, and re-checking is
            // exactly what the client should do.
            vayu::utils::log_warning (
            "POST /specs/sync - 409: " + std::string (e.what ()));
            send_error (res, 409, e.what ());
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /specs/sync - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
