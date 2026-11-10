/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The change feed's stream (issue #3420): it reconnects on its own backoff and
 * resumes from the last id, a `reset` refetches everything the feed covers,
 * and a kind this build does not know is passed over without stopping the
 * stream. `EventSource` is replaced by a recorder whose frames the test sends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import { CHANGE_FEED_COALESCE_MS } from "@/lib/change-feed-invalidation";
import { queryKeys } from "@/queries/keys";
import {
	CHANGE_FEED_RETRY_BASE_MS,
	CHANGE_FEED_RETRY_MAX_MS,
	ChangeFeedService,
	changeFeedRetryDelayMs,
} from "./change-feed-service";

/** Every source the service opened, in order, with its listeners reachable. */
class MockEventSource {
	static instances: MockEventSource[] = [];
	onerror: (() => void) | null = null;
	closed = false;
	private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: (event: MessageEvent) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	close() {
		this.closed = true;
	}

	/** Deliver one frame the way the browser does: named event, `id:` as `lastEventId`. */
	emit(type: string, id: number, data: unknown) {
		const event = new MessageEvent(type, {
			lastEventId: String(id),
			data: typeof data === "string" ? data : JSON.stringify(data),
		});
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

const FEED_URL = `${API_ENDPOINTS.BASE_URL}${API_ENDPOINTS.CHANGES}`;
// Ids the size the engine issues: a process start in microseconds.
const FIRST_ID = 1_789_000_000_000_000;

function sources() {
	return MockEventSource.instances;
}

function latest() {
	const all = sources();
	expect(all.length).toBeGreaterThan(0);
	return all[all.length - 1];
}

function requestChange(id = "req_1") {
	return { kind: "request", id, op: "update", collectionId: "col_1" };
}

let queryClient: QueryClient;
let invalidated: () => unknown[][];
let service: ChangeFeedService;

beforeEach(() => {
	vi.useFakeTimers();
	MockEventSource.instances = [];
	vi.stubGlobal("EventSource", MockEventSource);
	queryClient = new QueryClient();
	const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
	invalidated = () => spy.mock.calls.map(([filters]) => filters?.queryKey as unknown[]);
	service = new ChangeFeedService();
});

afterEach(() => {
	service.stop();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const includesKey = (key: readonly unknown[]) =>
	invalidated().some((k) => JSON.stringify(k) === JSON.stringify(key));

/** The delay of the newest timer @p timeouts saw scheduled. */
function lastDelay(timeouts: { mock: { calls: unknown[][] } }): number {
	const { calls } = timeouts.mock;
	expect(calls.length).toBeGreaterThan(0);
	return calls[calls.length - 1][1] as number;
}

/** Fail the current stream and let its reconnect fire. */
async function dropAndReconnect(source = latest()) {
	source.onerror?.();
	await vi.advanceTimersByTimeAsync(CHANGE_FEED_RETRY_MAX_MS * 2);
}

describe("ChangeFeedService", () => {
	it("subscribes with no resume point the first time", () => {
		service.start(queryClient);
		expect(sources().map((s) => s.url)).toEqual([FEED_URL]);
	});

	it("does not open a second stream while one is open", () => {
		service.start(queryClient);
		service.start(queryClient);
		expect(sources()).toHaveLength(1);
	});

	it("invalidates what a change names, once the coalescing window has passed", async () => {
		service.start(queryClient);
		latest().emit("ready", FIRST_ID, { lastEventId: FIRST_ID });
		latest().emit("change", FIRST_ID + 1, requestChange());

		expect(includesKey(queryKeys.requests.detail("req_1"))).toBe(false);
		await vi.advanceTimersByTimeAsync(CHANGE_FEED_COALESCE_MS);
		expect(includesKey(queryKeys.requests.detail("req_1"))).toBe(true);
	});

	it("asks nothing of the cache for a fresh subscription's ready", async () => {
		service.start(queryClient);
		latest().emit("ready", FIRST_ID, { lastEventId: FIRST_ID });
		await vi.advanceTimersByTimeAsync(CHANGE_FEED_COALESCE_MS);
		expect(invalidated()).toEqual([]);
	});

	it("refetches everything the feed covers on a reset", async () => {
		service.start(queryClient);
		latest().emit("reset", FIRST_ID + 2000, { lastEventId: FIRST_ID + 2000 });
		await vi.advanceTimersByTimeAsync(CHANGE_FEED_COALESCE_MS);

		expect(includesKey(queryKeys.collections.all)).toBe(true);
		expect(includesKey(queryKeys.requests.all)).toBe(true);
		expect(includesKey(queryKeys.environments.all)).toBe(true);
		expect(includesKey(queryKeys.globals.all)).toBe(true);
		expect(includesKey(queryKeys.trash.all)).toBe(true);
		expect(includesKey(queryKeys.clientCertificates.all)).toBe(true);
	});

	it("resumes from the last id it saw after a drop", async () => {
		service.start(queryClient);
		latest().emit("ready", FIRST_ID, { lastEventId: FIRST_ID });
		latest().emit("change", FIRST_ID + 1, requestChange());
		latest().emit("change", FIRST_ID + 2, requestChange("req_2"));

		const dropped = latest();
		await dropAndReconnect();

		expect(dropped.closed).toBe(true);
		expect(sources()).toHaveLength(2);
		expect(latest().url).toBe(`${FEED_URL}?lastEventId=${FIRST_ID + 2}`);
	});

	it("resumes from the ready's id when the stream drops before any change", async () => {
		service.start(queryClient);
		latest().emit("ready", FIRST_ID, { lastEventId: FIRST_ID });
		await dropAndReconnect();
		expect(latest().url).toBe(`${FEED_URL}?lastEventId=${FIRST_ID}`);
	});

	it("passes over a kind it does not know, and still advances the resume point", async () => {
		service.start(queryClient);
		latest().emit("ready", FIRST_ID, { lastEventId: FIRST_ID });
		latest().emit("change", FIRST_ID + 1, { kind: "dashboard", id: "d_1", op: "create" });
		latest().emit("change", FIRST_ID + 2, "not json");
		latest().emit("change", FIRST_ID + 3, requestChange());
		await vi.advanceTimersByTimeAsync(CHANGE_FEED_COALESCE_MS);

		// The stream kept going past both: the change after them was applied.
		expect(includesKey(queryKeys.requests.detail("req_1"))).toBe(true);
		await dropAndReconnect();
		expect(latest().url).toBe(`${FEED_URL}?lastEventId=${FIRST_ID + 3}`);
	});

	it("ignores what a source it has already closed still delivers", async () => {
		service.start(queryClient);
		const first = latest();
		first.emit("ready", FIRST_ID, { lastEventId: FIRST_ID });
		await dropAndReconnect(first);

		first.emit("change", FIRST_ID + 9, requestChange());
		await vi.advanceTimersByTimeAsync(CHANGE_FEED_COALESCE_MS);
		expect(invalidated()).toEqual([]);
		// Nor did its id become the resume point.
		await dropAndReconnect();
		expect(latest().url).toBe(`${FEED_URL}?lastEventId=${FIRST_ID}`);
	});

	it("keeps retrying a refused stream on a backoff that tops out at the engine's Retry-After", async () => {
		// A 503 `change_feed_full` reaches an EventSource as a bare error before
		// any frame. Spy on the delay the service asks for rather than the clock.
		const timeouts = vi.spyOn(globalThis, "setTimeout");
		service.start(queryClient);
		const delays: number[] = [];
		for (let attempt = 0; attempt < 10; attempt += 1) {
			timeouts.mockClear();
			latest().onerror?.();
			const delay = lastDelay(timeouts);
			delays.push(delay);
			await vi.advanceTimersByTimeAsync(delay);
		}

		// Never given up: one reconnect per refusal.
		expect(sources()).toHaveLength(11);
		expect(delays[0]).toBeGreaterThanOrEqual(CHANGE_FEED_RETRY_BASE_MS);
		expect(delays[0]).toBeLessThan(CHANGE_FEED_RETRY_BASE_MS * 2);
		// The tail sits at the cap, never back at the base.
		for (const delay of delays.slice(-3)) {
			expect(delay).toBeGreaterThanOrEqual(CHANGE_FEED_RETRY_MAX_MS);
		}
	});

	it("starts the ladder over once a stream serves again", async () => {
		const timeouts = vi.spyOn(globalThis, "setTimeout");
		service.start(queryClient);
		for (let attempt = 0; attempt < 6; attempt += 1) await dropAndReconnect();

		latest().emit("ready", FIRST_ID, { lastEventId: FIRST_ID });
		timeouts.mockClear();
		latest().onerror?.();
		expect(lastDelay(timeouts)).toBeLessThan(CHANGE_FEED_RETRY_BASE_MS * 2);
	});

	it("stops reconnecting once stopped, and resumes from where it was when started again", async () => {
		service.start(queryClient);
		latest().emit("ready", FIRST_ID, { lastEventId: FIRST_ID });
		latest().emit("change", FIRST_ID + 4, requestChange());
		latest().onerror?.();
		service.stop();
		await vi.advanceTimersByTimeAsync(CHANGE_FEED_RETRY_MAX_MS * 2);
		expect(sources()).toHaveLength(1);

		service.start(queryClient);
		expect(sources()).toHaveLength(2);
		expect(latest().url).toBe(`${FEED_URL}?lastEventId=${FIRST_ID + 4}`);
	});
});

describe("changeFeedRetryDelayMs", () => {
	it("doubles from the base and is capped, jitter included at both extremes", () => {
		expect(changeFeedRetryDelayMs(1, () => 0)).toBe(CHANGE_FEED_RETRY_BASE_MS);
		expect(changeFeedRetryDelayMs(2, () => 0)).toBe(CHANGE_FEED_RETRY_BASE_MS * 2);
		expect(changeFeedRetryDelayMs(1, () => 1)).toBe(CHANGE_FEED_RETRY_BASE_MS * 1.5);
		expect(changeFeedRetryDelayMs(30, () => 0)).toBe(CHANGE_FEED_RETRY_MAX_MS);
		expect(changeFeedRetryDelayMs(30, () => 1)).toBe(CHANGE_FEED_RETRY_MAX_MS * 1.5);
	});
});
