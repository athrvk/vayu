/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The per-run sleep record (issue #1357): ordering and the two eviction
 * bounds, the selector's stable identity (what keeps the dashboard from
 * re-rendering on every tick), and rehydration - including the version bump
 * and the malformed-payload cases a hand-edited or half-written localStorage
 * entry can produce.
 *
 * Follows `persist-migrations.test.ts`'s idiom: rehydrate through
 * `persist.rehydrate()`, never by calling `migrate` directly, so these cases
 * cover the seam zustand actually exercises.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
	useHostSleepStore,
	useHostSleeps,
	MAX_RUNS,
	MAX_SLEEPS_PER_RUN,
	type HostSleep,
} from "./host-sleep-store";
import { STORAGE_KEYS } from "@/constants/storage-keys";

function mkSleep(startSeconds: number, durationMs = 60_000, at = startSeconds * 1000): HostSleep {
	return { at, durationMs, startSeconds };
}

const seed = (payload: unknown) =>
	localStorage.setItem(STORAGE_KEYS.HOST_SLEEP_STORE, JSON.stringify(payload));

beforeEach(() => {
	localStorage.clear();
	useHostSleepStore.setState({ byRun: {}, runOrder: [] });
});

afterEach(() => {
	localStorage.clear();
	useHostSleepStore.setState({ byRun: {}, runOrder: [] });
});

describe("recordSleep", () => {
	it("appends in order for one run and keeps runs apart", () => {
		const s1 = mkSleep(10);
		const s2 = mkSleep(40);
		useHostSleepStore.getState().recordSleep("run1", s1);
		useHostSleepStore.getState().recordSleep("run1", s2);
		useHostSleepStore.getState().recordSleep("run2", mkSleep(5));

		const state = useHostSleepStore.getState();
		expect(state.byRun.run1).toEqual([s1, s2]);
		expect(state.byRun.run2).toHaveLength(1);
	});

	it("caps a run's intervals at MAX_SLEEPS_PER_RUN, keeping the newest", () => {
		// Mutation check: drop the `.slice(-MAX_SLEEPS_PER_RUN)` in recordSleep and
		// this fails - the array grows past the cap instead of staying at it.
		for (let i = 0; i < MAX_SLEEPS_PER_RUN + 5; i++) {
			useHostSleepStore.getState().recordSleep("run1", mkSleep(i));
		}

		const sleeps = useHostSleepStore.getState().byRun.run1;
		expect(sleeps).toHaveLength(MAX_SLEEPS_PER_RUN);
		// The oldest 5 (startSeconds 0..4) were dropped; the newest MAX_SLEEPS_PER_RUN survive.
		expect(sleeps[0].startSeconds).toBe(5);
		expect(sleeps[sleeps.length - 1].startSeconds).toBe(MAX_SLEEPS_PER_RUN + 4);
	});

	it("evicts the oldest run past MAX_RUNS, keeping the newest runs", () => {
		for (let i = 0; i < MAX_RUNS + 2; i++) {
			useHostSleepStore.getState().recordSleep(`run_${i}`, mkSleep(i));
		}

		const state = useHostSleepStore.getState();
		expect(state.runOrder).toHaveLength(MAX_RUNS);
		// run_0 and run_1 were the oldest two, first-annotated - evicted first.
		expect(state.byRun.run_0).toBeUndefined();
		expect(state.byRun.run_1).toBeUndefined();
		expect(state.runOrder[0]).toBe("run_2");
		expect(state.byRun.run_2).toBeDefined();
		expect(state.byRun[`run_${MAX_RUNS + 1}`]).toBeDefined();
	});
});

describe("useHostSleeps identity", () => {
	it("returns the same array reference across renders when the run is unchanged", () => {
		useHostSleepStore.getState().recordSleep("run_a", mkSleep(1));
		const { result, rerender } = renderHook(
			({ runId }: { runId: string }) => useHostSleeps(runId),
			{
				initialProps: { runId: "run_a" },
			}
		);
		const first = result.current;

		// An unrelated run changes; run_a's own array must not be replaced.
		useHostSleepStore.getState().recordSleep("run_b", mkSleep(2));
		rerender({ runId: "run_a" });

		expect(result.current).toBe(first);
	});

	it("returns a new reference once the run itself gains a sleep", () => {
		const { result, rerender } = renderHook(
			({ runId }: { runId: string }) => useHostSleeps(runId),
			{
				initialProps: { runId: "run_c" },
			}
		);
		const before = result.current;

		useHostSleepStore.getState().recordSleep("run_c", mkSleep(3));
		rerender({ runId: "run_c" });

		expect(result.current).not.toBe(before);
	});

	it("returns the same stable empty array for an unknown run id, and for null/undefined", () => {
		// This is what keeps a component with no sleeps yet from re-rendering the
		// dashboard on every tick - assert identity, not just equal contents.
		const unknown = renderHook(() => useHostSleeps("no-such-run"));
		const nullId = renderHook(() => useHostSleeps(null));
		const undefinedId = renderHook(() => useHostSleeps(undefined));

		expect(unknown.result.current).toEqual([]);
		expect(unknown.result.current).toBe(nullId.result.current);
		expect(nullId.result.current).toBe(undefinedId.result.current);
	});
});

describe("rehydration", () => {
	it("carries a well-formed payload across the version bump", async () => {
		seed({
			version: 0,
			state: {
				byRun: { run1: [{ at: 1000, durationMs: 5000, startSeconds: 10 }] },
				runOrder: ["run1"],
			},
		});

		await useHostSleepStore.persist.rehydrate();

		const state = useHostSleepStore.getState();
		expect(state.byRun.run1).toEqual([{ at: 1000, durationMs: 5000, startSeconds: 10 }]);
		expect(state.runOrder).toEqual(["run1"]);
	});

	it("degrades to no annotations when byRun is not an object", async () => {
		seed({ version: 0, state: { byRun: "nope", runOrder: ["run1"] } });

		await useHostSleepStore.persist.rehydrate();

		const state = useHostSleepStore.getState();
		expect(state.byRun).toEqual({});
		expect(state.runOrder).toEqual([]);
	});

	it("drops a run whose entries are not an array, rather than handing one to a reader", async () => {
		seed({ version: 0, state: { byRun: { run1: "nope" }, runOrder: ["run1"] } });

		await useHostSleepStore.persist.rehydrate();

		const state = useHostSleepStore.getState();
		expect(state.byRun.run1).toBeUndefined();
		expect(state.runOrder).toEqual([]);
	});

	it("drops sleeps with non-finite numbers, rather than handing one to a reader", async () => {
		seed({
			version: 0,
			state: {
				byRun: {
					run1: [
						{ at: Number.NaN, durationMs: 5000, startSeconds: 10 },
						{ at: 1000, durationMs: Number.POSITIVE_INFINITY, startSeconds: 10 },
						{ at: 1000, durationMs: 5000, startSeconds: "ten" },
					],
				},
				runOrder: ["run1"],
			},
		});

		await useHostSleepStore.persist.rehydrate();

		const state = useHostSleepStore.getState();
		// Every entry was malformed, so the run has nothing worth keeping.
		expect(state.byRun.run1).toBeUndefined();
		expect(state.runOrder).toEqual([]);
	});

	it("repairs a payload missing runOrder from byRun, keeping the runs", async () => {
		seed({
			version: 0,
			state: {
				byRun: { run1: [{ at: 1, durationMs: 2, startSeconds: 3 }] },
				// runOrder omitted entirely.
			},
		});

		await useHostSleepStore.persist.rehydrate();

		const state = useHostSleepStore.getState();
		expect(state.runOrder).toEqual(["run1"]);
		expect(state.byRun.run1).toHaveLength(1);
	});
});
