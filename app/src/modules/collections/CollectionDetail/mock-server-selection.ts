/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which running mock this collection's header is about (issue #481 phase 2). Its own file, like
 * `mock-server-options.ts` beside it, so `MockServerControl.tsx` exports nothing but a component
 * and fast refresh keeps working.
 */

import type { MockServer } from "@/types";

/**
 * The running mock for @p collectionId, or null, by lowest port when there are several: nothing
 * stops a user starting two mocks of one collection (different latency or error rate), the engine
 * lists them in map order, and the lowest port is stable across polls, which keeps the header from
 * flipping between two rows that both apply.
 */
export function mockForCollection(mocks: MockServer[], collectionId: string): MockServer | null {
	const matching = mocks
		.filter((mock) => mock.collectionId === collectionId)
		.sort((a, b) => a.port - b.port);
	return matching[0] ?? null;
}
