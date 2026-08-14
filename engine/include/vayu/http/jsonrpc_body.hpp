#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <string>

/**
 * @file jsonrpc_body.hpp
 * @brief The JSON-RPC 2.0 call envelope, applied at the engine's chokepoint.
 *
 * A `jsonrpc` body is stored as one string, and the string is allowed to be
 * either shape: the full `{"jsonrpc":"2.0","method":…,"id":…}` frame, or the
 * bare call - `{"method":…,"params":…}` - that is the part a user actually
 * edits between sends. Only the first is sendable; a server answers a frame
 * without `"jsonrpc"` with an Invalid Request error. So the engine completes
 * the envelope here, once, for every client rather than in each of them - the
 * same placement, and for the same reason, as `graphql_body.hpp`.
 *
 * Engine-side rather than renderer-side is the whole point: the renderer is one
 * of four clients (MCP `run_request`, a raw `POST /execute` and the load driver
 * are the others), and a copy in one of them is a copy the other three do not
 * get. GraphQL learned that as a bug report (#417); this mode starts where that
 * one ended up.
 */

namespace vayu::http {

/**
 * @brief A `jsonrpc` body's `content` as the bytes that go on the wire.
 *
 * Four inputs and what separates them:
 *
 * - A JSON object with a **string** `"jsonrpc"` member - a full envelope the
 *   caller wrote. Passed through **byte for byte**: it carries the caller's
 *   `id` (which they will match the response against), their key order, and
 *   whatever their server has agreed with them beyond the spec. It also carries
 *   the *absence* of an `id`, which is how a notification is written - a frame
 *   the server must not answer - so stamping one in would change what the
 *   request means. The member's *type* is what is checked rather than its
 *   presence, because `{"jsonrpc": 2.0}` is the JSON number 2.0 and the spec
 *   asks for the string; such a frame is completed below rather than sent as
 *   the invalid request it is.
 * - A JSON object without one - the bare call, and the case this function
 *   exists for. It gains `"jsonrpc":"2.0"`, and `"id":1` when it declares no
 *   `id` of its own. The id is a **constant**, never random or time-derived: a
 *   replayed run and the run it replays have to send the same bytes, or a diff
 *   of the two reports a change nobody made. A caller who wants a notification
 *   writes the envelope themselves and takes the row above.
 * - JSON that is not an object - a top-level array is a **batch call**, and
 *   there is no single envelope to complete. Passed through verbatim, which is
 *   already correct: every element of a batch carries its own envelope.
 * - Text that does not parse. Passed through verbatim, exactly as GraphQL does.
 *   This is what makes `{{variables}}` safe: a body that is `{{payload}}` at
 *   storage time is unparseable *then*, gets resolved during composition
 *   (interpolation is mode-agnostic - see `request_composer.cpp`), and the
 *   envelope check runs at wire time on the resolved text. A token that never
 *   resolved reaches the wire as typed rather than being wrapped into a
 *   well-formed request carrying nonsense.
 *
 * Members are added to the object the caller wrote rather than to a fresh one,
 * so their key order survives; JSON object members are unordered, so the
 * appended `jsonrpc` / `id` are as valid at the end as they would be at the
 * front, and rebuilding the object to place them first would reorder keys the
 * caller never edited.
 *
 * Empty in, empty out: an empty body has no call to envelope, and inventing one
 * would give a bodiless request a body.
 */
[[nodiscard]] std::string jsonrpc_wire_body (const std::string& content);

} // namespace vayu::http
