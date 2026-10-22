/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tools.ts
 * @brief The MCP tool registry. Each tool maps to engine capabilities, applies
 *        the safety guards (allowlist / caps / confirmation), and returns a
 *        result. Schemas are Zod (the SDK validates arguments and generates the
 *        JSON Schema for `tools/list`); tools carry MCP annotations (readOnly /
 *        destructive hints + a display title); every read tool declares an
 *        output schema for structured results, bar the bare-array reads
 *        (`output-schema.conformance.test.ts`). Transport-agnostic - the same
 *        registry backs both the Streamable HTTP server (Electron) and the
 *        stdio CLI.
 *
 * The definitions live under `tools/` (#1918), one `<domain>.tools.ts` per
 * contiguous run of the registry, and `TOOLS` concatenates them in registry
 * order: that order is what `tools/list` and the Settings catalog show, so a
 * new tool goes into the file whose run it extends, or a new file spliced in
 * at its place. `tools/contract.ts` holds the types, `kit.ts` the result,
 * argument and gate helpers, and one file per topic the rest. Imports run one
 * way - nothing under `tools/` imports this file - and `./tools.js` stays
 * the registry's public surface, so what callers import from it is
 * re-exported here.
 */

import { resolveRemedyTokens, settingRemedy } from "./remedy.js";
import { MaskingIncompleteError } from "./withhold.js";
import { DEFAULT_MCP_SAFETY_CONFIG } from "./config.js";
import {
	resolveDescription,
	type McpHost,
	type McpTool,
	type McpToolInfo,
	type ToolContext,
	type ToolResult,
} from "./tools/contract.js";
import {
	errorResult,
	NOTHING_CHANGED,
	STARTED_RUNS,
	str,
	ToolArgError,
	writesDisabled,
} from "./tools/kit.js";
import { READ_TOOLS } from "./tools/reads.tools.js";
import { GRAPHQL_SCHEMA_TOOLS } from "./tools/graphql-schema.tools.js";
import { RUN_REQUEST_TOOLS } from "./tools/run-request.tools.js";
import { ENGINE_CONFIG_TOOLS } from "./tools/engine-config.tools.js";
import { COLLECTION_TOOLS } from "./tools/collections.tools.js";
import { SPEC_TOOLS } from "./tools/spec.tools.js";
import { REQUEST_TOOLS } from "./tools/requests.tools.js";
import { TRASH_TOOLS } from "./tools/trash.tools.js";
import { EXAMPLE_TOOLS } from "./tools/examples.tools.js";
import { MOVE_TOOLS } from "./tools/move.tools.js";
import { ENVIRONMENT_TOOLS } from "./tools/environments.tools.js";
import { VARIABLE_TOOLS } from "./tools/variables.tools.js";
import { COOKIE_TOOLS } from "./tools/cookies.tools.js";
import { COLLECTION_RUN_TOOLS } from "./tools/collection-runs.tools.js";
import { LOAD_TOOLS } from "./tools/load.tools.js";
import { RUN_TOOLS } from "./tools/runs.tools.js";
import { CONNECTION_TOOLS } from "./tools/connection.tools.js";
import { OAUTH2_TOOLS } from "./tools/oauth2.tools.js";
import { MOCK_ISSUER_TOOLS } from "./tools/mock-issuer.tools.js";
import { MOCK_SERVER_TOOLS } from "./tools/mock-server.tools.js";
import { WEBHOOK_INBOX_TOOLS } from "./tools/webhook-inbox.tools.js";

export type {
	McpDataEntity,
	McpDataChangedEvent,
	StartedRun,
	ToolContext,
	UserInput,
	ToolResult,
	ToolCategory,
	McpTool,
	McpToolInfo,
} from "./tools/contract.js";
export { MCP_DATA_ENTITIES, resolveDescription } from "./tools/contract.js";
export { MAX_INLINE_BODY_BYTES, MAX_REPORT_TRACE_BYTES } from "./tools/inline-body-bounds.js";
export {
	DEFAULT_RUN_SAMPLE_LIMIT,
	DEFAULT_RUN_SERIES_LIMIT,
	MAX_RUN_SERIES_LIMIT,
	resolveBaseline,
	runTypeRefusal,
} from "./tools/run-housekeeping.js";
export { INLINE_FILE_REFUSAL } from "./tools/request-body.js";
export {
	MAX_IN_FLIGHT_BOUND,
	MAX_RESPONSE_SAMPLE_PERIOD,
	MAX_RESPONSE_SAMPLES_BOUND,
	MAX_SUCCESS_SAMPLE_PERIOD,
	MAX_SLOW_THRESHOLD_MS,
	MAX_REDIRECTS_BOUND,
} from "./tools/compose.js";
export {
	ENGINE_DEFAULT_HEADERS_SENTENCE,
	INSECURE_TLS_REFUSAL,
	elementSchema,
	REQUEST_SETTINGS_KEYS,
} from "./tools/input-schemas.js";
export { projectOAuth2Token, projectOAuth2Status } from "./tools/oauth2.js";
export { DEFAULT_INBOX_CAPTURE_LIMIT, MAX_INBOX_CAPTURE_LIMIT } from "./tools/webhook-inbox.js";
export { MAX_EXAMPLES_BODY_BYTES } from "./tools/examples.js";
export { MAX_INTROSPECTION_BYTES, MAX_SCHEMA_SDL_BYTES } from "./tools/graphql-schema.js";
export { MAX_SPEC_DIFF_ENTRIES } from "./tools/spec-bindings.js";

/**
 * Whether a session under @p config lists @p tool. One predicate for the two
 * readers that must agree: registration (`server.ts`) and the check that tells
 * clients the list changed when Settings do (`index.ts`, via
 * {@link toolListSignature}).
 *
 * A write tool that cannot succeed does not ship its schema (#1429): writes are
 * off by default, and on a default install those tools were 66,077 of the
 * 181,447 bytes (36%) of a `tools/list` an agent could do nothing with. The
 * handler check stays (`writesDisabled`), so a client holding a list from a
 * session where writes were on still gets the actionable error.
 */
export function isListed(tool: McpTool, config: ToolContext["config"]): boolean {
	if (config.disabledTools.includes(tool.name)) return false;
	return tool.category !== "write" || config.allowWrites;
}

/**
 * What a session under @p config lists, as one comparable string: each listed
 * tool's name and description, in registry order. Descriptions are in it
 * because some are built from the config (#2441), so a change can leave every
 * name in place and still alter what `tools/list` answers.
 */
export function toolListSignature(config: ToolContext["config"]): string {
	return TOOLS.filter((tool) => isListed(tool, config))
		.map((tool) => `${tool.name}\n${resolveDescription(tool, config)}`)
		.join("\n\n");
}

/**
 * The answer for a write tool the toggle withheld from registration, or null
 * when @p name is not one - a read/execute/load tool, a name no registry entry
 * carries, or a write tool in a session where writes are on.
 *
 * The same refusal the handlers return, because it is the same fact: the tool
 * exists, the user has not enabled writes, and enabling them is what unblocks
 * it. Without this the SDK answers an unregistered name with "Tool <name> not
 * found", which tells an agent nothing it can act on (issue #1431).
 *
 * A tool the *user* switched off is deliberately not covered: it is unregistered
 * for a different reason, and answering it here would tell a user who then
 * enabled writes to expect a tool that is still off.
 */
export function withheldWriteRefusal(name: string, ctx: ToolContext): ToolResult | null {
	if (ctx.config.allowWrites) return null;
	if (ctx.config.disabledTools.includes(name)) return null;
	const tool = findTool(name);
	if (!tool || tool.category !== "write") return null;
	return writesDisabled(ctx);
}

// --- Tool definitions --------------------------------------------------------

export const TOOLS: McpTool[] = [
	...READ_TOOLS,
	...GRAPHQL_SCHEMA_TOOLS,
	...RUN_REQUEST_TOOLS,
	...ENGINE_CONFIG_TOOLS,
	...COLLECTION_TOOLS,
	...SPEC_TOOLS,
	...REQUEST_TOOLS,
	...TRASH_TOOLS,
	...EXAMPLE_TOOLS,
	...MOVE_TOOLS,
	...ENVIRONMENT_TOOLS,
	...VARIABLE_TOOLS,
	...COOKIE_TOOLS,
	...COLLECTION_RUN_TOOLS,
	...LOAD_TOOLS,
	...RUN_TOOLS,
	...CONNECTION_TOOLS,
	...OAUTH2_TOOLS,
	...MOCK_ISSUER_TOOLS,
	...MOCK_SERVER_TOOLS,
	...WEBHOOK_INBOX_TOOLS,
];

/** Look up a tool by name. Only `dispatchTool` needs this, so it stays local. */
function findTool(name: string): McpTool | undefined {
	return TOOLS.find((t) => t.name === name);
}

/** IPC-safe metadata for every tool, for the Settings tool list. */
export function toolCatalog(): McpToolInfo[] {
	return TOOLS.map((t) => ({
		name: t.name,
		// Settings is an app screen, so the catalog is always the app's wording.
		// It answers outside any session, so a description built from the config
		// reads as it would under the defaults (reveal off).
		description: resolveRemedyTokens(resolveDescription(t, DEFAULT_MCP_SAFETY_CONFIG), "app"),
		category: t.category,
	}));
}

/**
 * A refusal shared by several tools (`INLINE_FILE_REFUSAL`, `INSECURE_TLS_REFUSAL`)
 * names its remedy with a token, since the constant is built before any host is
 * known. Only an error's text is resolved: a success carries workspace data,
 * which is never rewritten.
 */
function withRemedyResolved(result: ToolResult, host: McpHost): ToolResult {
	if (!result.isError) return result;
	return {
		...result,
		content: result.content.map((part) =>
			part.type === "text" ? { ...part, text: resolveRemedyTokens(part.text, host) } : part
		),
	};
}

/**
 * Dispatch a `tools/call`. Converts argument errors into tool errors so the
 * agent gets a readable message instead of a protocol failure.
 *
 * The single dispatch path: `server.ts` routes every registered tool callback
 * through here, so the disabled-tool rejection below is the same code the tests
 * exercise. (The SDK validates arguments against the Zod `inputSchema` first,
 * and registration already skips disabled tools - this rejection is what
 * answers a client that calls one anyway.)
 */
export async function dispatchTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<ToolResult> {
	const tool = findTool(name);
	if (!tool) return errorResult(`Unknown tool: ${name}`);
	// Tools the user switched off in Settings are rejected (and are also omitted
	// from tools/list, so a well-behaved client won't call them).
	if (ctx.config.disabledTools.includes(name)) {
		return errorResult(
			`Tool "${name}" is disabled. To use it, ask the user to ${settingRemedy("disabledTools", ctx.host)}.`
		);
	}
	let result: ToolResult;
	try {
		result = withRemedyResolved(await tool.handler(args, ctx, signal), ctx.host);
	} catch (err) {
		if (err instanceof ToolArgError || err instanceof MaskingIncompleteError) {
			return withRemedyResolved(errorResult(err.message), ctx.host);
		}
		return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	}
	// One record per served call, whichever transport served it (#1558) - the
	// one place both the Electron-hosted host and the stdio CLI route through.
	ctx.log?.debug("mcp", "Served tool call", { tool: name });
	// Only a call that succeeded changed anything. A tool that returned an error
	// result may still have got as far as the engine, but it cannot say so, and
	// an invalidation storm on every rejected call would be worse than the one
	// stale list a genuinely-partial failure leaves behind. A confirmation
	// preview is the third case: successful, and deliberately without effect.
	if (!result.isError && !NOTHING_CHANGED.has(result)) notifyDataChanged(tool, args, ctx, result);
	return result;
}

/**
 * Tell the renderer what a successful call changed, one event per declared
 * entity. The scope hints come from the call's own arguments: every tool in the
 * registry spells these two the same way, so reading them here is what keeps a
 * new write tool from having to remember an emit of its own.
 *
 * Notification failure must not fail a write the engine has already applied -
 * the same rule `update_engine_config`'s best-effort read-back follows - so a
 * throwing listener is logged and swallowed rather than turned into a tool
 * error the agent would read as "the write did not happen".
 */
function notifyDataChanged(
	tool: McpTool,
	args: Record<string, unknown>,
	ctx: ToolContext,
	result: ToolResult
): void {
	if (!ctx.onDataChanged || tool.invalidates.length === 0) return;
	const collectionId = str(args, "collectionId");
	const requestId = str(args, "requestId");
	const runId = str(args, "runId");
	const inboxId = str(args, "inboxId");
	const mockId = str(args, "mockId");
	// Rides the `run` event alone: that a run started is a fact about the run
	// family, and `run_collection`'s other entity is the cookie jar, which has no
	// use for it.
	const startedRun = STARTED_RUNS.get(result);
	for (const entity of tool.invalidates) {
		try {
			ctx.onDataChanged({
				entity,
				...(collectionId !== undefined ? { collectionId } : {}),
				...(requestId !== undefined ? { requestId } : {}),
				...(runId !== undefined ? { runId } : {}),
				...(inboxId !== undefined ? { inboxId } : {}),
				...(mockId !== undefined ? { mockId } : {}),
				...(entity === "run" && startedRun !== undefined ? { startedRun } : {}),
			});
		} catch (err) {
			ctx.log?.warn("mcp", `Failed to notify "${entity}" change`, {
				tool: tool.name,
				error: String(err),
			});
		}
	}
}
