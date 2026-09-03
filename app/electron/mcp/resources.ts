/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file resources.ts
 * @brief MCP resources - read-only Vayu data an agent can read and attach as
 *        context. Static resources expose the current lists (runs, collections,
 *        environments, engine config); a templated resource
 *        `vayu://run/{runId}/report` exposes any run's full report, with a list
 *        callback (enumerate recent runs) and a completion callback (autocomplete
 *        run IDs). `vayu://scripting/completions` re-serves the engine's own
 *        script-sandbox surface so an agent discovers it the way the editor does,
 *        instead of from a prose copy that drifts (issue #233), and
 *        `vayu://scripting/types` serves that same surface's TypeScript
 *        declarations - the signatures the names alone do not carry.
 *        All read-only; no allowlist/caps apply. See docs/engine/mcp.md.
 */

import type { ToolContext } from "./tools.js";
import {
	VARIABLE_PRECEDENCE_SENTENCE,
	VARIABLE_RESOLUTION_MODEL,
	VARIABLE_RESOLUTION_URI,
} from "./variable-origins.js";

export interface StaticResourceDef {
	name: string;
	uri: string;
	title: string;
	description: string;
	read: (ctx: ToolContext, signal?: AbortSignal) => Promise<unknown>;
}

/** Current-state resources - attach "what's in Vayu right now" as context. */
export const STATIC_RESOURCES: StaticResourceDef[] = [
	{
		name: "runs",
		uri: "vayu://runs",
		title: "Runs",
		// Says "100" because that is what the reader asks for
		// (`EngineClient.listRuns`'s default page). The content's
		// `pagination.total` / `hasMore` carry the real count, but an agent reads
		// the description first: a workspace with more than 100 runs must not have
		// last week's baseline presented as absent. A resource takes no arguments,
		// so the filters and paging `list_runs` accepts are named here as the way
		// to reach a run this page does not carry.
		description:
			"The most recent 100 runs (single requests and load tests), newest first. " +
			"Read `pagination.total` / `pagination.hasMore` in the content for the full count, " +
			"and use the `list_runs` tool to filter (by request, collection, type, status, text) " +
			"or page beyond this first block.",
		read: (ctx, signal) => ctx.client.listRuns({}, signal),
	},
	{
		name: "collections",
		uri: "vayu://collections",
		title: "Collections",
		// The same correction the environments row needed: each collection
		// carries variables, and a request resolves against its whole ancestor
		// chain rather than the one collection it sits in.
		description:
			"All request collections, each with its own `variables`. A request resolves against the whole chain from the root down, and a nested collection outranks its ancestors. " +
			VARIABLE_PRECEDENCE_SENTENCE +
			` Full model: ${VARIABLE_RESOLUTION_URI}.`,
		read: (ctx, signal) => ctx.client.listCollections(signal),
	},
	{
		name: "environments",
		uri: "vayu://environments",
		title: "Environments",
		// Which one is active matters more than the list does: it is the tier
		// that shadows every collection and global, and `isActive` on a row is
		// the only thing that says which. An agent that reads this as an
		// unordered set of "named variable sets" writes to the wrong one.
		description:
			"All environments (named variable sets). The row with `isActive: true` is the one requests resolve against when a call names no environmentId, and it outranks the collection chain and globals. " +
			VARIABLE_PRECEDENCE_SENTENCE +
			` Full model: ${VARIABLE_RESOLUTION_URI}.`,
		read: (ctx, signal) => ctx.client.listEnvironments(signal),
	},
	{
		name: "variable-resolution",
		uri: VARIABLE_RESOLUTION_URI,
		title: "Variable resolution model",
		// The one resource here that describes rules rather than current state.
		// It exists because the rules were discoverable only by reading two tool
		// descriptions that happened to mention them, and never at the tools
		// that change a value (issue #1207).
		description:
			"How {{variables}} resolve: the tier order, what a disabled or non-string definition does, the reserved namespaces (data.*, $vu/$iteration, the dynamic generators), and what a script's scoped and merged reads see. Read this before writing a variable - the tier you write to may be shadowed by one above it.",
		read: async () => VARIABLE_RESOLUTION_MODEL,
	},
	{
		name: "engine-config",
		uri: "vayu://config",
		title: "Engine configuration",
		description:
			"The engine's tunable configuration entries with values, defaults, and ranges.",
		read: (ctx, signal) => ctx.client.getConfig(signal),
	},
	{
		name: "scripting",
		uri: "vayu://scripting/completions",
		title: "Script sandbox API",
		// Names no name: the enumeration this used to carry had already gone
		// stale (it predated pm.info, pm.sendRequest and pm.test), which is the
		// drift the resource exists to end - the body is the engine's own list,
		// so the description must point at it rather than restate it.
		description:
			"The engine's authoritative list of every pm.* name and global the pre-request / test " +
			"script sandbox provides, with signatures and documentation. Read this before writing " +
			"a preRequestScript or postRequestScript - it is generated by the engine, so it is " +
			"current for the running version.",
		read: async (ctx, signal) =>
			projectScriptingSurface(await ctx.client.getScriptCompletions(signal)),
	},
	{
		name: "scripting-types",
		uri: "vayu://scripting/types",
		title: "Script sandbox type declarations",
		// Beside the completion list rather than instead of it: the completions
		// answer "what is there", these answer "what does it take and what does
		// it return". An agent writing `pm.expect(...)` chains or reading
		// `pm.response.to.have` needs the signature, and the alternative to
		// serving the engine's own `.d.ts` is prose that drifts - the drift
		// issue #233 recorded for the completion list.
		description:
			"The engine's TypeScript declarations (.d.ts) for the pre-request / test script " +
			"sandbox - the same text the app's editor feeds to its TypeScript worker, so every " +
			"pm.* signature, parameter and return type is the running engine's. Read this " +
			"beside vayu://scripting/completions when you need the shape of a call rather " +
			"than its name.",
		read: async (ctx, signal) =>
			projectScriptingTypes(await ctx.client.getScriptTypeDefinitions(signal)),
	},
];

/** One sandbox name as an agent sees it - the engine's own keys, minus Monaco's. */
export interface ScriptingApiEntry {
	label: string;
	detail?: string;
	documentation?: string;
}

export interface ScriptingSurface {
	version?: unknown;
	engine?: unknown;
	completions: ScriptingApiEntry[];
}

/**
 * Reduce `GET /scripting/completions` to the three fields that mean something
 * outside an editor. `insertText`, `insertTextRules`, `sortText`, `filterText`
 * and `kind` are Monaco's - snippet placeholders (`${1:secret}`) and a
 * `CompletionItemKind` enum an agent has no use for.
 *
 * Every entry survives, snippets included: dropping them would mean testing
 * `kind === 28`, which is exactly the copied-constant drift this resource exists
 * to avoid, and a snippet's label plus documentation still names a capability.
 *
 * Throws rather than returning a partial surface - an agent that reads a
 * silently-truncated API list concludes the sandbox cannot do what it can.
 */
export function projectScriptingSurface(payload: unknown): ScriptingSurface {
	const root =
		payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
	if (!root || !Array.isArray(root.completions)) {
		throw new Error(
			"GET /scripting/completions returned no `completions` array - cannot describe the script sandbox"
		);
	}
	const completions: ScriptingApiEntry[] = [];
	for (const item of root.completions) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.label !== "string" || !rec.label) continue;
		completions.push({
			label: rec.label,
			...(typeof rec.detail === "string" ? { detail: rec.detail } : {}),
			...(typeof rec.documentation === "string" ? { documentation: rec.documentation } : {}),
		});
	}
	return { version: root.version, engine: root.engine, completions };
}

/** The sandbox's type declarations as an agent sees them. */
export interface ScriptingTypes {
	version?: unknown;
	engine?: unknown;
	/** Monaco's library URI for the declarations - kept so the two halves of the
	 *  surface are recognisably the same document the editor loads. */
	libUri?: unknown;
	typeDefinitions: string;
}

/**
 * Reduce `GET /scripting/types` to the declarations and the version stamps
 * around them.
 *
 * Throws on anything but a non-empty `typeDefinitions` string, for the reason
 * {@link projectScriptingSurface} throws: half a type surface is worse than
 * none, because an agent reads a missing declaration as "the sandbox has no
 * such call" and writes around a capability that is there. An empty string is
 * one of those failures rather than an empty sandbox - the engine generates
 * these from the same table the completions come from, so it never legitimately
 * produces nothing.
 */
export function projectScriptingTypes(payload: unknown): ScriptingTypes {
	const root =
		payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
	const declarations =
		root && typeof root.typeDefinitions === "string" ? root.typeDefinitions : "";
	if (!declarations) {
		throw new Error(
			"GET /scripting/types returned no `typeDefinitions` text - cannot describe the script sandbox"
		);
	}
	return {
		version: root!.version,
		engine: root!.engine,
		libUri: root!.libUri,
		typeDefinitions: declarations,
	};
}

/** Templated per-run report resource. */
export const RUN_REPORT_RESOURCE = {
	name: "run-report",
	uriTemplate: "vayu://run/{runId}/report",
	title: "Run report",
	description:
		"Full report for a run: latency percentiles, throughput, error rate, and status-code mix. Attach as context for analysis.",
	read: (ctx: ToolContext, runId: string, signal?: AbortSignal) =>
		ctx.client.getRunReport(runId, signal),
	listRuns: (ctx: ToolContext, signal?: AbortSignal) => ctx.client.listRuns({}, signal),
};

/**
 * Best-effort extraction of run IDs from the loosely-typed `/runs` payload.
 * Accepts both the paginated `{data: [...]}` envelope (current) and a bare
 * array (the legacy no-param shape), so it survives either.
 */
export function extractRunIds(runs: unknown): string[] {
	const rows = Array.isArray(runs)
		? runs
		: runs && typeof runs === "object" && Array.isArray((runs as { data?: unknown }).data)
			? (runs as { data: unknown[] }).data
			: null;
	if (!rows) return [];
	const ids: string[] = [];
	for (const r of rows) {
		if (r && typeof r === "object") {
			const rec = r as Record<string, unknown>;
			const id = rec.id ?? rec.runId ?? rec._id;
			if (typeof id === "string" && id) ids.push(id);
			else if (typeof id === "number") ids.push(String(id));
		}
	}
	return ids;
}
