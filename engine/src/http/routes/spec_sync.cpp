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
 * The renderer works out *what* moved (`services/openapi/spec-diff.ts`, #654)
 * and which of it the user ticked; this applies exactly that and decides
 * nothing about the document itself. What it does own is every rule a client
 * must not be trusted with:
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
 *
 * Deliberately **not** an extension of `/import/apply`: that route creates, and
 * only creates, which is what lets it assign every id and validate a payload
 * with nothing stored behind it. A sync updates and deletes rows that already
 * exist, against a subtree it must first prove it owns. Folding the two
 * together would put "POST creates" - the rule the whole resource API is built
 * on (#95) - inside a conditional.
 */

#include "vayu/core/constants.hpp"
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
std::unordered_set<std::string> collection_subtree_ids (const std::vector<vayu::db::Collection>& all,
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

namespace {

/**
 * Cap on rows per call, the same bound and the same reasoning as
 * `/import/apply`'s: the whole payload becomes rows in memory before anything
 * is written, and a sync of a collection larger than this is not a sync.
 */
constexpr size_t MAX_SYNC_ITEMS = 10000;

/** Absent or null section - a stable empty list to hand out. */
const nlohmann::json EMPTY_ITEMS = nlohmann::json::array ();

std::pair<int, nlohmann::json> body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/**
 * An error that names the offending item, in the same place `/import/apply`
 * puts it (inside the error object, next to the code and message) so a client
 * reads one shape for both bulk endpoints. The name is a `tempId` for a row
 * being created and the real id for one being updated or deleted - in both
 * cases the only handle the caller has on it.
 */
std::pair<int, nlohmann::json>
item_error (int status, const std::string& message, const std::string& item) {
    auto body             = error_body (status, message);
    body["error"]["item"] = item;
    return { status, body };
}

/** Reads one optional top-level array; anything else that is not an array is a 400. */
std::optional<std::pair<int, nlohmann::json>>
read_items (const nlohmann::json& body, const char* key, const nlohmann::json*& out) {
    out = &EMPTY_ITEMS;
    if (!body.contains (key) || body[key].is_null ()) {
        return std::nullopt;
    }
    if (!body[key].is_array ()) {
        return body_error (std::string ("Invalid '") + key + "': must be an array");
    }
    out = &body[key];
    return std::nullopt;
}

/** Turns an applier's failure - its own error body, or a json type error - into a 400. */
template <typename Apply>
std::optional<std::pair<int, nlohmann::json>>
apply_item_fields (Apply apply, const char* kind, const std::string& item) {
    std::optional<std::pair<int, nlohmann::json>> err;
    try {
        err = apply ();
    } catch (const nlohmann::json::exception& e) {
        return item_error (400, std::string ("Invalid ") + kind + ": " + e.what (), item);
    }
    if (err) {
        err->second["error"]["item"] = item;
        return err;
    }
    return std::nullopt;
}

/** The `specId` a collection's binding names, or "" when it is bound to nothing. */
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

/** Validates a `tempId`, rejects a client-supplied `id`, and claims a real one. */
std::optional<std::pair<int, nlohmann::json>> claim_temp_id (const nlohmann::json& item,
const char* kind,
const char* prefix,
size_t index,
std::unordered_map<std::string, std::string>& id_map,
std::string& temp_id_out) {
    const std::string at = std::string (kind) + " at index " + std::to_string (index);
    if (!item.is_object ()) {
        return body_error ("Invalid " + at + ": must be an object");
    }
    if (item.contains ("id")) {
        return body_error ("Invalid " + at +
        ": 'id' is not accepted - the engine assigns ids; reference items by 'tempId'");
    }
    if (!item.contains ("tempId") || !item["tempId"].is_string () ||
    item["tempId"].get<std::string> ().empty ()) {
        return body_error ("Invalid " + at + ": 'tempId' must be a non-empty string");
    }
    temp_id_out = item["tempId"].get<std::string> ();
    if (id_map.contains (temp_id_out)) {
        return item_error (400, "Duplicate tempId '" + temp_id_out + "'", temp_id_out);
    }
    id_map.emplace (temp_id_out, vayu::utils::generate_id (prefix));
    return std::nullopt;
}

/**
 * The example rows one payload item carries, through the same applier every
 * other example write uses.
 *
 * `origin` is fixed to `import` here, and an explicit one is a 400: a sync
 * writes what the document says, and a payload that could claim `user` could
 * manufacture rows the *next* sync then refuses to replace - quietly turning
 * the protection this route exists to provide into a leak.
 *
 * @param suppressed_statuses the statuses this request holds a tombstone for
 * (issue #722) - the document's example for one of them is validated like any
 * other and then dropped, because the user deleted it and a sync that wrote it
 * back would make that delete a suggestion. Empty on the create path: a
 * request being created now has nothing behind it to have deleted.
 */
std::optional<std::pair<int, nlohmann::json>> build_example_rows (const nlohmann::json& item,
const std::string& request_id,
const std::string& owner,
int base_order,
int64_t now,
std::vector<vayu::db::RequestExample>& out,
size_t surviving,
const std::unordered_set<int>& suppressed_statuses = {}) {
    if (!item.contains ("examples") || item["examples"].is_null ()) {
        return std::nullopt;
    }
    if (!item["examples"].is_array ()) {
        return item_error (400, "Invalid 'examples': must be an array", owner);
    }
    const auto& examples = item["examples"];
    // Against what will be written rather than what was offered: a tombstoned
    // example never lands, so counting it here would refuse a sync that fits.
    std::vector<vayu::db::RequestExample> rows;
    rows.reserve (examples.size ());

    for (size_t i = 0; i < examples.size (); ++i) {
        const auto& example = examples[i];
        if (!example.is_object ()) {
            return item_error (400, "Invalid example: must be an object", owner);
        }
        if (example.contains ("id")) {
            return item_error (400,
            "Invalid example: 'id' is not accepted - the engine assigns ids", owner);
        }
        if (example.contains ("origin")) {
            return item_error (400,
            "Invalid example: 'origin' is not accepted - a sync writes imported examples, "
            "and the ones you saved yourself are never replaced",
            owner);
        }

        vayu::db::RequestExample x;
        x.id         = vayu::utils::generate_id ("exa_");
        x.request_id = request_id;
        x.created_at = now;
        x.updated_at = now;

        if (auto err = apply_item_fields (
            [&] { return apply_request_example_fields (x, example, /*is_create=*/true); },
            "example", owner)) {
            return err;
        }
        // Validated first and dropped second, so a malformed example the user
        // happens to have deleted is still a 400 rather than a silent skip.
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
        return item_error (400,
        "Too many examples: " + std::to_string (rows.size () + surviving) +
        " exceeds the limit of " +
        std::to_string (vayu::core::constants::request_example::MAX_PER_REQUEST) + " per request",
        owner);
    }
    out.insert (out.end (), std::make_move_iterator (rows.begin ()),
    std::make_move_iterator (rows.end ()));
    return std::nullopt;
}

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
    int base_order = 0;                ///< Where the replacement block starts.
    size_t surviving = 0;              ///< User rows, which stay exactly as they are.
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
            lowest_import = lowest_import ? std::min (*lowest_import, row.order) : row.order;
        } else {
            plan.surviving += 1;
        }
    }
    plan.base_order = lowest_import ? *lowest_import : highest + 1;
    return plan;
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
    std::unordered_set<std::string> collections;       ///< Which of them are folders.
};

} // namespace

/**
 * Testable core of `POST /specs/sync`, returning {http_status, json_body}.
 *
 * Read-decide-write under one lock, on `delete_spec_document`'s rule (#386):
 * the subtree this payload is allowed to touch, the rows it says exist and the
 * write itself have to be one scope, or a concurrent delete lands between the
 * check and the commit and the batch writes against a tree that has moved.
 */
std::pair<int, nlohmann::json>
spec_sync_response (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return body_error ("Body must be a JSON object");
    }

    std::string collection_id;
    if (auto err = apply_required_string_field (body, "collectionId", collection_id, /*is_create=*/true)) {
        return *err;
    }
    if (collection_id.empty ()) {
        return body_error ("Invalid 'collectionId': must be a non-empty string");
    }

    if (!body.contains ("spec") || !body["spec"].is_object ()) {
        return body_error ("Invalid 'spec': must be an object with the re-fetched document");
    }
    const auto& spec_item = body["spec"];
    for (const char* engine_owned : { "id", "hash", "fetchedAt" }) {
        if (spec_item.contains (engine_owned)) {
            return body_error (std::string ("Invalid 'spec.") + engine_owned +
            "': computed by the engine; omit it");
        }
    }
    std::string content;
    if (auto err = apply_required_string_field (spec_item, "content", content, /*is_create=*/true)) {
        return *err;
    }
    if (content.empty ()) {
        return body_error ("Invalid 'spec.content': an empty document is not a spec");
    }

    const nlohmann::json* new_collections = nullptr;
    const nlohmann::json* creates         = nullptr;
    const nlohmann::json* updates         = nullptr;
    const nlohmann::json* deletes         = nullptr;
    if (auto err = read_items (body, "collections", new_collections)) {
        return *err;
    }
    if (auto err = read_items (body, "create", creates)) {
        return *err;
    }
    if (auto err = read_items (body, "update", updates)) {
        return *err;
    }
    if (auto err = read_items (body, "delete", deletes)) {
        return *err;
    }

    size_t nested_examples = 0;
    for (const auto* section : { creates, updates }) {
        for (const auto& item : *section) {
            if (item.is_object () && item.contains ("examples") && item["examples"].is_array ()) {
                nested_examples += item["examples"].size ();
            }
        }
    }
    const size_t total = new_collections->size () + creates->size () + updates->size () +
    deletes->size () + nested_examples;
    if (total > MAX_SYNC_ITEMS) {
        return body_error ("Sync too large: " + std::to_string (total) +
        " items exceeds the limit of " + std::to_string (MAX_SYNC_ITEMS) + " per call");
    }

    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] {
        const auto stored_collections = db.get_collections ();
        auto root = std::find_if (stored_collections.begin (), stored_collections.end (),
        [&] (const vayu::db::Collection& c) { return c.id == collection_id; });
        if (root == stored_collections.end ()) {
            result = { 404, error_body (404, "Collection not found") };
            return;
        }
        if (bound_spec_id (root->openapi).empty ()) {
            result = body_error ("Collection '" + collection_id +
            "' is not bound to a spec; bind it before syncing");
            return;
        }
        const auto subtree = collection_subtree_ids (stored_collections, collection_id);

        const size_t cap = spec_size_cap (db);
        if (content.size () > cap) {
            result = body_error ("Spec document is " + std::to_string (content.size ()) +
            " bytes, over the limit of " + std::to_string (cap) +
            " (raise the 'maxSpecDocumentBytes' setting to allow more)");
            return;
        }

        const int64_t now = now_ms ();
        vayu::db::SpecSyncBatch batch;
        batch.spec.id         = vayu::utils::generate_id ("spec_");
        batch.spec.content    = content;
        batch.spec.hash       = spec_content_hash (content);
        batch.spec.fetched_at = now;
        if (auto reason = read_spec_indexes (spec_item, batch.spec, cap)) {
            result = body_error (*reason);
            return;
        }
        if (spec_item.contains ("sourceUrl") && !spec_item["sourceUrl"].is_null ()) {
            if (!spec_item["sourceUrl"].is_string ()) {
                result = body_error ("Invalid 'spec.sourceUrl': must be a string or null");
                return;
            }
            const auto url = spec_item["sourceUrl"].get<std::string> ();
            if (!url.empty ()) {
                batch.spec.source_url = url;
            }
        }

        // ---- new tag folders -------------------------------------------------
        ClaimedIds claimed;
        // Parent id -> the next `order` to hand out, seeded from the stored
        // siblings by the applier and advanced here: the applier computes its
        // default from rows that exist, so two folders created in one payload
        // would otherwise land on the same number (the same reason
        // `/import/apply` hands out its own slots).
        std::unordered_map<std::string, int> next_folder_order;
        for (size_t i = 0; i < new_collections->size (); ++i) {
            const auto& item = (*new_collections)[i];
            std::string temp;
            if (auto err = claim_temp_id (item, "collection", "col_", i, claimed.real, temp)) {
                result = *err;
                return;
            }
            claimed.collections.insert (temp);

            if (item.contains ("openapi")) {
                result = item_error (400,
                "Invalid 'openapi': a folder a sync creates is part of the document being "
                "synced, not a document of its own",
                temp);
                return;
            }

            nlohmann::json fields = item;
            std::string parent    = collection_id;
            if (item.contains ("parentId") && !item["parentId"].is_null ()) {
                if (!item["parentId"].is_string ()) {
                    result = item_error (400, "Invalid 'parentId': must be a string", temp);
                    return;
                }
                parent = item["parentId"].get<std::string> ();
                if (!subtree.contains (parent)) {
                    result = item_error (400,
                    "Invalid 'parentId': '" + parent +
                    "' is not the collection being synced or one beneath it",
                    temp);
                    return;
                }
            }
            fields["parentId"] = parent;

            vayu::db::Collection folder;
            folder.id         = claimed.real.at (temp);
            folder.created_at = now;
            folder.updated_at = now;
            if (auto err = apply_item_fields (
                [&] { return apply_collection_fields (db, folder, fields, /*is_create=*/true); },
                "collection", temp)) {
                result = *err;
                return;
            }
            if (!item.contains ("order") || item["order"].is_null ()) {
                auto slot    = next_folder_order.try_emplace (parent, folder.order).first;
                folder.order = slot->second++;
            }
            batch.new_collections.push_back (std::move (folder));
        }

        // ---- created requests -------------------------------------------------
        std::unordered_map<std::string, int> next_request_order;
        for (size_t i = 0; i < creates->size (); ++i) {
            const auto& item = (*creates)[i];
            std::string temp;
            if (auto err = claim_temp_id (item, "request", "req_", i, claimed.real, temp)) {
                result = *err;
                return;
            }

            nlohmann::json fields = item;
            std::string owner;
            if (item.contains ("collectionTempId") && !item["collectionTempId"].is_null ()) {
                if (!item["collectionTempId"].is_string ()) {
                    result = item_error (400, "Invalid 'collectionTempId': must be a string", temp);
                    return;
                }
                const auto named = item["collectionTempId"].get<std::string> ();
                if (!claimed.collections.contains (named)) {
                    result = item_error (400,
                    "Unknown collectionTempId '" + named + "'", temp);
                    return;
                }
                if (item.contains ("collectionId")) {
                    result = item_error (400,
                    "Invalid request: send either 'collectionTempId' (a folder in this "
                    "payload) or 'collectionId' (one already stored), not both",
                    temp);
                    return;
                }
                owner = claimed.real.at (named);
                // A folder this payload creates has no stored siblings to scan.
                next_request_order.try_emplace (owner, 0);
            } else {
                if (!item.contains ("collectionId") || !item["collectionId"].is_string ()) {
                    result = item_error (400,
                    "Invalid 'collectionId': must name a collection beneath the one being "
                    "synced, or use 'collectionTempId'",
                    temp);
                    return;
                }
                owner = item["collectionId"].get<std::string> ();
                if (!subtree.contains (owner)) {
                    result = item_error (400,
                    "Invalid 'collectionId': '" + owner +
                    "' is not the collection being synced or one beneath it",
                    temp);
                    return;
                }
                if (!next_request_order.contains (owner)) {
                    int highest = -1;
                    for (const auto& existing : db.get_requests_in_collection (owner)) {
                        highest = std::max (highest, existing.order);
                    }
                    next_request_order.emplace (owner, highest + 1);
                }
            }
            fields["collectionId"] = owner;
            fields.erase ("collectionTempId");

            vayu::db::Request row;
            row.id         = claimed.real.at (temp);
            row.created_at = now;
            row.updated_at = now;
            if (auto err = apply_item_fields (
                [&] { return apply_request_fields (db, row, fields, /*is_create=*/true); },
                "request", temp)) {
                result = *err;
                return;
            }
            if (!item.contains ("order") || item["order"].is_null ()) {
                row.order = next_request_order[owner]++;
            }
            if (auto err = build_example_rows (item, row.id, temp, /*base_order=*/0, now,
                batch.examples, /*surviving=*/0)) {
                result = *err;
                return;
            }
            batch.created.push_back (std::move (row));
        }

        // ---- updated requests -------------------------------------------------
        std::unordered_set<std::string> touched;
        for (size_t i = 0; i < updates->size (); ++i) {
            const auto& item = (*updates)[i];
            if (!item.is_object ()) {
                result = body_error ("Invalid update at index " + std::to_string (i) +
                ": must be an object");
                return;
            }
            if (!item.contains ("id") || !item["id"].is_string () ||
            item["id"].get<std::string> ().empty ()) {
                result = body_error ("Invalid update at index " + std::to_string (i) +
                ": 'id' must be the id of a stored request");
                return;
            }
            const std::string id = item["id"].get<std::string> ();
            if (!touched.insert (id).second) {
                result = item_error (400, "Request '" + id + "' appears twice in this sync", id);
                return;
            }
            auto stored = db.get_request (id);
            if (!stored) {
                // The diff was computed against a row that has since gone. A
                // conflict, not a bad request: nothing about the payload is
                // malformed, the ground moved under it.
                result = item_error (409, "Request '" + id + "' no longer exists", id);
                return;
            }
            if (!subtree.contains (stored->collection_id)) {
                result = item_error (400,
                "Request '" + id + "' is not beneath the collection being synced", id);
                return;
            }
            if (item.contains ("collectionId")) {
                result = item_error (400,
                "Invalid 'collectionId': a sync updates a request where it is; move it with "
                "PUT /requests/:id",
                id);
                return;
            }

            vayu::db::Request row = *stored;
            row.updated_at        = now;
            if (auto err = apply_item_fields (
                [&] { return apply_request_fields (db, row, item, /*is_create=*/false); },
                "request", id)) {
                result = *err;
                return;
            }

            if (item.contains ("examples") && !item["examples"].is_null ()) {
                const auto plan = refresh_examples (db.get_request_examples (id),
                db.get_suppressed_request_examples (id));
                batch.deleted_examples.insert (batch.deleted_examples.end (),
                plan.replaced.begin (), plan.replaced.end ());
                if (auto err = build_example_rows (item, id, id, plan.base_order, now,
                    batch.examples, plan.surviving, plan.suppressed_statuses)) {
                    result = *err;
                    return;
                }
            }
            batch.updated.push_back (std::move (row));
        }

        // ---- deleted requests -------------------------------------------------
        for (size_t i = 0; i < deletes->size (); ++i) {
            const auto& item = (*deletes)[i];
            if (!item.is_string () || item.get<std::string> ().empty ()) {
                result = body_error ("Invalid delete at index " + std::to_string (i) +
                ": must be the id of a stored request");
                return;
            }
            const std::string id = item.get<std::string> ();
            if (!touched.insert (id).second) {
                result = item_error (400, "Request '" + id + "' appears twice in this sync", id);
                return;
            }
            auto stored = db.get_request (id);
            if (!stored) {
                // Already gone is the state the caller asked for. Skipped rather
                // than refused: a delete is the one item whose goal a concurrent
                // write can only have achieved.
                continue;
            }
            if (!subtree.contains (stored->collection_id)) {
                result = item_error (400,
                "Request '" + id + "' is not beneath the collection being synced", id);
                return;
            }
            batch.deleted.push_back (id);
        }

        // ---- the binding moves with the rows ----------------------------------
        batch.binding            = *root;
        batch.binding.openapi    = nlohmann::json{ { "specId", batch.spec.id },
            { "specHash", batch.spec.hash },
            { "syncedAt", now } }
                                   .dump ();
        batch.binding.updated_at = now;

        db.spec_sync_apply (batch);
        result = { 200,
            nlohmann::json{ { "idMap", claimed.real },
                { "specId", batch.spec.id },
                { "specHash", batch.spec.hash },
                { "syncedAt", now },
                { "created", batch.created.size () },
                { "updated", batch.updated.size () },
                { "deleted", batch.deleted.size () } } };
    });
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
     * rejected), collections (new tag folders, each with a `tempId` and an
     * optional `parentId` inside the synced subtree), create (requests, each
     * with a `tempId` and either `collectionId` or `collectionTempId`, and
     * optional `examples`), update (requests by `id`, merge-patch, with
     * optional `examples` which replace the imported ones, never the saved
     * ones, and never a status the user deleted), delete (request ids).
     * Returns: 200 `{idMap, specId, specHash, syncedAt, created, updated,
     * deleted}`; 400 (with `error.item`) for a payload this cannot apply, 404
     * for an unknown collection, 409 when a row the diff was computed against
     * has since gone. Nothing is written unless all of it is.
     */
    ctx.server.Post ("/specs/sync", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const std::exception& e) {
            vayu::utils::log_warning ("POST /specs/sync - invalid JSON body: " +
            std::string (e.what ()));
            send_error (res, 400, "Invalid JSON body");
            return;
        }
        try {
            auto [status, response] = spec_sync_response (ctx.db, body);
            if (status != 200) {
                vayu::utils::log_warning ("POST /specs/sync - " + std::to_string (status) + ": " +
                error_message_of (response));
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
            vayu::utils::log_warning ("POST /specs/sync - 409: " + std::string (e.what ()));
            send_error (res, 409, e.what ());
        } catch (const std::exception& e) {
            vayu::utils::log_error ("POST /specs/sync - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
