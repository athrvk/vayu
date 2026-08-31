/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Response Store
 *
 * Persists response state per request ID so it survives:
 * - View switches (e.g., request builder <-> load test dashboard)
 * - Tab changes within the app
 *
 * Response data is stored in memory (not persisted to localStorage)
 * since responses can be large and we can reload from backend.
 *
 * The map is bounded by `RESPONSE_CACHE_MAX_ENTRIES` (#1156): before the cap,
 * the only evictions were the two delete seams (`useDeleteRequestMutation` and
 * `closeTabsForEntities`), so a session retained every distinct request it had
 * ever sent - a body plus its raw copy each - until the app quit. The bound is
 * write recency, not open-tab identity: this store cannot ask `tabs-store` what
 * is open (that store imports *this* one, and the cycle is the wrong shape), so
 * the cap is set to twice `MAX_OPEN_TABS` instead, and `response-store.test.ts`
 * holds the two constants together.
 */

import { create } from "zustand";
import type { ConsoleLogEntry, TestResult } from "@/types";

/**
 * A structural *subset* of the request builder's `ResponseState`, not a copy of
 * it: callers hand over a whole `ResponseState` and `setResponse` spreads it, so
 * fields this interface never names (`timing`, `bodyRaw`, `errorCode`, …) are
 * stored and read back through the `as ResponseState` cast in
 * RequestBuilderProvider. Never narrow the write to a hand-picked field list -
 * that silently drops whatever was left out, which is exactly how the Timing tab
 * lost its data on the restore path.
 */
export interface StoredResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	requestHeaders?: Record<string, string>;
	rawRequest?: string;
	body: string;
	bodyType: "json" | "html" | "xml" | "text" | "binary";
	size: number;
	time: number;
	/** Set when the response was rebuilt from a stored run - see `ResponseState`. */
	restoredFrom?: { runId?: string; at: string };
	// Script execution results
	/** A `string` is the pre-structured engine shape - see `parse-logs.ts`. */
	consoleLogs?: Array<ConsoleLogEntry | string>;
	/** Both scripts' assertions, each naming its script - see `TestResult`. */
	testResults?: TestResult[];
	preScriptError?: string;
	postScriptError?: string;
	// Metadata
	runId?: string;
	executedAt?: number;
}

/**
 * How many responses the map retains. The order is write recency, so what this
 * number buys is headroom rather than a guarantee about open tabs: at twice
 * `MAX_OPEN_TABS` a full set of tabs can each be re-sent, and every one of them
 * still finds its full-fidelity body on the way back. A tab held open without
 * being re-sent while twenty-four other requests are - a dirty tab, which tab
 * eviction exempts - does lose its entry, and loses only the unabridged copy:
 * the request re-opens against the backend's stored run, whose body the engine
 * truncated at `maxTraceBodyBytes`.
 */
export const RESPONSE_CACHE_MAX_ENTRIES = 24;

interface ResponseStoreState {
	// Map of requestId -> response
	responses: Map<string, StoredResponse>;
	/**
	 * Request ids least-recently-written first. Every key of `responses`
	 * appears here exactly once, and this list - not `executedAt` - is what
	 * eviction reads: a response restored from a stored run carries the
	 * execution's own timestamp, which says nothing about when this session
	 * last touched it.
	 */
	lru: string[];

	// Actions
	setResponse: (requestId: string, response: StoredResponse) => void;
	getResponse: (requestId: string) => StoredResponse | null;
	clearResponse: (requestId: string) => void;
	clearAll: () => void;
}

/**
 * The one place an entry is written, so the map and the recency list can never
 * disagree about which keys exist. Shaped after `schema-cache.ts`'s
 * `withEntry`, the codebase's other keyed LRU.
 */
function withResponse(
	state: Pick<ResponseStoreState, "responses" | "lru">,
	requestId: string,
	response: StoredResponse
): Pick<ResponseStoreState, "responses" | "lru"> {
	const responses = new Map(state.responses);
	responses.set(requestId, {
		...response,
		executedAt: response.executedAt || Date.now(),
	});

	// Re-writing a request moves it back to the most-recent end rather than
	// leaving it where it first landed - a request being re-sent is the one
	// least likely to want evicting.
	const lru = [...state.lru.filter((id) => id !== requestId), requestId];

	// The write that pushed the map over the cap is the request on screen, so
	// the victim is always some other request: taking from the front cannot
	// take what was just stored.
	while (lru.length > RESPONSE_CACHE_MAX_ENTRIES) {
		const victim = lru.shift();
		if (victim === undefined) break;
		responses.delete(victim);
	}

	return { responses, lru };
}

export const useResponseStore = create<ResponseStoreState>((set, get) => ({
	responses: new Map(),
	lru: [],

	setResponse: (requestId, response) => {
		set(withResponse(get(), requestId, response));
	},

	getResponse: (requestId) => {
		return get().responses.get(requestId) || null;
	},

	clearResponse: (requestId) => {
		const { responses, lru } = get();
		if (!responses.has(requestId)) return;
		const newResponses = new Map(responses);
		newResponses.delete(requestId);
		set({
			responses: newResponses,
			lru: lru.filter((id) => id !== requestId),
		});
	},

	clearAll: () => {
		set({ responses: new Map(), lru: [] });
	},
}));
