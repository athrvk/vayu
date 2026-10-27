/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file contract.ts
 * @brief What a tool is, what it is handed and what it answers: the registry's
 *        types, the elicitation seam and the data families a call can change.
 */

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { EngineClient } from "../engine-client.js";
import type { McpSafetyConfig } from "../config.js";
import type { Logger } from "../../log.js";
import type { AppFocus } from "../../app-focus.js";
import type { DataFileLocation } from "../../data-file-locations.js";

// --- Asking the person ------------------------------------------------------

/**
 * A call's line to the person, present only when the client can put a question
 * to them on this call (it declared elicitation, and the transport can carry
 * the round trip - the stateless legacy HTTP leg cannot).
 */
export interface UserInput {
	/**
	 * What the client answered to the previous round's questions, keyed as
	 * asked. Absent on a call's first round. From the client, so untrusted.
	 */
	responses?: Record<string, unknown>;
}

// --- Data-change notification ------------------------------------------------

/**
 * The data families an MCP call can change, named as the renderer's query cache
 * groups them. An MCP call mutates the engine from the main process, so the
 * renderer learns about it only if it is told: `refetchOnWindowFocus` is off
 * app-wide, and nothing else crosses the process boundary.
 *
 * Mirrored as `McpDataEntity` in `app/src/types/domain.ts`, because production
 * code under `electron/` cannot import from `app/src` (see the rationale in
 * `tsconfig.node.json`). `data-changed.conformance.test.ts` keeps the two
 * copies honest, and the renderer's mapping is exhaustive over this union, so
 * a new entity fails to compile until it has a reader.
 */
export const MCP_DATA_ENTITIES = [
	// A write that can reach any collection's requests or the trash: a cascade
	// delete, a move, an import, a spec bind or sync, a trash restore or purge.
	"collection",
	// A write to one collection row and nothing under it (#2546): create, update,
	// unbind. Its own family so an agent looping over collections refetches the
	// collections and not every request list in the workspace once per call.
	"collectionRow",
	"request",
	"environment",
	"run",
	"cookie",
	"config",
	// The local services the engine hosts for as long as its process lives -
	// webhook inboxes today, mock servers and issuers as #757 reaches them. One
	// family rather than one per service: the renderer reads them through the
	// Services drawer and the Dock's running-services count, which ask "what is
	// listening" and not "which kind".
	"service",
	// The engine's OAuth 2.0 token cache (issue #760). Its own family rather
	// than a fold into `config`: it has one reader of its own
	// (`queryKeys.oauth`), and the auth tab's token-status row polls at 30s -
	// long enough for an agent to clear a token, say so, and leave the window
	// showing the entry it just destroyed.
	"oauth",
	// The client-certificate registry (#2973). No tool writes it directly (the
	// user adds and removes entries), but a trash restore puts one back, so it
	// has a reader to refresh: the Settings card. Its own family rather than a
	// fold into `config`, whose invalidator would also refetch every config and
	// request-default read for a registry those do not serve, or into
	// `environment`, whose readers a certificate does not touch.
	"clientCertificate",
	// Variables a script or extractor wrote back while a send ran (#1916), with
	// no `update_*` call behind them. Its own family rather than `environment`/`collection` because
	// the run tools that cause it cannot name which scope changed, and borrowing
	// `collection` would drop every request and trash cache for a variable write.
	"variables",
] as const;

export type McpDataEntity = (typeof MCP_DATA_ENTITIES)[number];

/**
 * One thing changed. Invalidation only - no data rides across, the renderer
 * refetches through its normal query layer.
 *
 * The five scope hints are read from the call's own arguments and narrow the
 * invalidation to the caches that can have gone stale; each is absent when the
 * call did not name it. They are hints, not identity: `requestId` on a
 * `run` event is the saved request a design run was linked to, not the run's
 * own id - `runId` is that. The renderer narrows on `collectionId` (the
 * `request` family's list key), on `runId` (the per-run caches it removes), on
 * `inboxId` (the capture list it removes) and on `mockId` (the route table it
 * removes); a run event's `requestId` is
 * emitted because every hint is read off the same
 * arguments, and the run families it could narrow are invalidated at their
 * prefixes instead - a `delete_run` names no request, so a per-request key
 * could not reach the caches a delete moves (see `lib/mcp-invalidation.ts`).
 */
export interface McpDataChangedEvent {
	entity: McpDataEntity;
	/** The collection the call named, when it named one. */
	collectionId?: string;
	/** The saved request the call named, when it named one. */
	requestId?: string;
	/**
	 * The history run the call named, when it named one. Only the tools that
	 * rewrite or remove an *existing* run spell this (`stop_run`,
	 * `set_run_baseline`, `delete_run`); a runner names the request or
	 * collection it ran, and the run it created has no per-run cache yet.
	 */
	runId?: string;
	/**
	 * The webhook inbox the call named, when it named one. Only the tools that
	 * act on an *existing* inbox spell it (`stop_webhook_inbox`,
	 * `delete_webhook_inbox`, `clear_inbox_captures`, `update_inbox_response`);
	 * `start_webhook_inbox` has no id to name until the engine has answered.
	 *
	 * The renderer needs it because a capture list is not merely stale after a
	 * clear or a delete - it is *wrong*, and its cache entry has to be dropped
	 * rather than refetched into (see `lib/mcp-invalidation.ts`).
	 */
	inboxId?: string;
	/**
	 * The collection mock server the call named, when it named one. Among the
	 * tools that emit at all that is only `stop_mock_server`;
	 * `start_mock_server` has no id to name until the engine has answered.
	 *
	 * Read for the same reason `inboxId` is - a cache that has to be *dropped*
	 * rather than refetched - though the reason it cannot be refetched is the
	 * mirror one: a stopped mock's record dies with its listener, so refetching
	 * its route table would 404 and leave an error state describing a table that
	 * no longer exists. `useStopMockServerMutation` already drops it app-side.
	 */
	mockId?: string;
	/**
	 * The run this call just started, and which run service watches it (#1419).
	 *
	 * The one field on this event that is not a scope hint: it says the run is
	 * *live*, which is what lets the renderer attach its stream to a run no
	 * surface of its own started - and with it the OS progress indicator (#1362),
	 * the keep-awake hold (#1357) and the finished notification (#1358), all of
	 * which live inside the run services and used to begin only once a dashboard
	 * was opened.
	 *
	 * Present on the `run` event of the two tools that create a run
	 * (`start_load_run`, `run_collection`) and on no other: `run_collection_smoke`
	 * sends its requests one at a time and has no run to watch, and the tools that
	 * stop, re-baseline or delete a run are naming one that already exists. Read
	 * from the engine's answer rather than from the call's arguments, because a
	 * run has no id until the engine has given it one - which is also why it
	 * cannot be spelled the way the hints above are.
	 */
	startedRun?: StartedRun;
}

/**
 * A run an agent's call put in flight, named for the renderer that watches it.
 *
 * `kind` is which service owns the stream rather than what the user would call
 * the run: a load run and a collection run publish different frames, so
 * attaching the wrong service is a permanently empty view and not a degraded
 * one - the fork `RunCollectionDialog` already records for the app's own runs.
 */
export interface StartedRun {
	runId: string;
	kind: "load" | "collection";
}

/**
 * Which process serves the session: the Electron app, which has Settings screens
 * and a window, or the stdio CLI, which has only environment variables. Every
 * sentence that sends the user somewhere to lift a refusal reads it (`remedy.ts`).
 */
export type McpHost = "app" | "cli";

export interface ToolContext {
	client: EngineClient;
	config: McpSafetyConfig;
	/** Required, so a new host cannot forget to say which one it is. */
	host: McpHost;
	/**
	 * Present when the person can be asked on this call; lets a tool ask them to
	 * confirm (`confirmDestructive`). Absent → the tool falls back to its
	 * agent-side gate (the `confirmed` flag).
	 */
	userInput?: UserInput;
	/**
	 * Called once per entity a successful call changed, so the renderer can
	 * invalidate the matching queries. Absent when there is nothing to notify -
	 * the stdio CLI has no window.
	 */
	onDataChanged?: (event: McpDataChangedEvent) => void;
	/**
	 * Where a served call and a notify failure are logged (#1558), `src: "mcp"`.
	 * Absent only in a test double - both real hosts (the Electron-hosted
	 * transport and the stdio CLI) always provide one.
	 */
	log?: Logger;
	/**
	 * Where a collection's declared data file lives on this machine, as the app
	 * remembers it (#1742). Absent in the stdio CLI, which runs without the app
	 * and so has no record of any path.
	 */
	dataFileLocation?: (collectionId: string) => DataFileLocation | undefined;
	/**
	 * The SHA-256 hex of a remembered data file's bytes as they are now (#2051),
	 * rejecting when the file cannot be read. Absent in the stdio CLI, like
	 * `dataFileLocation`, so a listed `dataFile.hash` falls back to the stored one.
	 */
	currentDataFileHash?: (filePath: string) => Promise<string>;
	/**
	 * Which tab and environment the app window has open (#2045). Absent in the
	 * stdio CLI, which has no window, and undefined until a window has published.
	 */
	appFocus?: () => AppFocus | undefined;
	/**
	 * The `clientInfo.name` the connected client gave in its `initialize`
	 * handshake, stamped on every run this server starts (#1817). A function
	 * because the stdio host builds its server before the handshake arrives;
	 * undefined when no handshake is known for this request.
	 */
	clientName?: () => string | undefined;
	/**
	 * Reports @p done of @p total steps finished, for a call that runs long.
	 * Absent unless the client sent a `progressToken` (#2451), so a tool calls
	 * it as `ctx.progress?.(...)`. Fire-and-forget, with `done` never going
	 * backwards. @p message reaches the client unmasked, before the result's
	 * withholding runs: carry counts and a status word, never request data.
	 */
	progress?: (done: number, total: number, message?: string) => void;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	/** Present for tools that declare an `outputSchema` (validated by the SDK). */
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/**
 * Capability class surfaced in Settings for per-tool control; each maps to a
 * gate profile: `read` (inspection, ungated), `execute` (has an effect outside
 * this process without touching saved data - allowlist when it sends to a
 * target host, none when the effect is a loopback service the engine hosts, as
 * for the mock issuer), `write` (mutates saved data/config - write toggle),
 * `load` (starts/stops load tests - allowlist + caps + confirm).
 */
export type ToolCategory = "read" | "execute" | "write" | "load";

/**
 * A tool's description, or how to build it from the session's config. A
 * function where the text explains a setting the session may have lifted:
 * `tools/list` is paid on every connect, and a rule that does not apply to the
 * session reading it is only cost (#2441).
 */
export type ToolDescription = string | ((config: McpSafetyConfig) => string);

/**
 * What an agent should do when a call to a tool timed out or was cancelled
 * before the engine answered, which is a call that may have taken effect
 * (#2777). Per tool, because what a repeat does is a fact about the tool:
 *
 * - `"safe"`: repeating the call changes nothing a second time (a read, an
 *   idempotent update or delete).
 * - `{ check, noun }`: a create or import, where a blind retry makes a second
 *   one. @p check is the list tool that shows whether the first landed and
 *   @p noun what to look for in it.
 * - `"never-blind"`: a send or a load start, which leaves a row in run history;
 *   `list_runs` shows whether the first went out.
 */
export type RetryAdvice = "safe" | "never-blind" | { check: string; noun: string };

/**
 * A kind of stored object an id argument names, as an unknown-id answer words
 * it (#2778): `No <noun> with id "..."`, then the tool that lists them.
 */
export interface IdKind {
	/** What the engine's 404 sentence calls it ("Run not found"), lower case. */
	noun: string;
	/** The `list_*` tool that shows the ids that do exist. Absent where none does. */
	list?: string;
}

/** An {@link IdKind} and the argument that carries its id. */
export interface NotFoundDeclaration extends IdKind {
	/**
	 * The argument holding the id. An array names a tool taking several of one
	 * kind (`baseRunId`, `targetRunId`): the answer then names an id only when
	 * the engine's sentence does, since nothing else says which one was missing.
	 */
	idArg: string | readonly string[];
}

export interface McpTool {
	name: string;
	description: ToolDescription;
	/**
	 * Zod raw shape for the tool's arguments (SDK validates + builds JSON Schema).
	 * Spelled out rather than written `z.ZodRawShape`, which in Zod 4 is an alias
	 * for the core `$ZodType` and drops the classic surface - `.description`, the
	 * per-field text a client renders beside the input - from every field here.
	 */
	inputSchema: Record<string, z.ZodType>;
	/** Optional Zod schema for structured results (SDK validates `structuredContent`). */
	outputSchema?: z.ZodType;
	/** MCP tool annotations (title + read-only/destructive/idempotent/open-world hints). */
	annotations: ToolAnnotations;
	/**
	 * Feature group for the Settings tool list. Also says whether the tool only
	 * reads: `category === "read"` and nothing else does. A separate `readOnly`
	 * boolean lived here restating exactly that for all 21 tools, read by no one
	 * but its own test - the client-facing hint is `annotations.readOnlyHint`.
	 */
	category: ToolCategory;
	/**
	 * The data families a successful call changes. Required rather than
	 * defaulted, and deliberately not derived from `category`: an `execute` tool
	 * writes a history row and refills the cookie jar without being a "write",
	 * and a `load` tool writes run rows. A default would let a new tool ship
	 * silently invisible to the renderer, which is the bug this field exists to
	 * close; `[]` is a statement that the tool only reads.
	 */
	invalidates: readonly McpDataEntity[];
	/**
	 * What to tell an agent when this tool's call timed out or was cancelled.
	 * Declared on every tool without `idempotentHint: true` (a tool that omits
	 * the hint is not idempotent), which `tools.test.ts` holds. A tool with
	 * `idempotentHint: true` may leave it out and is told `"safe"`; any other
	 * tool that declares none gets the generic "check run history" wording.
	 */
	retry?: RetryAdvice;
	/**
	 * The objects an id argument of this tool names, so an engine 404 reads
	 * `No run with id "..."` and the list tool instead of the engine's JSON
	 * (#2778). Declared on every tool with a `<kind>Id` argument; one entry per
	 * kind when the tool takes several, the entry chosen being the one whose
	 * `noun` the engine's sentence contains. A tool that does not declare it
	 * answers `Engine error (404): <body>` on one line. `tools.test.ts` scans
	 * the registry.
	 */
	notFound?: NotFoundDeclaration | readonly NotFoundDeclaration[];
	/**
	 * What to say for an engine 404 that carries one of these `code`s, instead of
	 * the unknown-id sentence. For a 404 that is not "no such id": the id exists
	 * and the engine says why the answer is gone. The class stays `not_found`;
	 * a code not listed here, or a 404 with none, is worded as `notFound` words it.
	 */
	notFoundByCode?: Readonly<Record<string, string>>;
	handler: (
		args: Record<string, unknown>,
		ctx: ToolContext,
		signal?: AbortSignal
	) => Promise<ToolResult>;
}

/** @p tool's description as a session under @p config lists it. */
export function resolveDescription(
	tool: Pick<McpTool, "description">,
	config: McpSafetyConfig
): string {
	return typeof tool.description === "string" ? tool.description : tool.description(config);
}

/** Tool metadata safe to cross the IPC boundary (no handler/schema). */
export interface McpToolInfo {
	name: string;
	description: string;
	category: ToolCategory;
}
