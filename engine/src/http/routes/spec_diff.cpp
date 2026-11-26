/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `POST /specs/diff`: what a re-fetched document would change about the
 * collection bound to it (#654's comparison, engine-side per #854), the read
 * half of the sync. The rule is `core/spec_diff.hpp`; this route owns the three
 * things a caller must not be trusted with:
 *
 * - **Which requests are compared.** The bound collection's whole subtree,
 *   through the `collection_subtree_requests` walk `POST /specs/sync` bounds
 *   its writes by: an import files requests under one sub-collection per tag,
 *   so "the collection's requests" would exclude almost all of them and report
 *   a rewritten collection as untouched.
 * - **What the collection is bound to.** The bound document is read from the
 *   store, never sent: the three-way user-touched rule rests on the bound
 *   values being the stored ones, and a caller's stale copy would turn its own
 *   edits into "the document did this".
 * - **Whether anything changed.** `identical` is decided on the stored bytes
 *   (those `spec_documents.hash` covers), not a caller's hash.
 *
 * It writes nothing (no document, binding or stamp), so a caller may ask about
 * a document it has not decided to apply. The apply, `POST /specs/sync`,
 * re-reads everything rather than taking this answer, as `POST /specs/bind`
 * re-matches rather than trusting `POST /specs/match`: the two share the rule,
 * not a result.
 */

#include "vayu/core/spec_diff.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <optional>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

/// A request the comparison put in `removed` is one it could name an operation
/// for; one with no identity comes back as `unmapped` instead, never removed.
constexpr std::string_view REMOVED_HAS_IDENTITY_INVARIANT =
"a removed request carries the identity the comparison removed it by";

std::pair<int, nlohmann::json> body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/// JavaScript truthiness, as the renderer's comparison read a row's `enabled`:
/// an absent or `false` flag is off, every other stored value on.
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
    // A payload mode with no `content` compares as empty. JavaScript's template
    // literal wrote the word "undefined" there; no write can produce that
    // state, and reproducing it would put a sentinel in a user-visible diff.
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

/** One draft row, in the shape `requests.params` / `.headers` stores. */
nlohmann::json row_json (const vayu::core::DraftField& row) {
    nlohmann::json out{ { "key", row.key }, { "value", row.value },
        { "enabled", row.enabled } };
    if (!row.description.empty ()) {
        out["description"] = row.description;
    }
    if (row.file) {
        // A document names the upload, never the file: the part has no path and
        // the user picks one. `src` is present and empty because an import
        // writes that row, and a sync must not produce a different one for the
        // same operation.
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
 * example rows it would refresh. `examples` is the one field not sent back on
 * an apply (a sync derives the rows from the document it stores, #869, and the
 * caller only says whether to refresh), but a preview exists to show what an
 * apply would write, and the one builder of that shape keeps the shown and the
 * stored from drifting.
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
    } else if (draft.body.mode == "binary") {
        // The import's shape: the upload with no file chosen yet.
        body["file"] = nlohmann::json{ { "src", "" } };
        if (!draft.body.content_type.empty ()) {
            body["file"]["contentType"] = draft.body.content_type;
        }
    } else if (draft.body.mode != "none") {
        body["content"] = draft.body.content;
    }
    return { { "name", draft.name }, { "description", draft.description },
        { "method", draft.method }, { "url", draft.url },
        { "params", rows_json (draft.params) },
        { "headers", rows_json (draft.headers) }, { "body", std::move (body) } };
}

std::vector<vayu::core::DeclaredOperation> declined_identities (
const std::vector<vayu::db::DeclinedOperation>& records) {
    std::vector<vayu::core::DeclaredOperation> identities;
    identities.reserve (records.size ());
    for (const auto& record : records) {
        identities.push_back ({ record.operation_id, record.method, record.path, {} });
    }
    return identities;
}

RouteResult compare_bound_spec (vayu::db::Database& db,
const std::vector<vayu::db::Collection>& collections,
const std::unordered_set<std::string>& subtree,
const std::string& root_id,
const std::string& spec_id,
const nlohmann::ordered_json& fetched_document,
SpecComparison& out) {
    const auto stored = db.get_spec_document (spec_id);
    if (!stored) {
        return route_error (409,
        "Collection is bound to spec '" + spec_id +
        "', which is not stored - rebind it before syncing");
    }
    out.bound_content = stored->content;
    out.fetched       = vayu::core::spec_request_drafts_of (fetched_document);

    /*
     * A stored document that cannot be read is no reason to refuse to say what
     * the new one declares. Every write path derives its indexes from the
     * document (#853), so only a row older than that rule reaches here, and the
     * honest answer is the two-way comparison, `previousUnknown` on every
     * changed request saying so.
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
        entry.operation = vayu::core::parse_spec_identity (row.spec_operation);
        out.requests.push_back (std::move (entry));
    }

    out.diff = vayu::core::diff_spec (out.fetched, bound ? &*bound : nullptr,
    out.requests, declined_identities (db.get_declined_operations (root_id)));
    return {};
}

/**
 * Testable core of POST /specs/diff: the comparison, computed and returned,
 * nothing written. The three failures a caller can act on stay apart: an
 * unknown collection is a 404, one binding no document a 400 (nothing to
 * compare, and binding is another call), and a binding to a document the store
 * no longer holds a 409, a broken binding rather than a bad request.
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

    // A store's cap, read the same way: a document too large to keep is none to
    // compare against, and answering would offer an apply then refused.
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
    const auto subtree = spec_contract_subtree_ids (collections, collection_id);

    // Shared with a `"safe"` sync (#871): the route saying what would change
    // and the one changing it read one answer, so an apply cannot write rows
    // its preview never showed.
    SpecComparison comparison;
    if (auto outcome = compare_bound_spec (db, collections, subtree,
        collection_id, spec_id, fetched_read.root, comparison);
    !outcome) {
        return as_response (outcome.error ());
    }
    const auto& fetched              = comparison.fetched;
    const auto& requests             = comparison.requests;
    const vayu::core::SpecDiff& diff = comparison.diff;

    // What an apply with no ticks would write, per entry (#871), reported
    // rather than left to the caller: its rules (never write a field somebody
    // edited, never delete, leave an indistinguishable request alone) are the
    // ones whose silent failure costs a person their work, and here they have
    // one author. The Spec tab's pre-ticked boxes read this answer back, and
    // `POST /specs/sync`'s `"policy": "safe"` applies it.
    const vayu::core::SafeSpecApply safe = vayu::core::safe_spec_apply (diff);

    // A declined operation (#3031) is reported in an added one's shape, since
    // ticking it is the same create; only the bucket and its `safe` say
    // somebody deleted the request for it.
    const auto creatable = [&fetched] (const std::vector<size_t>& indices,
                           const std::vector<bool>& marks) {
        nlohmann::json entries = nlohmann::json::array ();
        for (size_t i = 0; i < indices.size (); ++i) {
            const auto& entry = fetched[indices[i]];
            entries.push_back ({ { "operation", spec_operation_json (entry.operation) },
            { "folder", entry.folder }, { "draft", draft_json (entry.draft) },
            { "safe", static_cast<bool> (marks[i]) } });
        }
        return entries;
    };
    nlohmann::json added    = creatable (diff.added, safe.create);
    nlohmann::json declined = creatable (diff.declined, safe.recreate);
    nlohmann::json removed  = nlohmann::json::array ();
    for (size_t i = 0; i < diff.removed.size (); ++i) {
        const size_t index = diff.removed[i];
        removed.push_back (
        { { "requestId", requests[index].id }, { "name", requests[index].name },
        { "operation",
        spec_operation_json (vayu::utils::invariant_value (
        requests[index].operation, REMOVED_HAS_IDENTITY_INVARIANT)) },
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
        { "identical", comparison.bound_content == content },
        { "added", std::move (added) }, { "declined", std::move (declined) },
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
     * Returns: {identical, added, declined, removed, changed, unchanged,
     * unmapped} (`declined` is what a person deleted the request for, #3031), 400,
     * 404 when the collection does not exist, or 409 when its binding names a
     * document the store no longer holds.
     */
    ctx.server.Post (
    "/specs/diff", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = parse_request_json (req.body);
            if (!json) {
                refuse_request_body (res, "POST /specs/diff", json.error ());
                return;
            }
            auto [status, body] = diff_spec_response (ctx.db, *json);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "POST /specs/diff - " + std::to_string (status) + ": " +
                error_message_of (body));
            } else {
                vayu::utils::log_info ("http",
                std::to_string (body["added"].size ()) + " added, " +
                std::to_string (body["declined"].size ()) + " declined, " +
                std::to_string (body["removed"].size ()) + " removed, " +
                std::to_string (body["changed"].size ()) + " changed, " +
                std::to_string (body["unchanged"].get<size_t> ()) + " unchanged");
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "POST /specs/diff - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });
}

} // namespace vayu::http::routes
