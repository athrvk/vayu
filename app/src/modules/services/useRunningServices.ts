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
 * indicator have to agree about what "running" means, and they disagree on the
 * two lists' own terms. An inbox keeps its record after it is stopped (`running`
 * is the flag that says so); a stopped issuer is *gone* from the engine's list,
 * so every issuer listed is a running one.
 *
 * Both reads go through the same query keys the drawer uses, so mounting this
 * in the Dock costs one shared poll, not a second set of requests.
 */

import { useInboxesQuery, useMockIssuersQuery } from "@/queries";

export function useRunningServiceCount(): number {
	const { data: inboxes = [] } = useInboxesQuery();
	const { data: issuers = [] } = useMockIssuersQuery();

	return inboxes.filter((inbox) => inbox.running).length + issuers.length;
}
