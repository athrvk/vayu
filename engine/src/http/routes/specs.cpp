/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/specs.cpp
 * @brief OpenAPI documents - stored once, bound by collections (issue #637).
 *
 * A spec is not owned by a collection: several may bind the same document, and
 * unbinding one must leave it there for the others. So it is a top-level
 * resource with no cascade reaching it, and the one rule that keeps that safe
 * lives here - `DELETE /specs/:id` refuses while any collection still names it,
 * saying which. The alternative, cascading the bindings to unbound, would
 * silently detach collections the caller never mentioned.
 *
 * The document is stored **verbatim** and its hash is computed here on every
 * write, never taken from the caller: a run stamps the hash it planned against,
 * and that stamp only means something if both sides were computed by this code
 * on these bytes.
 */

#include "vayu/core/constants.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/schema_validation.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/sha256.hpp"

#include <optional>
#include <string>
#include <unordered_set>
#include <utility>

namespace vayu::http::routes {

/**
 * The live cap on a stored document, in bytes.
 *
 * Read fresh on every write from the `maxSpecDocumentBytes` config entry rather
 * than cached, exactly as `http_version_seed` reads its default: a user who
 * raises the limit must be able to import the document that was refused, without
 * restarting the engine. A non-positive stored value falls back to the compiled
 * default rather than disabling the cap - a tampered or zeroed row must not be
 * able to turn the bound off.
 *
 * Shared with `POST /import/apply`, which writes spec rows of its own; declared
 * in routes.hpp so the two paths cannot come to enforce different limits.
 */
size_t spec_size_cap (vayu::db::Database& db) {
    const int configured = db.get_config_int ("maxSpecDocumentBytes",
    static_cast<int> (vayu::core::constants::spec_document::MAX_BYTES));
    if (configured <= 0) {
        return vayu::core::constants::spec_document::MAX_BYTES;
    }
    return static_cast<size_t> (configured);
}

/**
 * Hex-encoded SHA-256 of a document's text - the value stored in
 * `spec_documents.hash` and stamped onto a run's snapshot.
 *
 * Non-static so specs_route_test.cpp can assert the two agree on the same bytes;
 * declared in routes.hpp for the same reason.
 */
std::string spec_content_hash (const std::string& content) {
    const auto digest = vayu::utils::sha256 (content);
    return vayu::utils::hex_encode (std::string_view (
    reinterpret_cast<const char*> (digest.data ()), digest.size ()));
}

/**
 * Puts the `operations` (#629) and `responseSchemas` (#628) indexes onto
 * @p spec, both derived from the document about to be stored.
 *
 * **Neither is taken from the caller**, for the reason `hash` is not: an index a
 * client worked out is a claim about a document nobody verified, and a wrong one
 * does not merely go unread - coverage resolves a stamp by `operationId` first,
 * so a row claiming an id the document does not declare claims whichever
 * operation happens to share it. The engine reading the document is what #761's
 * phase B moved here (#853 for the operations, #860 for the schemas), and this
 * is the write path's whole use of it: `core::derive_spec_indexes` reads the
 * bytes about to be stored, once, and answers what they declare.
 *
 * One read for both is what makes the two agree. They describe the same
 * operations by the same identity rules, so a schema index carrying a status the
 * operation index does not list would be a contract disagreeing with itself -
 * which is what two extractors, in two languages, produced before this. The DOM
 * is handed out rather than dropped for that same reason: a sync writes the
 * examples the document it stores documents (issue #869), and reading those
 * bytes a second time would be a second answer about them.
 */
std::optional<std::string> read_spec_indexes (const nlohmann::json& item,
vayu::db::SpecDocument& spec,
size_t index_cap,
nlohmann::ordered_json* document_out) {
    for (const char* derived : { "operations", "responseSchemas" }) {
        if (item.contains (derived)) {
            return std::string ("'") + derived +
            "' is derived from the document by the engine; omit it";
        }
    }
    vayu::core::DocumentRead read = vayu::core::read_document (spec.content);
    if (!read.ok ()) {
        return "Invalid 'content': " + read.error;
    }
    auto indexes = vayu::core::spec_indexes_of (read.root, index_cap);
    if (!indexes.ok ()) {
        return indexes.error;
    }
    spec.operations       = std::move (indexes.operations);
    spec.response_schemas = std::move (indexes.response_schemas);
    if (document_out != nullptr) {
        *document_out = std::move (read.root);
    }
    return std::nullopt;
}

/**
 * A draft's documented responses, as the example rows a write of them takes.
 *
 * One definition of that shape for the two routes that have one: `POST
 * /specs/diff` reports it, so a caller can see what an apply would write, and
 * `POST /specs/sync` writes it (issue #869). It used to be the diff's alone, and
 * the caller echoed the rows back into the sync payload - which made a client
 * able to state examples the document does not describe, and made the shape
 * something two sides had to keep agreeing about.
 *
 * `documented` is the field that decides whether the row carries a
 * `Content-Type` at all: a `204 No Content` documents nothing and still becomes
 * an example, because a mock server has to be able to answer with it.
 */
nlohmann::json draft_example_rows (const std::vector<vayu::core::DraftExample>& examples) {
    nlohmann::json rows = nlohmann::json::array ();
    for (const vayu::core::DraftExample& example : examples) {
        nlohmann::json headers = nlohmann::json::array ();
        if (example.documented) {
            headers.push_back ({ { "key", "Content-Type" },
            { "value", example.content_type }, { "enabled", true } });
        }
        rows.push_back ({ { "name", example.name },
        { "status", example.status }, { "headers", std::move (headers) },
        { "body", example.body }, { "contentType", example.content_type } });
    }
    return rows;
}

/**
 * Resolve what a single request's response should be validated against
 * (issue #628).
 *
 * The binding lives on the collection an import created, and requests live in
 * its *tag sub-collections*, so this walks the ancestry and takes the nearest
 * bound collection - `core::nearest_spec_binding`, over the same chain
 * `POST /compose` walks for inherited auth, cycle guard included, and the same
 * function a scenario run resolves through. A request whose ancestry binds
 * nothing is not part of a contract: `bound` stays false and the caller writes
 * **no verdict at all**, which is the distinction the whole node rests on - a
 * response that was never judged against a contract did not fail one.
 *
 * Every other outcome is bound-but-unjudgeable and carries the reason, because
 * a chip that silently never appears is how a broken index stays broken.
 */
DesignSchemaResolution resolve_design_schema_index (vayu::db::Database& db,
const std::optional<std::string>& request_id) {
    DesignSchemaResolution resolved;
    if (!request_id || request_id->empty ()) {
        return resolved; // editor state with no stored row - not an operation
    }

    const auto request = db.get_request (*request_id);
    if (!request) {
        return resolved;
    }
    resolved.spec_operation = request->spec_operation.value_or (std::string ());

    // The same walk `resolve_scenario` uses, through the same function: the two
    // paths disagreeing about what "bound" means is what left a tag
    // sub-collection's run measuring nothing while a Send of the same request
    // was checked (issue #716).
    const auto bound = vayu::core::nearest_spec_binding (db, request->collection_id);
    if (!bound) {
        return resolved;
    }
    const std::string& spec_id   = bound->spec_id;
    const std::string& spec_hash = bound->spec_hash;

    resolved.bound      = true;
    const auto document = db.get_spec_document (spec_id);
    if (!document) {
        // The write path refuses a binding naming a document that will not
        // exist (`reject_unbindable_spec`), so this is a database edited from
        // outside. There is nothing to validate against, which is what
        // `no_index` says.
        resolved.reason = vayu::core::UncheckedReason::NoIndex;
        return resolved;
    }
    if (!spec_hash.empty () && document->hash != spec_hash) {
        // The binding names a document *and a version of it*, the rule
        // `resolve_scenario` applies to coverage. A row whose hash has moved
        // under the binding declares something this request was never bound to.
        resolved.reason = vayu::core::UncheckedReason::HashMismatch;
        return resolved;
    }

    auto index = vayu::core::ResponseSchemaIndex::parse (document->response_schemas);
    if (!index) {
        resolved.reason = vayu::core::UncheckedReason::NoIndex;
        return resolved;
    }
    resolved.index = std::move (index);
    return resolved;
}

/**
 * The verdict one design-mode response gets, or `std::nullopt` for a request
 * that is not bound to a contract at all (issue #628).
 *
 * The whole of the design-mode hook, in one function, so the `/execute` handler
 * states it once and the collection-run and load hooks that follow can call the
 * same thing rather than a second arrangement of the same three steps.
 */
std::optional<vayu::core::ValidationVerdict> validate_design_response (vayu::db::Database& db,
const std::optional<std::string>& request_id,
const vayu::Response& response) {
    vayu::http::routes::DesignSchemaResolution resolved;
    try {
        resolved = resolve_design_schema_index (db, request_id);
    } catch (const std::exception& e) {
        // A lookup failure costs the response its verdict, never the response.
        vayu::utils::log_warning (
        "Schema validation lookup failed: " + std::string (e.what ()));
        return std::nullopt;
    }
    if (!resolved.bound) {
        return std::nullopt;
    }
    if (!resolved.index) {
        vayu::core::ValidationVerdict verdict;
        verdict.reason = resolved.reason.value_or (vayu::core::UncheckedReason::NoIndex);
        return verdict;
    }

    const auto content_type = response.headers.find ("Content-Type");
    try {
        return resolved.index->check (resolved.spec_operation, response.status_code,
        content_type != response.headers.end () ? content_type->second : std::string (),
        response.body);
    } catch (const std::exception& e) {
        // Same rule as above: a validator that threw is not a response that
        // failed, and the exchange itself is not in question.
        vayu::utils::log_warning ("Schema validation failed: " + std::string (e.what ()));
        return std::nullopt;
    }
}

/**
 * Refuses a collection write whose `openapi` binding names a spec that will not
 * exist when the write lands.
 *
 * A binding that resolves to nothing is the worst of the states this table can
 * be in: the collection reads back as spec-bound, its runs stamp a `specId`
 * nobody can fetch, and #627's sync has nothing to re-fetch *from*. So it is
 * refused at the write rather than discovered by a later reader.
 *
 * @p pending is what the caller is about to write in the same transaction and
 * cannot look up yet - `POST /import/apply`'s own spec section. Every other
 * write path passes an empty set, because everything it may bind is already
 * stored.
 */
std::optional<std::pair<int, nlohmann::json>> reject_unbindable_spec (vayu::db::Database& db,
const std::string& openapi,
const std::unordered_set<std::string>& pending) {
    std::string spec_id;
    try {
        const auto parsed = nlohmann::json::parse (openapi);
        if (!parsed.is_object ()) {
            return std::nullopt;
        }
        spec_id = parsed.value ("specId", std::string ());
    } catch (const std::exception&) {
        return std::nullopt; // Not a binding; the applier already had its say.
    }
    if (spec_id.empty () || pending.contains (spec_id) ||
    db.get_spec_document (spec_id).has_value ()) {
        return std::nullopt;
    }
    return std::make_pair (400, error_body (400, "Spec '" + spec_id + "' does not exist"));
}

/**
 * Completes a binding the caller wrote without a version (issue #709), from the
 * document already in the store.
 *
 * The rule itself is `vayu::core::stamp_spec_binding`; this is the store's
 * answer to its one question. `syncedAt` is *now* rather than the document's
 * `fetched_at`: this write is the moment the collection was bound to that
 * version, which is what the Spec tab's "Bound" reports and what a later sync
 * compares against.
 */
void stamp_binding_from_store (vayu::db::Database& db, std::string& openapi) {
    auto stamped = vayu::core::stamp_spec_binding (openapi,
    [&] (const std::string& spec_id) -> std::optional<vayu::core::SpecStamp> {
        auto document = db.get_spec_document (spec_id);
        if (!document) {
            return std::nullopt;
        }
        return vayu::core::SpecStamp{ document->hash, now_ms () };
    });
    if (stamped) {
        openapi = std::move (*stamped);
    }
}

/**
 * Testable core of POST /specs - store one OpenAPI document, returning
 * {http_status, json_body}.
 *
 * Create only, like every other resource here: the engine mints the id (#97), so
 * a body `id` is a 400. There is deliberately no `PUT /specs/:id` - a document
 * that changed is a *different* document, and rewriting one in place would
 * invalidate the hash every run of every collection bound to it was stamped
 * with. Phase 2 (#627) re-fetches by storing a new one and moving the binding.
 *
 * `hash`, `fetchedAt` and both indexes are engine-computed and rejected in the
 * body for the same reason `id` is: each would otherwise be a claim about bytes
 * nobody verified. The indexes come from `core::derive_spec_indexes` (issues
 * #853 and #860), which is also what makes an unreadable document a `400` here
 * rather than a row nothing downstream can read.
 */
std::pair<int, nlohmann::json>
create_spec_document_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (auto err = reject_client_supplied_id (json)) {
        return *err;
    }
    for (const char* derived : { "hash", "fetchedAt" }) {
        if (json.contains (derived)) {
            return { 400, error_body (400, std::string ("'") + derived + "' is computed by the engine; omit it") };
        }
    }

    std::string content;
    if (auto err = apply_required_string_field (json, "content", content, /*is_create=*/true)) {
        return *err;
    }
    if (content.empty ()) {
        return { 400, error_body (400, "Invalid 'content': an empty document is not a spec") };
    }
    const size_t cap = spec_size_cap (db);
    if (content.size () > cap) {
        return { 400,
            error_body (400,
            "Spec document is " + std::to_string (content.size ()) +
            " bytes, over the limit of " + std::to_string (cap) +
            " (raise the 'maxSpecDocumentBytes' setting to allow more)") };
    }

    vayu::db::SpecDocument spec;
    spec.id      = vayu::utils::generate_id ("spec_");
    spec.content = std::move (content);
    spec.hash    = spec_content_hash (spec.content);
    if (auto reason = read_spec_indexes (json, spec, cap)) {
        return { 400, error_body (400, *reason) };
    }
    // When it was taken, not when the row was written - they are the same
    // instant here, and #627 will re-stamp it on every re-fetch.
    spec.fetched_at = now_ms ();

    if (json.contains ("sourceUrl") && !json["sourceUrl"].is_null ()) {
        if (!json["sourceUrl"].is_string ()) {
            return { 400, error_body (400, "Invalid 'sourceUrl': must be a string or null") };
        }
        const auto url = json["sourceUrl"].get<std::string> ();
        if (!url.empty ()) {
            spec.source_url = url;
        }
    }

    if (db.get_spec_document (spec.id).has_value ()) {
        return { 409, error_body (409, "Spec '" + spec.id + "' already exists") };
    }

    db.save_spec_document (spec);
    return { 200, vayu::json::serialize (spec) };
}

/** Testable core of GET /specs/:id - the whole document, or a 404. */
std::pair<int, nlohmann::json>
get_spec_document_response (vayu::db::Database& db, const std::string& id) {
    auto spec = db.get_spec_document (id);
    if (!spec) {
        return { 404, error_body (404, "Spec not found") };
    }
    return { 200, vayu::json::serialize (*spec) };
}

/**
 * Testable core of GET /specs/:id/meta - what the document *is*, without the
 * document (issue #712).
 *
 * Exists because the Spec tab's card needs `sourceUrl` and `fetchedAt` and
 * nothing else, and those live on the row rather than on the collection's
 * binding - so painting a URL and a date cost a transfer of the whole document
 * (12 MB for Stripe's spec) on every first open. Readers that need the text -
 * export, the sync comparison, `$ref` resolution - still read the full route,
 * on an action rather than on a tab opening.
 *
 * A missing id answers the **same** 404 body as the full read: the two are one
 * resource seen two ways, and a client that fell back from one to the other
 * must not have to know two shapes of "not found".
 */
std::pair<int, nlohmann::json>
get_spec_document_meta_response (vayu::db::Database& db, const std::string& id) {
    auto spec = db.get_spec_document (id);
    if (!spec) {
        return { 404, error_body (404, "Spec not found") };
    }
    return { 200, vayu::json::serialize_meta (*spec) };
}

/**
 * Testable core of DELETE /specs/:id.
 *
 * A spec still bound by a collection is a **409 naming the collection**, never a
 * cascade that quietly unbinds it: the caller asked to delete a document, not to
 * edit collections it did not mention, and the message has to be actionable
 * without a second round trip. Only the first binder is named, with a count when
 * there are more, so the answer stays one line whatever the fan-out.
 */
std::pair<int, nlohmann::json>
delete_spec_document_response (vayu::db::Database& db, const std::string& id) {
    // Read-decide-write, so the whole of it is one lock scope (issue #386's
    // rule): between "nobody binds this" and the delete, a concurrent collection
    // write could bind it and be left pointing at a document that is gone. The
    // collection write cores hold the lock across their own check-and-write, so
    // the two composites serialize against each other rather than interleaving.
    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] {
        if (!db.get_spec_document (id).has_value ()) {
            result = { 404, error_body (404, "Spec not found") };
            return;
        }
        const auto bound = db.get_collections_bound_to_spec (id);
        if (!bound.empty ()) {
            std::string message = "Spec '" + id + "' is bound by collection '" +
            bound.front ().name + "' (" + bound.front ().id + ")";
            if (bound.size () > 1) {
                message += " and " + std::to_string (bound.size () - 1) +
                " other" + std::string (bound.size () == 2 ? "" : "s");
            }
            message += "; unbind it before deleting the document";
            result = { 409, error_body (409, message) };
            return;
        }

        db.delete_spec_document (id);
        result = { 200,
            nlohmann::json{ { "message", "Spec deleted successfully" }, { "id", id } } };
    });
    return result;
}

void register_spec_routes (RouteContext& ctx) {
    /**
     * POST /specs
     * Stores one OpenAPI document verbatim and returns it with the id, hash and
     * fetch time the engine assigned. Create only - there is no PUT, because a
     * changed document is a new one (see the core above).
     * Body params: content (required, non-empty, at most `maxSpecDocumentBytes`,
     * and readable as JSON or YAML), sourceUrl (optional; null or absent means
     * it did not come from a URL), responseSchemas (optional, issue #628).
     * `id`, `hash`, `fetchedAt` and `operations` are engine-owned and a 400 if
     * sent - the operation index is read off the document here.
     * Returns: the stored document, or 400.
     */
    ctx.server.Post ("/specs", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = create_spec_document_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /specs - " +
                std::to_string (status) + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info (
                "POST /specs - Stored spec: id=" + body["id"].get<std::string> () +
                ", hash=" + body["hash"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("POST /specs - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * GET /specs/:id/meta
     * Returns everything about the document except the document: id, sourceUrl,
     * fetchedAt, hash and contentBytes. `content` and the two stored
     * indexes are **absent**, not empty - see `serialize_meta`.
     * Registered before the read below because both are `GET /specs/...`; the
     * one-segment pattern cannot match this path, and the order says so anyway.
     * Returns: the metadata, or 404 (the same body the full read answers with).
     */
    ctx.server.Get (R"(/specs/([^/]+)/meta)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string spec_id = req.matches[1];
        try {
            auto [status, body] = get_spec_document_meta_response (ctx.db, spec_id);
            if (status != 200) {
                vayu::utils::log_warning (
                "GET /specs/:id/meta - Spec not found: " + spec_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /specs/:id/meta - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * GET /specs/:id
     * Returns the whole stored document - content included, since rendering and
     * validating it is what every reader wants it for.
     * Returns: the document, or 404.
     */
    ctx.server.Get (R"(/specs/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string spec_id = req.matches[1];
        try {
            auto [status, body] = get_spec_document_response (ctx.db, spec_id);
            if (status != 200) {
                vayu::utils::log_warning ("GET /specs/:id - Spec not found: " + spec_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("GET /specs/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * DELETE /specs/:id
     * Deletes a stored document. Refused with 409 while any collection binds it,
     * naming the binder - never a cascade that unbinds collections the caller
     * did not mention.
     * Returns: a message and the id, 404, or 409.
     */
    ctx.server.Delete (R"(/specs/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string spec_id = req.matches[1];
        try {
            auto [status, body] = delete_spec_document_response (ctx.db, spec_id);
            if (status != 200) {
                vayu::utils::log_warning ("DELETE /specs/:id - " + std::to_string (status) +
                " for id=" + spec_id + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info ("DELETE /specs/:id - Deleted spec: id=" + spec_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /specs/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
