/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/reorder.cpp
 * @brief POST /reorder - the atomic batch reorder/move for collections and
 *        requests (issue #365).
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

/**
 * Cap on entries per call, mirroring `/import/apply`'s. Every row is loaded and
 * built before anything is written, so an unbounded batch is an unbounded
 * allocation; a drop writes a handful of rows and a whole-workspace renumber
 * stays far below this.
 */
constexpr size_t MAX_REORDER_ENTRIES = 10000;

/** A 400 about the payload as a whole. */
std::pair<int, nlohmann::json> body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/** The two entity kinds this endpoint moves. */
enum class Kind { Collection, Request };

/**
 * One scope whose children are renumbered dense before the moves apply: the
 * children of a collection (`parent` empty means the roots), or the requests of
 * a collection.
 */
struct Scope {
    Kind kind;
    std::optional<std::string> parent; // collection scope: nullopt = the roots
    std::string collection;            // request scope

    bool operator< (const Scope& other) const {
        if (kind != other.kind) {
            return kind < other.kind;
        }
        if (kind == Kind::Collection) {
            return parent < other.parent;
        }
        return collection < other.collection;
    }
};

/** One row's new position, and - when it changes owner - its new owner. */
struct Move {
    Kind kind;
    std::string id;
    int order         = 0;
    bool states_owner = false; // parentId / collectionId present in the body
    std::optional<std::string> parent; // collection move
    std::string collection;            // request move
};

/** Reads and validates `type`, the one field both entry shapes share. */
std::optional<std::pair<int, nlohmann::json>>
read_kind (const nlohmann::json& entry, const std::string& at, Kind& out) {
    if (!entry.is_object ()) {
        return body_error ("Invalid " + at + ": must be an object");
    }
    if (!entry.contains ("type") || !entry["type"].is_string ()) {
        return body_error ("Invalid " + at + ": 'type' must be \"collection\" or \"request\"");
    }
    const std::string type = entry["type"].get<std::string> ();
    if (type == "collection") {
        out = Kind::Collection;
        return std::nullopt;
    }
    if (type == "request") {
        out = Kind::Request;
        return std::nullopt;
    }
    return body_error ("Invalid " + at + ": unknown type '" + type + "'");
}

/**
 * Reads one `normalize` entry.
 *
 * A collection scope must *state* `parentId` (`null` for the roots) rather than
 * omitting it: absent would have to mean either "the roots" or "whatever parent
 * you infer", and a renumber that silently picked the wrong scope is a whole
 * folder reshuffled. A named parent or owning collection must exist - unlike the
 * single-row `PUT`, which tolerates an unresolvable parent because bulk import
 * writes rows that cannot see each other yet. Nothing here is bulk-created, so a
 * scope that resolves to no row is a client bug, not an ordering artifact.
 */
std::optional<std::pair<int, nlohmann::json>>
read_scope (vayu::db::Database& db, const nlohmann::json& entry, size_t index, Scope& out) {
    const std::string at = "normalize entry at index " + std::to_string (index);
    if (auto err = read_kind (entry, at, out.kind)) {
        return err;
    }
    if (out.kind == Kind::Collection) {
        if (!entry.contains ("parentId")) {
            return body_error ("Invalid " +
            at + ": 'parentId' must be stated (null normalizes the root collections)");
        }
        const auto& parent = entry["parentId"];
        if (parent.is_null ()) {
            out.parent = std::nullopt;
            return std::nullopt;
        }
        if (!parent.is_string ()) {
            return body_error ("Invalid " + at + ": 'parentId' must be a string or null");
        }
        out.parent = parent.get<std::string> ();
        if (!db.get_collection (*out.parent).has_value ()) {
            return body_error ("Collection '" + *out.parent + "' does not exist");
        }
        return std::nullopt;
    }
    if (!entry.contains ("collectionId") || !entry["collectionId"].is_string ()) {
        return body_error ("Invalid " + at + ": 'collectionId' must be a string");
    }
    out.collection = entry["collectionId"].get<std::string> ();
    if (!db.get_collection (out.collection).has_value ()) {
        return body_error ("Collection '" + out.collection + "' does not exist");
    }
    return std::nullopt;
}

/**
 * Reads one `moves` entry and checks that the row it names is stored.
 *
 * `order` is required and must be a non-negative integer: this endpoint exists
 * to write dense positions, and a float or a negative would be a silently
 * truncated or unreachable slot. The owner fields follow the merge-patch rule
 * the single-row endpoints use - absent keeps the current owner, present states
 * a move - except that a stated owner must exist, for the reason in `read_scope`.
 */
std::optional<std::pair<int, nlohmann::json>>
read_move (vayu::db::Database& db, const nlohmann::json& entry, size_t index, Move& out) {
    const std::string at = "move at index " + std::to_string (index);
    if (auto err = read_kind (entry, at, out.kind)) {
        return err;
    }
    if (!entry.contains ("id") || !entry["id"].is_string () ||
    entry["id"].get<std::string> ().empty ()) {
        return body_error ("Invalid " + at + ": 'id' must be a non-empty string");
    }
    out.id = entry["id"].get<std::string> ();

    if (!entry.contains ("order") || !entry["order"].is_number_integer () ||
    entry["order"].get<int64_t> () < 0) {
        return body_error ("Invalid " + at + ": 'order' must be a non-negative integer");
    }
    out.order = entry["order"].get<int> ();

    if (out.kind == Kind::Collection) {
        if (!db.get_collection (out.id).has_value ()) {
            return body_error ("Collection '" + out.id + "' does not exist");
        }
        if (entry.contains ("parentId")) {
            out.states_owner   = true;
            const auto& parent = entry["parentId"];
            if (parent.is_null ()) {
                out.parent = std::nullopt;
            } else if (parent.is_string ()) {
                out.parent = parent.get<std::string> ();
                if (!db.get_collection (*out.parent).has_value ()) {
                    return body_error ("Collection '" + *out.parent + "' does not exist");
                }
            } else {
                return body_error ("Invalid " + at + ": 'parentId' must be a string or null");
            }
        }
        return std::nullopt;
    }

    if (!db.get_request (out.id).has_value ()) {
        return body_error ("Request '" + out.id + "' does not exist");
    }
    if (entry.contains ("collectionId")) {
        if (!entry["collectionId"].is_string ()) {
            return body_error ("Invalid " + at + ": 'collectionId' must be a string");
        }
        out.states_owner = true;
        out.collection   = entry["collectionId"].get<std::string> ();
        if (!db.get_collection (out.collection).has_value ()) {
            return body_error ("Collection '" + out.collection + "' does not exist");
        }
    }
    return std::nullopt;
}

/**
 * Rejects a batch that would leave a collection as its own ancestor.
 *
 * The walk runs over the shape the batch *would* produce - stored parents with
 * every move's `parentId` applied on top - which is what makes this endpoint
 * close the TOCTOU race the per-row `PUT` has: validation and write share one
 * transaction here, so two concurrent reparents that each look legal alone
 * cannot both land. `PUT /collections/:id` validates against the shape it read
 * before writing, under a different lock than the write.
 *
 * Only moved collections start a walk: a cycle in the post-move graph must pass
 * through an edge this batch changed, so a chain that reaches a root or an
 * already-visited node is proof enough. The visited set also keeps a
 * pre-existing corrupt cycle (written before write-time validation existed, and
 * explicitly tolerated by `validate_parent_assignment`) from hanging the
 * validator.
 */
std::optional<std::pair<int, nlohmann::json>>
reject_post_move_cycles (vayu::db::Database& db, const std::vector<Move>& moves) {
    std::unordered_map<std::string, std::optional<std::string>> parent_of;
    for (const auto& c : db.get_collections ()) {
        parent_of[c.id] = c.parent_id;
    }
    for (const auto& move : moves) {
        if (move.kind == Kind::Collection && move.states_owner) {
            parent_of[move.id] = move.parent;
        }
    }

    for (const auto& move : moves) {
        if (move.kind != Kind::Collection || !move.states_owner) {
            continue;
        }
        if (move.parent.has_value () && *move.parent == move.id) {
            return body_error ("Collection '" + move.id + "' cannot be its own parent");
        }
        std::unordered_set<std::string> seen;
        std::optional<std::string> cursor = move.parent;
        while (cursor.has_value ()) {
            if (*cursor == move.id) {
                return body_error (
                "Cannot move collection '" + move.id + "' into its own descendant");
            }
            if (!seen.insert (*cursor).second) {
                break; // Pre-existing corrupt cycle; bounded, and not this batch's.
            }
            auto next = parent_of.find (*cursor);
            if (next == parent_of.end ()) {
                break;
            }
            cursor = next->second;
        }
    }
    return std::nullopt;
}

/**
 * The rows a batch will write, keyed by id so a row named by both a
 * normalization and a move is written once, with the move's position winning.
 *
 * Ordered maps rather than hash maps: the response lists what was written, and
 * a client diffing two responses should not have to sort them first.
 */
struct WriteSet {
    std::map<std::string, vayu::db::Collection> collections;
    std::map<std::string, vayu::db::Request> requests;

    bool empty () const {
        return collections.empty () && requests.empty ();
    }
};

/**
 * Renumbers one scope's children dense `0..n-1` in the pinned display order
 * (`order`, `createdAt`, `id` - the reads below already apply it).
 *
 * Only rows whose position actually changes are added, which is what makes the
 * operation observably idempotent: normalizing an already-dense scope writes
 * nothing at all. It is also the whole point of the `normalize` list - a
 * collection whose rows all sit at the legacy `0` has a display order that
 * exists nowhere but the sort, and the first drop into it has to materialize
 * that order before it can name a slot, or every sibling appears to jump.
 */
void normalize_scope (vayu::db::Database& db, const Scope& scope, int64_t now, WriteSet& out) {
    if (scope.kind == Kind::Collection) {
        int index = 0;
        for (const auto& c : db.get_collections ()) {
            if (c.parent_id != scope.parent) {
                continue;
            }
            if (c.order != index) {
                vayu::db::Collection row = c;
                row.order                = index;
                row.updated_at           = now;
                out.collections[row.id]  = std::move (row);
            }
            ++index;
        }
        return;
    }
    int index = 0;
    for (const auto& r : db.get_requests_in_collection (scope.collection)) {
        if (r.order != index) {
            vayu::db::Request row = r;
            row.order             = index;
            row.updated_at        = now;
            out.requests[row.id]  = std::move (row);
        }
        ++index;
    }
}

/** Applies one move on top of whatever the normalization pass already staged. */
void stage_move (vayu::db::Database& db, const Move& move, int64_t now, WriteSet& out) {
    if (move.kind == Kind::Collection) {
        auto staged              = out.collections.find (move.id);
        vayu::db::Collection row = staged != out.collections.end () ?
        staged->second :
        *db.get_collection (move.id);
        row.order                = move.order;
        if (move.states_owner) {
            row.parent_id = move.parent;
        }
        row.updated_at          = now;
        out.collections[row.id] = std::move (row);
        return;
    }
    auto staged = out.requests.find (move.id);
    vayu::db::Request row =
    staged != out.requests.end () ? staged->second : *db.get_request (move.id);
    row.order = move.order;
    if (move.states_owner) {
        row.collection_id = move.collection;
    }
    row.updated_at       = now;
    out.requests[row.id] = std::move (row);
}

} // namespace

/**
 * Testable core of POST /reorder - one drop, one round trip, one transaction
 * (issue #365), returning {http_status, json_body}.
 *
 * A drop that displaces N siblings used to have no sane write path: the only
 * write verbs are one row per `PUT`, so a renumber was N sequential requests -
 * non-atomic (a crash mid-sequence half-renumbers a parent), racy against a
 * concurrent create computing `max_order + 1` between two of them and against
 * `POST /import/apply`'s own transactional order slots, and an invalidation
 * storm on the client. This endpoint takes the whole batch instead.
 *
 * The order of business is fixed and load-bearing:
 *
 *  1. **Everything is validated first** - entry shapes, that every named row and
 *     owner exists, and that the *post-move* collection graph is acyclic. A
 *     failure is a 400 naming the offending row, with nothing written; the
 *     partial batch that per-row PUTs could leave behind is unreachable here.
 *  2. **`normalize` renumbers, then `moves` position.** Normalization
 *     materializes a scope's displayed order as dense `0..n-1` so a first drop
 *     into a legacy all-zeros collection has real slots to name; the moves then
 *     state the positions the drop actually produced, and win over the
 *     renumber for any row named by both.
 *  3. **One transaction under the DB mutex** (`Database::apply_reorder`), so the
 *     validation above and the write share a lock scope - which is what closes
 *     the read-then-write race `PUT /collections/:id`'s cycle guard still has.
 *
 * The response carries the rows as written, because the client that drew the
 * drop optimistically needs the authoritative positions to settle its caches on
 * - a count would tell it nothing it could use.
 *
 * Extracted for reorder_route_test.cpp, following the suite's route-test
 * convention (no in-process HTTP server).
 */
std::pair<int, nlohmann::json>
reorder_response (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return body_error ("Body must be a JSON object");
    }

    const nlohmann::json empty     = nlohmann::json::array ();
    const nlohmann::json* moves_in = &empty;
    const nlohmann::json* norm_in  = &empty;
    if (body.contains ("moves") && !body["moves"].is_null ()) {
        if (!body["moves"].is_array ()) {
            return body_error ("Invalid 'moves': must be an array");
        }
        moves_in = &body["moves"];
    }
    if (body.contains ("normalize") && !body["normalize"].is_null ()) {
        if (!body["normalize"].is_array ()) {
            return body_error ("Invalid 'normalize': must be an array");
        }
        norm_in = &body["normalize"];
    }

    const size_t total = moves_in->size () + norm_in->size ();
    if (total > MAX_REORDER_ENTRIES) {
        return body_error ("Reorder too large: " + std::to_string (total) +
        " entries exceeds the limit of " + std::to_string (MAX_REORDER_ENTRIES) + " per call");
    }

    std::vector<Scope> scopes;
    scopes.reserve (norm_in->size ());
    for (size_t i = 0; i < norm_in->size (); ++i) {
        Scope scope;
        if (auto err = read_scope (db, (*norm_in)[i], i, scope)) {
            return *err;
        }
        scopes.push_back (std::move (scope));
    }

    std::vector<Move> moves;
    moves.reserve (moves_in->size ());
    std::unordered_set<std::string> claimed;
    for (size_t i = 0; i < moves_in->size (); ++i) {
        Move move;
        if (auto err = read_move (db, (*moves_in)[i], i, move)) {
            return *err;
        }
        // Two positions for one row is not a resolvable batch - whichever won
        // would be an accident of iteration order, and the client that sent it
        // has a bug the 400 names.
        if (!claimed.insert (move.id).second) {
            return body_error ("Duplicate move for '" + move.id + "'");
        }
        moves.push_back (std::move (move));
    }

    if (auto err = reject_post_move_cycles (db, moves)) {
        return *err;
    }

    const int64_t now = now_ms ();
    WriteSet writes;
    for (const auto& scope : scopes) {
        normalize_scope (db, scope, now, writes);
    }
    for (const auto& move : moves) {
        stage_move (db, move, now, writes);
    }

    std::vector<vayu::db::Collection> collection_rows;
    std::vector<vayu::db::Request> request_rows;
    collection_rows.reserve (writes.collections.size ());
    request_rows.reserve (writes.requests.size ());
    nlohmann::json collections_out = nlohmann::json::array ();
    nlohmann::json requests_out    = nlohmann::json::array ();
    for (const auto& [id, row] : writes.collections) {
        collections_out.push_back (vayu::json::serialize (row));
        collection_rows.push_back (row);
    }
    for (const auto& [id, row] : writes.requests) {
        requests_out.push_back (vayu::json::serialize (row));
        request_rows.push_back (row);
    }

    if (!writes.empty ()) {
        db.apply_reorder (collection_rows, request_rows);
    }
    return { 200, nlohmann::json{ { "collections", collections_out }, { "requests", requests_out } } };
}

void register_reorder_routes (RouteContext& ctx) {
    /**
     * POST /reorder
     * Repositions collections and requests in one atomic batch - the write path
     * behind a drag-and-drop reorder or a cross-folder move.
     * Body params: `moves` (array of {type, id, order, parentId? |
     * collectionId?}) and `normalize` (array of {type, parentId |
     * collectionId}); both optional, an empty batch is a no-op. Normalization
     * renumbers a scope's children dense 0..n-1 in display order before the
     * moves apply. Returns: 200 `{"collections": [...], "requests": [...]}` -
     * the rows as written - or 400 naming the offending row, in which case
     * nothing at all was written.
     */
    ctx.server.Post ("/reorder", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const std::exception& e) {
            vayu::utils::log_warning (
            "POST /reorder - invalid JSON body: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON body");
            return;
        }
        // A validation failure is the core's 400; only a write or serialization
        // failure reaches this catch, and that is a 500, not the client's fault.
        try {
            auto [status, response] = reorder_response (ctx.db, body);
            if (status != 200) {
                vayu::utils::log_warning ("POST /reorder - " +
                std::to_string (status) + ": " + error_message_of (response));
            } else {
                vayu::utils::log_info ("POST /reorder - wrote " +
                std::to_string (response["collections"].size ()) + " collections, " +
                std::to_string (response["requests"].size ()) + " requests");
            }
            res.status = status;
            res.set_content (response.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("POST /reorder - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
