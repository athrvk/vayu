/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file webhook-inbox.ts
 * @brief The webhook inbox payloads and the capture-page bound.
 */

import { isRecord } from "./kit.js";
import { boundTraceNode } from "./inline-body-bounds.js";

/**
 * The canned-response fields `POST /inbox/start` and `PUT /inbox/:id` read
 * (`apply_response_fields`, engine/src/http/routes/inbox.cpp). Both routes take
 * the same block - start applies it to the defaults, the PUT merge-patches the
 * live one - so one list serves both payload builders.
 */
const INBOX_RESPONSE_KEYS = ["status", "body", "headers", "delayMs"] as const;

/**
 * The canned response a call described, carrying only the fields it named.
 *
 * An omitted field must stay omitted rather than travel as `null`: the PUT is a
 * merge-patch, so a spelled-out `null` would be the caller saying "reset this"
 * where they said nothing at all. Bounds (a 100-599 status, a delay under 30s)
 * are the engine's and come back as a `400` naming them - the schema owns the
 * shape, the same division `mockIssuerStartPayload` documents.
 */
export function inboxResponsePayload(response: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of INBOX_RESPONSE_KEYS) {
		if (response[key] !== undefined) out[key] = response[key];
	}
	return out;
}

/**
 * The `POST /inbox/start` body for a `start_webhook_inbox` call.
 *
 * **`bind` and `confirmNonLoopback` are never emitted**, whatever the arguments
 * carry. Binding a listener to a routable interface exposes it beyond this
 * machine, which epic #753 records as a non-goal for every MCP-hosted service -
 * so the guarantee lives here, in the one function that builds the body, rather
 * than in a schema an agent could be tempted to route around. With no `bind`
 * the engine uses its loopback default, and its non-loopback refusal never
 * comes into play.
 *
 * `allowedOrigins` (#2367) is CORS policy, which names which browser pages may
 * read the answers and widens nothing about who can connect, so it is forwarded
 * as given and left to the engine to validate; see {@link mockServerStartPayload}
 * for why the schema does not restate the bounds.
 */
export function inboxStartPayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	if (typeof args.port === "number") payload.port = args.port;
	if (args.allowedOrigins !== undefined) payload.allowedOrigins = args.allowedOrigins;
	if (isRecord(args.response)) payload.response = inboxResponsePayload(args.response);
	return payload;
}

/**
 * Default page for `get_inbox_captures` - the same 25 `get_run_samples` uses
 * and for the same reason: a capture is a whole recorded request, body
 * included, so a page is measured in bodies rather than rows.
 *
 * The ceiling is this side's, not the engine's. `GET /inbox/:id/requests`
 * clamps to the inbox's retention (500 by default, up to 10000 with
 * `inboxMaxCaptures` raised), and a capture body is bounded by
 * `inboxMaxBodyBytes` - 64 KB by default and configurable to 8 MB - so the
 * engine's own bound says nothing about what a tool result can carry. 100 rows
 * of bounded body is the largest page worth handing an agent; more is `offset`.
 */
export const DEFAULT_INBOX_CAPTURE_LIMIT = 25;
export const MAX_INBOX_CAPTURE_LIMIT = 100;

/**
 * Bound the bodies in one capture page.
 *
 * A capture carries the engine's own `body` / `bodyTruncated` / `bodyBytes`
 * disclosure trio - the shape {@link boundTraceNode} already speaks - so the
 * page is bounded by the same function rather than by a copy of it: a webhook
 * posting a 6 MB payload is exactly the #767 case, and the cut has to leave
 * `bodyBytes` alone where the engine already recorded the true original size.
 */
export function boundInboxCaptures(value: unknown): unknown {
	if (!isRecord(value) || !Array.isArray(value.data)) return value;
	return { ...value, data: value.data.map(boundTraceNode) };
}
