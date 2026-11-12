/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which templates a script editor offers, and under which headings.
 *
 * The engine's completion table is the single source for what the editor
 * advertises (`GET /scripting/completions`), and its snippet entries carry the
 * two things a list needs that a completion popup does not: which script kind
 * the template belongs in, and the heading to file it under. This module is the
 * whole of the renderer's opinion about them - a pure read over the payload, so
 * a panel test drives it without a Monaco instance and without the network.
 *
 * An unknown group is listed rather than dropped. The engine test pins the six
 * below, so a seventh means the engine gained one and this renderer has not been
 * rebuilt yet: showing it under its own heading loses nothing, where dropping it
 * would hide a template the engine deliberately shipped.
 */

import type { ScriptCompletion, ScriptSnippetContext } from "@/types/domain";

/**
 * `monaco.languages.CompletionItemKind.Snippet`. The engine writes the numeric
 * value into the table (`KIND_SNIPPET` in `scripting.cpp`) and the constant is
 * not exported from `monaco-editor` as a value we can import here without
 * pulling the editor into a node-environment test.
 */
export const SCRIPT_SNIPPET_KIND = 28;

/** The headings, in the order a script author meets them. */
export const SCRIPT_SNIPPET_GROUPS = [
	"Variables",
	"Request",
	"Response",
	"Tests",
	"Signing",
	"Logging",
] as const;

export interface ScriptSnippetGroup {
	/** The heading, as the engine spelled it. */
	group: string;
	snippets: ScriptCompletion[];
}

/**
 * Where a template with no heading of its own is filed. A `"both"` template is
 * a variable or logging helper, never a request or a test, so it takes the
 * heading the engine gives the one it ships today.
 */
const FALLBACK_GROUP: Record<ScriptSnippetContext, string> = {
	pre: "Request",
	test: "Tests",
	both: "Variables",
};

function isSnippetFor(entry: ScriptCompletion, context: ScriptSnippetContext) {
	if (entry.kind !== SCRIPT_SNIPPET_KIND) return false;
	if (!entry.insertText) return false;
	// A `"both"` template is offered everywhere, so asking for `"both"` returns
	// exactly those and never a pre-request-only or test-only one.
	return entry.context === context || entry.context === "both";
}

function groupRank(group: string) {
	const known = SCRIPT_SNIPPET_GROUPS.indexOf(group as (typeof SCRIPT_SNIPPET_GROUPS)[number]);
	return known === -1 ? SCRIPT_SNIPPET_GROUPS.length : known;
}

/**
 * The templates for one script kind, grouped and ordered. `"both"` is the
 * set for a script that runs outside any request.
 *
 * Entries keep the table's own order inside a group, which is the order
 * `sortText` already gives the completion popup - so a snippet sits in the same
 * place in both surfaces.
 */
export function snippetsForContext(
	completions: ScriptCompletion[] | undefined,
	context: ScriptSnippetContext
): ScriptSnippetGroup[] {
	const groups: ScriptSnippetGroup[] = [];
	for (const entry of completions ?? []) {
		if (!isSnippetFor(entry, context)) continue;
		// An entry with no group is still a template someone can insert; file it
		// under the heading its context makes true rather than refusing it.
		const group = entry.group || FALLBACK_GROUP[context];
		const existing = groups.find((candidate) => candidate.group === group);
		if (existing) {
			existing.snippets.push(entry);
			continue;
		}
		groups.push({ group, snippets: [entry] });
	}
	return groups.sort((a, b) => groupRank(a.group) - groupRank(b.group));
}

/** How many templates a context has, for the header's count. */
export function countSnippets(groups: ScriptSnippetGroup[]) {
	return groups.reduce((total, group) => total + group.snippets.length, 0);
}
