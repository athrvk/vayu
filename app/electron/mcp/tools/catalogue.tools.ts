/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief `list_element_kinds` and `get_script_api`: the element registry and the script sandbox's
 *        API by tool, for a client that cannot read the `vayu://elements/kinds` and
 *        `vayu://scripting/completions` resources (#3559). Both read through the resources' own
 *        projections, so the surfaces cannot disagree.
 */

import { z } from "zod";
import {
	projectElementKinds,
	projectScriptingSurface,
	type ElementKindEntry,
	type ScriptingSurface,
} from "../resources.js";
import type { McpTool } from "./contract.js";
import {
	callEngineStructured,
	engineErrorResult,
	str,
	structuredResult,
	ToolArgError,
} from "./kit.js";
import { elementKindsSchema, scriptApiSchema } from "./output-schemas.js";

/**
 * What a `list_element_kinds` summary row keeps. The whole catalogue is about
 * 21 KB, most of it `configSchema`, so the list is the index and one kind's
 * entry is the second call.
 */
const ELEMENT_KIND_SUMMARY_KEYS = ["kind", "category", "phases", "label"] as const;

function elementKindSummary(entry: ElementKindEntry): Record<string, unknown> {
	return Object.fromEntries(
		ELEMENT_KIND_SUMMARY_KEYS.filter((key) => key in entry).map((key) => [key, entry[key]])
	);
}

/**
 * `get_script_api`'s `q`. A blank one is refused rather than read as absent or
 * as matching everything: the second would hand back every entry's
 * documentation, about 100 KB, which is what the unfiltered answer leaves out.
 */
function scriptApiQuery(args: Record<string, unknown>): string | undefined {
	const q = str(args, "q");
	if (q === undefined) return undefined;
	if (q.trim() === "") {
		throw new ToolArgError('"q" must not be blank; omit it to list every name.');
	}
	return q.trim().toLowerCase();
}

/**
 * The sandbox surface as `get_script_api` answers it: every name with its
 * signature, or with @p needle only the entries that mention it, documentation
 * included.
 */
function scriptApiAnswer(surface: ScriptingSurface, needle: string | undefined) {
	if (needle === undefined) {
		const completions = surface.completions.map(({ label, detail }) =>
			detail === undefined ? { label } : { label, detail }
		);
		return { ...surface, completions };
	}
	const completions = surface.completions.filter((entry) =>
		[entry.label, entry.detail, entry.documentation].some((text) =>
			text?.toLowerCase().includes(needle)
		)
	);
	return { ...surface, completions };
}

export const CATALOGUE_TOOLS: McpTool[] = [
	{
		name: "list_element_kinds",
		category: "read",
		invalidates: [],
		description:
			"List the element kinds a request's or collection's `elements` list can hold (extractors, assertions, timers, controllers, scripts), as the running engine registers them. " +
			"Without `kind`, returns `kinds`: one summary row per kind (kind, category, phases, label). " +
			"With `kind`, returns that kind's whole entry, including `configSchema`, the JSON Schema its `config` is checked against: a key the schema does not declare is refused, and a property with a `default` runs with that value when left out. `collectionOnly: true` marks a kind only a collection's list may hold. " +
			"An unknown `kind` is an input error that names every registered kind.",
		annotations: {
			title: "List element kinds",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			kind: z
				.string()
				.optional()
				.describe(
					'One kind, e.g. "assert.status", for its config schema; omit for every kind.'
				),
		},
		outputSchema: elementKindsSchema,
		handler: async (args, ctx, signal) => {
			const wanted = str(args, "kind");
			let catalogue: ElementKindEntry[];
			try {
				catalogue = projectElementKinds(await ctx.client.getElementKinds(signal));
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			if (wanted === undefined) {
				return structuredResult({ kinds: catalogue.map(elementKindSummary) });
			}
			const entry = catalogue.find((candidate) => candidate.kind === wanted);
			if (!entry) {
				throw new ToolArgError(
					`Unknown element kind "${wanted}". The registered kinds are: ${catalogue.map((k) => k.kind).join(", ")}.`
				);
			}
			return structuredResult(entry);
		},
	},
	{
		name: "get_script_api",
		category: "read",
		invalidates: [],
		description:
			"Read the script sandbox's API: every pm.* name and global a pre-request or test script can use (a `script.pre` / `script.post` element, or a preRequestScript / postRequestScript argument), as the running engine provides it. Read it before writing a script rather than assuming what exists. " +
			"Without `q`, returns each entry's `label` and `detail` (its signature). With `q`, returns only the entries whose label, detail or documentation contains it (case-insensitive), each with its `documentation`.",
		annotations: {
			title: "Get the script API",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			q: z
				.string()
				.optional()
				.describe('Text to match, e.g. "crypto" or "pm.expect"; omit for every name.'),
		},
		outputSchema: scriptApiSchema,
		handler: (args, ctx, signal) => {
			const needle = scriptApiQuery(args);
			return callEngineStructured(
				ctx,
				() => ctx.client.getScriptCompletions(signal),
				(payload) => scriptApiAnswer(projectScriptingSurface(payload), needle)
			);
		},
	},
];
