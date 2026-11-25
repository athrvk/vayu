/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Response state per request id, so a response survives view switches (the request builder <-> the
 * load test dashboard) and tab changes. In memory only, not localStorage: responses can be large,
 * and the backend can reload them.
 *
 * Bounded by `RESPONSE_CACHE_MAX_ENTRIES` (#1156): the two delete seams
 * (`useDeleteRequestMutation`, `closeTabsForEntities`) are no bound, so a session would keep every
 * distinct request it ever sent, a body plus its raw copy each, until quit. The bound is write
 * recency, not open-tab identity: this store cannot ask `tabs-store` what is open (that store
 * imports this one, and the cycle is the wrong shape), so the cap is twice `MAX_OPEN_TABS`, and
 * `response-store.test.ts` holds the two constants together.
 *
 * A count says nothing about size: one 20 MB response is a body plus its raw copy (and, if binary,
 * its bytes), so 24 of them is a gigabyte kept for tabs the user is not looking at.
 * `RESPONSE_CACHE_MAX_BYTES` bounds that axis the same way, and whichever limit is hit first evicts
 * (#2544).
 */

import { create } from "zustand";
import type { ConsoleLogEntry, ScriptRequestRecord, TestResult } from "@/types";

/**
 * A structural subset of the request builder's `ResponseState`, not a copy: callers hand over a
 * whole `ResponseState` and `setResponse` spreads it, so fields this interface never names
 * (`timing`, `errorCode`, …) are stored and read back through the `as ResponseState` cast in
 * RequestBuilderProvider. Never narrow the write to a hand-picked field list: that drops whatever
 * was left out, which is how the Timing tab lost its data on the restore path.
 */
export interface StoredResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	requestHeaders?: Record<string, string>;
	rawRequest?: string;
	body: string;
	/** Named only so `estimateResponseBytes` can read it; see the note above. */
	bodyRaw?: string;
	/** Named only so `estimateResponseBytes` can read it; see the note above. */
	rawBytes?: { data: Uint8Array };
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
	/** The scripts' `pm.sendRequest` records - see `ResponseState.scriptRequests`. */
	scriptRequests?: ScriptRequestRecord[];
	// Metadata
	runId?: string;
	executedAt?: number;
}

/**
 * How many responses the map retains. The order is write recency, so this buys headroom, not a
 * guarantee about open tabs: at twice `MAX_OPEN_TABS` a full set of tabs can each be re-sent and
 * still find its full-fidelity body. A tab held open without a re-send while twenty-four other
 * requests are (a dirty tab, which tab eviction exempts) does lose its entry, and only the
 * unabridged copy: it re-opens against the backend's stored run, whose body the engine truncated at
 * `maxTraceBodyBytes`.
 */
export const RESPONSE_CACHE_MAX_ENTRIES = 24;

/**
 * How many bytes of response bodies the map retains, by `estimateResponseBytes`. Eviction runs
 * until the map is under it, but the response just written is never the victim: one response over
 * the budget is kept, alone, because it is the one on screen.
 */
export const RESPONSE_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * What a stored response's payload costs, a documented estimate, not a measurement: a JS string
 * counts at two bytes per UTF-16 code unit, exact for a string V8 holds as two-byte and an upper
 * bound for one it holds as Latin-1, so the budget errs toward evicting early. Binary bytes count
 * at their `byteLength`. Headers, timing and the other small fields are not counted.
 *
 * `body` and `bodyRaw` are the same text past the pane's formatting threshold (`paneBody` hands the
 * raw string back), so an equal pair counts once.
 *
 * The scripts' `pm.sendRequest` records (#3633) add their request and response bodies, up to
 * `maxTraceBodyBytes` more per send. A record's held text is counted, never its `bodyBytes`: that
 * is the size before the engine cut or shed the body, which this map does not hold.
 */
export function estimateResponseBytes(response: StoredResponse): number {
	const { body, bodyRaw, rawBytes, scriptRequests } = response;
	let bytes = body.length * 2;
	if (bodyRaw !== undefined && bodyRaw !== body) bytes += bodyRaw.length * 2;
	if (rawBytes) bytes += rawBytes.data.byteLength;
	for (const record of scriptRequests ?? []) {
		bytes += textBytes(record.request.body) + textBytes(record.response?.body);
	}
	return bytes;
}

/** A body's estimated cost, as {@link estimateResponseBytes} counts strings. */
function textBytes(body: unknown): number {
	return typeof body === "string" ? body.length * 2 : 0;
}

interface ResponseStoreState {
	// Map of requestId -> response
	responses: Map<string, StoredResponse>;
	/**
	 * Request ids, least recently written first. Every key of `responses` appears here once, and
	 * eviction reads this, not `executedAt`: a response restored from a stored run carries the
	 * execution's own timestamp, which says nothing about when this session last touched it.
	 */
	lru: string[];

	// Actions
	setResponse: (requestId: string, response: StoredResponse) => void;
	getResponse: (requestId: string) => StoredResponse | null;
	clearResponse: (requestId: string) => void;
	clearAll: () => void;
}

/**
 * The one place an entry is written, so the map and the recency list cannot disagree about which
 * keys exist. Shaped after `schema-cache.ts`'s `withEntry`, the codebase's other keyed LRU.
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

	// A re-written request moves to the most-recent end: a request being re-sent is the one least
	// likely to want evicting.
	const lru = [...state.lru.filter((id) => id !== requestId), requestId];

	// The write is the response on screen and last in `lru`, so stopping at one entry keeps it: the
	// victim is always another request, even when this one alone is over the byte budget.
	let bytes = 0;
	for (const stored of responses.values()) bytes += estimateResponseBytes(stored);
	while (
		lru.length > 1 &&
		(lru.length > RESPONSE_CACHE_MAX_ENTRIES || bytes > RESPONSE_CACHE_MAX_BYTES)
	) {
		const victim = lru.shift();
		if (victim === undefined) break;
		const evicted = responses.get(victim);
		if (evicted) bytes -= estimateResponseBytes(evicted);
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
