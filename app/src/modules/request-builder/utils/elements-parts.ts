/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collect the elements that run for a request (issue #1512): the collection
 * chain's, root to leaf, then the request's own, minus whatever the request's
 * own `inherit.disable` entries name. Each part records where it came from.
 *
 * Generalizes `scriptParts` (`./script-parts.ts`, kept for the load path's
 * `tests` field, which still sends a joined script string) to every element
 * kind: Send executes editor state that may be unsaved, so the app resolves
 * the whole chain itself rather than asking the engine to resolve it from a
 * stored id - the same reason the old script-only version existed.
 */

import type { Collection, ElementDef, ResolvedElement } from "@/types";

// Re-exported so existing importers of this file keep resolving it; the
// implementation lives in `lib/` because `lib/request-references.ts` (which
// this module may not import, and which may not import this module) needs it
// too. See `@/lib/elements.ts`.
export { scriptTextFor } from "@/lib/elements";

function disabledAncestorIds(requestElements: ElementDef[]): Set<string> {
	const ids = new Set<string>();
	for (const el of requestElements) {
		if (el.kind !== "inherit.disable") continue;
		const targetId = el.config.elementId;
		if (typeof targetId === "string") ids.add(targetId);
	}
	return ids;
}

export function elementsParts(
	chain: Collection[],
	requestId: string | undefined,
	requestElements: ElementDef[]
): ResolvedElement[] | undefined {
	const disabled = disabledAncestorIds(requestElements);
	const parts: ResolvedElement[] = [];
	for (const c of chain) {
		for (const el of c.elements) {
			if (disabled.has(el.id)) continue;
			parts.push({ ...el, origin: { kind: "collection", id: c.id, name: c.name } });
		}
	}
	for (const el of requestElements) {
		if (el.kind === "inherit.disable") continue;
		parts.push({ ...el, origin: { kind: "request", id: requestId } });
	}
	return parts.length > 0 ? parts : undefined;
}
