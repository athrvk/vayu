/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collect the script parts that run for a request: the collection chain's,
 * root to leaf, then the request's own. Each part records where it came from.
 *
 * The engine joins them and runs the result as one script. It used to be joined
 * here, which meant a stored run could not say which part came from where.
 *
 * This mirrors `scriptParts` in `app/electron/mcp/resolve.ts` byte-for-byte in
 * behaviour. It cannot be shared: `app/tsconfig.node.json` includes only
 * `electron`, so `resolve.ts` cannot import from `app/src/`. Keep the two in
 * sync - `app/electron/mcp/resolve.test.ts` guards the parity.
 */

import type { Collection, ScriptPart } from "@/types";

export function scriptParts(
	chain: Collection[],
	pick: (c: Collection) => string | undefined,
	requestId: string | undefined,
	requestScript: string | undefined
): ScriptPart[] | undefined {
	const parts: ScriptPart[] = [];
	for (const c of chain) {
		const script = pick(c);
		if (script && script.trim()) {
			parts.push({ origin: "collection", id: c.id, name: c.name, script });
		}
	}
	if (requestScript && requestScript.trim()) {
		parts.push({ origin: "request", id: requestId, script: requestScript });
	}
	return parts.length > 0 ? parts : undefined;
}
