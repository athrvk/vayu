/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { StreamEvent } from "@/types";

/**
 * How many of @p events the engine flagged as an in-band error (#3996). Reads the flag and nothing
 * else: the judgement is the engine's (`docs/engine/api-reference/execute.md`), so the name and
 * `data` of an event are never consulted here.
 */
export function countErrorEvents(events: readonly StreamEvent[]): number {
	let count = 0;
	for (const event of events) if (event.isError === true) count += 1;
	return count;
}
