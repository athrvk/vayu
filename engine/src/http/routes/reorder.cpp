/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * POST /reorder: the atomic batch reorder and move for collections and requests
 * (#365).
 */

#include "vayu/core/spec_binding.hpp"
#include "vayu/db/sibling_order.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

/**
 * Entries per call, as for `/import/apply`: every row is loaded and built
 * before anything is written, so an unbounded batch is an unbounded allocation;
 * a drop writes a handful of rows and a whole-workspace renumber stays far
 * below this.
 */
constexpr size_t MAX_REORDER_ENTRIES = 10000;

/** A 400 about the payload as a whole. */
RouteError body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/** The two entity kinds this endpoint moves. */
enum class Kind : std::uint8_t { Collection, Request };

/**
 * One parent whose children are renumbered dense before the moves apply: its
 * sub-folders and its requests as one list (#2535). `std::nullopt` is the
 * roots, which hold collections only.
 */
struct Scope {
    std::optional<std::string> parent;
};

/** One row's new position, and - when it changes owner - its new owner. */
struct Move {
    // Defaulted because `read_move` can refuse the entry before filling this
    // out-parameter: an indeterminate enum reads as a value on any path that
    // forgets to check the refusal.
    Kind kind = Kind::Collection;
    std::string id;
    int order         = 0;
    bool states_owner = false; // parentId / collectionId present in the body
    std::optional<std::string> parent; // collection move
    std::string collection;            // request move
};

/** Reads and validates a move's `type`. */
RouteResult read_kind (const nlohmann::json& entry, const std::string& at, Kind& out) {
    if (!entry.is_object ()) {
        return std::unexpected (body_error ("Invalid " + at + ": must be an object"));
    }
    if (!entry.contains ("type") || !entry["type"].is_string ()) {
        return std::unexpected (body_error (
        "Invalid " + at + R"(: 'type' must be "collection" or "request")"));
    }
    const std::string type = entry["type"].get<std::string> ();
    if (type == "collection") {
        out = Kind::Collection;
        return {};
    }
    if (type == "request") {
        out = Kind::Request;
        return {};
    }
    return std::unexpected (body_error ("Invalid " + at + ": unknown type '" + type + "'"));
}

/// What a `normalize` entry looks like, quoted by every refusal of one.
constexpr std::string_view SCOPE_SHAPE =
R"(a scope is {"parentId": <collection id, or null for the roots>} and covers )"
"the parent's sub-folders and requests together";

/**
 * Reads one `normalize` entry. A scope must state `parentId` (`null` or `""`
 * for the roots, through `read_parent_id_field`): absent could mean the roots
 * or an inferred parent, and a renumber of the wrong scope reshuffles a whole
 * folder. A named parent must exist, unlike for the single-row `PUT`, which
 * tolerates one because bulk import writes rows that cannot see each other yet;
 * nothing here is bulk-created, so an unresolved scope is a client bug. The
 * per-kind shapes predating #2535 (`type` with `parentId` or `collectionId`)
 * are refused: renumbering one kind alone would leave it tied with the other
 * kind's slots.
 */
RouteResult
read_scope (vayu::db::Database& db, const nlohmann::json& entry, size_t index, Scope& out) {
    const std::string at = "normalize entry at index " + std::to_string (index);
    if (!entry.is_object ()) {
        return std::unexpected (body_error ("Invalid " + at + ": must be an object"));
    }
    if (entry.contains ("type") || entry.contains ("collectionId")) {
        return std::unexpected (body_error ("Invalid " + at +
        ": 'type' and 'collectionId' are no longer accepted; " + std::string (SCOPE_SHAPE)));
    }
    if (!entry.contains ("parentId")) {
        return std::unexpected (body_error ("Invalid " + at +
        ": 'parentId' must be stated; " + std::string (SCOPE_SHAPE)));
    }
    if (auto outcome = read_parent_id_field (entry["parentId"], out.parent, at); !outcome) {
        return outcome;
    }
    if (out.parent && !db.get_collection (*out.parent).has_value ()) {
        return std::unexpected (
        body_error ("Collection '" + *out.parent + "' does not exist"));
    }
    return {};
}

/**
 * Reads one `moves` entry and checks the row it names is stored. `order` is
 * required, through `read_order_field`: this endpoint writes dense positions,
 * and a float, a negative or a value past `int` would be a truncated,
 * unreachable or wrapped slot. The owner fields follow the single-row
 * merge-patch rule (absent keeps, present moves), except that a stated owner
 * must exist, for `read_scope`'s reason.
 */
RouteResult
read_move (vayu::db::Database& db, const nlohmann::json& entry, size_t index, Move& out) {
    const std::string at = "move at index " + std::to_string (index);
    if (auto outcome = read_kind (entry, at, out.kind); !outcome) {
        return outcome;
    }
    if (!entry.contains ("id") || !entry["id"].is_string () ||
    entry["id"].get<std::string> ().empty ()) {
        return std::unexpected (
        body_error ("Invalid " + at + ": 'id' must be a non-empty string"));
    }
    out.id = entry["id"].get<std::string> ();

    if (auto outcome =
        read_order_field (entry.value ("order", nlohmann::json ()), out.order, at);
    !outcome) {
        return outcome;
    }

    if (out.kind == Kind::Collection) {
        if (!db.get_collection (out.id).has_value ()) {
            return std::unexpected (body_error ("Collection '" + out.id + "' does not exist"));
        }
        if (entry.contains ("parentId")) {
            out.states_owner = true;
            if (auto outcome = read_parent_id_field (entry["parentId"], out.parent, at);
            !outcome) {
                return outcome;
            }
            if (out.parent && !db.get_collection (*out.parent).has_value ()) {
                return std::unexpected (
                body_error ("Collection '" + *out.parent + "' does not exist"));
            }
        }
        return {};
    }

    if (!db.get_request (out.id).has_value ()) {
        return std::unexpected (body_error ("Request '" + out.id + "' does not exist"));
    }
    if (entry.contains ("collectionId")) {
        if (!entry["collectionId"].is_string ()) {
            return std::unexpected (
            body_error ("Invalid " + at + ": 'collectionId' must be a string"));
        }
        out.states_owner = true;
        out.collection   = entry["collectionId"].get<std::string> ();
        if (!db.get_collection (out.collection).has_value ()) {
            return std::unexpected (
            body_error ("Collection '" + out.collection + "' does not exist"));
        }
    }
    return {};
}

/**
 * Refuses a batch that would leave a collection its own ancestor. The walk runs
 * over the graph the batch would produce (stored parents with each move's
 * `parentId` on top), under the one acquisition of the DB mutex the write holds
 * (`reorder_response`), which closes the race the per-row `PUT` has: of two
 * concurrent reparents each legal alone, the second revalidates against the
 * first's committed graph and is refused. `PUT /collections/:id` validates
 * against what it read, under a different lock than the write.
 *
 * Only moved collections start a walk: a post-move cycle must pass through an
 * edge this batch changed, so reaching a root or a visited node is proof
 * enough. The visited set also keeps a pre-existing corrupt cycle (one
 * `validate_parent_assignment` tolerates) from hanging the validator.
 */
RouteResult reject_post_move_cycles (vayu::db::Database& db, const std::vector<Move>& moves) {
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
            return std::unexpected (
            body_error ("Collection '" + move.id + "' cannot be its own parent"));
        }
        std::unordered_set<std::string> seen;
        std::optional<std::string> cursor = move.parent;
        while (cursor.has_value ()) {
            if (*cursor == move.id) {
                return std::unexpected (body_error ("Cannot move collection '" +
                move.id + "' into its own descendant"));
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
    return {};
}

/**
 * The rows a batch writes, keyed by id so a row named by a normalization and a
 * move is written once, the move's position winning. Ordered maps: the response
 * lists what was written, and a client diffing two responses should not have to
 * sort them.
 */
struct WriteSet {
    std::map<std::string, vayu::db::Collection> collections;
    std::map<std::string, vayu::db::Request> requests;

    bool empty () const {
        return collections.empty () && requests.empty ();
    }
};

/** Stages @p row at @p index, unless that is where it already sits. */
template <typename Row>
void stage_position (const Row& row, int index, int64_t now, std::map<std::string, Row>& out) {
    if (row.order == index) {
        return;
    }
    Row moved        = row;
    moved.order      = index;
    moved.updated_at = now;
    out[moved.id]    = std::move (moved);
}

/**
 * Renumbers one parent's children dense `0..n-1` in sibling order
 * (`sibling_order.hpp`: `order`, folders before requests, `createdAt`, `id`),
 * sub-folders and requests as one list, so a tie across kinds comes out
 * distinct with the folder first. Only rows whose position changes are added,
 * so normalizing a dense scope writes nothing. That is the point of
 * `normalize`: a parent whose rows all sit at the legacy `0` has a display
 * order only the sort knows, and the first drop into it must materialize that
 * order before naming a slot, or every sibling appears to jump.
 */
void normalize_scope (vayu::db::Database& db, const Scope& scope, int64_t now, WriteSet& out) {
    const std::vector<vayu::db::Collection> collections = db.get_collections ();
    std::vector<const vayu::db::Collection*> folders;
    for (const auto& c : collections) {
        if (c.parent_id == scope.parent) {
            folders.push_back (&c);
        }
    }
    const std::vector<vayu::db::Request> requests = scope.parent ?
    db.get_requests_in_collection (*scope.parent) :
    std::vector<vayu::db::Request>{};

    int index = 0;
    for (const auto& slot : vayu::db::merge_siblings (folders, requests)) {
        if (slot.kind == vayu::db::SiblingKind::Folder) {
            stage_position (*folders.at (slot.index), index, now, out.collections);
        } else {
            stage_position (requests.at (slot.index), index, now, out.requests);
        }
        ++index;
    }
}

/// `read_move` proved every named row exists before staging, and the batch runs
/// under the DB mutex `reorder_response` holds, so a moved row is still there
/// when read back.
constexpr std::string_view ROW_EXISTS_INVARIANT =
"a validated move names a stored row, under the DB mutex the batch holds";

/** Applies one move on top of whatever the normalization pass already staged. */
void stage_move (vayu::db::Database& db, const Move& move, int64_t now, WriteSet& out) {
    if (move.kind == Kind::Collection) {
        auto staged              = out.collections.find (move.id);
        vayu::db::Collection row = staged != out.collections.end () ?
        staged->second :
        vayu::utils::invariant_value (db.get_collection (move.id), ROW_EXISTS_INVARIANT);
        row.order                = move.order;
        if (move.states_owner) {
            row.parent_id = move.parent;
        }
        row.updated_at          = now;
        out.collections[row.id] = std::move (row);
        return;
    }
    auto staged           = out.requests.find (move.id);
    vayu::db::Request row = staged != out.requests.end () ?
    staged->second :
    vayu::utils::invariant_value (db.get_request (move.id), ROW_EXISTS_INVARIANT);
    row.order             = move.order;
    if (move.states_owner) {
        row.collection_id = move.collection;
    }
    row.updated_at       = now;
    out.requests[row.id] = std::move (row);
}

/**
 * The stored rows of every stamped request whose binding the batch can change:
 * each one a move names with an owner, and each one beneath a collection a move
 * reparents. Read before anything is written, so they are the rows as they
 * stand; only a stamped request can decline anything.
 */
std::map<std::string, vayu::db::Request>
stamped_requests_moved (vayu::db::Database& db, const std::vector<Move>& moves) {
    std::map<std::string, vayu::db::Request> stamped;
    const auto keep = [&stamped] (vayu::db::Request request) {
        if (request.spec_operation) {
            stamped.emplace (request.id, std::move (request));
        }
    };
    for (const auto& move : moves) {
        if (!move.states_owner) {
            continue;
        }
        if (move.kind == Kind::Request) {
            keep (vayu::utils::invariant_value (db.get_request (move.id), ROW_EXISTS_INVARIANT));
            continue;
        }
        for (auto& request : db.get_requests_in_subtree (move.id)) {
            keep (std::move (request));
        }
    }
    return stamped;
}

/**
 * Stages the requests the batch takes out of the contract that answered for
 * them (#3446), and answers each one's id with the bound collection its
 * operation is declined under (`declined_by_move`, read over the staged tree
 * by `SpecTreeMove`). A departing request is staged with its stamp cleared, so
 * the response shows the row as written.
 */
std::unordered_map<std::string, std::string> stage_binding_departures (vayu::db::Database& db,
const std::vector<Move>& moves,
int64_t now,
WriteSet& writes) {
    std::unordered_map<std::string, std::string> departures;
    const auto stamped = stamped_requests_moved (db, moves);
    if (stamped.empty ()) {
        return departures;
    }

    const SpecTreeMove tree (db.get_collections (), writes.collections);
    for (const auto& [id, stored] : stamped) {
        const auto staged    = writes.requests.find (id);
        const bool is_staged = staged != writes.requests.end ();
        const std::string destination =
        is_staged ? staged->second.collection_id : stored.collection_id;
        const auto under = tree.declined_under (stored, destination);
        if (!under) {
            continue;
        }
        vayu::db::Request row = is_staged ? staged->second : stored;
        row.spec_operation    = std::nullopt;
        row.updated_at        = now;
        writes.requests[id]   = std::move (row);
        departures.emplace (id, *under);
    }
    return departures;
}

/**
 * The batch a reorder is about to stage: the scopes to renumber and the moves
 * to apply, each through the validation a single write uses.
 */
RouteResult read_reorder_batch (vayu::db::Database& db,
const nlohmann::json& body,
std::vector<Scope>& scopes,
std::vector<Move>& moves) {
    const nlohmann::json empty     = nlohmann::json::array ();
    const nlohmann::json* moves_in = &empty;
    const nlohmann::json* norm_in  = &empty;
    if (body.contains ("moves") && !body["moves"].is_null ()) {
        if (!body["moves"].is_array ()) {
            return std::unexpected (
            body_error ("Invalid 'moves': must be an array"));
        }
        moves_in = &body["moves"];
    }
    if (body.contains ("normalize") && !body["normalize"].is_null ()) {
        if (!body["normalize"].is_array ()) {
            return std::unexpected (
            body_error ("Invalid 'normalize': must be an array"));
        }
        norm_in = &body["normalize"];
    }

    const size_t total = moves_in->size () + norm_in->size ();
    if (total > MAX_REORDER_ENTRIES) {
        return std::unexpected (body_error (
        "Reorder too large: " + std::to_string (total) + " entries exceeds the limit of " +
        std::to_string (MAX_REORDER_ENTRIES) + " per call"));
    }

    scopes.reserve (norm_in->size ());
    for (size_t i = 0; i < norm_in->size (); ++i) {
        Scope scope;
        if (auto outcome = read_scope (db, (*norm_in)[i], i, scope); !outcome) {
            return outcome;
        }
        scopes.push_back (std::move (scope));
    }

    moves.reserve (moves_in->size ());
    std::unordered_set<std::string> claimed;
    for (size_t i = 0; i < moves_in->size (); ++i) {
        Move move;
        if (auto outcome = read_move (db, (*moves_in)[i], i, move); !outcome) {
            return outcome;
        }
        // Two positions for one row is no resolvable batch: whichever won would
        // be an accident of iteration order, and the client has a bug the 400
        // names.
        if (!claimed.insert (move.id).second) {
            return std::unexpected (body_error ("Duplicate move for '" + move.id + "'"));
        }
        moves.push_back (std::move (move));
    }
    return {};
}

/**
 * The batch, from validation to commit, with the DB mutex already held by
 * `reorder_response` (which says why). The order is fixed and load-bearing:
 *
 *  1. **Everything is validated first**: entry shapes, that every named row and
 *     owner exists, and that the post-move collection graph is acyclic. A
 *     failure is a 400 naming the row, with nothing written, so the partial
 *     batch per-row PUTs could leave is unreachable.
 *  2. **`normalize` renumbers, then `moves` position.** Normalization
 *     materializes a scope's displayed order as dense `0..n-1`, so a first drop
 *     into a legacy all-zeros collection has real slots to name; the moves then
 *     state the positions the drop produced and win for any row named by both.
 *     A stamped request a move takes out of its contract is staged with its
 *     stamp cleared (`stage_binding_departures`, #3446).
 *  3. **One transaction** (`Database::apply_reorder`) of updates, never
 *     inserts: a row deleted under the batch is a 409 naming it and a whole
 *     rollback, not a silent resurrection. The departures' declines are
 *     recorded in it.
 *
 * The response carries the rows as written: the client that drew the drop
 * optimistically settles its caches on the authoritative positions.
 */
std::pair<int, nlohmann::json> reorder_locked (vayu::db::Database& db,
const nlohmann::json& body,
const std::function<void ()>& before_write) {
    if (!body.is_object ()) {
        return as_response (body_error ("Body must be a JSON object"));
    }

    std::vector<Scope> scopes;
    std::vector<Move> moves;
    if (auto outcome = read_reorder_batch (db, body, scopes, moves); !outcome) {
        return as_response (outcome.error ());
    }

    if (auto outcome = reject_post_move_cycles (db, moves); !outcome) {
        return as_response (outcome.error ());
    }

    const int64_t now = now_ms ();
    WriteSet writes;
    for (const auto& scope : scopes) {
        normalize_scope (db, scope, now, writes);
    }
    for (const auto& move : moves) {
        stage_move (db, move, now, writes);
    }
    const auto departures = stage_binding_departures (db, moves, now, writes);

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
    const auto files = vayu::http::FileAccessPolicy::from_database (db);
    for (const auto& [id, row] : writes.requests) {
        requests_out.push_back (vayu::json::serialize (row, files));
        request_rows.push_back (row);
    }

    if (before_write) {
        before_write ();
    }

    if (!writes.empty ()) {
        try {
            db.apply_reorder (collection_rows, request_rows, departures);
        } catch (const vayu::db::MissingRowError& e) {
            // Unreachable while every writer takes the DB mutex, which this
            // runs under. It stays because `apply_reorder` is public, its
            // no-resurrection rule holds for any caller, and a 409 is the
            // honest answer to "the staged row is gone": the client's tree is
            // behind, and a retry fixes it.
            return { 409, error_body (409, e.what ()) };
        }
    }
    return { 200, nlohmann::json{ { "collections", collections_out }, { "requests", requests_out } } };
}

} // namespace

/**
 * Testable core of POST /reorder: one drop, one round trip, one lock scope
 * (#365, #386), {http_status, json_body}. A drop displacing N siblings has no
 * sane path through the single-row verbs: N sequential requests are non-atomic
 * (a crash half-renumbers a parent), race a concurrent create computing
 * `max_order + 1` and `POST /import/apply`'s transactional slots, and storm the
 * client with invalidations.
 *
 * **The whole batch runs under one acquisition of the DB mutex**, not one per
 * `Database` call. cpp-httplib serves on a thread pool and the renderer and MCP
 * are concurrent clients, so validating under one lock and committing under
 * another leaves three windows (#386): two conflicting reparents each passing
 * an acyclicity check the other's commit was invisible to, a create reading
 * `max_order + 1` inside the range being renumbered, and a cascade deleting a
 * staged row between read and write. `Database::with_lock` documents the cost
 * of holding it.
 *
 * @param before_write Test seam, invoked inside the lock once the batch is
 *        staged and immediately before it commits: the only way to observe the
 *        window. A probe starting a competing writer proves it waits, and one
 *        mutating the DB directly (the mutex is recursive) stages the
 *        delete-at-commit case. Production callers omit it.
 */
std::pair<int, nlohmann::json> reorder_response (vayu::db::Database& db,
const nlohmann::json& body,
const std::function<void ()>& before_write = nullptr) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] { result = reorder_locked (db, body, before_write); });
    return result;
}

void register_reorder_routes (RouteContext& ctx) {
    /**
     * POST /reorder
     * Repositions collections and requests in one atomic batch - the write path
     * behind a drag-and-drop reorder or a cross-folder move.
     * Body params: `moves` (array of {type, id, order, parentId? |
     * collectionId?}) and `normalize` (array of {parentId}, null for the
     * roots); both optional, an empty batch is a no-op. Normalization
     * renumbers a parent's sub-folders and requests together dense 0..n-1 in
     * sibling order before the moves apply. A stamped request moved out of
     * its spec contract, alone or under a moved folder, comes back with
     * `specOperation: null` and its operation declined under the source
     * binding (#3446). Returns: 200
     * `{"collections": [...], "requests": [...]}` - the rows as written - or
     * 400 naming the offending row, in which case nothing at all was written.
     */
    ctx.server.Post ("/reorder", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const auto body = parse_request_json (req.body);
        if (!body) {
            refuse_request_body (res, "POST /reorder", body.error ());
            return;
        }
        // A validation failure is the core's 400; only a write or serialization
        // failure reaches this catch, and that is a 500, not the client's fault.
        try {
            auto [status, response] = reorder_response (ctx.db, *body);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "POST /reorder - " + std::to_string (status) + ": " +
                error_message_of (response));
            } else {
                vayu::utils::log_info ("http",
                "wrote " + std::to_string (response["collections"].size ()) + " collections, " +
                std::to_string (response["requests"].size ()) + " requests");
            }
            res.status = status;
            res.set_content (response.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "POST /reorder - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
