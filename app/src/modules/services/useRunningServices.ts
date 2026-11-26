/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What local services are running, for the Dock's ambient indicator and the close that would stop
 * them (#1363).
 *
 * One definition for the drawer, the indicator, the main process and the restart notice
 * (`runningServicesIn`, `lib/services-stopped-by-restart.ts`), because the three lists disagree on
 * their own terms: an inbox keeps its record when stopped (`running` says so), while a stopped
 * issuer or mock server is *gone* from the engine's list, so every one listed is running.
 *
 * The count is the list's length, not a second sum: two answers to "what is running" drift, and the
 * Dock saying 2 while the close names 3 is invisible to a test that reads one of them. The reads
 * share the drawer's query keys, so the Dock costs one shared poll, not a second set of requests.
 *
 * **A dead engine is running nothing, whatever the cache holds.** The lists are engine-process
 * state, and TanStack keeps the last good data through failed refetches, right for a list the user
 * can read and wrong for a count that claims something is listening (the Dock would say "2
 * services" beside its own "Disconnected"). The gate lives here, not at a call site, because the
 * count is what is untrue, so every reader inherits it; the drawer reads `useEngineServing` too, so
 * its rows turn stopped on the same evidence the count drops to zero on.
 */

import { useEffect, useMemo } from "react";

import { useInboxesQuery, useMockIssuersQuery, useMockServersQuery } from "@/queries";
import { selectKnownEngineStatus, useEngineStore } from "@/stores";
import { runningServicesIn } from "@/lib/services-stopped-by-restart";
import type { RunningServiceSummary } from "@/types/electron";

/** One identity for "nothing", so a disconnected engine re-publishes nothing. */
const NOTHING_RUNNING: RunningServiceSummary[] = [];

/**
 * Whether the engine is up to hold any service. Not yet answered and stopped answering both read
 * false; a crash the sidecar reported counts before the health poll confirms it (#3493), through
 * the same `selectKnownEngineStatus` the Dock's light reads.
 */
export function useEngineServing(): boolean {
	return useEngineStore((s) => selectKnownEngineStatus(s) === "connected");
}

export function useRunningServices(): RunningServiceSummary[] {
	const serving = useEngineServing();
	const { data: inboxes = [] } = useInboxesQuery();
	const { data: issuers = [] } = useMockIssuersQuery();
	const { data: mocks = [] } = useMockServersQuery();

	return useMemo(() => {
		if (!serving) return NOTHING_RUNNING;
		// The summary main reads carries no id: it names, it never compares.
		return runningServicesIn({ inboxes, issuers, mocks }).map(({ kind, name, port }) => ({
			kind,
			name,
			port,
		}));
	}, [serving, inboxes, issuers, mocks]);
}

export function useRunningServiceCount(): number {
	return useRunningServices().length;
}

/**
 * Tells the main process what is running, so the close it intercepts can name it (#1363). Mounted
 * once at the app root; published on change rather than answered on demand, because the question
 * would arrive on the gesture the user is waiting on, and main cannot read the queries this derives
 * from.
 */
export function useRunningServicesPublisher(): void {
	const services = useRunningServices();

	useEffect(() => {
		window.electronAPI?.setRunningServices?.(services);
	}, [services]);
}
