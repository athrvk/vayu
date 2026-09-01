/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How many local services are running, for the Dock's ambient indicator.
 *
 * One hook rather than each surface counting for itself: the drawer and the
 * indicator have to agree about what "running" means, and the three lists
 * disagree on their own terms. An inbox keeps its record after it is stopped
 * (`running` is the flag that says so); a stopped issuer or mock server is
 * *gone* from the engine's list, so every one of those listed is a running one.
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

import { useInboxesQuery, useMockIssuersQuery, useMockServersQuery } from "@/queries";
import { useEngineStore } from "@/stores";

export function useRunningServiceCount(): number {
	const engineStatus = useEngineStore((s) => s.engineStatus);
	const { data: inboxes = [] } = useInboxesQuery();
	const { data: issuers = [] } = useMockIssuersQuery();
	const { data: mocks = [] } = useMockServersQuery();

	// Both of the not-connected states gate the same way: an engine that has not
	// answered yet is running no more than one that stopped answering.
	if (engineStatus !== "connected") return 0;
	return inboxes.filter((inbox) => inbox.running).length + issuers.length + mocks.length;
}
