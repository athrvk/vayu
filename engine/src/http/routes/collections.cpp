/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/collections.cpp
 * @brief Collection management routes
 */

#include "vayu/core/constants.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/http/list_page.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/sha256.hpp"

#include <algorithm>
#include <array>
#include <format>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>

namespace vayu::http::routes {

/**
 * Testable core of the parent-id validation for POST /collections. Fails with
 * the error response to send when the proposed parent would form a cycle in the
 * collection tree, and succeeds when the assignment is legal.
 *
 * Two shapes are rejected, both with 400:
 *   - Self-parent (`parentId == id`): a collection cannot be its own parent.
 *   - Reparent into a descendant: walking the proposed parent's ancestor chain
 *     reaches the collection being saved, so the move would make a node its own
 *     ancestor. A cycle here is what let `delete_collection`'s BFS loop forever
 *     under the global DB mutex, hanging every endpoint (see issue #79).
 *
 * The walk carries a visited set so pre-existing corrupt data (a cycle written
 * before this validation existed) cannot hang the validator itself. A parent id
 * that does not resolve to a stored collection ends the walk cleanly - parent
 * *existence* is intentionally not required here, because the import
 * orchestrator creates collections in bulk and an existence check would couple
 * this fix to import ordering.
 *
 * Extracted so the wiring is covered without an in-process HTTP server - see
 * collections_route_test.cpp. The error body is built by `error_body`, like
 * every other error the engine emits.
 */
RouteResult validate_parent_assignment (vayu::db::Database& db,
const std::string& id,
const std::optional<std::string>& parent_id) {
    if (!parent_id.has_value ()) {
        return {}; // No parent -> no cycle possible.
    }
    if (*parent_id == id) {
        return route_error (400, "A collection cannot be its own parent");
    }

    std::unordered_set<std::string> visited;
    std::optional<std::string> cursor = parent_id;
    while (cursor.has_value ()) {
        if (*cursor == id) {
            return route_error (400, "Cannot move a collection into its own descendant");
        }
        if (!visited.insert (*cursor).second) {
            break; // Already seen -> pre-existing corrupt cycle; stop, bounded.
        }
        auto ancestor = db.get_collection (*cursor);
        if (!ancestor.has_value ()) {
            break; // Chain ends at a missing parent; existence is not required.
        }
        cursor = ancestor->parent_id;
    }
    return {};
}

/**
 * Refuses a `parentId` naming a collection in the trash (#1883). Such a parent
 * reads as missing to `get_collection`, so without this the write lands a live
 * row under a stamped one: invisible in the sidebar, and destroyed by a purge
 * of the parent it was never listed under. An id the store has never seen is
 * still accepted, as `validate_parent_assignment` explains. Same status and
 * wording `POST /trash/:id/restore` gives the mirror case.
 *
 * Only a parent the body states is checked, so a row already stranded under a
 * trashed one stays editable by a PUT that does not move it.
 */
static RouteResult reject_trashed_parent (vayu::db::Database& db,
const nlohmann::json& json,
const std::optional<std::string>& parent_id) {
    if (!json.contains ("parentId") || !parent_id.has_value () ||
    !db.collection_is_trashed (*parent_id)) {
        return {};
    }
    return route_error (409, "Collection '" + *parent_id + "' is in the trash - restore it first");
}

using vayu::core::constants::data_schema::MAX_COLUMN_CHARS;
using vayu::core::constants::data_schema::MAX_COLUMNS;

/**
 * Contents-validation for `dataSchema`, run after `apply_json_field` has settled
 * the *shape* (object or null; anything else is its 400).
 *
 * A schema that stored garbage would not fail here - it would fail much later,
 * as a refusal message naming columns that are not column names, or as a diff in
 * the Data tab that no file can ever satisfy. So `columns` must be an array of
 * unique, non-empty strings and `declaredAt` a number if it is present at all.
 *
 * Deliberately independent of every other row: `POST /import/apply` validates
 * with `is_create=true` while the payload's parents are still unwritten, so a
 * check that reached for another record would refuse a legal bulk import.
 */
static RouteResult validate_data_schema (const nlohmann::json& schema) {
    if (schema.contains ("columns")) {
        const auto& columns = schema["columns"];
        if (!columns.is_array ()) {
            return route_error (400, "Invalid 'dataSchema.columns': must be an array of strings");
        }
        if (columns.size () > MAX_COLUMNS) {
            return route_error (400,
            "Invalid 'dataSchema.columns': " + std::to_string (columns.size ()) +
            " columns, over the limit of " + std::to_string (MAX_COLUMNS));
        }
        std::unordered_set<std::string> seen;
        for (const auto& column : columns) {
            if (!column.is_string ()) {
                return route_error (400,
                "Invalid 'dataSchema.columns': every column must be a string");
            }
            const auto name = column.get<std::string> ();
            if (name.empty ()) {
                return route_error (400,
                "Invalid 'dataSchema.columns': a column name cannot be empty");
            }
            if (name.size () > MAX_COLUMN_CHARS) {
                return route_error (400,
                "Invalid 'dataSchema.columns': a column name is longer than " +
                std::to_string (MAX_COLUMN_CHARS) + " characters");
            }
            if (!seen.insert (name).second) {
                return route_error (400,
                "Invalid 'dataSchema.columns': duplicate column '" + name + "'");
            }
        }
    }
    if (schema.contains ("declaredAt") && !schema["declaredAt"].is_number ()) {
        return route_error (400, "Invalid 'dataSchema.declaredAt': must be a number");
    }
    if (schema.contains ("fileName") && !schema["fileName"].is_string ()) {
        return route_error (400, "Invalid 'dataSchema.fileName': must be a string");
    }
    return {};
}

/**
 * Contents-validation for the `openapi` binding (issue #637), run after
 * `apply_json_field` has settled the shape - the same split `validate_data_schema`
 * above draws, and for the same reason.
 *
 * An empty object is the *unbound* state and is always legal. A non-empty one is
 * a binding, and a binding without a `specId` names nothing: it would serialize
 * as a collection that claims a spec and read back as one nobody can fetch, so
 * it is a 400 rather than a stored half-edge.
 *
 * Whether that `specId` resolves is deliberately **not** checked here. This
 * applier also runs under `POST /import/apply`, against a payload whose spec
 * rows are not written yet - the same reason `reject_missing_collection` sits in
 * the request route cores rather than in `apply_request_fields`. Resolution is
 * `reject_unbindable_spec`'s, called by each write path with whatever it knows
 * is about to exist.
 */
static RouteResult validate_openapi_binding (const nlohmann::json& binding) {
    if (binding.empty ()) {
        return {}; // Unbound; nothing to check.
    }
    if (!binding.contains ("specId") || !binding["specId"].is_string () ||
    binding["specId"].get<std::string> ().empty ()) {
        return route_error (400,
        "Invalid 'openapi.specId': a binding must name a stored spec "
        "(send openapi: {} or null to unbind)");
    }
    if (binding.contains ("specHash") && !binding["specHash"].is_string ()) {
        return route_error (400, "Invalid 'openapi.specHash': must be a string");
    }
    if (binding.contains ("syncedAt") && !binding["syncedAt"].is_number ()) {
        return route_error (400, "Invalid 'openapi.syncedAt': must be a number");
    }
    return {};
}

using vayu::core::constants::file_binding::MAX_FILE_NAME_BYTES;
using vayu::core::constants::file_binding::MAX_PATH_BYTES;

/// The members a `specFile` binding may carry (issue #2765).
constexpr auto SPEC_FILE_MEMBERS =
std::to_array<std::string_view> ({ "path", "fileName" });
/// The members a `dataFile` binding may carry: `hash` and `castNumbers` are
/// how the app last read the file (issues #2051, #2540).
constexpr auto DATA_FILE_MEMBERS =
std::to_array<std::string_view> ({ "path", "fileName", "hash", "castNumbers" });

/**
 * One of a file binding's two required strings: present, non-empty and within
 * @p cap bytes. Its form is not judged: the path is true of the machine that
 * picked it, so a Windows path restored onto Linux is stored as written and
 * the app shows it as a file it cannot find.
 */
static RouteResult validate_binding_string (const nlohmann::json& binding,
std::string_view field,
std::string_view member,
size_t cap) {
    const auto found = binding.find (member);
    if (found == binding.end () || !found->is_string () ||
    found->get_ref<const std::string&> ().empty ()) {
        return route_error (400,
        std::format ("Invalid '{0}.{1}': a binding must name the file as a "
                     "non-empty string (send {0}: {{}} or null to unbind)",
        field, member));
    }
    const size_t bytes = found->get_ref<const std::string&> ().size ();
    if (bytes > cap) {
        return route_error (413,
        std::format ("'{}.{}' is {} bytes, over the limit of {}", field, member, bytes, cap));
    }
    return {};
}

/**
 * Contents-validation for a `specFile` / `dataFile` binding (issue #2765), run
 * after `apply_json_field` has settled the shape, on the `openapi` split
 * above. `{}` is unbound and always legal. A binding holds only @p members, so
 * a reader never meets a stored member nothing writes or reads.
 */
static RouteResult validate_file_binding (const nlohmann::json& binding,
std::string_view field,
std::span<const std::string_view> members) {
    if (binding.empty ()) {
        return {};
    }
    for (const auto& entry : binding.items ()) {
        if (std::ranges::find (members, entry.key ()) == members.end ()) {
            return route_error (400,
            std::format ("Invalid '{}': unknown member '{}'", field, entry.key ()));
        }
    }
    if (auto outcome = validate_binding_string (binding, field, "path", MAX_PATH_BYTES);
    !outcome) {
        return outcome;
    }
    if (auto outcome = validate_binding_string (binding, field, "fileName", MAX_FILE_NAME_BYTES);
    !outcome) {
        return outcome;
    }
    // The same digest a run records as `dataFileHash`, in its one spelling.
    if (const auto hash = binding.find ("hash"); hash != binding.end () &&
    !(hash->is_string () &&
    vayu::utils::is_sha256_hex (hash->get_ref<const std::string&> ()))) {
        return route_error (400,
        std::format ("Invalid '{}.hash': must be the SHA-256 of the file's "
                     "bytes as 64 lowercase hex characters",
        field));
    }
    if (const auto cast = binding.find ("castNumbers");
    cast != binding.end () && !cast->is_boolean ()) {
        return route_error (
        400, std::format ("Invalid '{}.castNumbers': must be a boolean", field));
    }
    return {};
}

/**
 * Applies an object field whose default is `{}` under the null-vs-absent rule,
 * then runs @p validate over the contents. Shape is `apply_json_field`'s;
 * contents are @p validate's, and only a value the caller actually sent is
 * checked, so a stored one cannot refuse an update that says nothing about it.
 */
template <typename Validate>
static RouteResult apply_checked_object_field (const nlohmann::json& json,
const char* key,
std::string& out,
bool is_create,
Validate validate) {
    if (auto outcome = apply_json_field (json, key, out, "{}", is_create); !outcome) {
        return outcome;
    }
    if (json.contains (key) && json[key].is_object ()) {
        return validate (json[key]);
    }
    return {};
}

/**
 * Applies the request body onto `c` under the one null-vs-absent rule (see the
 * helpers in routes.hpp). Shared by the create and update cores so the two
 * verbs cannot drift apart on what a field means - the only thing that differs
 * between them is `is_create`.
 *
 * Returns an error response when a no-default field (`name`) is missing or
 * null, or when the proposed parent would form a cycle or is in the trash.
 *
 * Declared in routes.hpp because `POST /import/apply` applies the same fields to
 * every collection in a bulk payload (issue #96).
 */
RouteResult apply_collection_fields (vayu::db::Database& db,
vayu::db::Collection& c,
const nlohmann::json& json,
bool is_create) {
    if (auto outcome = apply_required_string_field (json, "name", c.name, is_create); !outcome) {
        return outcome;
    }

    apply_string_field (json, "description", c.description, "", is_create);

    const std::optional<std::string> previous_parent = c.parent_id;
    if (json.contains ("parentId")) {
        c.parent_id = json["parentId"].is_null () ?
        std::nullopt :
        std::optional<std::string> (json["parentId"].get<std::string> ());
    } else if (is_create) {
        c.parent_id = std::nullopt;
    }
    // A collection that changed parent is a newcomer among its new siblings; its
    // stored `order` was a position in a list it has left.
    const bool reparented = !is_create && c.parent_id != previous_parent;

    if (json.contains ("order") && !json["order"].is_null ()) {
        c.order = json["order"].get<int> ();
    } else if (is_create || reparented || json.contains ("order")) {
        // "Append after the current siblings" *is* this field's default, so the
        // one null-vs-absent rule lands all three of these on it: create (absent
        // or null), a reparent that states no order, and an explicit null on
        // update ("reset to the default"). Null used to reset to 0 instead,
        // which collided with the first sibling rather than resetting anything;
        // a reparent used to keep a position from the list it had just left.
        // The siblings are the parent's requests too (#2535). On a create the
        // id is not stored yet, so excluding it is a no-op there.
        c.order = db.next_sibling_order (c.parent_id, c.id);
    }

    if (auto outcome = apply_json_field (json, "variables", c.variables, "{}", is_create);
    !outcome) {
        return outcome;
    }
    // Collection auth is never 'inherit' - a collection is the root of a chain.
    if (auto outcome = apply_json_field (json, "auth", c.auth, R"({"mode":"none"})", is_create);
    !outcome) {
        return outcome;
    }
    // The same rule as a request's auth (`without_stale_postman_source`).
    c.auth = vayu::core::without_stale_postman_source (std::move (c.auth));
    // Scripts are elements now (issue #1514's clean cut) - see the
    // equivalent comment in requests.cpp's apply_request_fields.
    if (auto refusal = refuse_legacy_script_fields (json)) {
        return route_error (400, *refusal);
    }
    if (auto outcome = apply_elements_field (json, "elements", c.elements,
        is_create, vayu::core::ElementOwner::Collection);
    !outcome) {
        return outcome;
    }

    // The declared data contract (issue #599). `{}` is "no contract", which is
    // what both an absent field on create and an explicit null on update mean.
    if (auto outcome = apply_checked_object_field (
        json, "dataSchema", c.data_schema, is_create, validate_data_schema);
    !outcome) {
        return outcome;
    }
    // The OpenAPI binding (issue #637). `{}` is "bound to nothing", so
    // unbinding is `{"openapi": null}` and needs no verb of its own.
    if (auto outcome = apply_checked_object_field (
        json, "openapi", c.openapi, is_create, validate_openapi_binding);
    !outcome) {
        return outcome;
    }
    // The files the Spec and Data tabs are bound to (issue #2765), the same
    // way: `{"specFile": null}` unbinds.
    if (auto outcome = apply_checked_object_field (json, "specFile", c.spec_file, is_create,
        [] (const nlohmann::json& binding) {
            return validate_file_binding (binding, "specFile", SPEC_FILE_MEMBERS);
        });
    !outcome) {
        return outcome;
    }
    if (auto outcome = apply_checked_object_field (json, "dataFile", c.data_file, is_create,
        [] (const nlohmann::json& binding) {
            return validate_file_binding (binding, "dataFile", DATA_FILE_MEMBERS);
        });
    !outcome) {
        return outcome;
    }

    if (auto outcome = reject_trashed_parent (db, json, c.parent_id); !outcome) {
        return outcome;
    }
    // Reject writes that would put a cycle in the collection tree (self-parent,
    // or reparent into a descendant) before they reach the DB - a cycle makes
    // cascade delete loop forever under the global mutex. Cycle/self checks
    // only; parent existence is not required (import creates in bulk).
    return validate_parent_assignment (db, c.id, c.parent_id);
}

/**
 * Testable core of POST /collections - **create only**, returning
 * {http_status, json_body}.
 *
 * POST used to be a silent upsert, so a stale or typo'd id quietly created a
 * second record instead of failing, and an id collision merged two records into
 * one. Now an id that already exists is a 409 and the caller is told to use
 * PUT; POST only ever creates. A body `id` is rejected outright (#97) - the
 * engine owns id generation, and bulk import wires a tree together with the
 * temp ids of `POST /import/apply` (#96) rather than pre-assigning real ones.
 *
 * The 409 therefore only fires on a `generate_id` collision, which 122 bits of
 * entropy make unreachable in practice. It stays because the alternative on
 * that one-in-2^122 draw is `create_collection` overwriting a live record.
 */
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (auto outcome = reject_client_supplied_id (json); !outcome) {
        return as_response (outcome.error ());
    }
    const std::string id = vayu::utils::generate_id ("col_");

    if (db.get_collection (id).has_value ()) {
        return { 409, error_body (409, "Collection '" + id + "' already exists; use PUT /collections/:id to update") };
    }

    vayu::db::Collection c;
    c.id         = id;
    c.created_at = now_ms ();
    c.updated_at = now_ms ();

    // The checks and the write are one composite, so they are one lock scope
    // (issue #386's rule). The spec check proves a spec exists, and between
    // that read and this write a concurrent `DELETE /specs/:id` would otherwise
    // see no binder, delete the document, and leave this collection bound to
    // nothing - the one state the check exists to prevent. The delete side
    // holds the lock across its own check-and-remove for the same reason. The
    // applier's parent checks are the same shape: a parent trashed between
    // them and the write would strand this row under it (#1883).
    // `reject_unbindable_spec` is here rather than in the shared applier because
    // bulk import binds specs it is about to write - see its declaration.
    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] {
        if (auto outcome = apply_collection_fields (db, c, json, /*is_create=*/true); !outcome) {
            result = as_response (outcome.error ());
            return;
        }
        if (auto outcome = reject_unbindable_spec (db, c.openapi, {}); !outcome) {
            result = as_response (outcome.error ());
            return;
        }
        stamp_binding_from_store (db, c.openapi);
        db.create_collection (c);
        result = { 200, vayu::json::serialize (c) };
    });
    return result;
}

/** The read-merge-write of PUT /collections/:id, run under the caller's lock. */
static std::pair<int, nlohmann::json> update_collection_locked (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::optional<vayu::http::IfMatch>& if_match,
const std::function<void ()>& before_write) {
    if (auto outcome = reject_mismatched_body_id (json, id); !outcome) {
        return as_response (outcome.error ());
    }
    auto existing = db.get_collection (id);
    if (!existing) {
        return { 404, error_body (404, "Collection not found") };
    }
    if (auto held = check_if_match (if_match, existing->updated_at); !held) {
        return as_response (held.error ());
    }

    vayu::db::Collection c = *existing;
    if (auto outcome = apply_collection_fields (db, c, json, /*is_create=*/false); !outcome) {
        return as_response (outcome.error ());
    }
    c.updated_at = next_updated_at (existing->updated_at);

    // The spec check runs only when the write states a binding: a collection
    // bound to a spec that has since been deleted out of band must stay
    // editable by a PUT that says nothing about `openapi`, rather than becoming
    // unwritable - the same reading `reject_missing_collection` gets on a
    // request move.
    if (json.contains ("openapi")) {
        if (auto outcome = reject_unbindable_spec (db, c.openapi, {}); !outcome) {
            return as_response (outcome.error ());
        }
        stamp_binding_from_store (db, c.openapi);
    }
    if (before_write) {
        before_write ();
    }
    // Unbinding, or binding other bytes, forgets the operations deletes
    // declined under the old document (#3031).
    if (json.contains ("openapi") &&
    binding_leaves_document (existing->openapi, c.openapi)) {
        db.rebind_collection (c);
    } else {
        db.create_collection (c);
    }
    return { 200, vayu::json::serialize (c) };
}

/**
 * Testable core of PUT /collections/:id - **update only**, returning
 * {http_status, json_body}. A missing id is a 404 rather than a silent create.
 *
 * Semantics are merge-patch: absent fields keep their stored value. We use PUT
 * loosely rather than adding a separate PATCH verb (documented in
 * api-reference.md) because that is what the update branch has always done and
 * what every renderer call site expects. A body `id` that disagrees with the
 * path is a 400 (#97); the path is the identity.
 *
 * **The read, the merge and the write are one lock scope** (#1440). The create
 * core states why the spec check and the write cannot be separate acquisitions;
 * merge-patch extends the same argument to the read the merge is computed from.
 * The write carries every field the body did not name, read a moment earlier,
 * so two PUTs interleaved as read, read, write, write leave the second writer's
 * stale copy of the untouched fields on top of the first writer's changes -
 * silently, on both sides. That window used to sit between `get_collection`
 * here and `create_collection` inside the lock.
 *
 * @param if_match The request's `If-Match`, judged inside the same scope; a
 *        row it no longer names is a 412 (#2433).
 * @param before_write Test seam, invoked inside the lock scope with the merged
 *        row staged and immediately before it is written; see
 *        `update_request_response` for why it is an overload.
 */
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::optional<vayu::http::IfMatch>& if_match,
const std::function<void ()>& before_write) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        result = update_collection_locked (db, id, json, if_match, before_write);
    });
    return result;
}

std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    return update_collection_response (db, id, json, std::nullopt, before_write);
}

std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    return update_collection_response (db, id, json, std::nullopt, nullptr);
}

/**
 * Testable core of DELETE /collections/:id, returning {http_status,
 * json_body}.
 *
 * Deleting a tag folder of a bound collection declines every operation its
 * requests record (#3031), the decision `delete_request_response` records for
 * one request, made for a folderful; the delete records them under the binding
 * above the folder. Deleting the bound collection itself records nothing:
 * that is the whole contract going, not a choice about any operation of it,
 * and its records would have no collection to be read under.
 */
std::pair<int, nlohmann::json>
delete_collection_response (vayu::db::Database& db, const std::string& id) {
    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] {
        if (!db.get_collection (id)) {
            result = { 404, error_body (404, "Collection not found") };
            return;
        }
        std::optional<std::string> declined_under;
        if (const auto bound = vayu::core::nearest_spec_binding (db, id);
        bound && bound->collection_id != id) {
            declined_under = bound->collection_id;
        }
        db.delete_collection (id, declined_under);
        result = { 200,
            nlohmann::json{ { "message", "Collection deleted successfully" }, { "id", id } } };
    });
    return result;
}

/**
 * Testable core of GET /collections, returning {http_status, json_body}: every
 * live collection in the documented order as a bare array, or, with any of
 * `q` / `limit` / `offset` in @p page_query, one page of those whose `name`
 * holds `q` in the `{data, pagination}` envelope (#2443).
 */
std::pair<int, nlohmann::json> list_collections_response (vayu::db::Database& db,
const ListPageQuery& page_query) {
    const auto serialize = [] (const vayu::db::Collection& c) {
        return vayu::json::serialize (c);
    };
    if (page_query.present ()) {
        const auto page = parse_list_page (page_query);
        if (!page) {
            return as_response (page.error ());
        }
        return { 200,
            list_page_of (
            *page, db.get_collections (),
            [&page] (
            const vayu::db::Collection& c) { return page->matches (c.name); },
            serialize) };
    }

    const auto collections = db.get_collections ();
    nlohmann::json rows    = nlohmann::json::array ();
    for (const auto& c : collections) {
        rows.push_back (serialize (c));
    }
    vayu::utils::log_debug ("http",
    "Returning " + std::to_string (collections.size ()) + " collections");
    return { 200, rows };
}

void register_collection_routes (RouteContext& ctx) {
    /**
     * GET /collections
     * Retrieves all collections from the database.
     * Collections are folders that organize requests in a hierarchy.
     * Query params: q, limit, offset (optional) - any of them answers one page
     * of the collections whose name holds `q`, in the `{data, pagination}`
     * envelope (#2443).
     * Returns: Array of collection objects with id, name, parentId, order, and
     * timestamps, or that envelope; 400 for a bad `limit` or `offset`.
     */
    ctx.server.Get ("/collections",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto [status, body] =
            list_collections_response (ctx.db, list_page_query (req));
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "GET /collections - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * POST /collections
     * Creates a collection. Create only - an `id` that already exists is a 409
     * pointing at PUT, never a silent update (issue #95). The engine assigns
     * the id; a body carrying one is a 400 (issue #97).
     * Body params: name (required string), description, parentId, order,
     * variables, auth, elements, dataSchema, openapi, specFile, dataFile.
     * Returns: The created collection object, 400 (body `id`, missing
     * `name`, bad field shape, cycle), 409 (`parentId` in the trash), or 413
     * (an object field, or a file binding's `path` / `fileName`, over its cap).
     */
    ctx.server.Post ("/collections",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = parse_request_json (req.body);
            if (!json) {
                refuse_request_body (res, "POST /collections", json.error ());
                return;
            }
            auto [status, body] = create_collection_response (ctx.db, *json);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "POST /collections - " + std::to_string (status) + ": " +
                error_message_of (body));
            } else {
                vayu::utils::log_info ("http", "Created collection",
                { { "id", body["id"].get<std::string> () },
                { "name", body["name"].get<std::string> () } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "POST /collections - Error: " + std::string (e.what ()));
            send_exception (res, e);
        }
    });

    /**
     * PUT /collections/:id
     * Updates an existing collection (merge-patch: absent fields keep their
     * value, null resets to the default). Update only - a missing id is a 404,
     * never a silent create (issue #95).
     * Path params: id - The collection ID to update.
     * Headers: If-Match (optional) - the row's `W/"<updatedAt>"` (#2433).
     * Returns: The updated collection object with its ETag, 404 if it does
     * not exist, 412 if If-Match no longer names it, 400, 409 when
     * `parentId` names a collection in the trash, or 413 as on POST.
     */
    ctx.server.Put (R"(/collections/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string collection_id = req.matches[1];
        try {
            auto json = parse_request_json (req.body);
            if (!json) {
                refuse_request_body (res, "PUT /collections/:id", json.error ());
                return;
            }
            const auto if_match = read_if_match (req);
            if (!if_match) {
                refuse_request_body (res, "PUT /collections/:id", if_match.error ());
                return;
            }
            auto [status, body] = update_collection_response (
            ctx.db, collection_id, *json, *if_match, nullptr);
            if (status != 200) {
                vayu::utils::log_warning ("http", "PUT /collections/:id failed",
                { { "status", status }, { "id", collection_id },
                { "error", error_message_of (body) } });
            } else {
                vayu::utils::log_info ("http", "Updated collection",
                { { "id", collection_id }, { "name", body["name"].get<std::string> () } });
            }
            res.status = status;
            set_entity_tag (res, status, body);
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "PUT /collections/:id - Error: " + std::string (e.what ()));
            send_exception (res, e);
        }
    });

    /**
     * DELETE /collections/:id
     * Moves a collection and its whole subtree to the trash; beneath a bound
     * collection, the operations its requests record are recorded as
     * declined (#3031).
     * Path params: id - The collection ID to delete.
     * Returns: Success message or 404 if not found.
     */
    ctx.server.Delete (R"(/collections/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string collection_id = req.matches[1];
        vayu::utils::log_info ("http",
        "DELETE /collections/:id - Deleting collection: " + collection_id);
        try {
            auto [status, body] = delete_collection_response (ctx.db, collection_id);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "DELETE /collections/:id - Collection not found: " + collection_id);
            } else {
                vayu::utils::log_info ("http",
                "Successfully deleted collection", { { "id", collection_id } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
            "DELETE /collections/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
