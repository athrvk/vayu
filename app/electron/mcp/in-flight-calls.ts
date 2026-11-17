/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file in-flight-calls.ts
 * @brief An abort handle per 2025-era request the HTTP host is still serving,
 *        so that client's `notifications/cancelled` reaches it (#3574).
 *
 * The host builds a fresh server per POST, so a cancel arrives at a server that
 * never saw the request it names, and the SDK answers it 202 and drops it. The
 * host keeps the request's `AbortController` here instead, under the
 * `Mcp-Session-Id` it issued and the JSON-RPC request id, and aborts it when the
 * cancel names both. Never the request id alone: every client counts from 0.
 * A string id and a number id are different requests, as JSON-RPC has it.
 *
 * Nothing else is kept, and an entry lives exactly as long as its exchange:
 * the host releases it when the response ends however it ends. There is no
 * idle expiry, because a collection run holds its exchange for as long as its
 * requests take, however long that is.
 *
 * The cap is the bound against whoever can reach the port; a call evicted past
 * it keeps running and can no longer be cancelled by its client. A stop does
 * not read this registry: it ends every 2025-era exchange, held or not
 * (`http.ts`, #3575).
 */

import type { RequestId } from "@modelcontextprotocol/server";

/** Most calls held at once; past it the oldest goes. */
export const MAX_IN_FLIGHT_CALLS = 256;

/** One registered call: the signal its exchange is served under, and its release. */
export interface InFlightCall {
	readonly signal: AbortSignal;
	/** Forget the call. Idempotent, and a no-op once a later call took the key. */
	release(): void;
}

export class InFlightCalls {
	// Insertion order is registration order, so the oldest entries are at the front.
	private readonly entries = new Map<string, AbortController>();

	constructor(private readonly cap: number = MAX_IN_FLIGHT_CALLS) {}

	/**
	 * Register the call @p requestId of session @p sessionId. A second call
	 * under the same key replaces the first, which keeps running unregistered:
	 * the cancel a client sends names one request, and it is the latest.
	 */
	track(sessionId: string, requestId: RequestId): InFlightCall {
		const key = keyOf(sessionId, requestId);
		const controller = new AbortController();
		this.entries.delete(key);
		this.entries.set(key, controller);
		this.evict();
		return {
			signal: controller.signal,
			release: () => {
				if (this.entries.get(key) === controller) this.entries.delete(key);
			},
		};
	}

	/** Abort and forget the call a cancel names; false when none matches. */
	cancel(sessionId: string, requestId: RequestId): boolean {
		const key = keyOf(sessionId, requestId);
		const controller = this.entries.get(key);
		if (!controller) return false;
		this.entries.delete(key);
		controller.abort();
		return true;
	}

	get size(): number {
		return this.entries.size;
	}

	private evict(): void {
		for (const key of this.entries.keys()) {
			if (this.entries.size <= this.cap) return;
			this.entries.delete(key);
		}
	}
}

// JSON keeps the id's type, so request "1" and request 1 never share a key.
const keyOf = (sessionId: string, requestId: RequestId) => JSON.stringify([sessionId, requestId]);
