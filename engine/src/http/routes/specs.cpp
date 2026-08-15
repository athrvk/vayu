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
    return std::make_pair (400,
    error_body (400, "Spec '" + spec_id + "' does not exist"));
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
 * `hash` and `fetchedAt` are engine-computed and rejected in the body for the
 * same reason `id` is: a caller-supplied hash would be a claim about bytes
 * nobody verified.
 */
std::pair<int, nlohmann::json>
create_spec_document_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (auto err = reject_client_supplied_id (json)) {
        return *err;
    }
    for (const char* derived : { "hash", "fetchedAt" }) {
        if (json.contains (derived)) {
            return { 400,
                error_body (400, std::string ("'") + derived +
                "' is computed by the engine; omit it") };
        }
    }

    std::string content;
    if (auto err = apply_required_string_field (json, "content", content, /*is_create=*/true)) {
        return *err;
    }
    if (content.empty ()) {
        return { 400,
            error_body (400,
            "Invalid 'content': an empty document is not a spec") };
    }
    const size_t cap = spec_size_cap (db);
    if (content.size () > cap) {
        return { 400,
            error_body (400, "Spec document is " + std::to_string (content.size ()) +
            " bytes, over the limit of " + std::to_string (cap) +
            " (raise the 'maxSpecDocumentBytes' setting to allow more)") };
    }

    vayu::db::SpecDocument spec;
    spec.id      = vayu::utils::generate_id ("spec_");
    spec.content = std::move (content);
    spec.hash    = spec_content_hash (spec.content);
    // When it was taken, not when the row was written - they are the same
    // instant here, and #627 will re-stamp it on every re-fetch.
    spec.fetched_at = now_ms ();

    if (json.contains ("sourceUrl") && !json["sourceUrl"].is_null ()) {
        if (!json["sourceUrl"].is_string ()) {
            return { 400,
                error_body (400, "Invalid 'sourceUrl': must be a string or null") };
        }
        const auto url = json["sourceUrl"].get<std::string> ();
        if (!url.empty ()) {
            spec.source_url = url;
        }
    }

    if (db.get_spec_document (spec.id).has_value ()) {
        return { 409,
            error_body (409, "Spec '" + spec.id + "' already exists") };
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
                message += " and " + std::to_string (bound.size () - 1) + " other" +
                std::string (bound.size () == 2 ? "" : "s");
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
     * Body params: content (required, non-empty, at most `maxSpecDocumentBytes`),
     * sourceUrl (optional; null or absent means it did not come from a URL).
     * `id`, `hash` and `fetchedAt` are engine-owned and a 400 if sent.
     * Returns: the stored document, or 400.
     */
    ctx.server.Post ("/specs", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = create_spec_document_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /specs - " + std::to_string (status) +
                ": " + error_message_of (body));
            } else {
                vayu::utils::log_info ("POST /specs - Stored spec: id=" +
                body["id"].get<std::string> () +
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
            vayu::utils::log_error ("DELETE /specs/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
