/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * OpenAPI documents, stored once and bound by collections (#637). Several
 * collections may bind one document and unbinding one must leave it for the
 * others, so it is a top-level resource no cascade reaches, kept safe by one
 * rule here: `DELETE /specs/:id` refuses while any collection names it, saying
 * which. Cascading the bindings away would silently detach collections the
 * caller never mentioned.
 *
 * The document is stored **verbatim** and its hash computed here on every
 * write, never taken from the caller: a run stamps the hash it planned against,
 * which means something only if both sides were computed by this code on these
 * bytes.
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
 * The live cap on a stored document, in bytes, read from `maxSpecDocumentBytes`
 * on every write (never cached, as `http_version_seed` reads its default), so a
 * raised limit admits the refused document without a restart. A non-positive
 * stored value falls back to the compiled default: a tampered or zeroed row
 * must not turn the bound off. Shared with `POST /import/apply`, which writes
 * spec rows too (declared in routes.hpp), so the paths enforce one limit.
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
 * Hex SHA-256 of a document's text: `spec_documents.hash` and the stamp on a
 * run's snapshot. Non-static and in routes.hpp so `specs_route_test.cpp` can
 * assert the two agree on the same bytes.
 */
std::string spec_content_hash (const std::string& content) {
    const auto digest = vayu::utils::sha256 (content);
    return vayu::utils::hex_encode (vayu::utils::byte_view (digest));
}

/**
 * Puts the `operations` (#629) and `responseSchemas` (#628) indexes onto
 * @p spec, both derived from the document about to be stored.
 *
 * **Neither is taken from the caller**, for `hash`'s reason: a client's index
 * is a claim about a document nobody verified, and a wrong one does not merely
 * go unread: coverage resolves a stamp by `operationId` first, so a row
 * claiming an id the document lacks claims whichever operation shares it. The
 * engine reads the document (#761 phase B; #853, #860): `core::read_document`
 * once, then `core::spec_indexes_of` over that DOM.
 *
 * One read for both keeps them agreeing: they describe the same operations by
 * the same identity rules, and a schema index with a status the operation index
 * lacks would be a contract disagreeing with itself. The DOM is handed out for
 * the same reason: a sync writes the examples the stored document documents
 * (#869), and a second read would be a second answer.
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
 * A draft's documented responses as the example rows a write takes, one shape
 * for the two routes using it: `POST /specs/diff` reports it, so a caller sees
 * what an apply would write, and `POST /specs/sync` writes it (#869), so a
 * caller cannot state examples the document does not describe. `documented`
 * decides whether a row carries a `Content-Type`: a `204 No Content` documents
 * nothing and still becomes an example, because a mock server must be able to
 * answer with it.
 */
nlohmann::json draft_example_rows (const std::vector<vayu::core::DraftExample>& examples) {
    nlohmann::json rows = nlohmann::json::array ();
    for (const vayu::core::DraftExample& example : examples) {
        nlohmann::json headers = nlohmann::json::array ();
        if (example.documented) {
            headers.push_back ({ { "key", "Content-Type" },
            { "value", example.content_type }, { "enabled", true } });
        }
        nlohmann::json row = { { "name", example.name },
            { "status", example.status }, { "headers", std::move (headers) },
            { "body", example.body }, { "contentType", example.content_type } };
        // Engine-side provenance only (issue #1457): carried through
        // `POST /specs/sync` to the stored row so the bound export can write
        // an edited example back into the entry it came from.
        if (example.spec_example_key) {
            row["specExampleKey"] = *example.spec_example_key;
        }
        rows.push_back (std::move (row));
    }
    return rows;
}

/**
 * What a single request's response is validated against (#628). The binding
 * lives on the collection an import created and requests in its tag
 * sub-collections, so the ancestry is walked to the nearest bound collection
 * (`core::nearest_spec_binding`: `POST /compose`'s inherited-auth chain, cycle
 * guard included, and a scenario run's resolver). A request whose ancestry
 * binds nothing is in no contract: `bound` stays false and the caller writes
 * **no verdict**, the distinction the node rests on, since a response never
 * judged did not fail. Every other outcome is bound-but-unjudgeable and carries
 * its reason: a chip that silently never appears keeps a broken index broken.
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

    // `resolve_scenario`'s walk, through the same function: two answers to
    // "bound" would leave a tag sub-collection's run measuring nothing while a
    // Send of the same request is checked (#716).
    const auto bound = vayu::core::nearest_spec_binding (db, request->collection_id);
    if (!bound) {
        return resolved;
    }
    const std::string& spec_id   = bound->spec_id;
    const std::string& spec_hash = bound->spec_hash;

    resolved.bound      = true;
    const auto document = db.get_spec_document (spec_id);
    if (!document) {
        // The write path refuses a binding to a document that will not exist
        // (`reject_unbindable_spec`), so this is a database edited from
        // outside: nothing to validate against, which `no_index` says.
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
 * bound to no contract (#628): the whole design-mode hook in one function, so
 * `/execute` states it once and the collection-run and load hooks call the same
 * thing.
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
        "http", "Schema validation lookup failed: " + std::string (e.what ()));
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
        vayu::utils::log_warning (
        "http", "Schema validation failed: " + std::string (e.what ()));
        return std::nullopt;
    }
}

/**
 * Refuses a collection write whose `openapi` binding names a spec that will not
 * exist when the write lands: a binding to nothing reads back as spec-bound,
 * stamps runs with a `specId` nobody can fetch, and leaves #627's sync nothing
 * to re-fetch from, so it is refused at the write, not found by a later reader.
 * @p pending is what the caller writes in the same transaction and cannot look
 * up yet (`POST /import/apply`'s spec section); every other path passes an
 * empty set.
 */
RouteResult reject_unbindable_spec (vayu::db::Database& db,
const std::string& openapi,
const std::unordered_set<std::string>& pending) {
    std::string spec_id;
    try {
        const auto parsed = nlohmann::json::parse (openapi);
        if (!parsed.is_object ()) {
            return {};
        }
        spec_id = parsed.value ("specId", std::string ());
    } catch (const std::exception&) {
        return {}; // Not a binding; the applier already had its say.
    }
    if (spec_id.empty () || pending.contains (spec_id) ||
    db.get_spec_document (spec_id).has_value ()) {
        return {};
    }
    return route_error (400, "Spec '" + spec_id + "' does not exist");
}

/**
 * Completes a binding written without a version (#709) from the stored
 * document; the rule is `vayu::core::stamp_spec_binding`. `syncedAt` is now,
 * not the document's `fetched_at`: this write is when the collection was bound
 * to that version, what the Spec tab's "Bound" reports and a later sync
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
 * Testable core of POST /specs, storing one OpenAPI document, {http_status,
 * json_body}. Create only: the engine mints the id (#97), so a body `id` is a
 * 400. There is no `PUT /specs/:id`: a changed document is a different
 * document, and rewriting one in place would invalidate the hash every bound
 * collection's runs were stamped with; a re-fetch (#627) stores a new one and
 * moves the binding.
 *
 * `hash`, `fetchedAt` and both indexes are engine-computed and refused in the
 * body for `id`'s reason: each would be a claim about bytes nobody verified.
 * The indexes come from `read_spec_indexes` (#853, #860), which also makes an
 * unreadable document a 400 here rather than a row nothing downstream reads.
 */
std::pair<int, nlohmann::json>
create_spec_document_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (auto outcome = reject_client_supplied_id (json); !outcome) {
        return as_response (outcome.error ());
    }
    for (const char* derived : { "hash", "fetchedAt" }) {
        if (json.contains (derived)) {
            return { 400, error_body (400, std::string ("'") + derived + "' is computed by the engine; omit it") };
        }
    }

    std::string content;
    if (auto outcome = apply_required_string_field (json, "content", content, /*is_create=*/true);
    !outcome) {
        return as_response (outcome.error ());
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
    // When it was taken, the instant this row is written; a re-fetch (#627)
    // stores a new row with its own stamp.
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
 * Testable core of GET /specs/:id/meta: what the document is, without it
 * (#712). The Spec tab's card needs only `sourceUrl` and `fetchedAt`, which
 * live on the row, so painting them cost the whole document (12 MB for Stripe's
 * spec) per first open. Readers needing the text (export, the sync comparison,
 * `$ref` resolution) read the full route on an action, not a tab opening. A
 * missing id answers the full read's 404 body: one resource seen two ways, so a
 * client falling back between them knows one "not found".
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
 * there are more, so the answer stays one line whatever the fan-out. A binder in
 * the Trash counts and is named as such (#3446): restoring it brings the
 * binding back.
 */
std::pair<int, nlohmann::json>
delete_spec_document_response (vayu::db::Database& db, const std::string& id) {
    // Read-decide-write, one lock scope (#386's rule): between "nobody binds
    // this" and the delete, a concurrent write could bind it and point at a
    // deleted document. The binding writes (POST /collections, /import/apply,
    // /specs/bind) hold the lock across their own check-and-write, so the two
    // serialize.
    std::pair<int, nlohmann::json> result;
    db.with_lock ([&] {
        if (!db.get_spec_document (id).has_value ()) {
            result = { 404, error_body (404, "Spec not found") };
            return;
        }
        const auto bound = db.get_collections_bound_to_spec (id);
        if (!bound.empty ()) {
            const auto& named   = bound.front ();
            std::string message = "Spec '" + id + "' is bound by collection '" +
            named.name + "' (" + named.id + ")";
            if (named.deleted_at) {
                message += ", which is in the Trash";
            }
            if (bound.size () > 1) {
                message += " and " + std::to_string (bound.size () - 1) +
                " other" + std::string (bound.size () == 2 ? "" : "s");
            }
            message += named.deleted_at ?
            "; restore it and unbind it, or purge it, before deleting the "
            "document" :
            "; unbind it before deleting the document";
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
     * it did not come from a URL). `id`, `hash`, `fetchedAt`, `operations` and
     * `responseSchemas` are engine-owned and a 400 if sent - both indexes are
     * read off the document here.
     * Returns: the stored document, or 400.
     */
    ctx.server.Post ("/specs", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = parse_request_json (req.body);
            if (!json) {
                refuse_request_body (res, "POST /specs", json.error ());
                return;
            }
            auto [status, body] = create_spec_document_response (ctx.db, *json);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "POST /specs - " + std::to_string (status) + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info ("http", "Stored spec",
                { { "id", body["id"].get<std::string> () },
                { "hash", body["hash"].get<std::string> () } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "POST /specs - Error: " + std::string (e.what ()));
            send_exception (res, e);
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
                "http", "GET /specs/:id/meta - Spec not found: " + spec_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "GET /specs/:id/meta - Error: " + std::string (e.what ()));
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
                vayu::utils::log_warning (
                "http", "GET /specs/:id - Spec not found: " + spec_id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "GET /specs/:id - Error: " + std::string (e.what ()));
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
                vayu::utils::log_warning ("http", "DELETE /specs/:id failed",
                { { "status", status }, { "id", spec_id },
                { "error", error_message_of (body) } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "DELETE /specs/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
