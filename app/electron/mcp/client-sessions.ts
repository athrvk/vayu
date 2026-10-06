/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file client-sessions.ts
 * @brief Which MCP client sent a request, for the stateless HTTP host (#1817).
 *
 * The host builds a fresh server per POST, so the server that answers
 * `initialize` is gone before the client's first `tools/call` arrives, and the
 * SDK's `getClientVersion()` is empty on every request that can start a run.
 * The host hands out an `Mcp-Session-Id` on the `initialize` response instead
 * (a client must echo it on every later request) and records the handshake's
 * `clientInfo.name` here under it. Nothing else is kept per session: safety
 * config and the tool list stay rebuilt per request.
 *
 * Bounded both ways, because the ids are minted for whoever can reach the
 * port: a cap on the entry count, evicting the least recently seen, and an
 * idle expiry. An unknown, missing or expired id answers no name, which costs
 * the run its client label and nothing else - it is still recorded as an MCP
 * run.
 */

/**
 * Longest name kept, in code points; the engine's own cap on `origin.client`.
 * The handshake's `clientInfo.name` is an unbounded string up to the request
 * body limit, so without it 256 entries could hold hundreds of megabytes.
 */
export const MAX_CLIENT_NAME_CHARS = 128;

/** Most sessions remembered at once; past it the least recently seen goes. */
export const MAX_CLIENT_SESSIONS = 256;

/**
 * How long a session may sit unused before its name is forgotten. Long,
 * because an agent session idles for hours between tool calls and an expired
 * entry only drops a label; the cap above is what bounds memory.
 */
export const CLIENT_SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

interface Entry {
	name: string;
	seenAt: number;
}

export class ClientSessions {
	// Insertion order is last-seen order: every touch re-inserts, so the
	// stalest entries are always at the front.
	private readonly entries = new Map<string, Entry>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly cap: number = MAX_CLIENT_SESSIONS,
		private readonly idleMs: number = CLIENT_SESSION_IDLE_MS
	) {}

	/** Record the client name a handshake gave under the session id it was issued. */
	remember(sessionId: string, name: string): void {
		this.entries.delete(sessionId);
		this.entries.set(sessionId, {
			name: [...name].slice(0, MAX_CLIENT_NAME_CHARS).join(""),
			seenAt: this.now(),
		});
		this.evict();
	}

	/**
	 * The client name recorded for a session, restarting its idle clock;
	 * undefined for a missing, unknown or expired id.
	 */
	clientName(sessionId: string | undefined): string | undefined {
		if (sessionId === undefined) return undefined;
		const entry = this.entries.get(sessionId);
		if (!entry) return undefined;
		this.entries.delete(sessionId);
		if (this.expired(entry)) return undefined;
		this.entries.set(sessionId, { name: entry.name, seenAt: this.now() });
		return entry.name;
	}

	get size(): number {
		return this.entries.size;
	}

	private expired(entry: Entry): boolean {
		return this.now() - entry.seenAt > this.idleMs;
	}

	private evict(): void {
		for (const [id, entry] of this.entries) {
			if (this.entries.size <= this.cap && !this.expired(entry)) return;
			this.entries.delete(id);
		}
	}
}
