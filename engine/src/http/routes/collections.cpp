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

#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <optional>
#include <string>
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
 * The `order` a collection takes when the caller states none: one past the
 * highest already held by a sibling under @p parent_id.
 *
 * @p self_id is excluded so a collection asked to reset its own order lands
 * after its *other* siblings rather than one past itself. On a create the id is
 * not stored yet, so the exclusion is a no-op there.
 */
static int next_sibling_order (vayu::db::Database& db,
const std::optional<std::string>& parent_id,
const std::string& self_id) {
    int max_order = -1;
    for (const auto& col : db.get_collections ()) {
        if (col.id != self_id && col.parent_id == parent_id) {
            max_order = std::max (max_order, col.order);
        }
    }
    return max_order + 1;
}

/**
 * Bounds on a declared data contract, stated here rather than left implicit.
 *
 * A column name is a `{{data.<name>}}` token's identifier and a header cell of a
 * CSV, so 256 characters is far past anything a real file carries; 1024 columns
 * likewise. They exist so a malformed or hostile payload cannot store a blob
 * that every later reader has to walk - the schema is read on every plan
 * resolution that refuses a data token.
 */
constexpr size_t MAX_DATA_SCHEMA_COLUMNS      = 1024;
constexpr size_t MAX_DATA_SCHEMA_COLUMN_CHARS = 256;

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
        if (columns.size () > MAX_DATA_SCHEMA_COLUMNS) {
            return route_error (400,
            "Invalid 'dataSchema.columns': " + std::to_string (columns.size ()) +
            " columns, over the limit of " + std::to_string (MAX_DATA_SCHEMA_COLUMNS));
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
            if (name.size () > MAX_DATA_SCHEMA_COLUMN_CHARS) {
                return route_error (400,
                "Invalid 'dataSchema.columns': a column name is longer than " +
                std::to_string (MAX_DATA_SCHEMA_COLUMN_CHARS) + " characters");
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

/**
 * Applies the request body onto `c` under the one null-vs-absent rule (see the
 * helpers in routes.hpp). Shared by the create and update cores so the two
 * verbs cannot drift apart on what a field means - the only thing that differs
 * between them is `is_create`.
 *
 * Returns an error response when a no-default field (`name`) is missing or
 * null, or when the proposed parent would form a cycle.
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
        c.order = next_sibling_order (db, c.parent_id, c.id);
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
    apply_string_field (json, "preRequestScript", c.pre_request_script, "", is_create);
    apply_string_field (json, "postRequestScript", c.post_request_script, "", is_create);

    // The declared data contract (issue #599). `{}` is "no contract", which is
    // what both an absent field on create and an explicit null on update mean.
    if (auto outcome = apply_json_field (json, "dataSchema", c.data_schema, "{}", is_create);
    !outcome) {
        return outcome;
    }
    // Shape is `apply_json_field`'s; contents are this one's. Only a value the
    // caller actually sent is checked - a stored schema is left alone, so an
    // update that says nothing about it cannot be refused by it.
    if (json.contains ("dataSchema") && json["dataSchema"].is_object ()) {
        if (auto outcome = validate_data_schema (json["dataSchema"]); !outcome) {
            return outcome;
        }
    }

    // The OpenAPI binding (issue #637). `{}` is "bound to nothing", which both
    // an absent field on create and an explicit null on update mean - so
    // unbinding is `{"openapi": null}` and needs no verb of its own.
    if (auto outcome = apply_json_field (json, "openapi", c.openapi, "{}", is_create);
    !outcome) {
        return outcome;
    }
    if (json.contains ("openapi") && json["openapi"].is_object ()) {
        if (auto outcome = validate_openapi_binding (json["openapi"]); !outcome) {
            return outcome;
        }
    }

    // Reject writes that would put a cycle in the collection tree (self-parent,
    // or reparent into a descendant) before they reach the DB - a cycle makes
    // cascade delete loop forever under the global mutex. Cycle/self checks
    // only; parent existence is not required (import creates in bulk).
    if (auto outcome = validate_parent_assignment (db, c.id, c.parent_id); !outcome) {
        return outcome;
    }
    return {};
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

    if (auto outcome = apply_collection_fields (db, c, json, /*is_create=*/true); !outcome) {
        return as_response (outcome.error ());
    }

    // The spec check and the write are one composite, so they are one lock
    // scope (issue #386's rule): the check proves a spec exists, and between
    // that read and this write a concurrent `DELETE /specs/:id` would otherwise
    // see no binder, delete the document, and leave this collection bound to
    // nothing - the one state the check exists to prevent. The delete side
    // holds the lock across its own check-and-remove for the same reason.
    // `reject_unbindable_spec` is here rather than in the shared applier because
    // bulk import binds specs it is about to write - see its declaration.
    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] {
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

/**
 * Testable core of PUT /collections/:id - **update only**, returning
 * {http_status, json_body}. A missing id is a 404 rather than a silent create.
 *
 * Semantics are merge-patch: absent fields keep their stored value. We use PUT
 * loosely rather than adding a separate PATCH verb (documented in
 * api-reference.md) because that is what the update branch has always done and
 * what every renderer call site expects. A body `id` that disagrees with the
 * path is a 400 (#97); the path is the identity.
 */
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    if (auto outcome = reject_mismatched_body_id (json, id); !outcome) {
        return as_response (outcome.error ());
    }
    auto existing = db.get_collection (id);
    if (!existing) {
        return { 404, error_body (404, "Collection not found") };
    }

    vayu::db::Collection c = *existing;
    if (auto outcome = apply_collection_fields (db, c, json, /*is_create=*/false); !outcome) {
        return as_response (outcome.error ());
    }
    c.updated_at = now_ms ();

    // One lock scope over check-then-write, exactly as the create core does -
    // see there for why the two cannot be separate acquisitions. The check runs
    // only when the write states a binding: a collection bound to a spec that
    // has since been deleted out of band must stay editable by a PUT that says
    // nothing about `openapi`, rather than becoming unwritable - the same
    // reading `reject_missing_collection` gets on a request move.
    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] {
        if (json.contains ("openapi")) {
            if (auto outcome = reject_unbindable_spec (db, c.openapi, {}); !outcome) {
                result = as_response (outcome.error ());
                return;
            }
            stamp_binding_from_store (db, c.openapi);
        }
        db.create_collection (c);
        result = { 200, vayu::json::serialize (c) };
    });
    return result;
}

void register_collection_routes (RouteContext& ctx) {
    /**
     * GET /collections
     * Retrieves all collections from the database.
     * Collections are folders that organize requests in a hierarchy.
     * Returns: Array of collection objects with id, name, parentId, order, and timestamps.
     */
    ctx.server.Get ("/collections", [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info ("GET /collections - Fetching all collections");
        auto collections        = ctx.db.get_collections ();
        nlohmann::json response = nlohmann::json::array ();
        for (const auto& c : collections) {
            response.push_back (vayu::json::serialize (c));
        }
        vayu::utils::log_debug ("GET /collections - Returning " +
        std::to_string (collections.size ()) + " collections");
        res.set_content (response.dump (), "application/json");
    });

    /**
     * POST /collections
     * Creates a collection. Create only - an `id` that already exists is a 409
     * pointing at PUT, never a silent update (issue #95). The engine assigns
     * the id; a body carrying one is a 400 (issue #97).
     * Body params: name (required string), description, parentId, order,
     * variables, auth, preRequestScript, postRequestScript.
     * Returns: The created collection object, or 400 (body `id`, missing
     * `name`, bad field shape, cycle).
     */
    ctx.server.Post ("/collections",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = create_collection_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /collections - " +
                std::to_string (status) + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info (
                "POST /collections - Created collection: id=" + body["id"].get<std::string> () +
                ", name=" + body["name"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /collections - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * PUT /collections/:id
     * Updates an existing collection (merge-patch: absent fields keep their
     * value, null resets to the default). Update only - a missing id is a 404,
     * never a silent create (issue #95).
     * Path params: id - The collection ID to update.
     * Returns: The updated collection object, 404 if it does not exist, or 400.
     */
    ctx.server.Put (R"(/collections/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string collection_id = req.matches[1];
        try {
            auto json = nlohmann::json::parse (req.body);
            auto [status, body] = update_collection_response (ctx.db, collection_id, json);
            if (status != 200) {
                vayu::utils::log_warning ("PUT /collections/:id - " + std::to_string (status) +
                " for id=" + collection_id + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info (
                "PUT /collections/:id - Updated collection: id=" + collection_id +
                ", name=" + body["name"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "PUT /collections/:id - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * DELETE /collections/:id
     * Deletes a collection and all its requests.
     * Path params: id - The collection ID to delete.
     * Returns: Success message or 404 if not found.
     */
    ctx.server.Delete (R"(/collections/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string collection_id = req.matches[1];
        vayu::utils::log_info (
        "DELETE /collections/:id - Deleting collection: " + collection_id);
        try {
            auto collection = ctx.db.get_collection (collection_id);
            if (!collection) {
                vayu::utils::log_warning (
                "DELETE /collections/:id - Collection not found: " + collection_id);
                send_error (res, 404, "Collection not found");
                return;
            }

            ctx.db.delete_collection (collection_id);
            vayu::utils::log_info (
            "DELETE /collections/:id - Successfully deleted collection: " + collection_id +
            ", name=" + collection->name);

            nlohmann::json response;
            response["message"] = "Collection deleted successfully";
            response["id"]      = collection_id;
            res.set_content (response.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /collections/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
