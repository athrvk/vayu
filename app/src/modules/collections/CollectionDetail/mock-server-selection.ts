/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which running mock this collection's header is about (issue #481 phase 2).
 *
 * Its own file, like `format.ts` beside it, so `MockServerControl.tsx` exports
 * nothing but a component and fast refresh keeps working.
 */

import type { MockServer } from "@/types";

/**
 * The running mock for @p collectionId, or null.
 *
 * By port when there are several: nothing stops a user starting two mocks of
 * one collection (different latency, different error rate), and the engine
 * lists them in map order. The lowest port is stable across polls, which is
 * what keeps the header from flipping between two rows that both apply.
 */
export function mockForCollection(mocks: MockServer[], collectionId: string): MockServer | null {
	const matching = mocks
		.filter((mock) => mock.collectionId === collectionId)
		.sort((a, b) => a.port - b.port);
	return matching[0] ?? null;
}
