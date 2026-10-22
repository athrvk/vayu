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
 * Send executes editor state that may be unsaved, so the app resolves the
 * whole chain itself rather than asking the engine to resolve it from a
 * stored id - `POST /compose`'s by-id path (what MCP and a saved request's
 * load-test run, issue #1594, both use instead) resolves the same chain
 * engine-side, since it has a real id to resolve from.
 */

import type { Collection, ElementDef, ResolvedElement } from "@/types";
import { isBlankScriptElement } from "@/lib/elements";

// Re-exported so existing importers of this file keep resolving it; the
// implementation lives in `lib/` because `lib/request-references.ts` (which
// this module may not import, and which may not import this module) needs it
// too. See `@/lib/elements.ts`.
export { scriptTextFor } from "@/lib/elements";

/**
 * Whether a load run left to its default would replay a post-request script
 * after the run, on a sample of responses: some enabled, non-blank
 * `script.post` in the resolved list (inherited collection scripts included)
 * that is not marked `config.inline`. Takes `elementsParts`' result, so the
 * dialog warns about exactly the list the run composes.
 */
export function hasReplayedPostScript(parts: ElementDef[] | undefined): boolean {
	return (parts ?? []).some(
		(el) =>
			el.kind === "script.post" &&
			el.enabled &&
			!isBlankScriptElement(el) &&
			el.config.inline !== true
	);
}

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
	for (const [depth, c] of chain.entries()) {
		// The chain is root first, so every collection after it is a folder; the
		// engine stamps a stored request's chain the same way (#2522).
		const scope = depth === 0 ? "collection" : "folder";
		for (const el of c.elements) {
			if (disabled.has(el.id)) continue;
			parts.push({ ...el, origin: { kind: "collection", scope, id: c.id, name: c.name } });
		}
	}
	for (const el of requestElements) {
		if (el.kind === "inherit.disable") continue;
		parts.push({ ...el, origin: { kind: "request", scope: "request", id: requestId } });
	}
	return parts.length > 0 ? parts : undefined;
}
