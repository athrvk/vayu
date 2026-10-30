/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collect the elements that run for a request (issue #1512): the collection
 * chain's, root to leaf, then the request's own, minus whatever an
 * `inherit.disable` entry at any level names (#3070). Each part records where
 * it came from. A disable entry is never itself a part: it suppresses, it does
 * not run, and a chain level's would reach a single-request run's
 * `requestElements`, where the engine refuses it.
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

/**
 * `parts` without its switched-off elements, `undefined` when none are left -
 * `elementsParts`' own empty answer. For a load run's `requestElements` only
 * (#3050): the pipeline skips a disabled element, so sending one buys nothing,
 * and a disabled kind a single-request run has no home for would only burden
 * the run. Send and code generation keep the disabled elements, as the
 * Elements tab does.
 */
export function withoutDisabled(
	parts: ResolvedElement[] | undefined
): ResolvedElement[] | undefined {
	const enabled = (parts ?? []).filter((el) => el.enabled);
	return enabled.length > 0 ? enabled : undefined;
}

/**
 * Kinds the engine accepts only on a collection (`collectionOnly` in
 * `GET /elements/kinds`): the run-boundary scripts. A single-request run never
 * takes a collection's lifecycle scripts, and `requestElements` is validated as
 * a request's own, which refuses them. A constant rather than a read of the
 * catalogue because the catalogue is a query that may not have landed when
 * Start is pressed, and a miss there would send the refused kinds;
 * `scenario-only.conformance.test.ts` holds this set to the catalogue fixture.
 */
export const COLLECTION_ONLY_KINDS: ReadonlySet<string> = new Set([
	"script.setup",
	"script.teardown",
]);

/**
 * `parts` without the collection-only elements inherited from a collection,
 * `undefined` when none are left. For a load run's `requestElements` only
 * (#3070), after `withoutDisabled`. Send and code generation compose the
 * chain through `POST /compose`, which validates a collection-origin entry as a
 * collection's own, so they keep these.
 */
export function withoutInheritedCollectionOnly(
	parts: ResolvedElement[] | undefined
): ResolvedElement[] | undefined {
	const kept = (parts ?? []).filter(
		(el) => !(el.origin?.kind === "collection" && COLLECTION_ONLY_KINDS.has(el.kind))
	);
	return kept.length > 0 ? kept : undefined;
}

/**
 * Every `inherit.disable` target across the chain and the request's own list.
 * Gathered before any level is emitted and in no order, as `POST /compose`
 * does (`disabled_element_ids`): a folder's disable can name a root element,
 * a root's a folder's, a request's an ancestor's.
 */
function disabledElementIds(chain: Collection[], requestElements: ElementDef[]): Set<string> {
	const ids = new Set<string>();
	for (const el of [...chain.flatMap((c) => c.elements), ...requestElements]) {
		if (el.kind !== "inherit.disable") continue;
		const targetId = el.config.elementId;
		if (typeof targetId === "string") ids.add(targetId);
	}
	return ids;
}

/** Whether `el` is composed at all: not a disable entry, and not named by one. */
function isComposed(el: ElementDef, disabled: Set<string>): boolean {
	return el.kind !== "inherit.disable" && !disabled.has(el.id);
}

export function elementsParts(
	chain: Collection[],
	requestId: string | undefined,
	requestElements: ElementDef[]
): ResolvedElement[] | undefined {
	const disabled = disabledElementIds(chain, requestElements);
	const parts: ResolvedElement[] = [];
	for (const [depth, c] of chain.entries()) {
		// The chain is root first, so every collection after it is a folder; the
		// engine stamps a stored request's chain the same way (#2522).
		const scope = depth === 0 ? "collection" : "folder";
		for (const el of c.elements) {
			if (!isComposed(el, disabled)) continue;
			parts.push({ ...el, origin: { kind: "collection", scope, id: c.id, name: c.name } });
		}
	}
	for (const el of requestElements) {
		if (!isComposed(el, disabled)) continue;
		parts.push({ ...el, origin: { kind: "request", scope: "request", id: requestId } });
	}
	return parts.length > 0 ? parts : undefined;
}
