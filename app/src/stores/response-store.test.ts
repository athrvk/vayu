/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The response map's bound (#1156).
 *
 * Before it, the only evictions were the two delete seams - so the map grew
 * with every distinct request a session sent, each entry a body plus its raw
 * copy, until the app quit. These cases lock the ceiling and the order it
 * evicts in.
 *
 * Mutation check: drop the `while (lru.length > RESPONSE_CACHE_MAX_ENTRIES)`
 * loop in `withResponse` and every case in "bounds the session" fails; drop the
 * `.filter((id) => id !== requestId)` that moves a re-written key to the recent
 * end and "a re-sent request is not the next victim" fails; forget the `lru`
 * half of `clearResponse` or `clearAll` and "the recency list and the map hold
 * the same keys" fails, because a cleared id would keep occupying a slot.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	RESPONSE_CACHE_MAX_ENTRIES,
	useResponseStore,
	type StoredResponse,
} from "./response-store";
import { MAX_OPEN_TABS } from "./tabs-store";

beforeEach(() => {
	useResponseStore.getState().clearAll();
});

/** A response with a body big enough to be worth evicting, and nothing else. */
function aResponse(body = "x".repeat(1024)): StoredResponse {
	return {
		status: 200,
		statusText: "OK",
		headers: {},
		body,
		bodyType: "text",
		size: body.length,
		time: 12,
	};
}

/** Sends `count` distinct requests, named `req_0` … `req_<count-1>`. */
function send(count: number, prefix = "req") {
	for (let i = 0; i < count; i++) {
		useResponseStore.getState().setResponse(`${prefix}_${i}`, aResponse());
	}
}

/** The keys the store currently holds, in the order it would evict them. */
function retained(): string[] {
	return [...useResponseStore.getState().lru];
}

describe("bounds the session", () => {
	it("keeps at most RESPONSE_CACHE_MAX_ENTRIES responses however many are sent", () => {
		send(RESPONSE_CACHE_MAX_ENTRIES * 3);

		expect(useResponseStore.getState().responses.size).toBe(RESPONSE_CACHE_MAX_ENTRIES);
	});

	it("evicts least-recently-written first and keeps the newest", () => {
		const sent = RESPONSE_CACHE_MAX_ENTRIES + 5;
		send(sent);

		const { getResponse } = useResponseStore.getState();
		// The five oldest are gone …
		for (let i = 0; i < 5; i++) expect(getResponse(`req_${i}`)).toBeNull();
		// … and every one after them survived, in write order.
		expect(retained()).toEqual(
			Array.from({ length: RESPONSE_CACHE_MAX_ENTRIES }, (_, i) => `req_${i + 5}`)
		);
	});

	it("never evicts the response just stored", () => {
		send(RESPONSE_CACHE_MAX_ENTRIES);

		useResponseStore.getState().setResponse("newest", aResponse("the body on screen"));

		expect(useResponseStore.getState().getResponse("newest")?.body).toBe("the body on screen");
	});

	it("a re-sent request is not the next victim", () => {
		send(RESPONSE_CACHE_MAX_ENTRIES);
		// Re-send the oldest: it moves to the recent end, so the eviction the
		// next send forces must take `req_1` instead.
		useResponseStore.getState().setResponse("req_0", aResponse());

		useResponseStore.getState().setResponse("one_more", aResponse());

		expect(useResponseStore.getState().getResponse("req_0")).not.toBeNull();
		expect(useResponseStore.getState().getResponse("req_1")).toBeNull();
		expect(useResponseStore.getState().responses.size).toBe(RESPONSE_CACHE_MAX_ENTRIES);
	});

	it("a re-send replaces the entry rather than adding one", () => {
		useResponseStore.getState().setResponse("req_0", aResponse("first"));
		useResponseStore.getState().setResponse("req_0", aResponse("second"));

		expect(useResponseStore.getState().responses.size).toBe(1);
		expect(useResponseStore.getState().getResponse("req_0")?.body).toBe("second");
		expect(retained()).toEqual(["req_0"]);
	});
});

describe("the cap covers the tabs a session works in", () => {
	/*
	 * The store cannot read `tabs-store` - that store imports this one - so the
	 * bound is stated as a number here and held against the tab cap by this
	 * guard. Raise `MAX_OPEN_TABS` past twelve without raising the cache and an
	 * open tab's response could be evicted while its tab is still on screen.
	 */
	it("retains at least twice MAX_OPEN_TABS", () => {
		expect(RESPONSE_CACHE_MAX_ENTRIES).toBeGreaterThanOrEqual(2 * MAX_OPEN_TABS);
	});

	it("a full set of open tabs keeps every full-fidelity response through a tail of one-off sends", () => {
		const openTabRequests = Array.from({ length: MAX_OPEN_TABS }, (_, i) => `open_${i}`);
		for (const id of openTabRequests) {
			useResponseStore.getState().setResponse(id, aResponse(`body of ${id}`));
		}

		// Everything the cap has room for beyond those tabs, sent afterwards.
		send(RESPONSE_CACHE_MAX_ENTRIES - MAX_OPEN_TABS, "tail");

		const { getResponse } = useResponseStore.getState();
		for (const id of openTabRequests) {
			expect(getResponse(id)?.body).toBe(`body of ${id}`);
		}
	});

	it("re-sending the open tabs keeps them ahead of any tail, however long", () => {
		const openTabRequests = Array.from({ length: MAX_OPEN_TABS }, (_, i) => `open_${i}`);
		for (const id of openTabRequests) {
			useResponseStore.getState().setResponse(id, aResponse(`body of ${id}`));
		}

		// Twice what the previous case sends, with the tabs worked in between:
		// recency is what the cap buys, so a tab being *used* stays regardless of
		// how much else the session sends.
		for (let round = 0; round < 2; round++) {
			send(RESPONSE_CACHE_MAX_ENTRIES - MAX_OPEN_TABS, `tail_${round}`);
			for (const id of openTabRequests) {
				useResponseStore.getState().setResponse(id, aResponse(`body of ${id}`));
			}
		}

		const { getResponse } = useResponseStore.getState();
		for (const id of openTabRequests) {
			expect(getResponse(id)?.body).toBe(`body of ${id}`);
		}
	});

	/*
	 * The honest edge of the bound, stated as a test rather than left for
	 * someone to discover: recency is write recency, so a tab held open without
	 * being re-sent is not protected by being open. Tab eviction only allows
	 * that for a dirty tab, and the entry it loses is the unabridged copy - the
	 * request re-opens against the backend's stored run.
	 */
	it("does not protect a tab that stays open without being re-sent", () => {
		useResponseStore.getState().setResponse("untouched_open_tab", aResponse());

		send(RESPONSE_CACHE_MAX_ENTRIES);

		expect(useResponseStore.getState().getResponse("untouched_open_tab")).toBeNull();
	});
});

describe("the delete seams still evict by identity", () => {
	it("clearResponse drops the named request and leaves the rest", () => {
		send(3);

		useResponseStore.getState().clearResponse("req_1");

		expect(useResponseStore.getState().getResponse("req_1")).toBeNull();
		expect(retained()).toEqual(["req_0", "req_2"]);
	});

	it("clearing an id it does not hold changes nothing", () => {
		send(2);
		const { responses: mapBefore, lru: lruBefore } = useResponseStore.getState();

		useResponseStore.getState().clearResponse("never-sent");

		// The same objects, not merely equal ones: an absent id is not worth a
		// new reference, which every subscriber would re-render for.
		expect(useResponseStore.getState().responses).toBe(mapBefore);
		expect(useResponseStore.getState().lru).toBe(lruBefore);
		expect(retained()).toEqual(["req_0", "req_1"]);
	});

	it("clearAll empties both halves", () => {
		send(4);

		useResponseStore.getState().clearAll();

		expect(useResponseStore.getState().responses.size).toBe(0);
		expect(retained()).toEqual([]);
	});
});

describe("the recency list and the map hold the same keys", () => {
	it("through a mixed sequence of sends, re-sends, clears and overflow", () => {
		// Deterministic pseudo-random walk: a seeded LCG, so a failure is
		// reproducible rather than a once-a-week surprise.
		let seed = 1337;
		const next = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % n;
		};

		for (let step = 0; step < 500; step++) {
			const id = `req_${next(RESPONSE_CACHE_MAX_ENTRIES * 2)}`;
			if (next(4) === 0) {
				useResponseStore.getState().clearResponse(id);
			} else {
				useResponseStore.getState().setResponse(id, aResponse("body"));
			}

			const { responses, lru } = useResponseStore.getState();
			expect(lru.length).toBe(responses.size);
			expect(new Set(lru).size).toBe(lru.length); // no key listed twice
			for (const key of lru) expect(responses.has(key)).toBe(true);
			expect(responses.size).toBeLessThanOrEqual(RESPONSE_CACHE_MAX_ENTRIES);
		}
	});
});
