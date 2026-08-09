#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

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

} // namespace vayu::http
