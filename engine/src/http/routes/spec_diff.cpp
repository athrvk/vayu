/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/spec_diff.cpp
 * @brief `POST /specs/diff` - what a re-fetched document would change about the
 *        collection bound to it (issue #654's comparison, moved engine-side by
 *        #854).
 *
 * The read half of the sync. `POST /specs/sync` has always applied a diff
 * atomically and decided nothing: the renderer worked out what moved and the
 * engine wrote exactly what it was told, which put the whole Sync section out of
 * reach of everything that is not the Spec tab - MCP first among them. The rule
 * itself is `core/spec_diff.hpp`; this is the one way to ask it, and it owns the
 * three things a caller must not be trusted with:
 *
 * - **Which requests are compared.** The whole subtree of the bound collection,
 *   through the same `collection_subtree_requests` walk `POST /specs/sync`
 *   bounds its writes by - an OpenAPI import files its requests under one
 *   sub-collection per tag, so a caller passing "the collection's requests"
 *   would compare against a set that excludes almost all of them and report a
 *   collection as untouched by a document that rewrote it.
 * - **What the collection is bound to.** The bound document is read from the
 *   store by the binding, never sent: the three-way user-touched rule rests on
 *   the *bound* values being the ones actually stored, and a caller that could
 *   supply them could - by accident, with a stale copy - turn every one of its
 *   own edits into "the document did this".
 * - **Whether anything changed at all.** `identical` is decided on the stored
 *   bytes, the same bytes `spec_documents.hash` is over, rather than on a hash
 *   the caller computed.
 *
 * It writes nothing: no document is stored, no binding moved, no stamp written,
 * so a caller may ask about a document it has not decided to apply - and the
 * apply is `POST /specs/sync`, which re-reads everything rather than being
 * handed this answer, exactly as `POST /specs/bind` re-matches rather than
 * trusting `POST /specs/match`. What the two share is the rule, not a result
 * carried between them.
 */

#include "vayu/core/spec_diff.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <optional>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

std::pair<int, nlohmann::json> body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/// JavaScript truthiness, which is what the renderer's comparison read a row's
/// `enabled` with - an absent or `false` flag is off, and every other stored
/// value is on.
bool truthy (const nlohmann::json* node) {
    if (node == nullptr || node->is_null ()) {
        return false;
    }
    if (node->is_boolean ()) {
        return node->get<bool> ();
    }
    if (node->is_string ()) {
        return !node->get_ref<const std::string&> ().empty ();
    }
    if (node->is_number ()) {
        return node->get<double> () != 0.0;
    }
    return true;
}

const nlohmann::json* prop (const nlohmann::json& node, const char* key) {
    const auto found = node.find (key);
    return found == node.end () ? nullptr : &*found;
}

std::string text_of (const nlohmann::json& node, const char* key) {
    const nlohmann::json* value = prop (node, key);
    return value != nullptr && value->is_string () ? value->get<std::string> () :
                                                     std::string ();
}

/** One stored key/value table (`requests.params` / `.headers`), as rows. */
std::vector<vayu::core::DraftField> read_rows (const std::string& blob) {
    std::vector<vayu::core::DraftField> rows;
    const auto parsed = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_array ()) {
        return rows;
    }
    for (const auto& entry : parsed) {
        if (!entry.is_object ()) {
            continue;
        }
        vayu::core::DraftField row;
        row.key         = text_of (entry, "key");
        row.value       = text_of (entry, "value");
        row.enabled     = truthy (prop (entry, "enabled"));
        row.description = text_of (entry, "description");
        row.file        = text_of (entry, "type") == "file";
        rows.push_back (std::move (row));
    }
    return rows;
}

/** A stored `requests.body`, as the comparison reads it. */
vayu::core::DraftBody read_body (const std::string& blob) {
    vayu::core::DraftBody body;
    const auto parsed = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_object ()) {
        return body; // `none`, which is what a body nothing can read declares.
    }
    body.mode = text_of (parsed, "mode");
    if (body.mode.empty ()) {
        body.mode = "none";
    }
    // A row whose mode names a payload but carries no `content` compares as
    // empty. JavaScript's template literal wrote the word "undefined" there;
    // that is a state no write can produce, and reproducing it would put a
    // sentinel in a user-visible diff.
    body.content = text_of (parsed, "content");
    if (const nlohmann::json* fields = prop (parsed, "fields");
    fields != nullptr && fields->is_array ()) {
        for (const auto& field : *fields) {
            if (!field.is_object ()) {
                continue;
            }
            vayu::core::DraftField row;
            row.key         = text_of (field, "key");
            row.value       = text_of (field, "value");
            row.enabled     = truthy (prop (field, "enabled"));
            row.description = text_of (field, "description");
            row.file        = text_of (field, "type") == "file";
            body.fields.push_back (std::move (row));
        }
    }
    return body;
}

/**
 * `requests.spec_operation`, or absent for a request that answers to none.
 *
 * Half an identity identifies nothing - the comparison follows a stamp by its
 * method and path when it has no id - so a row missing either is a request with
 * no operation rather than one with a partial match, the same reading
 * `POST /specs/export` gives the column.
 */
std::optional<vayu::core::DeclaredOperation> read_identity (
const std::optional<std::string>& blob) {
    if (!blob || blob->empty ()) {
        return std::nullopt;
    }
    const auto parsed = nlohmann::json::parse (*blob, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_object ()) {
        return std::nullopt;
    }
    vayu::core::DeclaredOperation identity;
    identity.operation_id = text_of (parsed, "operationId");
    identity.method       = text_of (parsed, "method");
    identity.path         = text_of (parsed, "path");
    if (identity.method.empty () || identity.path.empty ()) {
        return std::nullopt;
    }
    return identity;
}

/** One draft row, in the shape `requests.params` / `.headers` stores. */
nlohmann::json row_json (const vayu::core::DraftField& row) {
    nlohmann::json out{ { "key", row.key }, { "value", row.value },
        { "enabled", row.enabled } };
    if (!row.description.empty ()) {
        out["description"] = row.description;
    }
    if (row.file) {
        // A document names the upload, never the file: the part is written with
        // no path attached and the user picks one. `src` is present and empty
        // because that is the row an import writes, and a sync must not produce
        // a different one for the same operation.
        out["type"] = "file";
        out["src"]  = "";
    }
    return out;
}

nlohmann::json rows_json (const std::vector<vayu::core::DraftField>& rows) {
    nlohmann::json out = nlohmann::json::array ();
    for (const vayu::core::DraftField& row : rows) {
        out.push_back (row_json (row));
    }
    return out;
}

/**
 * The draft as this route reports it: the fields an apply writes, plus the
 * example rows it would refresh.
 *
 * `examples` is the one field here that is *not* sent back on an apply: since
 * issue #869 a sync derives the rows from the document it stores and the caller
 * states only whether to refresh them. It is still reported, because what an
 * apply would write to a request is exactly the kind of thing a preview exists
 * to show - and it is built by the one function that knows that shape, so what
 * is shown here and what is stored there cannot drift apart.
 */
nlohmann::json draft_json (const vayu::core::DraftRequest& draft) {
    nlohmann::json out = draft_request_fields_json (draft);
    out["examples"]    = draft_example_rows (draft.examples);
    return out;
}

nlohmann::json fields_json (const std::vector<vayu::core::SpecFieldDiff>& fields) {
    nlohmann::json out = nlohmann::json::array ();
    for (const vayu::core::SpecFieldDiff& field : fields) {
        out.push_back ({ { "field", vayu::core::spec_field_name (field.field) },
        { "current", field.current }, { "next", field.next },
        { "userTouched", field.user_touched } });
    }
    return out;
}

/** The wire spelling of every field a safe apply would write. */
nlohmann::json safe_fields_json (const std::vector<vayu::core::SpecField>& fields) {
    nlohmann::json out = nlohmann::json::array ();
    for (const vayu::core::SpecField field : fields) {
        out.push_back (vayu::core::spec_field_name (field));
    }
    return out;
}

} // namespace

nlohmann::json spec_operation_json (const vayu::core::DeclaredOperation& operation) {
    nlohmann::json out{ { "method", operation.method }, { "path", operation.path } };
    if (!operation.operation_id.empty ()) {
        // Absent rather than "", the spelling every other spec route answers
        // with: an operation that declares no `operationId` is not one whose id
        // is empty.
        out["operationId"] = operation.operation_id;
    }
    return out;
}

nlohmann::json draft_request_fields_json (const vayu::core::DraftRequest& draft) {
    nlohmann::json body{ { "mode", draft.body.mode } };
    if (draft.body.mode == "form-data" || draft.body.mode == "x-www-form-urlencoded") {
        body["fields"] = rows_json (draft.body.fields);
    } else if (draft.body.mode != "none") {
        body["content"] = draft.body.content;
    }
    return { { "name", draft.name }, { "description", draft.description },
        { "method", draft.method }, { "url", draft.url },
        { "params", rows_json (draft.params) },
        { "headers", rows_json (draft.headers) }, { "body", std::move (body) } };
}

std::optional<std::pair<int, nlohmann::json>> compare_bound_spec (vayu::db::Database& db,
const std::vector<vayu::db::Collection>& collections,
const std::unordered_set<std::string>& subtree,
const std::string& spec_id,
const nlohmann::ordered_json& fetched_document,
SpecComparison& out) {
    const auto stored = db.get_spec_document (spec_id);
    if (!stored) {
        return std::make_pair (409,
        error_body (409,
        "Collection is bound to spec '" + spec_id +
        "', which is not stored - rebind it before syncing"));
    }
    out.bound_content = stored->content;
    out.fetched       = vayu::core::spec_request_drafts_of (fetched_document);

    /*
     * A stored document that cannot be read is not a reason to refuse to say
     * what the *new* one declares. Every write path derives its indexes from the
     * document (issue #853), so this is only reachable for a row written before
     * that rule - and the honest answer there is the two-way comparison, with
     * `previousUnknown` on every changed request saying so per request.
     */
    const vayu::core::DocumentRead bound_read =
    vayu::core::read_document (stored->content);
    const std::optional<std::vector<vayu::core::SpecRequestDraft>> bound =
    bound_read.ok () ? std::optional<std::vector<vayu::core::SpecRequestDraft>> (
                       vayu::core::spec_request_drafts_of (bound_read.root)) :
                       std::nullopt;

    const std::vector<vayu::db::Request> stored_requests =
    collection_subtree_requests (db, collections, subtree);
    out.requests.reserve (stored_requests.size ());
    for (const auto& row : stored_requests) {
        vayu::core::ComparableRequest entry;
        entry.id          = row.id;
        entry.name        = row.name;
        entry.description = row.description;
        entry.method      = vayu::to_string (row.method);
        entry.url         = row.url;
        entry.params      = read_rows (row.params);
        entry.headers     = read_rows (row.headers);
        entry.body        = read_body (row.body);
        entry.operation   = read_identity (row.spec_operation);
        out.requests.push_back (std::move (entry));
    }

    out.diff =
    vayu::core::diff_spec (out.fetched, bound ? &*bound : nullptr, out.requests);
    return std::nullopt;
}

/**
 * Testable core of POST /specs/diff - the comparison, computed and returned,
 * nothing written.
 *
 * The three failures a caller can act on are told apart rather than folded into
 * one: a collection that does not exist is a 404, a collection that binds no
 * document is a 400 (there is nothing to compare against, and binding is a
 * different call), and a binding naming a document the store no longer holds is
 * a 409 - a broken binding rather than a bad request.
 */
std::pair<int, nlohmann::json>
diff_spec_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (!json.is_object ()) {
        return body_error ("Invalid body: must be an object");
    }

    const auto collection_id_field = json.find ("collectionId");
    if (collection_id_field == json.end () || !collection_id_field->is_string () ||
    collection_id_field->get<std::string> ().empty ()) {
        return body_error (
        "Invalid 'collectionId': must be a non-empty string");
    }
    const auto collection_id = collection_id_field->get<std::string> ();

    const auto spec_field = json.find ("spec");
    if (spec_field == json.end () || !spec_field->is_object ()) {
        return body_error (
        "Invalid 'spec': must be an object with the document to compare");
    }
    const auto content_field = spec_field->find ("content");
    if (content_field == spec_field->end () || !content_field->is_string ()) {
        return body_error ("Invalid 'spec.content': must be a string");
    }
    const auto content = content_field->get<std::string> ();
    if (content.empty ()) {
        return body_error (
        "Invalid 'spec.content': an empty document is not a spec");
    }

    const auto root = db.get_collection (collection_id);
    if (!root) {
        return { 404, error_body (404, "Collection not found") };
    }
    const std::string spec_id = bound_spec_id (root->openapi);
    if (spec_id.empty ()) {
        return body_error ("Collection '" +
        collection_id + "' is not bound to a spec; bind it before asking what a document would change");
    }

    // The same cap a store of these bytes would apply, read the same way: a
    // document too large to keep is not one to compare against, and answering
    // about it would offer an apply that is then refused.
    const size_t cap = spec_size_cap (db);
    if (content.size () > cap) {
        return body_error ("Spec document is " + std::to_string (content.size ()) +
        " bytes, over the limit of " + std::to_string (cap) +
        " (raise the 'maxSpecDocumentBytes' setting to allow more)");
    }

    const vayu::core::DocumentRead fetched_read = vayu::core::read_document (content);
    if (!fetched_read.ok ()) {
        return body_error ("Invalid 'spec.content': " + fetched_read.error);
    }

    const auto collections = db.get_collections ();
    const auto subtree = collection_subtree_ids (collections, collection_id);

    // The comparison itself, shared with a `"safe"` sync (issue #871): the route
    // that says what would change and the route that changes it read one answer,
    // so an apply cannot write rows its preview never showed.
    SpecComparison comparison;
    if (auto err = compare_bound_spec (
        db, collections, subtree, spec_id, fetched_read.root, comparison)) {
        return *err;
    }
    const auto& fetched              = comparison.fetched;
    const auto& requests             = comparison.requests;
    const vayu::core::SpecDiff& diff = comparison.diff;

    // What an apply with no ticks would write, per entry (issue #871). Reported
    // rather than left to the caller: the rules behind it - never write a field
    // somebody edited, never delete, leave a request nothing can be told apart
    // about alone - are the ones whose silent failure costs a person their work,
    // and a second author for them is exactly what moving them here removes. The
    // Spec tab's pre-ticked boxes are this answer read back, and
    // `POST /specs/sync`'s `"policy": "safe"` applies the same one.
    const vayu::core::SafeSpecApply safe = vayu::core::safe_spec_apply (diff);

    nlohmann::json added = nlohmann::json::array ();
    for (size_t i = 0; i < diff.added.size (); ++i) {
        const size_t index = diff.added[i];
        added.push_back ({ { "operation", spec_operation_json (fetched[index].operation) },
        { "folder", fetched[index].folder },
        { "draft", draft_json (fetched[index].draft) }, { "safe", safe.create[i] } });
    }
    nlohmann::json removed = nlohmann::json::array ();
    for (size_t i = 0; i < diff.removed.size (); ++i) {
        const size_t index = diff.removed[i];
        removed.push_back (
        { { "requestId", requests[index].id }, { "name", requests[index].name },
        // Present by construction: a request with no identity is `unmapped`,
        // never removed.
        { "operation", spec_operation_json (*requests[index].operation) },
        { "safe", safe.remove[i] } });
    }
    nlohmann::json changed = nlohmann::json::array ();
    for (size_t i = 0; i < diff.changed.size (); ++i) {
        const auto& item  = diff.changed[i];
        const auto& entry = fetched[item.draft];
        changed.push_back ({ { "requestId", requests[item.request].id },
        { "name", requests[item.request].name },
        { "boundOperation", spec_operation_json (item.bound_operation) },
        { "operation", spec_operation_json (entry.operation) },
        { "matchedBy", item.matched_by == vayu::core::IdentityMatch::OperationId ? "operationId" : "path" },
        { "renamed", item.renamed }, { "previousUnknown", item.previous_unknown },
        { "fields", fields_json (item.fields) },
        { "draft", draft_json (entry.draft) }, { "safe", safe.update[i].apply },
        { "safeFields", safe_fields_json (safe.update[i].fields) } });
    }

    return { 200,
        nlohmann::json{ // The stored bytes rather than a hash of them: the engine hashes what it
        // stores, and a second opinion about whether two documents are the same
        // is the one thing this route exists to prevent.
        { "identical", comparison.bound_content == content }, { "added", std::move (added) },
        { "removed", std::move (removed) }, { "changed", std::move (changed) },
        { "unchanged", diff.unchanged }, { "unmapped", diff.unmapped } } };
}

void register_spec_diff_routes (RouteContext& ctx) {
    /**
     * POST /specs/diff
     * Compares a re-fetched document against the one the named collection is
     * bound to, and against every request in its subtree. Reads only - nothing
     * is stored, stamped or created, so a caller may ask about a document it has
     * not decided to apply.
     * Body params: collectionId (required), spec.content (required - the
     * re-fetched document, verbatim).
     * Returns: {identical, added, removed, changed, unchanged, unmapped}, 400,
     * 404 when the collection does not exist, or 409 when its binding names a
     * document the store no longer holds.
     */
    ctx.server.Post (
    "/specs/diff", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = diff_spec_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /specs/diff - " +
                std::to_string (status) + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info ("POST /specs/diff - " +
                std::to_string (body["added"].size ()) + " added, " +
                std::to_string (body["removed"].size ()) + " removed, " +
                std::to_string (body["changed"].size ()) + " changed, " +
                std::to_string (body["unchanged"].get<size_t> ()) + " unchanged");
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /specs/diff - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });
}

} // namespace vayu::http::routes
