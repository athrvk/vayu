/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file server.ts
 * @brief Builds a configured MCP server (official SDK high-level `McpServer`)
 *        with the Vayu tool registry. Each enabled tool is registered with its
 *        Zod input schema (validated automatically), annotations, and optional
 *        output schema. A per-instance context (engine client + current safety
 *        config) is closed over each tool, and each call adds what only it
 *        knows (`callContext`). Transport-agnostic: built per request by the
 *        Streamable HTTP host (Electron) and per connection by the stdio CLI.
 */

import { z } from "zod";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	McpServer,
	ResourceTemplate,
	type CallToolResult,
	type ClientCapabilities,
	type InputRequiredResult,
	type ServerContext,
} from "@modelcontextprotocol/server";
import {
	TOOLS,
	dispatchTool,
	isListed,
	resolveDescription,
	withheldWriteRefusal,
	type ToolContext,
} from "./tools.js";
import { INPUT_REQUIRED } from "./tools/kit.js";
import type { McpHost } from "./tools/contract.js";
import { resolveRemedyTokens, settingRemedy } from "./remedy.js";
import { SERVER_ICONS } from "./server-icon.js";
import { STATIC_RESOURCES, RUN_REPORT_RESOURCE, extractRunIds } from "./resources.js";
import { PROMPTS } from "./prompts.js";

/** Provides the per-request tool context (client + current safety config). */
export type ToolContextProvider = () => ToolContext;

export interface McpServerInfo {
	name: string;
	version: string;
}

/** Vayu's identity, surfaced to clients via the server's Implementation info. */
const VAYU_TITLE = "Vayu";
const VAYU_DESCRIPTION =
	"Vayu is a local API testing and load-testing platform: Postman-style requests " +
	"plus k6-level load tests in one app, driven by a native C++ engine. This MCP " +
	"server exposes that engine so an agent can send requests, run and analyze load " +
	"tests, and read or tune engine configuration on the user's machine.";
const VAYU_WEBSITE = "https://github.com/athrvk/vayu";

/*
 * What belongs here: the cross-cutting facts no single tool description can
 * carry - the capability taxonomy, the safety model, and the other surfaces.
 *
 * What does not: tool names. The user can disable any tool individually, so a
 * roster written here is a list of things that may not exist in the session
 * reading it - which is why this text used to end by telling the reader to
 * trust `tools/list` over it. Each tool's own description is the one copy of
 * its contract, and it ships only when the tool does.
 */
const INSTRUCTIONS_HEAD =
	"Vayu is a local API testing and load-testing platform (Postman-style requests " +
	"plus k6-level load tests in one app, backed by a native C++ engine); these " +
	"tools drive that engine. Start by checking engine health, so a later failure " +
	"is not mistaken for a bad request. Tools are grouped by capability, named in " +
	"each tool's own description: read (inspect collections, requests, " +
	"environments, runs, config and live metrics; it returns workspace data, with " +
	"secret values withheld unless the user enables reveal), execute (send " +
	"real traffic to a target), write (mutate saved data or engine config), and " +
	"load (start and stop load tests). " +
	"Every tool that puts traffic on the network is restricted to an allowlist, " +
	"and load runs additionally enforce hard RPS, virtual-user and duration caps. Write " +
	"tools require write access, and the destructive ones ask " +
	"for confirmation - via elicitation where the client supports it, otherwise by " +
	"returning what the call would destroy and waiting for a `confirmed: true` " +
	"retry. A tool that is subject to either gate says so in its own description. ";

/**
 * The write gate, stated where an agent reads it before its first call - and
 * only in the sessions it applies to, since the server is rebuilt per request
 * and this text is therefore as current as `tools/list` itself.
 *
 * Withholding the write tools (#1429) took the handlers' "turn on write access"
 * refusal off the wire with them: the SDK rejects an unregistered name before
 * dispatch, so an agent on a default install saw no write tool and no reason
 * for its absence (#1431). It names how the host lifts the gate, and no tool.
 */
function writeGateSentence(host: McpHost): string {
	return (
		"Write access is off in this session, so no write tool is listed: a task that " +
		`needs one is blocked until the user chooses to ${settingRemedy("allowWrites", host)}, ` +
		"after which they appear in `tools/list`. "
	);
}

/** Every resource the server registers, derived so the sentence cannot lag the list. */
const RESOURCE_URIS = [...STATIC_RESOURCES.map((r) => r.uri), RUN_REPORT_RESOURCE.uriTemplate];

const INSTRUCTIONS_TAIL =
	"`tools/list` is authoritative for what this session actually has. " +
	"A user names an entity with a Vayu reference line, " +
	'`Vayu <kind> "<name>" (<id>)`, and the id in parentheses is the one to look up. ' +
	'For "the request I mean", ask the user for a reference line (the app\'s Copy for ' +
	"agent) or read the app's current focus. A run you started is read by the runId " +
	"its start call returned, not by its position in the run list: a newer run, " +
	"yours or anyone's, moves that position. " +
	`Vayu data is also available as resources (${RESOURCE_URIS.slice(0, -1).join(", ")}, ` +
	`and ${RESOURCE_URIS[RESOURCE_URIS.length - 1]}) to attach as ` +
	"context, and prompts (summarize_run, compare_runs, diagnose_errors, " +
	"suggest_load_profile) provide ready-made starting points. Before writing a " +
	"preRequestScript or postRequestScript, read vayu://scripting/completions - it is " +
	"the engine's own list of every pm.* name the script sandbox provides, including " +
	"synchronous pm.crypto hashing and btoa/atob for signing a request. A GraphQL " +
	"request's schema can be read through Vayu, introspected with the request's own " +
	"auth and answered as SDL, before a query is written.";

/**
 * The reveal setting, stated the same way and for the same reason as the write
 * gate: a withheld value is a marker in place of data, and an agent that does
 * not know why it is there reads it as missing data rather than as a setting a
 * person can change (#1805).
 *
 * This is the one full statement of the withholding rules: a tool's
 * description carries only `withheldPointer`'s line (#2441), and a tools-only
 * client never reads the resources that restate parts of it.
 */
function revealGateSentence(host: McpHost): string {
	return (
		"Secret values are withheld in this session. Stored data: a secret variable or a " +
		"cookie reads `valueWithheld: true`; an auth credential (a token, password, client " +
		"secret or key) `<member>Withheld: true`, and a credential row in a Postman import's " +
		"`postman` source `valueWithheld: true`; so does a header row named `Authorization`, " +
		"`Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`, " +
		"`X-CSRF-Token` or the header the request's API-key auth names. A `url` (a saved " +
		"request's; a smoke test row's, composed or else stored; a GraphQL schema read's " +
		"`endpoint`, though never the schema) drops the password of `user:password@` and " +
		"empties a credential query or fragment value (`api_key`, `token`, `signature`, or " +
		"the one the API-key auth places in the query) in place " +
		"(`?api_key=&page=2`), and a `params` row naming one reads `valueWithheld: true`. An " +
		"empty value or a pure {{variable}} reference is shown as written. A proxy URL's " +
		"user:password is stripped, with `credentialsWithheld: true` on the config entry or " +
		"the connection diagnosis's `proxy`. An OpenAPI diff's `headers`, `url` or `params` " +
		"change whose current value could carry a credential (such a header with a value, a " +
		"`user:password@` or a url cut short before its host ends, a credential-named query " +
		"or params value) reads `currentWithheld: true` in place of `current`. An auth block " +
		"carrying a Withheld marker is refused as `auth` by every tool that takes one, " +
		"because it holds no credential. " +
		"A request that references a secret still sends with it, because the engine resolves " +
		"it. What a run recorded (run rows, reports, samples, exports, send results, inbox " +
		"captures, mock activity) reads `<redacted>` in place of every secret variable's " +
		"value and every literal credential a stored collection's or request's auth holds, 4 " +
		"bytes or longer, raw, percent-encoded, JSON- or XML-escaped; in place of a credential " +
		"header's value in header maps, `headerLines` and `rawRequest` header lines, request " +
		"and response alike; in place of what auth wrote at send time (an OAuth 2.0 token " +
		"or an API key, whatever its source) in the request's `url`, header maps and " +
		"`rawRequest`; and in place of a credential-named query value (matched on the whole " +
		"name, however it got there; an empty value or a pure {{variable}} reference is shown as written) in that `url` and request line. A base64 body " +
		'(`bodyEncoding: "base64"`) is searched as the bytes it decodes to, matched as ' +
		"UTF-8 and as Latin-1, and stays base64 that decodes, with " +
		"`<redacted>` in place of those bytes. Everything else is kept - shape, order and " +
		"the engine's size fields, which still count the bytes it read - and the request was sent with the real values. If a " +
		"lookup the masking needs fails, the call answers an error naming it and none of the " +
		"result. A load run's confirmation preview shows the run as it will be recorded: " +
		"secrets `<redacted>`, the `auth` block's credentials `<member>Withheld: true`. " +
		"A script you supply when sending a request or starting a load run " +
		"(preRequestScript, postRequestScript, tests, or a script.* element) is refused, " +
		"because a script reads every variable. A task that needs the " +
		`value itself is blocked until the user chooses to ${settingRemedy("revealSecretsToAgents", host)}. `
	);
}

/** The server instructions for one session, gated on that session's config. */
function instructionsFor(config: ToolContext["config"], host: McpHost): string {
	return (
		INSTRUCTIONS_HEAD +
		(config.allowWrites ? "" : writeGateSentence(host)) +
		(config.revealSecretsToAgents ? "" : revealGateSentence(host)) +
		INSTRUCTIONS_TAIL
	);
}

/** How one built server is to behave beyond the session's safety config. */
export interface McpServerOptions {
	/**
	 * Whether this server's client can be told the tool list changed. Only a
	 * client that holds a stream open for it can: a 2026-07-28 client of the
	 * HTTP host, through `subscriptions/listen`. Advertising it to anyone else
	 * would promise a notification that never comes, so it defaults to false.
	 */
	toolListChanges?: boolean;
	/**
	 * The client name an earlier request's handshake recorded, for a host whose
	 * server never sees the handshake itself (the stateless legacy HTTP leg, see
	 * `client-sessions.ts`). A server that did see one reads it from the SDK.
	 */
	sessionClientName?: string;
}

/**
 * Create an MCP server exposing the Vayu tools. `contextProvider` is invoked
 * once per built server so the safety config can change at runtime (the HTTP
 * host builds a fresh server per request; the stdio CLI builds one per
 * connection). Tools a session does not list are not registered, so they are
 * absent from `tools/list`.
 */
export function createMcpServer(
	info: McpServerInfo,
	contextProvider: ToolContextProvider,
	opts: McpServerOptions = {}
): McpServer {
	const baseCtx = contextProvider();

	const mcp = new McpServer(
		{
			name: info.name,
			version: info.version,
			title: VAYU_TITLE,
			description: VAYU_DESCRIPTION,
			websiteUrl: VAYU_WEBSITE,
			icons: SERVER_ICONS,
		},
		// No `capabilities` here: declaring `tools` up front makes the SDK install
		// its `tools/call` handler at construction, before the capture below can
		// see it. Registration declares what is registered.
		{ instructions: instructionsFor(baseCtx.config, baseCtx.host) }
	);
	// Before the first registration, which otherwise defaults each to true. The
	// resource and prompt lists change under no client: the prompts are fixed,
	// and the one list that moves (runs, under the run-report template) is moved
	// by the app as much as by an agent, which this process does not see.
	mcp.server.registerCapabilities({
		tools: { listChanged: opts.toolListChanges ?? false },
		resources: { listChanged: false },
		prompts: { listChanged: false },
	});

	const takeToolHandlers = captureToolHandlers(mcp);

	for (const tool of TOOLS) {
		if (!isListed(tool, baseCtx.config)) continue;
		mcp.registerTool(
			tool.name,
			{
				title: tool.annotations.title,
				description: resolveDescription(tool, baseCtx.config),
				inputSchema: z.object(tool.inputSchema),
				...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
				annotations: tool.annotations,
			},
			async (args, sdkCtx): Promise<CallToolResult | InputRequiredResult> => {
				// Through `dispatchTool`, not `tool.handler` directly: one dispatch
				// path means the disabled-tool rejection and the argument-error
				// translation cannot diverge between production and the tests.
				const result = await dispatchTool(
					tool.name,
					args,
					callContext(mcp, baseCtx, sdkCtx, opts.sessionClientName),
					sdkCtx.mcpReq.signal
				);
				return INPUT_REQUIRED.get(result) ?? (result as CallToolResult);
			}
		);
	}

	const { list: sdkListTools, call: sdkCallTool } = takeToolHandlers();
	resolveRemedyInToolList(mcp, baseCtx.host, sdkListTools);
	answerWithheldWriteCalls(mcp, baseCtx, sdkCallTool);

	registerResources(mcp, baseCtx);
	registerPrompts(mcp, baseCtx);

	return mcp;
}

/**
 * The tool context for one call: the session's, plus what only the call knows -
 * who the client is and whether the person behind it can be asked.
 *
 * A 2026-07-28 request carries both in its own envelope; a 2025-era one has
 * them only from the handshake, which a stdio or in-memory server saw and the
 * stateless legacy HTTP leg did not. That leg therefore never offers the
 * question: it has no way to carry the client's answer back to the server that
 * asked, and the SDK would refuse it anyway.
 */
function callContext(
	mcp: McpServer,
	base: ToolContext,
	sdkCtx: ServerContext,
	sessionClientName: string | undefined
): ToolContext {
	const envelope = sdkCtx.mcpReq.envelope as EnvelopeView | undefined;
	const capabilities =
		envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? mcp.server.getClientCapabilities();
	const clientName =
		envelope?.[CLIENT_INFO_META_KEY]?.name ??
		mcp.server.getClientVersion()?.name ??
		sessionClientName;
	return {
		...base,
		clientName: () => clientName,
		...(canAskForm(capabilities)
			? { userInput: { responses: sdkCtx.mcpReq.inputResponses } }
			: {}),
	};
}

/**
 * Whether a client with @p capabilities can answer a form question - the kind
 * `confirmDestructive` puts. The SDK's own rule, which it applies by refusing
 * the call (`-32021`) rather than falling back: a mode named outright must
 * include `form`, and a bare `elicitation: {}` is the pre-mode form-only
 * declaration. The client package exports this as `getSupportedElicitationModes`;
 * the server package does not.
 */
function canAskForm(capabilities: ClientCapabilities | undefined): boolean {
	const elicitation = capabilities?.elicitation;
	if (!elicitation) return false;
	return elicitation.form !== undefined || elicitation.url === undefined;
}

/** The two envelope members `callContext` reads, as the 2026-07-28 revision defines them. */
interface EnvelopeView {
	[CLIENT_CAPABILITIES_META_KEY]?: ClientCapabilities;
	[CLIENT_INFO_META_KEY]?: { name?: string };
}

/**
 * A `tools/call` or `tools/list` handler as the SDK's `Server` holds it.
 *
 * Deliberately loose in its request type: the wrappers below read one field and
 * forward the rest untouched, and restating the SDK's request shape here is a
 * second copy of it to drift.
 */
type ToolHandler = (
	request: { params: { name: string } },
	ctx: unknown
) => unknown | Promise<unknown>;

/** The two handlers `registerTool` installs, as captured. */
interface ToolHandlers {
	list: ToolHandler | undefined;
	call: ToolHandler | undefined;
}

/**
 * Watch for the `tools/call` and `tools/list` handlers `registerTool` installs,
 * and return a getter for them.
 *
 * The SDK offers no pre-dispatch hook (2.3.1): its handler looks the name up in
 * its own registry and rejects before anything of Vayu's runs, and its
 * `fallbackRequestHandler` serves only methods with no handler at all. So a
 * wrapper can only be put in front of it by replacing it - which needs the
 * original to delegate to. `setRequestHandler` is public on both sides of
 * this, and the interception is removed again as soon as the registration loop
 * is done.
 *
 * A capture that came back empty would leave the refusal unshipped, so what
 * holds this to the SDK across an upgrade is the protocol test that calls a
 * withheld name and reads the answer.
 */
function captureToolHandlers(mcp: McpServer): () => ToolHandlers {
	const server = mcp.server as unknown as {
		setRequestHandler: (method: string, handler: ToolHandler) => void;
	};
	const install = server.setRequestHandler.bind(server);
	const captured: ToolHandlers = { list: undefined, call: undefined };

	server.setRequestHandler = (method: string, handler: ToolHandler) => {
		if (method === "tools/call") captured.call = handler;
		if (method === "tools/list") captured.list = handler;
		install(method, handler);
	};

	return () => {
		delete (server as Partial<typeof server>).setRequestHandler;
		return captured;
	};
}

/**
 * Fill every remedy token in the `tools/list` answer with the host's wording.
 *
 * The SDK converts each tool's Zod schema to JSON Schema only when it answers
 * the list, so a token in a parameter's description is out of reach of
 * anything done at registration. Resolving the answer covers a tool's
 * description, its parameters' and its output schema in one place.
 */
function resolveRemedyInToolList(
	mcp: McpServer,
	host: McpHost,
	sdkListTools: ToolHandler | undefined
): void {
	if (!sdkListTools) return;
	const server = mcp.server as unknown as {
		setRequestHandler: (method: string, handler: ToolHandler) => void;
	};
	server.setRequestHandler("tools/list", async (request, callCtx) =>
		resolveRemedyTokens(await sdkListTools(request, callCtx), host)
	);
}

/**
 * Answer a call to a write tool this session withheld with the refusal that
 * names the setting, in place of the SDK's "Tool <name> not found".
 *
 * The withholding (#1429) is what makes this necessary: it took the handlers'
 * refusal off the wire along with the schemas, leaving an agent that guessed a
 * write tool's name - from its own memory, or from a list it fetched while
 * writes were on - with an unknown-tool error and nothing to ask the user for
 * (#1431). Every other name reaches the SDK's handler unchanged, so schema
 * validation and structured output are untouched.
 */
function answerWithheldWriteCalls(
	mcp: McpServer,
	ctx: ToolContext,
	sdkCallTool: ToolHandler | undefined
): void {
	if (ctx.config.allowWrites || !sdkCallTool) return;
	const server = mcp.server as unknown as {
		setRequestHandler: (method: string, handler: ToolHandler) => void;
	};
	server.setRequestHandler("tools/call", (request, callCtx) => {
		const refusal = withheldWriteRefusal(request.params.name, ctx);
		return refusal ?? sdkCallTool(request, callCtx);
	});
}

/** Register the read-only Vayu data resources (static lists + run-report template). */
function registerResources(mcp: McpServer, ctx: ToolContext): void {
	const meta = (title: string, description: string) => ({
		title,
		description: resolveRemedyTokens(description, ctx.host),
		mimeType: "application/json",
	});

	// Every callback below forwards `ctx.mcpReq.signal` - the SDK aborts it when the
	// client cancels the request, and the engine client turns that into an
	// aborted fetch instead of a detached request running to its own timeout.
	for (const r of STATIC_RESOURCES) {
		mcp.registerResource(r.name, r.uri, meta(r.title, r.description), async (uri, sdkCtx) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "application/json",
					text: JSON.stringify(await r.read(ctx, sdkCtx.mcpReq.signal), null, 2),
				},
			],
		}));
	}

	mcp.registerResource(
		RUN_REPORT_RESOURCE.name,
		new ResourceTemplate(RUN_REPORT_RESOURCE.uriTemplate, {
			list: async (sdkCtx) => {
				const runs = await RUN_REPORT_RESOURCE.listRuns(ctx, sdkCtx.mcpReq.signal);
				return {
					resources: extractRunIds(runs).map((id) => ({
						uri: `vayu://run/${id}/report`,
						name: `Run ${id} report`,
						mimeType: "application/json",
					})),
				};
			},
			complete: {
				// Unsignalled by necessity: the SDK's completion callback is
				// `(value, context?)` with no handler context, so there is
				// no signal to forward here. Autocomplete is a single cheap
				// `/runs` read, so an uncancelled one costs little.
				runId: async (value: string) => {
					const runs = await RUN_REPORT_RESOURCE.listRuns(ctx);
					return extractRunIds(runs)
						.filter((id) => id.startsWith(value))
						.slice(0, 20);
				},
			},
		}),
		meta(RUN_REPORT_RESOURCE.title, RUN_REPORT_RESOURCE.description),
		async (uri, variables, sdkCtx) => {
			const raw = variables.runId;
			const runId = Array.isArray(raw) ? (raw[0] ?? "") : String(raw ?? "");
			const report = await RUN_REPORT_RESOURCE.read(ctx, runId, sdkCtx.mcpReq.signal);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "application/json",
						text: JSON.stringify(report, null, 2),
					},
				],
			};
		}
	);
}

/** Register the server-provided prompt templates (summarize / compare / diagnose / plan). */
function registerPrompts(mcp: McpServer, ctx: ToolContext): void {
	for (const p of PROMPTS) {
		mcp.registerPrompt(
			p.name,
			{ title: p.title, description: p.description, argsSchema: z.object(p.argsSchema) },
			async (args, sdkCtx) => {
				const result = await p.build(args, ctx, sdkCtx.mcpReq.signal);
				return result as typeof result & Record<string, unknown>;
			}
		);
	}
}
