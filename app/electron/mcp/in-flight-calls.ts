/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file in-flight-calls.ts
 * @brief An abort handle per 2025-era request the HTTP host is still serving,
 *        so that client's `notifications/cancelled` reaches it (#3574), and a
 *        stop ends it rather than waiting for it (#3575).
 *
 * The host builds a fresh server per POST, so a cancel arrives at a server that
 * never saw the request it names, and the SDK answers it 202 and drops it. The
 * host keeps the request's `AbortController` here instead, under the
 * `Mcp-Session-Id` it issued and the JSON-RPC request id, and aborts it when the
 * cancel names both. Never the request id alone: every client counts from 0.
 * A string id and a number id are different requests, as JSON-RPC has it.
 *
 * A stop drops each call's connection instead (#3575): the clean end of the
 * stream a cancel gets leaves a client still waiting with no answer until its
 * own timeout, while a dropped connection fails its call at once.
 *
 * Nothing else is kept, and an entry lives exactly as long as its exchange:
 * the host releases it when the response ends however it ends. There is no
 * idle expiry, because a collection run holds its exchange for as long as its
 * requests take, however long that is.
 *
 * The cap is the bound against whoever can reach the port; a call evicted past
 * it keeps running, and can no longer be cancelled by its client or ended by a
 * stop.
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

interface Entry {
	readonly controller: AbortController;
	readonly drop: () => void;
}

export class InFlightCalls {
	// Insertion order is registration order, so the oldest entries are at the front.
	private readonly entries = new Map<string, Entry>();

	constructor(private readonly cap: number = MAX_IN_FLIGHT_CALLS) {}

	/**
	 * Register the call @p requestId of session @p sessionId, whose connection
	 * @p drop closes. A second call under the same key replaces the first, which
	 * keeps running unregistered: the cancel a client sends names one request,
	 * and it is the latest.
	 */
	track(sessionId: string, requestId: RequestId, drop: () => void): InFlightCall {
		const key = keyOf(sessionId, requestId);
		const entry: Entry = { controller: new AbortController(), drop };
		this.entries.delete(key);
		this.entries.set(key, entry);
		this.evict();
		return {
			signal: entry.controller.signal,
			release: () => {
				if (this.entries.get(key) === entry) this.entries.delete(key);
			},
		};
	}

	/** Abort and forget the call a cancel names; false when none matches. */
	cancel(sessionId: string, requestId: RequestId): boolean {
		const key = keyOf(sessionId, requestId);
		const entry = this.entries.get(key);
		if (!entry) return false;
		this.entries.delete(key);
		entry.controller.abort();
		return true;
	}

	/**
	 * End every call as a stop does, and forget it: its connection is dropped
	 * before its signal is aborted, so no answer of any kind reaches its client.
	 */
	abortAll(): void {
		for (const { controller, drop } of this.entries.values()) {
			drop();
			controller.abort();
		}
		this.entries.clear();
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
