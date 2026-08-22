/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/spec_describe.cpp
 * @brief `POST /specs/describe` - what a picked document is, before anything is
 *        stored (issue #869).
 *
 * The last read of a document the renderer still made. Picking a file in the
 * Spec tab painted three things from a parse there - the format, `info.title`
 * and the operations the document declares - and handed those identities to
 * `POST /specs/match`; the bind then derived the same identities from the same
 * bytes engine-side (`core::derive_spec_indexes`, #862). Two readers of one
 * document is the thing #853 set out to end, and here it had a failure of its
 * own: a document the two read differently previewed one pairing and committed
 * another.
 *
 * So this answers the question the card was asking, from the reader the write
 * uses. It is the shape `GET /specs/:id/meta` has - describe rather than send -
 * pointed at bytes nobody has stored yet, which is why the document comes in the
 * body: a bind preview is about a document the user has not committed to, and a
 * route that stored it to describe it would store one for every file merely
 * looked at.
 *
 * It stays a *description*, deliberately: the identities go back to the caller
 * and the caller hands them to `POST /specs/match`, rather than this route
 * matching too. The pairing needs a collection and this does not - and the
 * alternative, teaching the matcher to take a document, would upload the same
 * bytes twice for one preview.
 */

#include "vayu/core/constants.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <string>
#include <utility>

namespace vayu::http::routes {

namespace {

/// The one failure this route has: bytes it cannot describe. Written as
/// `spec_diff.cpp` writes it, since both are read routes whose every refusal is
/// about the document in the body.
std::pair<int, nlohmann::json> body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/** One declared operation, in the shape `requests.spec_operation` is stamped with. */
nlohmann::json identity_json (const vayu::core::DeclaredOperation& operation) {
    nlohmann::json out{ { "method", operation.method }, { "path", operation.path } };
    if (!operation.operation_id.empty ()) {
        // Absent rather than "", the same way the stored stamp omits it: an
        // operation that declares no `operationId` is not one whose id is empty.
        out["operationId"] = operation.operation_id;
    }
    return out;
}

} // namespace

/**
 * Testable core of POST /specs/describe - the read, answered, nothing written.
 *
 * The refusals are the ones a bind of these bytes would make, in the same words,
 * because a preview that succeeded where the write will fail is worse than no
 * preview: the document's own size cap (`spec_size_cap`), the operation count a
 * stored index may carry, and a document that cannot be read at all.
 */
std::pair<int, nlohmann::json>
describe_spec_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (!json.is_object ()) {
        return body_error ("Body must be a JSON object");
    }
    const auto content_field = json.find ("content");
    if (content_field == json.end () || !content_field->is_string ()) {
        return body_error ("Invalid 'content': must be the document's text");
    }
    const auto content = content_field->get<std::string> ();
    if (content.empty ()) {
        return body_error (
        "Invalid 'content': an empty document is not a spec");
    }

    // The cap a store of these bytes would apply, read the same way
    // `POST /specs/diff` reads it: describing a document too large to keep would
    // offer a bind that is then refused.
    const size_t cap = spec_size_cap (db);
    if (content.size () > cap) {
        return body_error ("Spec document is " + std::to_string (content.size ()) +
        " bytes, over the limit of " + std::to_string (cap) +
        " (raise the 'maxSpecDocumentBytes' setting to allow more)");
    }

    const vayu::core::DocumentRead read = vayu::core::read_document (content);
    if (!read.ok ()) {
        return body_error ("Invalid 'content': " + read.error);
    }

    const vayu::core::DocumentDescription described =
    vayu::core::describe_document (read.root);
    if (!described.is_spec ()) {
        // A readable file that is not a contract - a Postman export, a config,
        // a document whose `openapi` is a version this does not read. Named as
        // what is missing rather than as "unrecognised", because the caller can
        // act on that: it is the key a spec declares itself with.
        return body_error (
        "This document declares neither 'openapi': '3.x' nor "
        "'swagger': '2.0', so it is not an OpenAPI document.");
    }
    if (described.operations.size () > vayu::core::constants::spec_document::MAX_OPERATIONS) {
        return body_error ("Spec declares " +
        std::to_string (described.operations.size ()) + " operations, over the limit of " +
        std::to_string (vayu::core::constants::spec_document::MAX_OPERATIONS));
    }

    nlohmann::json operations = nlohmann::json::array ();
    for (const vayu::core::DeclaredOperation& operation : described.operations) {
        operations.push_back (identity_json (operation));
    }

    return { 200,
        nlohmann::json{ { "format", described.format },
        { "title", described.title }, { "operations", std::move (operations) } } };
}

void register_spec_describe_routes (RouteContext& ctx) {
    /**
     * POST /specs/describe
     * Says what a document is without storing it: the dialect that claimed it,
     * what it calls itself, and every operation it declares. Reads only - a
     * caller may ask about a document it has not decided to bind.
     * Body params: content (required - the document's text, verbatim).
     * Returns: {format, title, operations}, or 400 for bytes that are over the
     * size cap, cannot be read, or are not an OpenAPI document.
     */
    ctx.server.Post ("/specs/describe",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = describe_spec_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /specs/describe - " +
                std::to_string (status) + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info ("POST /specs/describe - " +
                body["format"].get<std::string> () + ", " +
                std::to_string (body["operations"].size ()) + " operation(s)");
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /specs/describe - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });
}

} // namespace vayu::http::routes
