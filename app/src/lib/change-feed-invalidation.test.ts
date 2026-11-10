/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The change feed's events reach the cache through the MCP families (issue
 * #3420): each kind names the reads it can have made stale, a burst becomes
 * one invalidation per key, and no flush lands while a mutation is in flight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/keys";
import type { Request, RequestSummary } from "@/types";
import {
	CHANGE_FEED_COALESCE_MS,
	FeedInvalidationBatch,
	invalidateFeedDomain,
	invalidationsForChange,
	parseChangeFeedChange,
	type ChangeFeedChange,
	type ChangeFeedKind,
} from "./change-feed-invalidation";

type Key = readonly unknown[];

/** A client whose `invalidateQueries` records the keys it was asked for. */
function spiedClient() {
	const queryClient = new QueryClient();
	const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
	const keys = () => spy.mock.calls.map(([filters]) => filters?.queryKey as Key);
	return { queryClient, keys };
}

/** Apply one change straight away, the way a flush would, and return the keys. */
function keysFor(change: ChangeFeedChange, seed?: (queryClient: QueryClient) => void): Key[] {
	const { queryClient, keys } = spiedClient();
	seed?.(queryClient);
	const batch = new FeedInvalidationBatch(queryClient);
	const invalidation = invalidationsForChange(queryClient, change);
	expect(invalidation).not.toBeNull();
	batch.add(invalidation!);
	vi.advanceTimersByTime(CHANGE_FEED_COALESCE_MS);
	return keys();
}

const same = (a: Key) => (b: Key) => JSON.stringify(a) === JSON.stringify(b);
const includesKey = (keys: Key[], key: Key) => keys.some(same(key));

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("parseChangeFeedChange", () => {
	it("keeps the fields the engine sends", () => {
		expect(
			parseChangeFeedChange({
				kind: "request",
				id: "req_1",
				op: "update",
				collectionId: "col_1",
			})
		).toEqual({ kind: "request", id: "req_1", op: "update", collectionId: "col_1" });
		expect(
			parseChangeFeedChange({
				kind: "example",
				id: "exa_1",
				op: "delete",
				requestId: "req_1",
			})
		).toEqual({ kind: "example", id: "exa_1", op: "delete", requestId: "req_1" });
	});

	it("rejects a frame missing what every change carries", () => {
		expect(parseChangeFeedChange(null)).toBeNull();
		expect(parseChangeFeedChange("request")).toBeNull();
		expect(parseChangeFeedChange({ kind: "request", op: "update" })).toBeNull();
		expect(parseChangeFeedChange({ kind: "request", id: "req_1" })).toBeNull();
		expect(parseChangeFeedChange({ kind: 3, id: "req_1", op: "update" })).toBeNull();
	});

	it("parses a kind this build does not know, so its id still counts", () => {
		expect(parseChangeFeedChange({ kind: "dashboard", id: "d_1", op: "create" })).toEqual({
			kind: "dashboard",
			id: "d_1",
			op: "create",
		});
	});
});

describe("invalidationsForChange", () => {
	it("takes a collection's row write as that row alone", () => {
		for (const op of ["create", "update"]) {
			const keys = keysFor({ kind: "collection", id: "col_1", op });
			expect(includesKey(keys, queryKeys.collections.all)).toBe(true);
			expect(includesKey(keys, queryKeys.requests.all)).toBe(false);
			expect(includesKey(keys, queryKeys.trash.all)).toBe(false);
		}
	});

	it("takes a collection's delete, restore, purge and any op it does not know as the cascade", () => {
		// One event on the root stands for the whole subtree.
		for (const op of ["delete", "restore", "purge", "archive"]) {
			const keys = keysFor({ kind: "collection", id: "col_1", op });
			expect(includesKey(keys, queryKeys.collections.all)).toBe(true);
			expect(includesKey(keys, queryKeys.requests.all)).toBe(true);
			expect(includesKey(keys, queryKeys.prefetch.allRequests())).toBe(true);
			expect(includesKey(keys, queryKeys.trash.all)).toBe(true);
		}
	});

	it("takes a request write as its detail and its own collection's list", () => {
		const keys = keysFor({ kind: "request", id: "req_1", op: "update", collectionId: "col_1" });
		expect(includesKey(keys, queryKeys.requests.detail("req_1"))).toBe(true);
		expect(includesKey(keys, queryKeys.requests.listByCollection("col_1"))).toBe(true);
		expect(includesKey(keys, queryKeys.requests.lists())).toBe(false);
		expect(includesKey(keys, queryKeys.compose.allForRequest("req_1"))).toBe(true);
	});

	it("takes a moved request's source list too, read from the cache before it refetches", () => {
		// The event names only the destination.
		const keys = keysFor(
			{ kind: "request", id: "req_1", op: "update", collectionId: "col_2" },
			(queryClient) =>
				queryClient.setQueryData<RequestSummary[]>(
					queryKeys.requests.listByCollection("col_1"),
					[{ id: "req_1", collectionId: "col_1" } as RequestSummary]
				)
		);
		expect(includesKey(keys, queryKeys.requests.listByCollection("col_1"))).toBe(true);
		expect(includesKey(keys, queryKeys.requests.listByCollection("col_2"))).toBe(true);
		expect(includesKey(keys, queryKeys.requests.lists())).toBe(false);
	});

	it("reads the source from an open request's detail when no list holds it", () => {
		const keys = keysFor(
			{ kind: "request", id: "req_1", op: "update", collectionId: "col_2" },
			(queryClient) =>
				queryClient.setQueryData<Request>(queryKeys.requests.detail("req_1"), {
					id: "req_1",
					collectionId: "col_1",
				} as Request)
		);
		expect(includesKey(keys, queryKeys.requests.listByCollection("col_1"))).toBe(true);
	});

	it("takes an example write as its request's examples and the trash", () => {
		const keys = keysFor(
			{ kind: "example", id: "exa_1", op: "delete", requestId: "req_1" },
			(queryClient) =>
				queryClient.setQueryData<RequestSummary[]>(
					queryKeys.requests.listByCollection("col_1"),
					[{ id: "req_1", collectionId: "col_1" } as RequestSummary]
				)
		);
		// The Examples list sits under the request's detail key.
		const examples = JSON.stringify(queryKeys.requests.examples("req_1"));
		const detail = JSON.stringify(queryKeys.requests.detail("req_1")).slice(0, -1);
		expect(examples.startsWith(detail)).toBe(true);
		expect(includesKey(keys, queryKeys.requests.detail("req_1"))).toBe(true);
		expect(includesKey(keys, queryKeys.trash.all)).toBe(true);
		// Narrowed to the owner the tree shows, not every list.
		expect(includesKey(keys, queryKeys.requests.lists())).toBe(false);
	});

	it("takes an environment write as the variables and the trash", () => {
		const keys = keysFor({ kind: "environment", id: "env_1", op: "delete" });
		expect(includesKey(keys, queryKeys.environments.all)).toBe(true);
		expect(includesKey(keys, queryKeys.globals.all)).toBe(true);
		expect(includesKey(keys, queryKeys.trash.all)).toBe(true);
		expect(includesKey(keys, queryKeys.compose.all)).toBe(true);
	});

	it("takes a globals write as the globals and every composition", () => {
		const keys = keysFor({ kind: "globals", id: "globals", op: "update" });
		expect(includesKey(keys, queryKeys.globals.all)).toBe(true);
		expect(includesKey(keys, queryKeys.compose.all)).toBe(true);
	});

	it("takes a client certificate's trash write as the registry and the trash", () => {
		// The one kind whose MCP family leaves the trash to another.
		for (const op of ["delete", "restore", "purge"]) {
			const keys = keysFor({ kind: "clientCertificate", id: "crt_1", op });
			expect(includesKey(keys, queryKeys.clientCertificates.all)).toBe(true);
			expect(includesKey(keys, queryKeys.trash.all)).toBe(true);
		}
	});

	it("ignores a kind this build does not know, an inherited property name included", () => {
		const { queryClient } = spiedClient();
		for (const kind of ["dashboard", "constructor", "toString", "__proto__"]) {
			expect(invalidationsForChange(queryClient, { kind, id: "x", op: "update" })).toBeNull();
		}
	});
});

describe("invalidateFeedDomain", () => {
	const KINDS: Record<ChangeFeedKind, ChangeFeedChange> = {
		collection: { kind: "collection", id: "col_1", op: "delete" },
		request: { kind: "request", id: "req_1", op: "update", collectionId: "col_1" },
		example: { kind: "example", id: "exa_1", op: "delete", requestId: "req_1" },
		environment: { kind: "environment", id: "env_1", op: "update" },
		globals: { kind: "globals", id: "globals", op: "update" },
		clientCertificate: { kind: "clientCertificate", id: "crt_1", op: "restore" },
	};

	it("reaches every read a single change can, so a reset leaves nothing stale", () => {
		const { queryClient, keys } = spiedClient();
		invalidateFeedDomain(queryClient);
		const reset = keys();
		expect(reset.length).toBeGreaterThan(0);
		const covered = (key: Key) =>
			reset.some((prefix) => prefix.every((part, i) => same([part])([key[i]])));

		for (const change of Object.values(KINDS)) {
			for (const key of keysFor(change)) expect(covered(key), JSON.stringify(key)).toBe(true);
		}
	});
});

describe("FeedInvalidationBatch", () => {
	const requestChange: ChangeFeedChange = {
		kind: "request",
		id: "req_1",
		op: "update",
		collectionId: "col_1",
	};

	function countOf(keys: Key[], key: Key) {
		return keys.filter(same(key)).length;
	}

	it("coalesces a burst on one row into one invalidation per key, after the window", () => {
		const { queryClient, keys } = spiedClient();
		const batch = new FeedInvalidationBatch(queryClient);

		for (let i = 0; i < 5; i += 1) {
			batch.add(invalidationsForChange(queryClient, requestChange)!);
			vi.advanceTimersByTime(CHANGE_FEED_COALESCE_MS / 10);
		}
		vi.advanceTimersByTime(CHANGE_FEED_COALESCE_MS);

		expect(countOf(keys(), queryKeys.requests.detail("req_1"))).toBe(1);
		expect(countOf(keys(), queryKeys.requests.listByCollection("col_1"))).toBe(1);
	});

	it("holds nothing back once the window has passed", () => {
		const { queryClient, keys } = spiedClient();
		const batch = new FeedInvalidationBatch(queryClient);

		batch.add(invalidationsForChange(queryClient, requestChange)!);
		vi.advanceTimersByTime(CHANGE_FEED_COALESCE_MS - 1);
		expect(keys()).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(countOf(keys(), queryKeys.requests.detail("req_1"))).toBe(1);

		// A second change is a second flush, not swallowed by the first.
		batch.add(invalidationsForChange(queryClient, requestChange)!);
		vi.advanceTimersByTime(CHANGE_FEED_COALESCE_MS);
		expect(countOf(keys(), queryKeys.requests.detail("req_1"))).toBe(2);
	});

	it("does not let a client writing without pause put its changes off forever", () => {
		const { queryClient, keys } = spiedClient();
		const batch = new FeedInvalidationBatch(queryClient);

		// One change every 50ms for a second: a restarting debounce would never fire.
		for (let i = 0; i < 20; i += 1) {
			batch.add(invalidationsForChange(queryClient, requestChange)!);
			vi.advanceTimersByTime(50);
		}
		expect(countOf(keys(), queryKeys.requests.detail("req_1"))).toBeGreaterThanOrEqual(4);
	});

	it("takes a reset as the whole domain, subsuming what was pending", () => {
		const { queryClient, keys } = spiedClient();
		const batch = new FeedInvalidationBatch(queryClient);

		batch.add(invalidationsForChange(queryClient, requestChange)!);
		batch.addReset();
		vi.advanceTimersByTime(CHANGE_FEED_COALESCE_MS);

		expect(includesKey(keys(), queryKeys.requests.all)).toBe(true);
		expect(includesKey(keys(), queryKeys.environments.all)).toBe(true);
		expect(includesKey(keys(), queryKeys.clientCertificates.all)).toBe(true);
		// The narrow key is not asked for on top: `requests.all` covers it.
		expect(includesKey(keys(), queryKeys.requests.detail("req_1"))).toBe(false);
	});

	it("waits for an in-flight mutation to settle before it flushes", async () => {
		const { queryClient, keys } = spiedClient();
		const batch = new FeedInvalidationBatch(queryClient);
		let release!: () => void;
		const observer = new MutationObserver(queryClient, {
			mutationFn: () => new Promise<void>((resolve) => (release = resolve)),
		});
		void observer.mutate();
		expect(queryClient.isMutating()).toBe(1);

		// The autosave PUT's own echo, arriving before the PUT's answer.
		batch.add(invalidationsForChange(queryClient, requestChange)!);
		await vi.advanceTimersByTimeAsync(CHANGE_FEED_COALESCE_MS * 5);
		expect(keys()).toEqual([]);

		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(countOf(keys(), queryKeys.requests.detail("req_1"))).toBe(1);
	});
});
