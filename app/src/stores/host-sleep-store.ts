/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Host Sleep Store - when the machine slept under a run, per run (issue #1357).
 *
 * The wake lock the app holds during a run is a request to the OS, not a
 * guarantee: a closed lid, a critical battery or a user who forces sleep
 * overrides it. The run's series then has a stretch it cannot explain, and a
 * reader with no marker reads it as the server's fault.
 *
 * The engine's run report has no field for a client-side annotation - the
 * engine was suspended too and knows nothing about it - so the record lives
 * here, beside the report rather than inside it, keyed by run id. Two readers:
 * the live dashboard marks it on the charts, and History's Events tab states it
 * in words for the same run later.
 *
 * Persisted, because the gap outlives the session that produced it: a user who
 * finds the hole tomorrow needs the same answer. Bounded on both axes - the
 * newest {@link MAX_RUNS} runs, {@link MAX_SLEEPS_PER_RUN} intervals each -
 * because localStorage is a fixed budget shared with the workspace, and a run
 * nobody has open is not worth a byte of it.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";

/** One interval the host spent asleep while a run was streaming. */
export interface HostSleep {
	/** Wall clock ms at the suspend - the only clock that ran through it. */
	at: number;
	/** How long the host was down. This is the number a reader needs. */
	durationMs: number;
	/**
	 * Elapsed seconds into the run at the last tick before the suspend, which is
	 * where the marker sits on the charts.
	 *
	 * Deliberately not paired with an end: whether the engine's elapsed clock
	 * advanced through the suspend is a per-platform answer (a monotonic clock
	 * stops on Linux and macOS; a boot-time clock does not), so a band drawn
	 * `durationMs` wide would be a claim about the series that may be fiction.
	 * The marker says where, the duration says how long.
	 */
	startSeconds: number;
}

/** Runs kept. Older runs' annotations are evicted oldest-first. */
export const MAX_RUNS = 20;

/** Intervals kept per run - a laptop lid opened and closed all afternoon. */
export const MAX_SLEEPS_PER_RUN = 20;

interface HostSleepState {
	/** Sleeps by run id, oldest interval first within a run. */
	byRun: Record<string, HostSleep[]>;
	/** Run ids in the order they were first annotated, oldest first. */
	runOrder: string[];
	recordSleep: (runId: string, sleep: HostSleep) => void;
}

/** One frozen empty array, so a run with no sleeps is a stable selector result. */
const NONE: readonly HostSleep[] = Object.freeze([]);

interface PersistedHostSleeps {
	byRun: Record<string, HostSleep[]>;
	runOrder: string[];
}

function isSleep(value: unknown): value is HostSleep {
	const sleep = value as Partial<HostSleep> | null;
	if (!sleep || typeof sleep !== "object") return false;
	return (
		Number.isFinite(sleep.at) &&
		Number.isFinite(sleep.durationMs) &&
		Number.isFinite(sleep.startSeconds)
	);
}

/**
 * Normalize a persisted payload.
 *
 * Wired as both `migrate` and `merge`, as `recovery-notice-store` is and for
 * the same reason: `migrate` only runs on a version change, `merge` runs on
 * every rehydrate. A hand-edited or half-written entry must not put a
 * non-array where a reader maps over one.
 */
function normalizeHostSleeps(persisted: unknown): PersistedHostSleeps {
	const stored = (persisted ?? {}) as Partial<PersistedHostSleeps>;
	const rawRuns = stored.byRun;
	if (!rawRuns || typeof rawRuns !== "object") return { byRun: {}, runOrder: [] };

	const byRun: Record<string, HostSleep[]> = {};
	for (const [runId, sleeps] of Object.entries(rawRuns)) {
		if (!Array.isArray(sleeps)) continue;
		const kept = sleeps.filter(isSleep).slice(-MAX_SLEEPS_PER_RUN);
		if (kept.length > 0) byRun[runId] = kept;
	}

	// Order is a cache-eviction detail, so a payload that lost it is repaired
	// from the runs themselves rather than thrown away with them.
	const stampedOrder = Array.isArray(stored.runOrder) ? stored.runOrder : [];
	const runOrder = stampedOrder.filter((id) => typeof id === "string" && id in byRun);
	for (const runId of Object.keys(byRun)) {
		if (!runOrder.includes(runId)) runOrder.push(runId);
	}
	return { byRun, runOrder };
}

export const useHostSleepStore = create<HostSleepState>()(
	persist(
		(set) => ({
			byRun: {},
			runOrder: [],

			recordSleep: (runId, sleep) =>
				set((state) => {
					const existing = state.byRun[runId] ?? [];
					const byRun = {
						...state.byRun,
						[runId]: [...existing, sleep].slice(-MAX_SLEEPS_PER_RUN),
					};
					const runOrder = state.runOrder.includes(runId)
						? state.runOrder
						: [...state.runOrder, runId];
					if (runOrder.length <= MAX_RUNS) return { byRun, runOrder };

					const evicted = runOrder.slice(0, runOrder.length - MAX_RUNS);
					for (const old of evicted) delete byRun[old];
					return { byRun, runOrder: runOrder.slice(evicted.length) };
				}),
		}),
		{
			name: STORAGE_KEYS.HOST_SLEEP_STORE,
			version: 1,
			partialize: (state) => ({ byRun: state.byRun, runOrder: state.runOrder }),
			migrate: normalizeHostSleeps,
			merge: (persisted, current) => ({ ...current, ...normalizeHostSleeps(persisted) }),
		}
	)
);

/**
 * The sleeps recorded against one run, for a component that has its id.
 *
 * A selector rather than a prop drilled from the view that owns the run: both
 * readers (the live dashboard, History's detail) already hold the run id, and
 * neither derives anything from the list that the other would have to match.
 */
export function useHostSleeps(runId: string | null | undefined): readonly HostSleep[] {
	return useHostSleepStore((state) => (runId ? (state.byRun[runId] ?? NONE) : NONE));
}
