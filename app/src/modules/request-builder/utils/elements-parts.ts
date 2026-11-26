/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The elements that run for a request (#1512): the chain's root to leaf, then the request's own,
 * minus what any `inherit.disable` names (#3070), each part recording its origin. A disable entry
 * is never a part: it suppresses, and a chain level's would reach a single-request run's
 * `requestElements`, which the engine refuses. Send executes possibly unsaved editor state, so the
 * app resolves the chain itself; `POST /compose`'s by-id path (MCP, a saved request's load run,
 * #1594) resolves the same chain engine-side from a real id. Send and code generation take
 * `elementsParts` through `sendElementsParts`, which also drops the request's own drafts that
 * cannot run (#3066).
 */

import type { Collection, ElementDef, ElementKindSchema, ResolvedElement } from "@/types";
import { elementNeeds, isBlankScriptElement, type LeftOutElement } from "@/lib/elements";

// Re-exported so this file's importers resolve it; it lives in `lib/` since
// `lib/request-references.ts`, which this module may not import nor be imported by, needs it too
// (`@/lib/elements.ts`).
export { scriptTextFor } from "@/lib/elements";

/**
 * Whether a default load run would replay a post-request script after the run on sampled responses:
 * an enabled, non-blank `script.post` (inherited included) not marked `config.inline`. Takes
 * `elementsParts`' result, so the dialog warns about the list the run composes.
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

/** The enabled, non-blank `script.pre` elements of a list. */
function livePreScripts(elements: ElementDef[] | undefined): ElementDef[] {
	return (elements ?? []).filter(
		(el) => el.kind === "script.pre" && el.enabled && !isBlankScriptElement(el)
	);
}

/**
 * Whether the list has an enabled, non-blank `script.pre` not marked `config.inline`: the one the
 * load engine skips at As marked and All deferred (`script_element_runs_inline`), so the dialog
 * warns.
 */
export function hasUnmarkedPreScript(elements: ElementDef[] | undefined): boolean {
	return livePreScripts(elements).some((el) => el.config.inline !== true);
}

/**
 * Whether the list has an enabled, non-blank `script.pre` marked `config.inline`: it runs at As
 * marked; All deferred skips it.
 */
export function hasInlinePreScript(elements: ElementDef[] | undefined): boolean {
	return livePreScripts(elements).some((el) => el.config.inline === true);
}

/**
 * `parts` without switched-off elements, `undefined` when none are left (`elementsParts`' empty
 * answer). For a load run's `requestElements` only (#3050): the pipeline skips them, and a disabled
 * kind a single-request run cannot hold would burden the run. Send and code generation drop them
 * via `sendElementsParts`, with the incomplete ones (#3066).
 */
export function withoutDisabled(
	parts: ResolvedElement[] | undefined
): ResolvedElement[] | undefined {
	const enabled = (parts ?? []).filter((el) => el.enabled);
	return enabled.length > 0 ? enabled : undefined;
}

/**
 * Kinds the engine accepts only on a collection (`collectionOnly` in `GET /elements/kinds`): the
 * run-boundary scripts. A single-request run never takes them, and `requestElements` is validated
 * as a request's own. A constant, not a catalogue read: the catalogue may not have landed at Start,
 * and a miss would send refused kinds; `scenario-only.conformance.test.ts` holds it to the
 * catalogue fixture.
 */
export const COLLECTION_ONLY_KINDS: ReadonlySet<string> = new Set([
	"script.setup",
	"script.teardown",
]);

/**
 * `parts` without inherited collection-only elements, `undefined` when none are left; for a load
 * run's `requestElements` only (#3070), after `withoutDisabled`. Send and code generation compose
 * through `POST /compose`, which validates a collection-origin entry as a collection's, so they
 * keep these.
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
 * Every `inherit.disable` target across the chain and the request's list, gathered before any level
 * is emitted and in no order, as `POST /compose` does (`disabled_element_ids`): a folder's disable
 * can name a root element, a root's a folder's, a request's an ancestor's.
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
		// The chain is root first, so every later collection is nested; the engine stamps a stored
		// request's chain the same way (#2522).
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

/**
 * `elementsParts` as a Send puts it on the wire (#3066): the request's own draft elements that are
 * off, or fail the app's check (`elementNeeds`, behind the editor's "Needs ..." chip), are left
 * out. The engine refuses an element failing its schema (#3052), turning an unfinished check into a
 * 400 on the whole request. Incomplete ones come back as `leftOut` for the caller to report; off
 * ones are not, as their row says so. Only the request's own are judged: an inherited level passes
 * as composed, since its author is not mid-edit there and it was held to the same check on save
 * (#3048). Empty `kinds` (catalogue not loaded) still drops disabled elements and judges operand
 * rules, which need no schema; a kind with no schema fails nothing.
 */
export function sendElementsParts(
	chain: Collection[],
	requestId: string | undefined,
	requestElements: ElementDef[],
	kinds: ElementKindSchema[]
): { parts: ResolvedElement[] | undefined; leftOut: LeftOutElement[] } {
	const parts: ResolvedElement[] = [];
	const leftOut: LeftOutElement[] = [];
	for (const el of elementsParts(chain, requestId, requestElements) ?? []) {
		if (el.origin?.kind !== "request") {
			parts.push(el);
			continue;
		}
		if (!el.enabled) continue;
		const needs = elementNeeds(el, kinds);
		if (needs) leftOut.push({ element: el, needs });
		else parts.push(el);
	}
	return { parts: parts.length > 0 ? parts : undefined, leftOut };
}
