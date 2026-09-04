/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What local services are running - for the Dock's ambient indicator, and for
 * the close that would stop them (issue #1363).
 *
 * One hook rather than each surface counting for itself: the drawer, the
 * indicator and the main process have to agree about what "running" means, and
 * the three lists disagree on their own terms. An inbox keeps its record after
 * it is stopped (`running` is the flag that says so); a stopped issuer or mock
 * server is *gone* from the engine's list, so every one of those listed is a
 * running one.
 *
 * The count is the list's length rather than a second sum: two answers to
 * "what is running" drift, and the Dock saying 2 while the close names 3 is the
 * kind of disagreement no test that reads one of them can see.
 *
 * All three reads go through the same query keys the drawer uses, so mounting
 * this in the Dock costs one shared poll, not a second set of requests.
 *
 * **A dead engine is running nothing, whatever the cache still holds.** All
 * three lists are engine-*process* state, so when the engine goes down every service
 * it was holding went down with it - but TanStack keeps the last good data
 * through failed refetches, which is right for a list the user can still read
 * and wrong for a count that claims something is listening. The Dock said "2
 * services" in green beside its own "Disconnected" light. The gate lives here
 * rather than at the one call site because the count is what is untrue: any
 * later reader inherits the answer instead of re-deriving the caveat.
 */

import { useEffect, useMemo } from "react";

import { useInboxesQuery, useMockIssuersQuery, useMockServersQuery } from "@/queries";
import { useEngineStore } from "@/stores";
import type { RunningServiceSummary } from "@/types/electron";

/** One identity for "nothing", so a disconnected engine re-publishes nothing. */
const NOTHING_RUNNING: RunningServiceSummary[] = [];

export function useRunningServices(): RunningServiceSummary[] {
	const engineStatus = useEngineStore((s) => s.engineStatus);
	const { data: inboxes = [] } = useInboxesQuery();
	const { data: issuers = [] } = useMockIssuersQuery();
	const { data: mocks = [] } = useMockServersQuery();

	return useMemo(() => {
		// Both of the not-connected states gate the same way: an engine that has
		// not answered yet is running no more than one that stopped answering.
		if (engineStatus !== "connected") return NOTHING_RUNNING;
		return [
			...inboxes
				.filter((inbox) => inbox.running)
				.map((inbox) => ({ kind: "inbox" as const, name: null, port: inbox.port })),
			...mocks.map((mock) => ({
				kind: "mock-server" as const,
				// The name it was started under, which is how the drawer lists it and
				// the only part of a mock a user recognises at a glance.
				name: mock.collectionName,
				port: mock.port,
			})),
			...issuers.map((issuer) => ({
				kind: "issuer" as const,
				name: null,
				port: issuer.port,
			})),
		];
	}, [engineStatus, inboxes, issuers, mocks]);
}

export function useRunningServiceCount(): number {
	return useRunningServices().length;
}

/**
 * Tell the main process what is running, so the close it intercepts can name it
 * (issue #1363).
 *
 * Mounted once at the app root. Published on change rather than answered on
 * demand: the question would arrive on the gesture the user is already waiting
 * on, and main cannot read the queries this is derived from.
 */
export function useRunningServicesPublisher(): void {
	const services = useRunningServices();

	useEffect(() => {
		window.electronAPI?.setRunningServices?.(services);
	}, [services]);
}
