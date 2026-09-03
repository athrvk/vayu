#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <optional>
#include <string>

/**
 * @file graphql_body.hpp
 * @brief The GraphQL-over-HTTP envelope, applied at the engine's chokepoint.
 *
 * A `graphql` body is stored as one string, and the string is allowed to be
 * either shape: the `{"query": ...}` envelope the request builder writes, or
 * the bare document an agent or a `curl` caller hands over. Only the first is
 * sendable - a GraphQL server reads its query out of a JSON object - so the
 * engine normalizes here, once, for every client rather than in each of them.
 *
 * It was in each of them, and only one had it: the renderer enveloped in its
 * own serializer (`app/src/lib/graphql/graphql-body.ts`), so MCP `run_request`
 * and any raw `POST /execute` sent the bare document and were answered with a
 * 400. That is the repo's "a hand-rolled copy of a primitive does not receive
 * the primitive's fixes" rule landing on a process boundary; the fix is to put
 * the primitive under both clients instead of beside one of them.
 */

namespace vayu::http {

/**
 * @brief A `graphql` body's `content` as the bytes that go on the wire.
 *
 * An already-enveloped body is returned **byte-identical** - the envelope
 * carries `operationName`, `variables` and whatever else a server has agreed
 * with its clients, and re-serializing it would reorder keys the user never
 * edited. A bare document is wrapped as `{"query": ...}`.
 *
 * The three inputs and what separates them:
 *
 * - Parses as a JSON object with a string `query` - the envelope. Passed
 *   through. (`query` must be a *string*: that is the test the renderer's
 *   `toGraphQLEnvelope` applies, and the two must agree or a body would mean
 *   different things on either side of the boundary.)
 * - Does not parse, but is shaped like a JSON object (`{` then a quoted key) -
 *   passed through as well. This is an envelope whose `{{token}}` went
 *   unresolved, or one a caller mistyped; either way we could not read it, and
 *   wrapping something we failed to understand would turn a broken envelope
 *   into a valid request carrying the wrong query. Acting on knowledge is not
 *   the same as acting on ignorance. A GraphQL document can never take this
 *   shape - a selection set opens with a field name, never with a quoted
 *   string - so the guard cannot swallow a real bare query.
 * - Anything else - a bare document, and the case this function exists for.
 *
 * Empty in, empty out: an empty body has no bytes to envelope, and inventing
 * `{"query":""}` for it would give a bodiless request a body.
 */
[[nodiscard]] std::string graphql_wire_body (const std::string& content);

/**
 * @brief Whether a `graphql` body's `content` is already the JSON envelope.
 *
 * The first two of `graphql_wire_body`'s three cases, asked as a question:
 * `graphql_wire_body` passes such a body through untouched and wraps anything
 * else. It is exported because a second caller needs the same answer for a
 * different reason - the `{{data.*}}` binder escapes a token that lands inside
 * a JSON string literal, and only an envelope has any (a bare document is
 * escaped wholesale when it is wrapped, so escaping it first would double it).
 *
 * One classifier for both, rather than a second copy that could call a body an
 * envelope on one side of the bind and a document on the other.
 */
[[nodiscard]] bool graphql_body_is_enveloped (const std::string& content);

/**
 * @brief A `graphql` body's `content` as **GET** query parameters, or nothing.
 *
 * GraphQL-over-HTTP defines two transports, and the method picks between them:
 * POST carries the envelope as a JSON body, GET carries the same fields as
 * query parameters (`?query=…&operationName=…&variables=…`) and **no body**.
 * A body on GET is undefined by that specification, and the servers that
 * answer it answer `400 Bad Request` with nothing that says why - which is
 * exactly what a request built from Vayu's default GET used to get (#1228).
 *
 * The parameters come back already percent-encoded and joined, the shape
 * @ref compose_query answers with, for @ref url_with_query to merge into the
 * URL. `variables` and `extensions` are JSON-encoded values, as the
 * specification's GET transport requires; a bare document becomes `query`
 * alone.
 *
 * **Nothing** - meaning "send this the way it has always been sent" - for the
 * three cases where the fields cannot be recovered:
 *
 * - An empty body. There is nothing to carry.
 * - Content that is shaped like an envelope but does not parse - the same case
 *   @ref graphql_wire_body passes through rather than wrapping, for the same
 *   reason: acting on a body we could not read is acting on ignorance, and
 *   here it would mean sending a request whose query we invented.
 * - An envelope carrying a member this transport has no parameter for, or one
 *   whose `operationName`, `variables` or `extensions` is not the type the
 *   specification gives it. Those members were agreed between a user and their
 *   server; dropping them silently would send a *different* request, so the
 *   body transport - which carries them verbatim - stays the honest answer.
 *
 * The caller that turns this into a decision is `wire_url` / `has_wire_body`
 * in `form_body.hpp`, which is where the method is in scope; this function
 * knows only about content.
 */
[[nodiscard]] std::optional<std::string> graphql_get_parameters (const std::string& content);

} // namespace vayu::http
