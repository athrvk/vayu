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
 *        destructive hints + a display title) and some declare an output schema
 *        for structured results. Transport-agnostic - the same registry backs
 *        both the Streamable HTTP server (Electron) and the stdio CLI.
 */

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { EngineClient, RunListQuery } from "./engine-client.js";
import {
	DEFAULT_RUN_PAGE_LIMIT,
	EngineRequestError,
	EngineTimeoutError,
	MAX_ENGINE_PAGE_LIMIT,
} from "./engine-client.js";
import type { McpSafetyConfig } from "./config.js";
import type { LoadRunParams } from "./safety.js";
import {
	checkAllowlist,
	checkLoadCaps,
	checkMonitorHost,
	defaultDurationUnderCap,
} from "./safety.js";
import { compareReports } from "./compare.js";
import {
	collectionChain,
	collectionParentId,
	precedenceNote,
	resolveVariableReports,
	VARIABLE_PRECEDENCE_SENTENCE,
	VARIABLE_RESOLUTION_URI,
	type CollectionLike,
	type OriginScopes,
	type StoredVariableBag,
} from "./variable-origins.js";
import { HTTP_VERSIONS } from "./http-versions.js";

/** An auth block as stored/forwarded (discriminated by `mode`). */
type AuthRecord = Record<string, unknown> & { mode?: string };

// --- Elicitation -------------------------------------------------------------

/** A restricted, flat object schema the client renders as a form. */
export interface ElicitParams {
	message: string;
	requestedSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export interface ElicitOutcome {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, unknown>;
}

/** Ask the human via the client; throws if the client can't elicit. */
export type ElicitFn = (params: ElicitParams) => Promise<ElicitOutcome>;

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
	"collection",
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
}

export interface ToolContext {
	client: EngineClient;
	config: McpSafetyConfig;
	/**
	 * Present when the connected client supports elicitation; lets a tool ask the
	 * human to confirm. Absent (or throwing) → the tool falls back to its
	 * agent-side gate (e.g. the `confirmed` flag).
	 */
	elicit?: ElicitFn;
	/**
	 * Called once per entity a successful call changed, so the renderer can
	 * invalidate the matching queries. Absent when there is nothing to notify -
	 * the stdio CLI has no window.
	 */
	onDataChanged?: (event: McpDataChangedEvent) => void;
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

export interface McpTool {
	name: string;
	description: string;
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
	handler: (
		args: Record<string, unknown>,
		ctx: ToolContext,
		signal?: AbortSignal
	) => Promise<ToolResult>;
}

/** Tool metadata safe to cross the IPC boundary (no handler/schema). */
export interface McpToolInfo {
	name: string;
	description: string;
	category: ToolCategory;
}

// --- Result helpers ----------------------------------------------------------

function jsonResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// --- Inline body bounds ------------------------------------------------------

/**
 * How much of a body a tool result carries inline (issue #767).
 *
 * A tool-result budget, not an engine one. No engine cap fits. The config entry
 * that bounds a single response, `maxResponseBodyBytes`, is still the load
 * path's alone ("Design-mode sends are not affected"); `maxTraceBodyBytes`
 * (5MB) is a storage bound sized for a human opening one full trace in the UI;
 * and `maxDesignResponseBodyBytes` (32MB, issue #1157) does bound a design send
 * - it is why an agent can no longer be handed an unbounded body - but 32MB is
 * a "keep the engine's memory finite" number, three orders of magnitude past
 * what a tool result can carry. Between them a design send returns every byte
 * it read up to 32MB: an ordinary page fetch came back as 1.3M characters and
 * exceeded the tool-result token limit outright, with nothing in between the
 * engine's answer and the agent.
 *
 * 32KB is not a new number: it is `maxSampleBodyBytes`
 * (`DEFAULT_MAX_SAMPLE_BODY_BYTES`, engine `constants.hpp`), this codebase's own
 * answer to "how much of a body does an automated reader get" for load-run
 * captures. Fixed rather than read from live config: `run_request` has just
 * sent a real request and should not pay a second round trip for a number that
 * only has to be reasonable, and a constant is what the tests can pin.
 */
export const MAX_INLINE_BODY_BYTES = 32_768;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes, reporting its true size.
 *
 * The cut steps back off a continuation byte rather than landing mid-character:
 * a split code point comes back as a replacement glyph, which an agent reads as
 * content the response never carried.
 */
function boundText(
	text: string,
	maxBytes = MAX_INLINE_BODY_BYTES
): { text: string; truncated: boolean; bytes: number } {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return { text, truncated: false, bytes: buf.byteLength };
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return { text: buf.subarray(0, end).toString("utf8"), truncated: true, bytes: buf.byteLength };
}

const HEADER_BODY_SEPARATOR = "\r\n\r\n";

/**
 * Bound a node's `rawRequest` wire message, cutting the body half only.
 *
 * The engine's rule for this field, kept rather than re-decided
 * (`cap_node_raw_request`, `engine/src/utils/json.cpp`): the header block is the
 * reason the field exists - it carries the `Cookie` line libcurl attached, which
 * appears nowhere else - so a cut that ate the headers would take exactly what
 * the reader opened it for. A message with no blank line has no body to cut.
 *
 * Unlike the engine, this records the cut explicitly. The engine can lean on the
 * `bodyTruncated` pair beside it because both are capped at one limit at write
 * time; a tool result has to say so on its own, since the field an agent reads
 * here sits beside the *response*'s size fields, not the request body's.
 *
 * Returns the node unchanged (same reference) when nothing was cut, so callers
 * can tell "bounded" from "untouched" without re-comparing content.
 */
function boundWireMessage(node: Record<string, unknown>): Record<string, unknown> {
	const raw = node.rawRequest;
	if (typeof raw !== "string") return node;
	const separator = raw.indexOf(HEADER_BODY_SEPARATOR);
	if (separator === -1) return node;
	const bodyStart = separator + HEADER_BODY_SEPARATOR.length;
	const bounded = boundText(raw.slice(bodyStart));
	if (!bounded.truncated) return node;
	return {
		...node,
		rawRequest: raw.slice(0, bodyStart) + bounded.text,
		rawRequestTruncated: true,
		rawRequestBytes: Buffer.byteLength(raw, "utf8"),
	};
}

/**
 * Bound one `POST /execute` response - what `run_request` hands back.
 *
 * `bodySize` is the engine's own byte count for this body and is exactly what a
 * truncation flag refers to, so it is used rather than recomputed; it is only
 * filled in when the engine sent no usable one.
 *
 * The engine's `bodyCapped` (issue #1157) is carried through untouched, and the
 * two flags must stay distinguishable: `bodyTruncated` set here means this tool
 * result is showing less than the engine returned, which the app's own history
 * still has in full, while `bodyCapped` means the engine never read more than
 * this - re-sending returns the same prefix, and only raising
 * `maxDesignResponseBodyBytes` changes it. Both can be true of one response.
 */
function boundExecuteResponse(value: unknown): unknown {
	if (!isRecord(value)) return value;
	let out = value;
	const bodyRaw = value.bodyRaw;
	if (typeof bodyRaw === "string") {
		const bounded = boundText(bodyRaw);
		if (bounded.truncated) {
			out = {
				...out,
				bodyRaw: bounded.text,
				// The parsed body holds the same payload verbatim, so leaving it
				// would hand back in full the very bytes `bodyRaw` now says were
				// cut - the JSON-doubling case. Null rather than deleted:
				// `serialize(Response)` always emits this key, and null is already
				// its "nothing parsed here" value, so a truncated response keeps
				// the shape every reader of this tool already parses.
				body: null,
				bodyTruncated: true,
				...(typeof value.bodySize === "number" ? {} : { bodySize: bounded.bytes }),
			};
		}
	}
	return boundWireMessage(out);
}

/**
 * Bound one stored-trace node (`trace.request` or `trace.response`).
 *
 * Mirrors the engine's own disclosure pair for a cut body
 * (`cap_node_body`): `bodyTruncated` plus `bodyBytes` holding the *original*
 * size, so an agent that has read one convention recognises the other.
 */
function boundTraceNode(node: unknown): unknown {
	if (!isRecord(node)) return node;
	let out = node;
	const body = node.body;
	if (typeof body === "string") {
		const bounded = boundText(body);
		if (bounded.truncated) {
			out = {
				...out,
				body: bounded.text,
				bodyTruncated: true,
				// Only when the engine recorded none. A trace it already cut at
				// `maxTraceBodyBytes` carries the true original size here, and
				// overwriting that with the size of the 5MB slice we re-cut would
				// replace a real number with a smaller one that looks just as real.
				...(typeof node.bodyBytes === "number" ? {} : { bodyBytes: bounded.bytes }),
			};
		}
	}
	return boundWireMessage(out);
}

/**
 * How many bytes of stored trace one run report carries in total (issue #769).
 *
 * The per-node bound above does not bound the *result*: the report route caps
 * `results[]` at 100 rows and each row may keep up to `MAX_INLINE_BODY_BYTES`
 * on each of three nodes, so a 100-step scenario measured at 3.3M characters
 * with every node honestly flagged as truncated - 2.5x the 1.3M that made #767
 * fail in the first place. Truncation stops being the binding constraint at
 * that row count: 100 steps of an 8KB body, well under the per-node bound and
 * so never touched, still totalled 845K characters.
 *
 * 96KB is `MAX_INLINE_BODY_BYTES * 3`: the largest single row the per-node
 * bound can produce (a request body, a response body and a `rawRequest`, each
 * at the cap), derived from the existing bound rather than invented beside it.
 * That is the number with a reason - a budget below it would drop rows for
 * being merely as big as one row is allowed to be - and it leaves the whole
 * result an order of magnitude under the 1.3M characters that failed in #767,
 * or dozens of rows when the bodies are ordinary.
 *
 * It bounds the traces, not the report: the row scalars (id, status, latency,
 * step identity) are ~200 bytes a row, so 100 of them are noise beside one
 * body, and they are never dropped - the run's shape is the answer even when
 * the payloads cannot come along, which is why no second row cap is needed.
 */
export const MAX_REPORT_TRACE_BYTES = MAX_INLINE_BODY_BYTES * 3;

/**
 * Whether a row's trace is one to keep first when the budget cannot hold them
 * all, mirroring the engine's own thinning rule for `stepsStored`
 * (`ScenarioStepStore::add`, called with `outcome != Passed`) so the two do not
 * disagree about which steps matter.
 *
 * A row the engine stamped no outcome on is a design-mode row, where the engine
 * has no rule to disagree with; its transport error is the only failure signal
 * it carries.
 */
function isPriorityTraceRow(row: Record<string, unknown>): boolean {
	const trace = row.trace;
	if (isRecord(trace) && typeof trace.outcome === "string") return trace.outcome !== "passed";
	return typeof row.error === "string" && row.error !== "";
}

/** One report row, with its trace bounded per node and measured. */
interface MeasuredRow {
	row: unknown;
	/** Set only for a row that carries a trace; the per-node-bounded copy. */
	traced?: { record: Record<string, unknown>; trace: Record<string, unknown>; priority: boolean };
	/** True when bounding changed the trace, so the row must be rebuilt. */
	rebuilt: boolean;
	bytes: number;
}

/**
 * Bound the stored traces in a run report - what `get_run_report` hands back.
 *
 * Two bounds, because one does not imply the other: every trace node is cut to
 * `MAX_INLINE_BODY_BYTES` (issue #767), and the traces together are cut to
 * `MAX_REPORT_TRACE_BYTES` (issue #769). Rows past the total budget keep every
 * scalar and lose only their trace, flagged `traceOmitted` on the row with
 * `tracesOmitted` and `traceBudgetBytes` on the report - the same disclose-in-
 * band shape `list_runs` uses for its 100-row page, so an agent that reads a
 * short report never mistakes it for the whole run.
 *
 * Design and scenario rows only: a load run's results never go through
 * `build_result_trace` (it is called from `record_design_result` and the
 * scenario runner, never the load hot path), so they carry no `trace` node and
 * the walk leaves them untouched. Rebuilt rather than mutated so a report with
 * nothing over either bound comes back as the object the engine returned.
 */
function boundRunReport(value: unknown): unknown {
	if (!isRecord(value) || !Array.isArray(value.results)) return value;

	let nodeBounded = false;
	const measured: MeasuredRow[] = value.results.map((row) => {
		if (!isRecord(row) || !isRecord(row.trace)) return { row, rebuilt: false, bytes: 0 };
		const trace = row.trace;
		const next: Record<string, unknown> = { ...trace };
		let rebuilt = false;
		for (const key of ["request", "response"] as const) {
			if (!(key in trace)) continue;
			next[key] = boundTraceNode(trace[key]);
			if (next[key] !== trace[key]) rebuilt = true;
		}
		if (rebuilt) nodeBounded = true;
		const bounded = rebuilt ? next : trace;
		// The compact size of what this row would embed. Measured after the
		// per-node cut, since that is what the result would actually carry.
		return {
			row,
			traced: { record: row, trace: bounded, priority: isPriorityTraceRow(row) },
			rebuilt,
			bytes: Buffer.byteLength(JSON.stringify(bounded), "utf8"),
		};
	});

	// Spend the budget on the rows that matter first, then in run order. The
	// first trace is always embedded, whatever it costs: a design run's report
	// is one row, and a report that dropped it would answer nothing at all.
	const spendOrder = [
		...measured.filter((m) => m.traced?.priority),
		...measured.filter((m) => m.traced && !m.traced.priority),
	];
	const keep = new Set<MeasuredRow>();
	let spent = 0;
	for (const entry of spendOrder) {
		if (keep.size > 0 && spent + entry.bytes > MAX_REPORT_TRACE_BYTES) break;
		keep.add(entry);
		spent += entry.bytes;
	}

	const omitted = spendOrder.length - keep.size;
	if (!nodeBounded && omitted === 0) return value;

	const results = measured.map((entry) => {
		if (!entry.traced) return entry.row;
		if (keep.has(entry)) {
			return entry.rebuilt
				? { ...entry.traced.record, trace: entry.traced.trace }
				: entry.row;
		}
		const withoutTrace = { ...entry.traced.record };
		delete withoutTrace.trace;
		return { ...withoutTrace, traceOmitted: true };
	});

	if (omitted === 0) return { ...value, results };
	return {
		...value,
		results,
		tracesOmitted: omitted,
		traceBudgetBytes: MAX_REPORT_TRACE_BYTES,
	};
}

// --- Run housekeeping bounds -------------------------------------------------

/**
 * Run types and statuses `list_runs` filters on, spelled as the engine parses
 * them (`parse_run_type` / `parse_run_status`, engine `types.hpp`) and matching
 * the renderer's own `Run` union in `app/src/types/domain.ts`.
 *
 * Restated here rather than imported because `electron/` shares no module graph
 * with `app/src/` - the same reason `HTTP_VERSIONS` has its own copy. Declared
 * as Zod enums so an unrecognised value is a refusal: `GET /runs` *ignores* a
 * filter it cannot parse, so a typo would otherwise answer the unfiltered page
 * and read as "nothing matched anywhere".
 */
const RUN_TYPES = ["design", "load", "scenario"] as const;
const RUN_STATUSES = ["pending", "running", "completed", "failed", "stopped"] as const;

/**
 * Default page for `get_run_samples` - small, because a sample carries a real
 * response body (bounded engine-side by `maxSampleBodyBytes`) and 500 of them is
 * a context window, not a page. The engine's own default here is 50.
 */
export const DEFAULT_RUN_SAMPLE_LIMIT = 25;

/**
 * Default and ceiling for the two per-tick series reads.
 *
 * The engine defaults these to 5000 rows and caps them at 50000 - sized for the
 * dashboard's charts, which draw every point and show a human the shape. An
 * agent reads them as JSON through a context window, so both are far past what
 * a tool result can carry, and the #319 lesson (`get_live_metrics` returning
 * whatever a run had accumulated) is that the bound belongs on this side of the
 * boundary. Refused rather than clamped, so an agent asking for more is told.
 */
export const DEFAULT_RUN_SERIES_LIMIT = 100;
export const MAX_RUN_SERIES_LIMIT = 1_000;

/**
 * What a bounded page did *not* return, in words.
 *
 * The `{data, pagination}` envelope already carries `total` and `hasMore`, but a
 * bound an agent has to reconstruct from two numbers is one it can miss - the
 * same disclose-in-band rule the smoke matrix and the report's trace budget
 * follow. Empty when the page is the whole answer: a caveat on a complete read
 * is noise that teaches an agent to skip the caveats that matter.
 */
function pageCaveat(value: unknown, noun: string): string {
	if (!isRecord(value)) return "";
	const pagination = value.pagination;
	if (!isRecord(pagination) || pagination.hasMore !== true) return "";
	const offset = typeof pagination.offset === "number" ? pagination.offset : 0;
	const returned = typeof pagination.returned === "number" ? pagination.returned : 0;
	const total = typeof pagination.total === "number" ? String(pagination.total) : "more";
	return (
		`\n\nBounded read: ${returned} of ${total} ${noun}, starting at offset ${offset}. ` +
		`Read the next page with offset: ${offset + returned}.`
	);
}

/**
 * A run named in words, for the prompt that asks a human to delete it.
 *
 * The same rule `delete_request` follows: a confirmation carrying only an opaque
 * id is not one a person can answer. Every part is optional because a run row is
 * only as descriptive as the snapshot it stored - a malformed one serializes to
 * an empty summary engine-side rather than failing - so this degrades to the id
 * instead of printing "undefined".
 */
function describeRun(runId: string, run: Record<string, unknown>): string {
	const snapshot = isRecord(run.configSnapshot) ? run.configSnapshot : {};
	const kind = typeof run.type === "string" && run.type !== "" ? `${run.type} run` : "run";
	const parts: string[] = [];
	if (typeof snapshot.url === "string" && snapshot.url !== "") parts.push(snapshot.url);
	if (typeof snapshot.comment === "string" && snapshot.comment !== "") {
		parts.push(`"${snapshot.comment}"`);
	}
	if (typeof run.status === "string" && run.status !== "") parts.push(run.status);
	// `startTime` is epoch milliseconds (engine `Run::start_time`, an int64), so
	// it is rendered rather than printed - a human confirming a delete cannot
	// read 1755454800000 as "this morning".
	if (typeof run.startTime === "number" && Number.isFinite(run.startTime) && run.startTime > 0) {
		parts.push(`started ${new Date(run.startTime).toISOString()}`);
	}
	if (run.baseline === true) parts.push("pinned as a baseline");
	return parts.length > 0 ? `the ${kind} ${runId} (${parts.join(", ")})` : `the ${kind} ${runId}`;
}

/**
 * A webhook inbox named in words, for the prompt that asks a human to delete it.
 *
 * The capture count is the part that has to be there: a stopped inbox holding
 * 40 recorded webhooks and one holding none are the same call with very
 * different consequences, and only this sentence tells them apart. It is stated
 * even at zero, because "captures 0 requests" is the reassurance that makes the
 * prompt answerable - an absent count reads as unknown, not as none.
 */
function describeInbox(inboxId: string, inbox: Record<string, unknown>): string {
	const parts: string[] = [];
	if (typeof inbox.url === "string" && inbox.url !== "") parts.push(inbox.url);
	parts.push(inbox.running === true ? "running" : "stopped");
	const captures = typeof inbox.captureCount === "number" ? inbox.captureCount : 0;
	parts.push(`${captures} captured request${captures === 1 ? "" : "s"}`);
	return `the webhook inbox ${inboxId} (${parts.join(", ")})`;
}

/**
 * The `GET /runs` query a `list_runs` call describes.
 *
 * Only the filters the caller actually stated travel. An omitted one must not
 * reach the URL as `type=undefined`: the engine ignores a filter it cannot
 * parse, so that spelling happens to behave like "unfiltered" today - by way of
 * the same rule that silently swallows a typo. Sending nothing is the honest
 * form, and leaves the schema as the only thing rejecting a bad value.
 */
function runListQuery(args: Record<string, unknown>): RunListQuery {
	const query: RunListQuery = {
		limit: optionalPageLimit(args, "limit", DEFAULT_RUN_PAGE_LIMIT, MAX_ENGINE_PAGE_LIMIT),
		offset: optionalOffset(args, "offset"),
	};
	for (const key of ["type", "status", "requestId", "collectionId", "q"] as const) {
		const value = str(args, key);
		if (value !== undefined) query[key] = value;
	}
	if (typeof args.baseline === "boolean") query.baseline = args.baseline;
	return query;
}

/**
 * A paginated engine read whose result says what it left behind.
 * {@link callEngine} with a `shape` cannot do this: the caveat is text beside
 * the JSON, not a rewrite of it.
 *
 * `shape` is the same seam {@link callEngine} offers, and it runs before the
 * caveat is computed - a page whose rows carry bodies is bounded here, and the
 * caveat still describes the page the engine answered rather than the cut one
 * (it reads `pagination`, which a body bound does not touch).
 */
async function pagedRead(
	fn: () => Promise<unknown>,
	noun: string,
	shape?: (value: unknown) => unknown
): Promise<ToolResult> {
	let answer: unknown;
	try {
		answer = await fn();
	} catch (err) {
		return engineErrorResult(err);
	}
	const caveat = pageCaveat(answer, noun);
	return withCaveat(jsonResult(shape ? shape(answer) : answer), caveat);
}

/** Result that carries both a text rendering and structured content. */
function structuredResult(value: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		structuredContent: value,
	};
}

function textResult(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Append a note to a result's text without disturbing its structured content.
 * For telling an agent what a call could *not* do - a caveat printed nowhere is
 * the same as not having noticed it.
 */
function withCaveat(result: ToolResult, caveat: string): ToolResult {
	if (!caveat) return result;
	return {
		...result,
		content: [...result.content, { type: "text" as const, text: caveat.trimStart() }],
	};
}

function engineErrorResult(err: unknown): ToolResult {
	if (err instanceof EngineRequestError) {
		return errorResult(`Engine error (${err.status}): ${err.body || err.message}`);
	}
	const msg = err instanceof Error ? err.message : String(err);
	// An abort means the engine was reachable and working - the opposite of the
	// "not running, retry" advice below. Whatever was in flight may well have
	// completed engine-side, so say so instead of inviting a second send.
	if (err instanceof EngineTimeoutError) {
		return errorResult(
			`The engine did not answer within this client's ${Math.round(err.timeoutMs / 1000)}s budget. ` +
				`It may still have completed the call - check run history (list_runs) before retrying. ` +
				`For a target that is legitimately this slow, raise the engine's "defaultTimeout" ` +
				`with update_engine_config.`
		);
	}
	if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(msg))) {
		return errorResult(
			`The call was cancelled before the engine answered. It may still have completed - ` +
				`check run history (list_runs) before retrying. (${msg})`
		);
	}
	if (/ECONNREFUSED|fetch failed/i.test(msg)) {
		return errorResult(
			`Could not reach the Vayu engine. Make sure the Vayu app is running, then retry. (${msg})`
		);
	}
	return errorResult(`Unexpected error: ${msg}`);
}

/**
 * Wrap an engine call so transport errors surface as tool errors, not crashes.
 *
 * `shape` runs on the engine's answer before it becomes a result - the one seam
 * where a passthrough tool can bound what it hands an agent (issue #767).
 */
async function callEngine(
	fn: () => Promise<unknown>,
	shape?: (value: unknown) => unknown
): Promise<ToolResult> {
	try {
		const answer = await fn();
		return jsonResult(shape ? shape(answer) : answer);
	} catch (err) {
		return engineErrorResult(err);
	}
}

// --- Argument coercion helpers ----------------------------------------------

function str(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	return typeof v === "string" ? v : undefined;
}

/** An optional boolean argument, absent when the caller stated nothing. */
function bool(args: Record<string, unknown>, key: string): boolean | undefined {
	const v = args[key];
	return typeof v === "boolean" ? v : undefined;
}

function requireStr(args: Record<string, unknown>, key: string): string {
	const v = str(args, key);
	if (v === undefined || v === "") throw new ToolArgError(`"${key}" is required.`);
	return v;
}

/**
 * An optional array-of-strings argument. A non-array, or an array carrying
 * anything but strings, is the caller's mistake rather than an empty selection:
 * silently dropping the bad entries would answer a different question than the
 * one asked and look like the names simply were not defined.
 */
function stringArray(args: Record<string, unknown>, key: string): string[] | undefined {
	const v = args[key];
	if (v === undefined) return undefined;
	if (!Array.isArray(v) || v.some((entry) => typeof entry !== "string")) {
		throw new ToolArgError(`"${key}" must be an array of strings.`);
	}
	return v as string[];
}

class ToolArgError extends Error {}

/**
 * The refusal a data-mutating tool returns while the write toggle is off, or
 * null when writes are allowed. One wording for the collection / request /
 * environment tools: which of them was called does not change what the user has
 * to do about it, and a copy per tool is a copy per tool to drift.
 * `update_engine_config` keeps its own sentence, which names config.
 */
function writesDisabled(ctx: ToolContext): ToolResult | null {
	if (ctx.config.allowWrites) return null;
	return errorResult(
		"Writes are disabled. Turn on write access in Vayu Settings → MCP to allow this."
	);
}

/**
 * The run pinned as baseline for whatever saved request @p targetRunId ran -
 * `compare_runs`'s answer when the caller named no base, tool and prompt alike:
 * the prompt asked for both ids while the tool resolved one, so the same
 * question reached the agent two ways (issue #760). Exported for the prompt
 * rather than copied into it, since a second resolution rule would be a second
 * definition of "the baseline".
 *
 * Resolution is the engine's, not a scan here: `GET /runs?baseline=true&
 * requestId=...` is ordered newest-first, so "the baseline" is its first row.
 * That is the same question the history view's vs-baseline strip asks, so an
 * agent and the UI compare a run against the same pin.
 *
 * Every way this can fail to find one throws a message naming the fix, because
 * the alternative - silently comparing against some other run - is a wrong
 * answer presented as a right one. A run that has no saved request behind it
 * (an ad-hoc load run) has nothing to resolve *through*, which is a different
 * problem from a request with no pin, and says so.
 */
export async function resolveBaseline(
	targetRunId: string,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<string> {
	const run = (await ctx.client.getRun(targetRunId, signal)) as Record<string, unknown> | null;
	const requestId = run && typeof run.requestId === "string" ? run.requestId : null;
	if (!requestId) {
		throw new ToolArgError(
			`Run ${targetRunId} did not run a saved request, so it has no baseline to resolve. ` +
				`Pass "baseRunId" explicitly.`
		);
	}

	const page = (await ctx.client.listBaselineRuns(requestId, signal)) as {
		data?: Array<Record<string, unknown>>;
	} | null;
	const baseline = page?.data?.[0];
	const baseRunId = baseline && typeof baseline.id === "string" ? baseline.id : null;
	if (!baseRunId) {
		throw new ToolArgError(
			`No run is pinned as the baseline for request ${requestId}. Pin one in Vayu's ` +
				`history sidebar, or pass "baseRunId" explicitly.`
		);
	}
	if (baseRunId === targetRunId) {
		throw new ToolArgError(
			`Run ${targetRunId} is itself the baseline for request ${requestId}; there is ` +
				`nothing to compare it against. Pass "baseRunId" to compare it with another run.`
		);
	}
	return baseRunId;
}

// --- Confirmation gate -------------------------------------------------------

/**
 * Results that reported success while changing nothing - a confirmation
 * preview, or a prompt the user declined.
 *
 * Dispatch's rule is "a call that did not error changed what its tool
 * declares", and a gated tool is the one shape that breaks it: the preview's
 * whole point is that nothing happened, so emitting for it would refetch the
 * collection tree every time an agent asked what a delete would destroy - and
 * would say a run started when `start_load_run` only described one.
 *
 * A WeakSet rather than a field on {@link ToolResult}: the result object is
 * handed to the SDK verbatim (`server.ts`), so an extra property would be
 * serialized to the client as though it were part of the MCP result shape.
 */
const NOTHING_CHANGED = new WeakSet<ToolResult>();

/** Mark a successful result as having changed nothing (see {@link NOTHING_CHANGED}). */
function unchanged(result: ToolResult): ToolResult {
	NOTHING_CHANGED.add(result);
	return result;
}

/**
 * What the user is being asked to agree to. The two halves are worded per tool
 * because a load run and a cascade delete are agreed to for different reasons -
 * but the *mechanism* below is one implementation, so a fix to the elicitation
 * path reaches every gated tool.
 */
interface ConfirmationPrompt {
	/** The question, shown in the client's dialog and repeated in the preview. */
	message: string;
	/** Label of the boolean the client renders. */
	acceptTitle: string;
	acceptDescription: string;
	/** Returned when the human declines - states that nothing happened. */
	declined: string;
	/** Full text returned when the client cannot elicit and no flag was set. */
	preview: string;
}

/**
 * Ask the human before something destructive, however the client can manage it.
 *
 * Preferred path is elicitation - a real prompt to a real person. A client that
 * cannot elicit falls back to the agent-side flag: the first call returns a
 * preview and does nothing, and only a second call carrying `confirmed: true`
 * proceeds. Anti-accident rather than anti-adversary (an agent can set the flag
 * itself), which is the same posture `start_load_run` has always had; the
 * elicitation path is what upgrades it to a human decision.
 *
 * Returns `null` when the caller may proceed, or the result to return instead.
 */
async function confirmDestructive(
	args: Record<string, unknown>,
	ctx: ToolContext,
	prompt: ConfirmationPrompt
): Promise<ToolResult | null> {
	if (ctx.elicit) {
		try {
			const outcome = await ctx.elicit({
				message: prompt.message,
				requestedSchema: {
					type: "object",
					properties: {
						proceed: {
							type: "boolean",
							title: prompt.acceptTitle,
							description: prompt.acceptDescription,
						},
					},
					required: ["proceed"],
				},
			});
			if (outcome.action !== "accept" || outcome.content?.proceed === false) {
				return unchanged(textResult(prompt.declined));
			}
			return null;
		} catch {
			// Client can't elicit - fall through to the flag-based gate.
		}
	}
	if (args.confirmed !== true) return unchanged(textResult(prompt.preview));
	return null;
}

/** The `confirmed` fallback flag, declared identically on every gated tool. */
function confirmedInput(action: string) {
	return z
		.boolean()
		.optional()
		.describe(`Fallback confirmation for clients without elicitation: set true to ${action}.`);
}

/** The body modes whose content is a field list rather than a string. */
const FORM_BODY_MODES = new Set(["form-data", "x-www-form-urlencoded"]);

/**
 * The body an agent described, in the shape the engine reads.
 *
 * Both form modes carry their content as `fields` - the same
 * `{key, value, enabled}` rows the request builder and every importer produce
 * - so a `body` string is split on `&` into entries rather than handed over
 * whole. These two tools have advertised both modes all along while emitting
 * `{ mode, content }`, which the engine reads no `fields` from: before issue
 * #381 that meant an empty body on the wire, and now it is a refusal. Either
 * way the mode was documented and unusable; splitting here makes the schema's
 * promise true.
 *
 * Every field produced here is a **text** part. A `form-data` file part
 * (issue #393) names a path on the user's machine, which an agent has no way to
 * choose on their behalf and no way to verify - so MCP states the limit in the
 * two `bodyType` descriptions rather than inventing a shape for it.
 */
function bodyPayload(bodyType: string, content: string): Record<string, unknown> {
	if (!FORM_BODY_MODES.has(bodyType)) return { mode: bodyType, content };
	const fields = [...new URLSearchParams(content)].map(([key, value]) => ({
		key,
		value,
		enabled: true,
	}));
	return { mode: bodyType, fields };
}

/**
 * A whole number greater than zero, or `fallback` when the caller omitted the
 * argument.
 *
 * Rejects rather than clamps. The values this guards feed `Array.slice(-limit)`,
 * where a non-positive number does not mean "fewer rows" but *more* than asked
 * for - `0` returns everything, `-3` returns all but the three oldest - so a
 * silent repair would hand back a plausible-looking result built on an argument
 * the caller got wrong.
 */
function optionalPositiveInt(args: Record<string, unknown>, key: string, fallback: number): number {
	const v = args[key];
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
		throw new ToolArgError(`"${key}" must be a whole number greater than 0.`);
	}
	return v;
}

/**
 * A page size, refused above @p max rather than clamped to it (the #319
 * precedent): an agent that asked for 5000 rows and silently got 500 reads the
 * short page as the whole answer, which is the one failure a bound must not
 * produce.
 */
function optionalPageLimit(
	args: Record<string, unknown>,
	key: string,
	fallback: number,
	max: number
): number {
	const value = optionalPositiveInt(args, key, fallback);
	if (value > max) {
		throw new ToolArgError(
			`"${key}" must be ${max} or less. Read further rows with "offset" instead.`
		);
	}
	return value;
}

// --- Variable blobs ----------------------------------------------------------
//
// Environments and globals store their variables as one JSON blob that every
// write replaces wholesale (`PUT /environments/:id`, `POST /globals`), so
// "change one variable" is always read-merge-write here. One implementation for
// both, because the two blobs have the same shape and the same invariant
// (issue #314): a write must carry forward the flags it was not asked to
// change, or a rotated secret comes back unmasked and a disabled variable
// silently re-enables.

/**
 * One variable as an agent may state it: a bare value, or a value with the
 * flags the Variables drawer sets beside it.
 *
 * The string form is what `update_environment` has always taken and stays the
 * short spelling for the common case. The object form is what makes the flags
 * reachable at all - every field is optional, and an omitted one keeps whatever
 * is stored rather than resetting it, which is the same merge rule the value
 * itself follows.
 */
const VARIABLE_INPUT = z.union([
	z.string(),
	z.object({
		value: z.string().optional().describe("New value. Omitted keeps the stored one."),
		secret: z
			.boolean()
			.optional()
			.describe(
				"Mask this variable in the Vayu UI. App-side display only - MCP reads (list_environments, vayu://environments) return every value in full."
			),
		type: z
			.enum(["string", "number", "boolean", "json"])
			.optional()
			.describe("How the app renders and validates the value."),
		enabled: z
			.boolean()
			.optional()
			.describe("Whether the variable takes part in {{...}} resolution."),
	}),
]);

/** The `variables` argument, described for whichever blob it is writing. */
function variablesInput(subject: string) {
	return z
		.record(z.string(), VARIABLE_INPUT)
		.optional()
		.describe(
			`Variables to set on ${subject}, as a name -> value map. A value is either a string (sets the value, keeps every flag) or an object {value, secret, type, enabled} whose omitted fields keep their stored setting. Merges: variables not named here are left alone. ${VARIABLE_PRECEDENCE_SENTENCE} A name defined in a higher tier shadows what you write here - see ${VARIABLE_RESOLUTION_URI}.`
		);
}

/** The stored `variables` blob off a collection / environment / globals row. */
function variableBagOf(row: unknown): StoredVariableBag | undefined {
	if (!isRecord(row)) return undefined;
	const bag = row.variables;
	return isRecord(bag) ? (bag as StoredVariableBag) : undefined;
}

/**
 * The environment `resolve_variables` should resolve against.
 *
 * Three cases, deliberately distinct: a named id must exist (a typo resolving
 * silently against the active environment would report confident, wrong
 * answers), `"none"` is the explicit no-environment case that
 * `activate_environment` already spells that way, and an omitted id means the
 * active row - the same default a send takes.
 */
function pickEnvironment(rows: readonly unknown[], environmentId: string | undefined) {
	if (environmentId === "none") return undefined;
	if (environmentId !== undefined && environmentId !== "") {
		const found = rows.find((row) => isRecord(row) && row.id === environmentId);
		if (!found) throw new ToolArgError(`No environment with id "${environmentId}".`);
		return found as Record<string, unknown>;
	}
	return rows.find((row) => isRecord(row) && row.isActive === true) as
		Record<string, unknown> | undefined;
}

/**
 * Read every scope `resolve_variables` needs, in one pass over the engine's
 * lists. Globals are always read; the collection chain and the environment only
 * when the context names them.
 *
 * A `collectionId` that names nothing is refused rather than resolved as an
 * empty chain: "this collection defines none of these" and "there is no such
 * collection" are different answers, and an agent acting on the first when the
 * second is true writes to a collection that does not exist.
 */
async function gatherVariableScopes(
	ctx: ToolContext,
	collectionId: string | undefined,
	environmentId: string | undefined,
	signal?: AbortSignal
): Promise<OriginScopes> {
	const globals = variableBagOf(await ctx.client.getGlobals(signal));

	let chain: OriginScopes["chain"];
	if (collectionId !== undefined && collectionId !== "") {
		const listed = await ctx.client.listCollections(signal);
		const rows = (Array.isArray(listed) ? listed : []) as CollectionLike[];
		chain = collectionChain(rows, collectionId);
		if (chain.length === 0) throw new ToolArgError(`No collection with id "${collectionId}".`);
	}

	let environment: OriginScopes["environment"];
	if (environmentId !== "none") {
		const listed = await ctx.client.listEnvironments(signal);
		const rows = Array.isArray(listed) ? listed : [];
		const row = pickEnvironment(rows, environmentId);
		if (row) {
			environment = {
				id: typeof row.id === "string" ? row.id : undefined,
				name: typeof row.name === "string" ? row.name : undefined,
				variables: variableBagOf(row),
			};
		}
	}

	return { globals, chain, environment };
}

/**
 * What context the answer was computed in, echoed back so a report can be read
 * without re-deriving it. The environment is stated even when there is none:
 * "no environment was active" is why a value came from a collection, and an
 * omitted key would leave that to be guessed.
 */
function describeScopes(
	scopes: OriginScopes,
	collectionId: string | undefined,
	environmentId: string | undefined
): Record<string, unknown> {
	return {
		collectionId: collectionId ?? null,
		collectionChain: (scopes.chain ?? []).map((c) => ({ id: c.id, name: c.name })),
		environmentId: scopes.environment?.id ?? null,
		environmentName: scopes.environment?.name ?? null,
		environmentSelection:
			environmentId === "none"
				? "explicitly none"
				: environmentId
					? "named by the caller"
					: scopes.environment
						? "the active environment"
						: "no environment is active",
	};
}

/** The `removeVariables` argument - the delete a blank value cannot express. */
function removeVariablesInput(subject: string) {
	return z
		.array(z.string())
		.optional()
		.describe(
			`Variable names to delete from ${subject} outright. Setting a variable to an empty string leaves the name resolving to nothing; this removes it. A name that is not there is reported, not an error.`
		);
}

/**
 * Read the `variables` argument as a patch, refusing anything that is not a
 * name -> value map.
 *
 * The throwing form of the check `create_environment` / `update_environment`
 * make inline (`dispatchTool` turns a `ToolArgError` into the same tool error
 * their `errorResult` produces, with the same message). It is a function here
 * because the collection tools take the argument at two more call sites, and a
 * fourth hand-written copy of "is this an object" is how the four start
 * disagreeing about what a malformed one does.
 */
function readVariablesPatch(args: Record<string, unknown>): Record<string, unknown> | undefined {
	const value = args.variables;
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		throw new ToolArgError('"variables" must be an object mapping names to values.');
	}
	return value;
}

/** Read and validate `removeVariables` off raw arguments. */
function removalNames(args: Record<string, unknown>): string[] {
	const value = args.removeVariables;
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || name === "")) {
		throw new ToolArgError('"removeVariables" must be an array of variable names.');
	}
	return value as string[];
}

interface MergedVariables {
	/** The whole blob to write back. */
	variables: Record<string, unknown>;
	/** Names `removeVariables` asked for that the blob did not hold. */
	absentRemovals: string[];
}

/**
 * Lay a caller's patch over a stored variables blob.
 *
 * Removals run first and a name in both lists is refused rather than resolved:
 * "set it and delete it" has no correct order, so guessing one would apply half
 * of what the caller asked for and report success.
 *
 * A new variable must carry a value. Without that rule `{secret: true}` against
 * a mistyped name creates an empty secret variable and reports success - the
 * typo becomes a variable rather than an error. "New" covers a stored entry
 * that is not usable either (a bare string off disk, `lib/variable-resolution.ts`
 * D17), since there is no value there to keep.
 */
function mergeVariables(
	stored: unknown,
	patch: Record<string, unknown> | undefined,
	removals: readonly string[]
): MergedVariables {
	const merged: Record<string, unknown> = isRecord(stored) ? { ...stored } : {};
	const absentRemovals: string[] = [];
	const held = (name: string) => Object.prototype.hasOwnProperty.call(merged, name);

	for (const name of removals) {
		if (patch && Object.prototype.hasOwnProperty.call(patch, name)) {
			throw new ToolArgError(
				`"${name}" is named in both "variables" and "removeVariables". Pick one.`
			);
		}
		if (held(name)) delete merged[name];
		else absentRemovals.push(name);
	}

	for (const [name, input] of Object.entries(patch ?? {})) {
		const prev = merged[name];
		// The object guard keeps a malformed stored entry (a bare string, an
		// array) from spreading into index-keyed garbage - it is replaced with a
		// sane entry rather than merged onto.
		const base = isRecord(prev) ? prev : {};
		if (typeof input === "string") {
			// `enabled` leads the spread so a new (or malformed) entry defaults to
			// enabled while an existing explicit flag survives: writing a value
			// must not silently re-enable a variable the user disabled.
			merged[name] = { enabled: true, ...base, value: input };
			continue;
		}
		if (!isRecord(input)) {
			throw new ToolArgError(
				`"${name}" must be a string value, or an object with any of value, secret, type, enabled.`
			);
		}
		const stated: Record<string, unknown> = {};
		for (const field of ["value", "secret", "type", "enabled"] as const) {
			if (input[field] !== undefined) stated[field] = input[field];
		}
		if (stated.value === undefined && typeof base.value !== "string") {
			throw new ToolArgError(
				`"${name}" has no stored value to keep, so this call has to give it one: pass a string, or an object carrying "value".`
			);
		}
		merged[name] = { enabled: true, ...base, ...stated };
	}

	return { variables: merged, absentRemovals };
}

/**
 * What a removal list asked for and did not find, said in band.
 *
 * A name that was not there is not an error - a retried call whose first
 * attempt landed would otherwise fail on its own success - but it is not
 * nothing either: silence would let a mistyped name read as a variable
 * removed.
 */
function absentRemovalCaveat(names: readonly string[]): string {
	if (names.length === 0) return "";
	return `\n\nNothing to remove for: ${names.join(", ")} - no variable of that name was stored.`;
}

/**
 * An environment named in words, for the prompt that asks a human to delete it.
 *
 * The variable count is the part that has to be there, for the reason
 * `describeInbox`'s capture count is: an environment holding 20 variables and an
 * empty one are the same call with very different consequences. Whether it is
 * the *active* environment is the other half - deleting that one also drops
 * whatever every unsent tab was resolving against.
 */
function describeEnvironment(environmentId: string, environment: Record<string, unknown>): string {
	const name =
		typeof environment.name === "string" && environment.name !== ""
			? environment.name
			: environmentId;
	const count = isRecord(environment.variables) ? Object.keys(environment.variables).length : 0;
	const parts = [`${count} variable${count === 1 ? "" : "s"}`];
	if (environment.isActive === true) parts.push("currently active");
	return `the environment "${name}" (${parts.join(", ")})`;
}

/** A row offset: whole and non-negative, since 0 is the first page. */
function optionalOffset(args: Record<string, unknown>, key: string): number {
	const v = args[key];
	if (v === undefined || v === null) return 0;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new ToolArgError(`"${key}" must be a whole number of 0 or more.`);
	}
	return v;
}

/**
 * The request fields an agent stated directly, raw - and *only* the ones it
 * actually supplied, so this can be laid over a saved request by `POST
 * /compose` without a `method: "GET"` default clobbering its stored verb.
 *
 * Nothing here resolves `{{variables}}` anymore: composition - interpolation
 * and the `inherit` auth walk - is engine-owned (issue #226), and MCP hands
 * the engine raw strings. The body is emitted in the shape the engine's
 * `deserialize_request` reads - keyed off `mode`, not `type`, and carrying
 * `fields` rather than `content` for the two form modes (see `bodyPayload`).
 */
function readRequestOverrides(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	// Upper-cased because the engine's `parse_method` matches the verb exactly
	// (compose normalises this too; being explicit keeps previews readable).
	const method = str(args, "method");
	if (method !== undefined) out.method = method.toUpperCase();
	const url = str(args, "url");
	if (url !== undefined) out.url = url;
	if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
			headers[key] = String(value);
		}
		out.headers = headers;
	}
	const bodyContent = str(args, "body");
	if (bodyContent !== undefined) {
		out.body = bodyPayload(str(args, "bodyType") ?? "text", bodyContent);
	}
	// httpVersion is an override like any other field here: `POST /compose`
	// always emits a stored request's protocol, so a `start_load_run
	// { requestId, httpVersion }` must lay the agent's choice over it.
	// Forwarded only when the agent supplies one - on a URL-only call an
	// absent field already resolves to Auto engine-side. The `run_request` /
	// `start_load_run` Zod schemas restrict the value to a known protocol.
	const httpVersion = str(args, "httpVersion");
	if (httpVersion !== undefined) out.httpVersion = httpVersion;
	// Redirect policy is part of the request half, not the load shape: the app
	// sends both fields through `POST /compose` beside the method and the body
	// (`request-builder/index.tsx`), and the engine emits them on every composed
	// payload under the never-elided rule. Only `start_load_run` declares them -
	// `run_request` has no such argument, so nothing can arrive here from it -
	// because an ad-hoc load target has no saved request whose stored policy the
	// run could inherit.
	if (typeof args.followRedirects === "boolean") out.followRedirects = args.followRedirects;
	if (typeof args.maxRedirects === "number") out.maxRedirects = args.maxRedirects;
	return out;
}

/**
 * Compose a request engine-side and return the execute-ready payload.
 *
 * This is the one place MCP's execute/load tools obtain a resolved request:
 * `POST /compose` owns `{{variable}}` interpolation and the `inherit` auth
 * walk (issue #226 deleted the MCP-side copy). Composition is pure - nothing
 * is sent - which is what lets the caller run the allowlist gate on the
 * *resolved* URL before any traffic flows, and the composed payload is passed
 * to `/execute` or `/runs` unchanged: a value composition substituted is never
 * substituted again. What the engine does resolve past this point is the
 * leftovers - a name composition could not answer keeps its braces (#1009) and
 * is resolved after the pre-request script, before the send (#1008) - which is
 * why the gate refuses an unresolved *authority* rather than checking one.
 *
 * A 404 for a named `requestId` surfaces as a {@link ToolArgError} so the
 * agent reads "no such saved request", not a transport failure.
 */
async function composeViaEngine(
	client: EngineClient,
	body: Record<string, unknown>,
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	try {
		const composed = await client.composeRequest(body, signal);
		if (!composed || typeof composed !== "object" || Array.isArray(composed)) {
			throw new ToolArgError("Engine returned an unusable composed request.");
		}
		return composed as Record<string, unknown>;
	} catch (err) {
		if (err instanceof EngineRequestError && err.status === 404 && body.requestId) {
			throw new ToolArgError(`No saved request with id "${String(body.requestId)}".`);
		}
		throw err;
	}
}

/**
 * Start a streaming execute and read its events under the caller's bounds
 * (issue #575).
 *
 * `POST /execute` with `stream: true` answers `202 {runId, eventsUrl}` and
 * hands the transfer to an engine worker, so there is no exchange to return.
 * What an agent gets instead is this: the run it can follow up on, the events
 * that arrived within the bounds it named, and - in band, beside them - which
 * bound the read stopped at.
 *
 * The three stopping conditions are reported separately rather than collapsed
 * into "partial", because the follow-up differs: `completed` means the stream
 * is over and `get_run_report` has the whole story; `capReached` means raise
 * `maxStreamEvents`; `budgetExhausted` means the stream is still running and
 * `stop_run` ends it.
 */
async function runStreamingRequest(
	args: Record<string, unknown>,
	payload: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<ToolResult> {
	const maxEvents = optionalPositiveInt(args, "maxStreamEvents", DEFAULT_STREAM_MAX_EVENTS);
	const budgetMs = optionalPositiveInt(args, "streamBudgetMs", DEFAULT_STREAM_BUDGET_MS);
	if (budgetMs > MAX_STREAM_BUDGET_MS) {
		return errorResult(
			`"streamBudgetMs" must be ${MAX_STREAM_BUDGET_MS} or less - a tool call cannot hold the session longer. Start the stream, then follow it with get_run_report.`
		);
	}

	let started: Record<string, unknown>;
	try {
		const accepted = await ctx.client.executeRequest(payload, signal);
		if (!accepted || typeof accepted !== "object" || Array.isArray(accepted)) {
			return errorResult("Engine returned an unusable answer for a streaming request.");
		}
		started = accepted as Record<string, unknown>;
	} catch (err) {
		return engineErrorResult(err);
	}

	const runId = typeof started.runId === "string" ? started.runId : "";
	if (!runId) {
		// A payload the engine refused *after* the flag was read, or a buffered
		// answer to a request we asked to stream. Either way, hand back what it
		// said rather than reading events for a run that does not exist.
		return jsonResult(started);
	}

	let consumed;
	try {
		consumed = await ctx.client.consumeStreamEvents(runId, maxEvents, budgetMs, signal);
	} catch (err) {
		return engineErrorResult(err);
	}

	const budgetExhausted = !consumed.completed && !consumed.capReached;
	return structuredResult({
		runId,
		eventsUrl: started.eventsUrl,
		// The bounds this read ran under, beside what it produced - not in a
		// note the agent may or may not reach.
		maxStreamEvents: maxEvents,
		streamBudgetMs: budgetMs,
		completed: consumed.completed,
		capReached: consumed.capReached,
		budgetExhausted,
		...(consumed.endReason !== undefined && { endReason: consumed.endReason }),
		...(consumed.totalEvents !== undefined && { totalEvents: consumed.totalEvents }),
		eventCount: consumed.events.length,
		events: consumed.events,
		nextStep: consumed.completed
			? "The stream has ended. get_run_report has the stored events and any test results."
			: "The run is still streaming engine-side. Read more with get_run_report, or end it with stop_run.",
	});
}

/**
 * The post-response validation script an agent supplied, under either name.
 *
 * One concept, historically two engine keys: `POST /execute` grew up calling it
 * `postRequestScript`, `POST /runs` calls it `tests`. Both endpoints now read
 * both names (`read_post_request_script`), so the choice here is purely about
 * what an agent sees: MCP names it `postRequestScript` on both tools - the way
 * the app's single **Tests** tab drives Send and a load run alike - and keeps
 * `tests` accepted as the engine's own spelling. Supplying both is rejected
 * rather than silently resolved: with no way to know which the agent meant,
 * picking one would drop a script the agent believes is running.
 *
 * Ad-hoc, so this stays a plain string (still accepted by the engine's
 * `read_script`) rather than the `ScriptPart[]` the chain-composing callers
 * send - there is no collection chain here to collect parts from.
 */
function readValidationScript(args: Record<string, unknown>): string | undefined {
	const post = str(args, "postRequestScript");
	const tests = str(args, "tests");
	if (post !== undefined && tests !== undefined) {
		throw new ToolArgError(
			'Pass either "postRequestScript" or "tests", not both - they are the same script.'
		);
	}
	return post ?? tests;
}

/** Read an optional agent-supplied `auth` block (a `{ mode, … }` object). */
function readAuthArg(args: Record<string, unknown>): AuthRecord | undefined {
	const a = args.auth;
	return a && typeof a === "object" && !Array.isArray(a) ? (a as AuthRecord) : undefined;
}

/**
 * Build the request half of a `POST /runs` body - everything except the load
 * shape (mode, duration, concurrency…).
 *
 * **Two shapes, one rule.** Given a `requestId`, `POST /compose` composes the
 * saved request exactly as the app composes it for a load run and as
 * `run_collection_smoke` composes it for a Send - variables resolved, its
 * stored auth applied through the collection chain, and the chain's + its own
 * test scripts attached. Anything the agent states explicitly - url, method,
 * headers, body, auth, tests - is laid over the stored request *before*
 * resolution, so overrides carrying `{{variables}}` resolve too. Without a
 * `requestId` the run is ad-hoc and `url` is required.
 *
 * The composed scripts stay under `postRequestScripts`: `POST /runs` reads that
 * name as an alias of `tests` (`read_post_request_script`), which is what lets
 * one composed request start either kind of run without a second shape.
 *
 * `droppedPreRequestScripts` counts what a load run cannot honour - the engine
 * has no pre-request hook on `POST /runs`, so a saved request that signs itself
 * in a pre-request script goes out unsigned under load. Counted and reported
 * rather than dropped in silence.
 */
async function composeLoadRunRequest(
	args: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<{ payload: Record<string, unknown>; droppedPreRequestScripts: number }> {
	const savedId = str(args, "requestId");
	const overrides = readRequestOverrides(args);
	const authArg = readAuthArg(args);
	if (authArg) overrides.auth = authArg;

	const composeBody: Record<string, unknown> = {
		collectionId: str(args, "collectionId"),
		environmentId: str(args, "environmentId"),
		// This composed payload is repeated once per iteration, per virtual
		// user, so the `{{$guid}}` family belongs to each repetition, not to
		// this one-time composition - leave the tokens written as-is and let
		// the engine generate a fresh value per iteration at bind time
		// (issue #995).
		deferDynamicVariables: true,
	};
	if (savedId === undefined) {
		if (str(args, "url") === undefined) {
			throw new ToolArgError(
				'Pass "url" for an ad-hoc load run, or "requestId" to load-test a saved request.'
			);
		}
		composeBody.request = {
			...overrides,
			method: (overrides.method as string | undefined) ?? "GET",
			url: requireStr(args, "url"),
		};
	} else {
		composeBody.requestId = savedId;
		if (Object.keys(overrides).length > 0) composeBody.request = overrides;
	}

	const payload = await composeViaEngine(ctx.client, composeBody, signal);

	// A saved request's pre-request scripts cannot run under load; strip them
	// from the payload but report how many were dropped.
	const droppedPreRequestScripts = Array.isArray(payload.preRequestScripts)
		? payload.preRequestScripts.length
		: 0;
	delete payload.preRequestScripts;

	// An agent-written validation script replaces the composed one rather than
	// joining it, and must clear `postRequestScripts` to do so: /runs reads both
	// names, prefers the list, and would otherwise run the saved request's
	// assertions while silently ignoring the ones the agent asked for. This is
	// the only place either name is placed on a run payload - the handler does
	// not add it again.
	const adHocScript = readValidationScript(args);
	if (adHocScript !== undefined) {
		delete payload.postRequestScripts;
		payload.tests = adHocScript;
	}

	return { payload, droppedPreRequestScripts };
}

/**
 * Mode `start_load_run` sends when the agent names none. Closed-loop and
 * duration-bounded, so an unspecified run is one the duration cap can hold.
 */
const DEFAULT_LOAD_MODE = "constant_concurrency";

/**
 * The engine's `maxInFlight` guard (`run_config::MAX_IN_FLIGHT` in
 * `engine/include/vayu/core/constants.hpp`), mirrored here so the schema
 * rejects an out-of-range value by name instead of surfacing a 400.
 *
 * It is a literal rather than an import because production code in `electron/`
 * may not reach into `src/` - `tsconfig.node.json` withholds the `@/*` mapping
 * on purpose, so the import would not type-check. The copy is kept honest from
 * the test side, the way the dynamic-variable table already is: `tools.test.ts`
 * ties it to the renderer's `LOAD_TEST_LIMITS`, and
 * `src/constants/load-test.engine-parity.test.ts` ties that to this header.
 */
export const MAX_IN_FLIGHT_BOUND = 1_000_000;

/**
 * The engine's guards on the two numeric recording knobs
 * (`validate_run_config`, `engine/src/http/routes/execution.cpp`), mirrored for
 * the reason {@link MAX_IN_FLIGHT_BOUND} is: the schema refuses an
 * out-of-range value by name instead of surfacing a `400`.
 *
 * Deliberately *not* the load dialog's own ceilings - `LOAD_TEST_LIMITS`
 * narrows the slow threshold to a minute because that is a sensible thing to
 * put on a slider, not because the engine refuses more. A tool that copied the
 * slider's bound would refuse runs the engine accepts and the app cannot
 * compose.
 */
export const MAX_SUCCESS_SAMPLE_PERIOD = 100_000;
export const MAX_SLOW_THRESHOLD_MS = 86_400_000;

/**
 * The redirect ceiling `apply_request_fields` clamps a stored request to
 * (`std::clamp (r.max_redirects, 0, 100)`). `POST /runs` has no guard of its
 * own - the field reaches `CURLOPT_MAXREDIRS` as an `int`, where a negative
 * means *unlimited* - so this schema is the only thing between an agent's
 * `maxRedirects: -1` and a run that follows redirect chains forever. Refused
 * rather than clamped, like every other bound here: a value silently changed is
 * a run measuring something the agent did not ask for.
 *
 * Read by both surfaces that take the field - `requestSettingsInput`, which
 * writes it onto a saved request (issue #759), and `start_load_run`, which lays
 * it over a composed payload (#760) - so the two cannot come to disagree about
 * what the engine accepts.
 */
export const MAX_REDIRECTS_BOUND = 100;

/**
 * The recording knobs the app's load dialog sends, as `{tool argument: run
 * config key}`. Two spellings because the engine's are snake_case here and only
 * here - `success_sample_rate` is not a rate but a *period* (keep 1 in N), and
 * the app's own `StartLoadTestRequest` carries a comment saying so. The
 * argument is named for what the value means; the payload key stays the
 * engine's, so `get_run_report`'s echo of the config snapshot matches what a
 * run was started with.
 */
const LOAD_RECORDING_FIELDS: ReadonlyArray<[argument: string, configKey: string]> = [
	["successSamplePeriod", "success_sample_rate"],
	["slowRequestThresholdMs", "slow_threshold_ms"],
	["saveTimingBreakdown", "save_timing_breakdown"],
];

/**
 * Copy the recording knobs and the run comment onto a `POST /runs` payload.
 *
 * Shared by both load paths because both read them: a scenario load run is
 * driven by the same `RunContext`, whose constructor is the one place
 * `success_sample_rate` / `save_timing_breakdown` / `slow_threshold_ms` are
 * read (`core/run_manager.cpp`), and `comment` is lifted into the run summary
 * and the report's `metadata.configuration` by `routes/runs.cpp` whichever
 * executor produced the run. Forwarding them on one path only would have been a
 * knob that silently did nothing on the other.
 *
 * Absent stays absent - never defaulted - because each of these has an engine
 * default a stated value would overwrite, and "the caller said nothing" and
 * "the caller asked for the default" are the same run only by accident.
 */
function applyRecordingKnobs(
	args: Record<string, unknown>,
	payload: Record<string, unknown>
): void {
	for (const [argument, configKey] of LOAD_RECORDING_FIELDS) {
		const value = args[argument];
		if (typeof value === "number" || typeof value === "boolean") payload[configKey] = value;
	}
	const comment = str(args, "comment");
	if (comment !== undefined) payload.comment = comment;
}

/**
 * Copy the default-header opt-outs onto an execute or run payload (issue #1337).
 *
 * Beside the composed payload rather than through composition, for the reason
 * `data` is: composition resolves `{{variables}}` and the auth chain, and an
 * opt-out is neither - it is a send-time fact about the engine's own defaults,
 * never stored on a request and never interpolated. `POST /execute` and
 * `POST /runs` read it off the payload they are given.
 *
 * Absent stays absent: an empty list and no list say the same thing to the
 * engine, and sending one where the agent named none would be this layer
 * making a claim on its behalf.
 */
function applyDefaultHeaderOptOuts(
	args: Record<string, unknown>,
	payload: Record<string, unknown>
): void {
	const names = args.disabledDefaultHeaders;
	if (Array.isArray(names)) payload.disabledDefaultHeaders = names;
}

// --- Shared input schema fragments ------------------------------------------

/** Optional resolution scope shared by the ad-hoc execute/load tools. */
const collectionIdInput = z
	.string()
	.optional()
	.describe(
		"Optional collection ID. Scopes variable resolution to that collection's variable chain and lets auth mode 'inherit' resolve against it."
	);

const environmentIdInput = z
	.string()
	.optional()
	.describe("Optional environment ID whose variables resolve {{templates}} in this request.");

/**
 * The refusal an ad-hoc send gets for `verifySSL: false`, and with it the
 * answer to the per-call TLS question issue #795 posed.
 *
 * The stored field is writable (`create_request` / `update_request`) and a
 * per-call one is not, because the two differ in what survives the call. A
 * stored `verifySSL: false` is a document: the app's Settings tab shows the box
 * unticked and prints a warning under it, `list_requests` reads it back, and a
 * user can undo it. An argument on one send is visible only inside the agent's
 * own transcript - nothing in Vayu records that a certificate went unchecked,
 * so nobody can find it afterwards or take it back.
 *
 * The alternative considered was the `allowInsecureTls` safety toggle #795
 * sketched. Rejected: it would be a *global* permission - every allowlisted host
 * for the rest of the session, granted once for one dev box and then forgotten -
 * where the stored field is per request, and it would need a Settings control of
 * its own to be reachable at all, which is a second way to weaken TLS for a case
 * the first one already covers.
 *
 * `true` is accepted rather than refused alongside it: it is what the composed
 * payload already carries, so an agent restating the safe default should not be
 * argued with.
 */
/**
 * What the engine puts on a request nobody wrote it into (issue #1229).
 *
 * Every execute path adds these, so an agent comparing the response it got
 * against the request it wrote is otherwise looking at headers no tool
 * mentioned - and an agent testing "what does this endpoint do with no
 * `User-Agent`" had no way to find out that it cannot simply omit one.
 *
 * One sentence in one place, carried by the three tools that send traffic: three
 * paraphrases of the same rule are three things to keep in step with the engine.
 */
export const ENGINE_DEFAULT_HEADERS_SENTENCE =
	"Headers the engine adds itself: every request sent through Vayu that does not already name them gets a `User-Agent` (`Vayu/<version>`), an `Accept-Encoding` negotiating the compression this build can decode, and - only when the user has switched it on - a fresh per-request correlation id (`X-Vayu-Request-Id` by default). They are added at send time and never stored on a request, and a header you write under one of those names always wins, so setting `User-Agent` yourself is how you control what the target sees. Refusing one outright - sending no `User-Agent` at all - is the engine's `disabledDefaultHeaders` field, which names the headers a send declines; the app's Headers tab offers it as a tick per header, and run_request and start_load_run take it as an argument. run_collection_smoke does not: it replays each saved request exactly as stored, so a refusal there would be a per-send decision applied to requests the agent did not write.";

/**
 * The default headers one send refuses (issue #1337), as `disabledDefaultHeaders`.
 *
 * One fragment for the two tools that build a request payload: the field means
 * the same thing on `POST /execute` and `POST /runs`, and the engine reads it
 * off both through the same `read_default_header_opt_outs` (`utils/json.cpp`).
 *
 * Shape only. The engine owns what a usable header name is and refuses a bad
 * one by name, so a second copy of that rule here could only drift from it -
 * the same posture `thresholds` and the stream caps take.
 */
const defaultHeaderOptOutsInput = z
	.array(z.string())
	.optional()
	.describe(
		'Default headers this send refuses, by name (e.g. ["User-Agent", "Accept-Encoding"]). This is the only way to send a request with **no** User-Agent at all - writing one yourself replaces the value but still sends the header. Only the engine\'s own defaults are refusable; a name it adds nothing under is accepted and does nothing, and a name that cannot be a header name is refused by the engine. Nothing is stored: the refusal applies to this send alone.'
	);

export const INSECURE_TLS_REFUSAL =
	"verifySSL: false is not accepted on a one-off send - a skipped certificate check has to leave a record, and an argument on a single call leaves none. Two ways forward: ask the user to add the internal authority under Vayu Settings > Network & connectivity, which keeps verification on for every request; or save the request with create_request/update_request `verifySSL: false` and run it (run_collection_smoke composes a saved request exactly as stored). The app then shows that request as accepting any certificate, and the user can untick it.";

/**
 * `run_request`'s TLS argument: declared so that asking for the downgrade gets
 * {@link INSECURE_TLS_REFUSAL} - naming the two supported routes - rather than a
 * stripped unknown key and a handshake failure the agent has to guess at.
 */
const verifySSLSendInput = z
	.boolean()
	.optional()
	.describe(
		"Verify the server's TLS certificate (default true). Only `true` is accepted here: `false` is refused, because skipping the certificate check for one agent-issued send leaves no trace in Vayu afterwards. Save the request with `verifySSL: false` (create_request / update_request) if the user wants an internal or self-signed host reachable, or have them trust that authority under Vayu Settings > Network & connectivity."
	);

/**
 * The post-response validation script, declared identically on `run_request` and
 * `start_load_run` so one script an agent writes carries between them - the way
 * the app's single **Tests** tab drives both Send and a load run. See
 * `readValidationScript` for why the `tests` alias exists and stays.
 */
const validationScriptInput = z
	.string()
	.optional()
	.describe(
		"JavaScript run after a response arrives; use pm.test(...) for assertions, returned as test results. This is the same script the app's Tests tab holds - under load it runs against sampled responses, not every one. Read the `vayu://scripting/completions` resource for the sandbox's full surface (pm.expect chains, pm.response.to.*, the variable scopes) rather than assuming what exists."
	);

const validationScriptAliasInput = z
	.string()
	.optional()
	.describe(
		"Alias for `postRequestScript` (the engine's own name for it on a load run). Pass one or the other, not both."
	);

/**
 * How many events one budgeted read collects, and how long it may wait
 * (issue #575).
 *
 * Both bounds are the agent's to choose and both are reported back with the
 * result, because a list an agent believes is the whole stream and a list that
 * is the first `maxStreamEvents` of it lead to opposite conclusions. The
 * descriptions name the bound *before* the payload for the same reason the
 * budget-carrying tools already do: a caveat read after the data has been
 * believed is a caveat that arrived too late.
 */
const DEFAULT_STREAM_MAX_EVENTS = 50;
const DEFAULT_STREAM_BUDGET_MS = 5_000;
/** A ceiling on the ceiling: `tools/call` is request/response, and a caller
 *  that asked to wait five minutes would hold the whole MCP session. */
const MAX_STREAM_BUDGET_MS = 60_000;

/**
 * One data row bound to a single send (issue #601).
 *
 * The agent-facing half of what the app's Send-with-row does: `{{data.column}}`
 * tokens substitute against this row and both scripts read it as
 * `pm.iterationData`, without a collection run existing. `run_collection_smoke`
 * deliberately stays out of it - it has no scenario path at all (see mcp.md).
 *
 * The failure shape is named in the description because it is the useful half:
 * a column the row does not carry is a `400` naming the token and the row's
 * columns, and *nothing is sent* - so an agent reading the error can fix the
 * request rather than wondering what went out.
 *
 * Credentials bind too (issue #642), and the description says which mode does
 * not: an agent that is told "auth cannot bind" writes the token somewhere else
 * for no reason, and one told nothing writes it into an oauth2 config and gets
 * a 400 it cannot explain.
 */
const dataRowInput = z
	.record(z.string(), z.unknown())
	.optional()
	.describe(
		'One data row to bind, as an object of name/value pairs (e.g. {"id": "7", "email": "a@b.c"}). Every {{data.column}} in the URL, headers, body and auth credentials is substituted against it, and pre-request and post-response scripts read it as pm.iterationData (pm.info.iteration is 0). A column the row does not carry is an error naming the token and the row\'s columns, and nothing is sent. A credential binds before it is encoded, so basic auth base64s the row\'s values; the exception is OAuth 2.0, whose token comes from the token endpoint rather than the request, so a {{data.*}} in an oauth2 config is refused by name. Omit this to send without a row, which leaves {{data.*}} tokens written as they stand.'
	);

/**
 * Whether the bound contract is a gate, worded for the surface asking (issues
 * #720, #766).
 *
 * One fragment rather than a copy per tool, because the flag means the same
 * thing wherever it is offered - does a schema failure fail the unit - while
 * two things about it are genuinely per-surface: which unit one verdict
 * decides, and which way it defaults.
 *
 * **`run_collection_smoke` defaults to `true`, where the engine's `POST /runs`
 * flag defaults to `false`**, and the divergence is deliberate rather than an
 * oversight: that tool has folded a checked-and-failed schema verdict into `ok`
 * since #681, says so in its own description, and an agent that has been
 * reading its matrix would silently start seeing contract failures pass if the
 * default moved. Each surface keeps the default its readers already have. Off,
 * the verdict still rides every row: it stops deciding pass/fail, it is never
 * withheld.
 */
function failOnSchemaErrorInput(surface: {
	/** What one verdict decides here: a smoke row's request, or a run's step. */
	unit: string;
	/** This surface's default, stated in the description rather than implied. */
	defaultsOn: boolean;
	/** What the non-default setting buys, in this surface's own terms. */
	guidance: string;
}) {
	return z
		.boolean()
		.optional()
		.describe(
			`Whether a response that does not match the schema the collection's bound OpenAPI document declares fails its ${surface.unit} (default ${surface.defaultsOn}). ${surface.guidance} Only a checked verdict is ever folded in: a status or content type the document declares no schema for is reported unchecked and never fails a ${surface.unit}, with or without this.`
		);
}

/**
 * Why a schema gate cannot ride a load run, in the executor's own terms rather
 * than a bare "unsupported" (issue #766).
 *
 * `failOnSchemaError` is *declared* on `start_load_run` so this refusal can
 * reach an agent at all: the MCP SDK validates a call against the tool's schema
 * and **strips** what the schema does not declare, so an undeclared key would
 * be dropped before the handler ran and the run would start with the agent
 * believing a gate applied. Declared and refused, the answer names the flag and
 * the surface that honours it. It is refused on both of this tool's paths - a
 * scenario is not the reason, the executor is: `read_fail_on_schema_error` is
 * the scenario *runner*'s, and no load path reads it.
 */
const LOAD_RUN_SCHEMA_GATE_REFUSAL =
	`"failOnSchemaError" does not apply to a load run: the load executor validates sampled ` +
	`responses once the run has drained and never demotes a step, so a gate here would decide ` +
	`nothing. Nothing was started - the flag would have been read as shaping this run while ` +
	`no load path looks at it. The schema verdict rides the report's \`schemaValidation\` ` +
	`block either way. Remove it, or run the same collection in design mode with ` +
	`run_collection, which is where the gate takes effect.`;

/**
 * The two fields a scenario block carries besides its collection id, declared
 * here because both scenario surfaces take them and they must mean the same
 * thing on each (issue #754): `run_collection` runs the plan once through the
 * design runner, `start_load_run` drives the same plan with virtual users.
 *
 * `iterations` is deliberately not among them - see the scenario block on
 * `start_load_run` for why a load run reads the top-level one instead.
 *
 * Whether to descend into sub-collections, and in which order that happens.
 */
const scenarioRecursiveInput = z
	.boolean()
	.optional()
	.describe(
		"Descend into sub-collections (default false). The order is the sidebar's: at every level each sub-collection's whole subtree runs before that level's own requests."
	);

/**
 * The inline data set, in the shape `POST /runs` reads it.
 *
 * Inline because the engine never opens a file - the app parses CSV/TSV/JSON and
 * sends rows, and a path an agent chose would be a trust boundary neither side
 * wants. The engine's own `maxScenarioDataRows` / `maxScenarioDataBytes` bound
 * the array and its 400 is surfaced verbatim rather than re-derived here, which
 * would be a second copy of a limit the user can raise in Settings.
 */
const scenarioDataInput = z
	.array(z.record(z.string(), z.unknown()))
	.optional()
	.describe(
		'Data rows, one flat object per row (e.g. [{"id":"1"},{"id":"2"}]). Every {{data.column}} in a step\'s URL, headers, body and auth credentials is bound per iteration, and both scripts read the row as pm.iterationData. A step carrying a {{data.*}} token with no data set is refused by the engine before anything is sent, as is a present-but-empty array. The row set is not persisted - only its count is recorded on the run - but a bound value travels in the request that carried it, and the run stores each step\'s request and response until the run is pruned.'
	);

const streamInput = z
	.boolean()
	.optional()
	.describe(
		`Consume the response as a text/event-stream instead of buffering it (default false). BOUNDED, ALWAYS: this tool does not stream to you - it reads the run's events for at most \`streamBudgetMs\` milliseconds (default ${DEFAULT_STREAM_BUDGET_MS}) and returns at most \`maxStreamEvents\` of them (default ${DEFAULT_STREAM_MAX_EVENTS}). The result says which bound it stopped at (\`completed\`, \`capReached\`, \`budgetExhausted\`) and carries \`totalEvents\` where the engine knows it, so a partial read is never mistaken for the whole stream. The run keeps going engine-side after this returns; read it later with get_run_report, or end it with stop_run.`
	);

const maxStreamEventsInput = z
	.number()
	.int()
	.positive()
	.optional()
	.describe(
		`Streaming only: how many events to return before stopping the read (default ${DEFAULT_STREAM_MAX_EVENTS}). Reaching it sets \`capReached\` - the stream itself is not stopped.`
	);

const streamBudgetMsInput = z
	.number()
	.int()
	.positive()
	.optional()
	.describe(
		`Streaming only: how long to read events for, in milliseconds (default ${DEFAULT_STREAM_BUDGET_MS}, maximum ${MAX_STREAM_BUDGET_MS}). Reaching it sets \`budgetExhausted\`.`
	);

/**
 * A saved request's stored scripts, as `create_request` and `update_request`
 * write them - the two fields the engine keeps on the row
 * (`preRequestScript` / `postRequestScript`) and the app's **Pre-request** and
 * **Tests** tabs edit.
 *
 * One name per script here, deliberately. The `tests` alias exists on the *run*
 * tools because the engine spells an ad-hoc run body that way
 * (`readValidationScript`); a second name for a stored field would be a second
 * name to keep in step and a second way for an agent to half-write a script.
 *
 * `clearable` appends the merge-patch rule, which is `update_request`'s alone -
 * on a create there is no stored script to keep.
 */
function storedScriptInput(which: "pre" | "post", clearable: boolean) {
	const what =
		which === "pre"
			? "JavaScript stored on the request and run before it is sent - the app's Pre-request tab. Use it to sign or otherwise rewrite the request through pm.request."
			: "JavaScript stored on the request and run after its response arrives - the app's Tests tab. Use pm.test(...) for assertions. Same script `run_request` takes under this name, but persisted onto the request rather than supplied per call.";
	return z
		.string()
		.optional()
		.describe(
			`${what} Read the \`vayu://scripting/completions\` resource for the sandbox's surface rather than assuming what exists.` +
				(clearable
					? " Leave it out to keep the stored script; pass an empty string to clear it."
					: "")
		);
}

/**
 * A collection's stored scripts - the ones that run around *every* request in
 * it, not around one (issue #759).
 *
 * A separate fragment from `storedScriptInput` rather than a parameter on it,
 * because what an agent has to know here is the scope: a script written onto a
 * collection runs for every request below it, including the ones in its
 * sub-collections, so the blast radius of a wrong one is a whole tree rather
 * than a row. Both take the same clearing rule the request scripts do on an
 * update - the engine merge-patches strings, so an empty string is a value.
 */
function collectionScriptInput(which: "pre" | "post") {
	const when =
		which === "pre"
			? "before each request in this collection is sent, ahead of that request's own pre-request script"
			: "after each response in this collection arrives, ahead of that request's own test script";
	return z
		.string()
		.optional()
		.describe(
			`JavaScript stored on the collection and run ${when} - the app's collection-level scripts. It runs for every request in the collection and in its sub-collections, so scope it accordingly. Read the \`vayu://scripting/completions\` resource for the sandbox's surface. Leave it out to keep the stored script; pass an empty string to clear it.`
		);
}

/**
 * Optional auth block. Callers can copy a saved request's `auth` object verbatim
 * (read via list_requests). The engine applies it - bearer/basic/apikey and
 * oauth2 (using its token cache) - after `{{variables}}` inside it are resolved;
 * `inherit` resolves against the collection chain (supply collectionId).
 */
const authInput = z
	.object({ mode: z.string().describe("bearer | basic | apikey | oauth2 | inherit | none.") })
	.passthrough()
	.optional()
	.describe(
		"Optional auth block (e.g. { mode: 'bearer', token: '{{apiToken}}' }); the engine resolves and applies it."
	);

/**
 * The auth block as it is *stored* on a document, described for the resource
 * holding it (issue #759).
 *
 * The same schema `run_request` and `start_load_run` take - one definition, not
 * a copy - because a saved request's auth and an ad-hoc one are the same object
 * in the same shape, and an agent that read a request's `auth` over
 * `list_requests` must be able to write it back verbatim. What differs per
 * subject is only which modes are meaningful: a request may `inherit` (its
 * default), while a collection is the root of the chain and never does.
 */
function storedAuthInput(subject: string, extra: string) {
	return authInput.describe(
		`Auth block stored on ${subject}, in the same shape run_request takes - e.g. { mode: 'bearer', token: '{{apiToken}}' }. It is stored as written and resolved when the request is sent, so {{variables}} inside it are fine. ${extra}`
	);
}

/**
 * The **Settings** tab's five per-request fields, as the engine stores them on
 * the row (issues #759, #795).
 *
 * One definition spread into both `create_request` and `update_request`: the
 * fields mean the same thing on either verb, and the merge-patch difference is
 * carried by the surrounding tool description rather than by two copies of five
 * schemas. Ranges are the engine's own (`apply_request_fields`) rather than new
 * numbers - `maxRedirects` is clamped to 0-100 there, and an unrecognized
 * `httpVersion` is a 400 rather than a coercion, which is why the enum is
 * closed here too.
 *
 * `verifySSL` is the one whose description has to say what the field *means*
 * rather than what it sets: it is the only setting here whose off position is a
 * security downgrade, and an agent that reads "certificate verification" as a
 * strictness knob would turn it off to make a handshake stop failing. The
 * merge-patch rule matters more for it than for the other four for the same
 * reason - a defaulted `true` on an unrelated update would silently re-enable
 * verification a user turned off, and the request would then fail against the
 * host it was written for.
 */
function requestSettingsInput() {
	return {
		followRedirects: z
			.boolean()
			.optional()
			.describe(
				"Follow 3xx redirects when this request is sent (default true). The request builder's Settings tab."
			),
		maxRedirects: z
			.number()
			.int()
			.min(0)
			.max(MAX_REDIRECTS_BOUND)
			.optional()
			.describe(
				`How many redirects to follow before giving up (default 10, 0-${MAX_REDIRECTS_BOUND}).`
			),
		httpVersion: z
			.enum(HTTP_VERSIONS)
			.optional()
			.describe(
				'Protocol to negotiate when this request is sent: "auto" | "http1.1" | "http2" (default "auto").'
			),
		stream: z
			.boolean()
			.optional()
			.describe(
				"Consume the response as a text/event-stream rather than buffering it (default false). Stored on the request, so a later send - from the app or from run_request - streams without being told to."
			),
		verifySSL: z
			.boolean()
			.optional()
			.describe(
				"Verify the server's TLS certificate when this request is sent (default true). Setting it false skips the certificate check entirely, hostname included, so an internal or self-signed host answers instead of failing - and anything on the network path can then read and rewrite the request. It is stored on the request and applies to every later send of it: the app's Send, a load run and a stream alike. Prefer keeping it on and having the user add the internal authority under Vayu Settings > Network & connectivity; turn it off only when they have asked for exactly that, and say so in your reply, because the app shows this request as accepting any certificate from then on."
			),
	};
}

/**
 * The stored settings a call named, forwarded verbatim; an unnamed one is absent.
 *
 * Every key {@link requestSettingsInput} declares appears here - the schema
 * declares the shape, this list is what the payload builder actually reads, so a
 * field added to one and not the other is an argument the engine never sees.
 */
export const REQUEST_SETTINGS_KEYS = [
	"followRedirects",
	"maxRedirects",
	"httpVersion",
	"stream",
	"verifySSL",
] as const;

/**
 * Lay the caller's stored-settings fields onto a request payload.
 *
 * Values pass through unvalidated on purpose: the schema above owns the shapes,
 * and the engine owns the ranges - re-deriving either here would be a second
 * copy that refuses what the engine accepts the moment one side moves. What
 * this owns is the *absent* rule, which is the merge-patch contract: a field the
 * caller did not name is never written, so an update cannot silently reset the
 * redirect policy a user set in the app.
 */
function applyRequestSettings(
	args: Record<string, unknown>,
	payload: Record<string, unknown>
): void {
	for (const key of REQUEST_SETTINGS_KEYS) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
}

// --- OAuth 2.0 token cache ---------------------------------------------------

/**
 * The `oauth2` config block, shaped as the engine reads it (`oauth_client.cpp`)
 * and as a saved request's `auth` already carries it - so an agent can lift the
 * block out of `list_requests` and hand it to `fetch_oauth2_token` unchanged.
 *
 * `passthrough` rather than an enumerated object for the same reason
 * {@link authInput} is: the engine owns which fields a grant needs, and a
 * closed schema here would refuse a config the engine accepts the day a field
 * is added. What is enumerated is the one field this layer decides on -
 * `grantType`, because the interactive grant is refused before the call.
 */
const oauth2ConfigInput = z
	.object({
		grantType: z
			.string()
			.describe(
				"client_credentials | password. `authorization_code` is refused here - it needs a browser, so authorize it in the app."
			),
		accessTokenUrl: z.string().describe("The provider's token endpoint (http(s))."),
		clientId: z.string().describe("OAuth 2.0 client id."),
	})
	.passthrough()
	.describe(
		"The OAuth 2.0 config to acquire a token for - the same block a saved request's `auth` carries, so it can be copied from list_requests verbatim. Beyond the three required fields the engine reads clientSecret, username/password (password grant), scope, audience, resource, refreshTokenUrl, autoRefreshToken, clientAuthentication and credentialsId. The cache key is derived from accessTokenUrl + clientId + credentialsId + username: configs differing only in scope share one cached token, so set a distinct `credentialsId` to keep them apart."
	);

/** The engine-derived key one cache entry lives under. */
const oauth2CacheKeyInput = z
	.string()
	.describe(
		"The cache key, as returned in `cacheKey` by fetch_oauth2_token (or shown by the app's auth tab). Derived engine-side from the config; there is no way to compose one here that would be guaranteed to match."
	);

/**
 * Why the interactive grant is refused rather than attempted.
 *
 * Two reasons, and the second is the load-bearing one. It cannot work: the
 * exchange needs a browser and the loopback listener `oauth_authorize.cpp`
 * binds, which the app drives and MCP has no place in. And it must not be
 * *attempted*, because `acquire_token` answers a cache hit before it ever looks
 * at the grant - so a call naming a config whose accessTokenUrl / clientId /
 * credentialsId happen to match an entry the user authorized interactively
 * would return that entry without proving anything. Refusing on `grantType`
 * closes the shape of that call rather than trusting the redaction below to
 * make it harmless.
 */
const OAUTH2_INTERACTIVE_REFUSAL =
	'The `authorization_code` grant is not available over MCP: it redirects through a browser to a loopback listener the app owns, and an agent cannot complete that exchange. Authorize it once in Vayu (the request\'s Auth tab -> "Get New Access Token"); the token lands in the same engine cache these tools read, so get_oauth2_token_status and clear_oauth2_token work on it afterwards. For a machine-to-machine flow use `client_credentials`.';

/**
 * The engine's token record with the bearer removed.
 *
 * **The decision, stated rather than implied:** no MCP tool returns access
 * token bytes. The engine is what applies a token to a request - an agent names
 * a config and the run authenticates - so the bytes buy an agent nothing it can
 * use through Vayu, while handing them over turns a token the *user* acquired
 * (including through a browser flow no agent could complete) into something an
 * agent can carry off this machine. Everything an agent legitimately needs from
 * the cache is its shape: which key, what type, which scopes, when it expires,
 * whether a refresh token came with it.
 *
 * `accessTokenWithheld` is stated rather than left as a silent omission,
 * because an agent that finds no `accessToken` and is not told why concludes
 * the acquisition half-failed and retries with `force`.
 */
export function projectOAuth2Token(token: unknown): unknown {
	if (!isRecord(token)) return token;
	const { accessToken: _withheld, ...rest } = token;
	return { ...rest, accessTokenWithheld: true };
}

/** `GET /oauth2/token`'s answer, with the nested token record projected. */
export function projectOAuth2Status(status: unknown): unknown {
	if (!isRecord(status)) return status;
	if (!isRecord(status.token)) return status;
	return { ...status, token: projectOAuth2Token(status.token) };
}

// --- Structured output schemas ----------------------------------------------

const metricDeltaSchema = z.object({
	metric: z.string(),
	base: z.number().nullable(),
	target: z.number().nullable(),
	delta: z.number().nullable(),
	pctChange: z.number().nullable(),
	// Which way is an improvement. Without it a reader has to know that falling
	// latency is good and falling throughput is not; `neutral` marks the metric
	// (total requests) where neither direction is a verdict.
	direction: z.enum(["lower-is-better", "higher-is-better", "neutral"]),
});

const runComparisonSchema = z.object({
	baseRunId: z.string(),
	targetRunId: z.string(),
	latency: z.array(metricDeltaSchema),
	throughput: z.array(metricDeltaSchema),
	reliability: z.array(metricDeltaSchema),
	statusCodes: z.record(z.string(), z.object({ base: z.number(), target: z.number() })),
});

const engineHealthSchema = z
	.object({ status: z.string(), version: z.string().optional() })
	.passthrough();

/** Whether a `GET /health` body can be returned as `structuredContent` as-is. */
function isEngineHealthShape(value: unknown): value is Record<string, unknown> {
	return engineHealthSchema.safeParse(value).success;
}

const smokeResultSchema = z.object({
	collectionId: z.string(),
	total: z.number(),
	passed: z.number(),
	failed: z.number(),
	skipped: z.number(),
	results: z.array(
		z.object({
			name: z.string(),
			method: z.string(),
			url: z.string(),
			ok: z.boolean(),
			statusCode: z.number().optional(),
			skipped: z.boolean().optional(),
			reason: z.string().optional(),
			error: z.string().optional(),
			/*
			 * What the collection's bound OpenAPI document says about this
			 * response (issue #681). Absent for a collection bound to nothing -
			 * a response nobody judged against a contract did not fail one - and
			 * declared here because a field returned but not declared is
			 * rejected by the SDK before an agent ever sees it.
			 */
			schema: z
				.object({
					checked: z.boolean(),
					valid: z.boolean().optional(),
					reason: z.string().optional(),
					failuresTotal: z.number().optional(),
					failures: z.array(z.string()).optional(),
				})
				.optional(),
			/*
			 * What this request's own post-request script asserted (issue #733).
			 * A schema verdict explains itself on the row; a test failure did
			 * not - `ok:false` beside `statusCode: 200` named no reason at all,
			 * while the detail sat in the `/execute` body this tool had just
			 * read. Absent when the response carried no test results, which is
			 * not the same as every assertion passing.
			 */
			tests: z
				.object({
					total: z.number(),
					failed: z.number(),
					failures: z.array(z.string()).optional(),
				})
				.optional(),
		})
	),
});

/**
 * How many failed-test names one smoke row carries.
 *
 * Ten, the number the engine caps a schema verdict's `failures` at
 * (`constants::schema_validation::MAX_FAILURES`), because the two lists ride
 * the same row and are read the same way. Nothing caps `testResults` upstream -
 * a script may write as many assertions as it likes - so the cap has to be
 * here, and `failed` stays the true total so a cut list is visible as one.
 */
const MAX_TEST_FAILURES_PER_ROW = 10;

/**
 * Both scripts' assertions, flattened for a tool result (#733).
 *
 * Rendered `name: message` for the reason the schema failures are: an agent
 * reads this as text. `undefined` means the response carried no test results at
 * all - the one state that must not become `{total: 0, failed: 0}`, which would
 * say the script asserted nothing and everything held, when no script ran.
 *
 * A pre-request assertion is labelled (issue #810). The engine lists both
 * scripts' assertions now, and an assertion made before the request went out
 * fails for different reasons than one about the response - an agent told only
 * the name would read every failure as the latter. Nothing labels the
 * post-request ones: they are what this list has always been.
 */
function readTestVerdict(
	resp: Record<string, unknown>
): { total: number; failed: number; failures?: string[] } | undefined {
	if (!Array.isArray(resp.testResults)) return undefined;
	const tests = resp.testResults as Array<{
		name?: unknown;
		passed?: unknown;
		error?: unknown;
		source?: unknown;
	}>;
	if (tests.length === 0) return undefined;
	const failed = tests.filter((t) => t.passed === false);
	const failures = failed.slice(0, MAX_TEST_FAILURES_PER_ROW).map((t) => {
		const bare = typeof t.name === "string" && t.name ? t.name : "(unnamed test)";
		const name = t.source === "pre" ? `[pre-request] ${bare}` : bare;
		const message = typeof t.error === "string" ? t.error.trim() : "";
		return message ? `${name}: ${message}` : name;
	});
	return {
		total: tests.length,
		failed: failed.length,
		...(failures.length > 0 ? { failures } : {}),
	};
}

/**
 * The schema verdict a `POST /execute` body carries, flattened for a tool
 * result (issue #681).
 *
 * The failures are rendered `path: message` rather than passed through as
 * objects: an agent reads this as text, and the engine has already capped the
 * list. `undefined` means the engine wrote no verdict at all, which is the one
 * state that must not become `{checked: false}` - that would say the contract
 * could not judge this response, when there was no contract.
 */
function readSchemaVerdict(resp: Record<string, unknown>): Record<string, unknown> | undefined {
	const node = resp.validation;
	if (!node || typeof node !== "object") return undefined;
	const v = node as {
		checked?: unknown;
		valid?: unknown;
		reason?: unknown;
		failuresTotal?: unknown;
		failures?: unknown;
	};
	if (typeof v.checked !== "boolean") return undefined;
	const failures = Array.isArray(v.failures)
		? (v.failures as Array<{ path?: unknown; message?: unknown }>).map((f) =>
				`${typeof f.path === "string" && f.path ? f.path : "(body)"}: ${
					typeof f.message === "string" ? f.message : ""
				}`.trim()
			)
		: undefined;
	return {
		checked: v.checked,
		...(typeof v.valid === "boolean" ? { valid: v.valid } : {}),
		...(typeof v.reason === "string" ? { reason: v.reason } : {}),
		...(typeof v.failuresTotal === "number" ? { failuresTotal: v.failuresTotal } : {}),
		...(failures && failures.length > 0 ? { failures } : {}),
	};
}

const configUpdateSchema = z
	.object({
		changedKeys: z.array(z.string()),
		restartRequired: z.array(z.string()),
	})
	.passthrough();

/**
 * Of the changed config keys, which require an engine restart to take effect.
 *
 * The engine says so in a typed `requiresRestart` field on each entry
 * (`engine/src/http/routes/config.cpp`), read here and in `SettingsMain.tsx`.
 * It replaced a "… (Requires Restart)" substring in the entry's `label` that
 * both consumers regex-matched out of the prose - so a label that fell out of
 * step with the mechanism (the `workers` case, #197) misinformed an agent and
 * the settings screen at once, and no rewording of the copy could be made
 * without minding this parser.
 *
 * Strictly `=== true`: this decides whether the tool result tells an agent its
 * change is live, and a payload that omits the field (an engine older than the
 * app it is paired with) has not said that it does not need one.
 *
 * `update_config`'s `restartRequired` result shape is unchanged.
 */
function restartRequiredAmong(configResponse: unknown, changedKeys: string[]): string[] {
	const raw = Array.isArray(configResponse)
		? configResponse
		: configResponse && typeof configResponse === "object"
			? ((configResponse as Record<string, unknown>).entries ?? [])
			: [];
	const entries = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
	const byKey = new Map(entries.map((e) => [String(e.key), e]));
	return changedKeys.filter((key) => byKey.get(key)?.requiresRestart === true);
}

/**
 * The direct sub-collections of `collectionId`, by name.
 *
 * `GET /requests?collectionId=` returns a collection's *direct* requests only
 * (the DB filters on `collection_id ==`), while collections nest via `parentId`
 * - so a smoke run on a parent leaves every descendant folder untested. This
 * names them so the result can say so.
 *
 * Returns `null` when the collection list could not be read: the caller
 * discloses "could not check" rather than the absence of children, since the
 * two are not the same claim.
 */
async function childCollectionNames(
	client: EngineClient,
	collectionId: string,
	signal?: AbortSignal
): Promise<string[] | null> {
	let all: unknown;
	try {
		all = await client.listCollections(signal);
	} catch {
		return null;
	}
	if (!Array.isArray(all)) return null;
	const names: string[] = [];
	for (const item of all) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (rec.parentId === collectionId) names.push(String(rec.name ?? rec.id ?? "unnamed"));
	}
	return names;
}

/** The disclosure `run_collection_smoke` attaches about folders it did not run. */
function smokeScopeCaveat(children: string[] | null): string {
	if (children === null) {
		return (
			"\n\nNote: could not read the collection list, so any sub-collections could not be " +
			"checked. This tool runs a collection's direct requests only - requests in nested " +
			"folders are never included."
		);
	}
	if (children.length === 0) return "";
	return (
		`\n\nNote: ${children.length} sub-collection(s) were NOT run - this tool runs a ` +
		`collection's direct requests only, and the counts above exclude every request nested ` +
		`inside: ${children.join(", ")}. Call run_collection_smoke on each to cover them.`
	);
}

// --- Scenario runs (a collection as the unit of work) ------------------------

/** A step of a scenario plan, as much of it as the pre-flight walk needs. */
interface ScenarioStepRow {
	id: string;
	name: string;
}

/**
 * The saved requests a scenario run will execute, in the order the engine will
 * execute them (issue #754).
 *
 * Mirrors `collect_requests` (`engine/src/core/scenario_plan.cpp`): without
 * `recursive` a collection's direct requests are the whole plan; with it, every
 * sub-collection's subtree is emitted **before** that level's own requests, which
 * is the order the sidebar renders. The order matters here for one reason - the
 * pre-flight refusal names the first step that fails - so a walk in some other
 * order would name a different step than the run would have reached first.
 *
 * The `visited` set is the same guard the engine's walk carries: a corrupted
 * `parentId` (a self-parent, an A -> B -> A loop) must terminate rather than
 * enumerate forever.
 */
async function scenarioStepRows(
	client: EngineClient,
	collectionId: string,
	recursive: boolean,
	signal?: AbortSignal
): Promise<ScenarioStepRow[]> {
	const requestsIn = async (id: string): Promise<ScenarioStepRow[]> => {
		const rows = await client.listRequests(id, signal);
		return (Array.isArray(rows) ? rows : []).map((row) => {
			const rec = (row ?? {}) as { id?: unknown; name?: unknown };
			return {
				id: typeof rec.id === "string" ? rec.id : "",
				name: String(rec.name ?? rec.id ?? "request"),
			};
		});
	};
	if (!recursive) return requestsIn(collectionId);

	const all = await client.listCollections(signal);
	// One read, grouped by parent - `GET /collections` is ordered by `order`, so
	// each parent's children keep that order without a sort here.
	const childrenOf = new Map<string, string[]>();
	for (const item of Array.isArray(all) ? all : []) {
		if (!item || typeof item !== "object") continue;
		const rec = item as { id?: unknown; parentId?: unknown };
		if (typeof rec.id !== "string" || typeof rec.parentId !== "string" || !rec.parentId) {
			continue;
		}
		childrenOf.set(rec.parentId, [...(childrenOf.get(rec.parentId) ?? []), rec.id]);
	}

	const ordered: ScenarioStepRow[] = [];
	const visited = new Set<string>();
	// Two entry kinds on one stack, exactly as the engine walks it: `emit` is
	// pushed *under* the children, so a folder's own requests come last.
	const stack: Array<{ step: "descend" | "emit"; id: string }> = [
		{ step: "descend", id: collectionId },
	];
	while (stack.length > 0) {
		const entry = stack.pop() as { step: "descend" | "emit"; id: string };
		if (entry.step === "emit") {
			ordered.push(...(await requestsIn(entry.id)));
			continue;
		}
		if (visited.has(entry.id)) continue;
		visited.add(entry.id);
		stack.push({ step: "emit", id: entry.id });
		const children = childrenOf.get(entry.id) ?? [];
		for (let i = children.length - 1; i >= 0; i--) {
			stack.push({ step: "descend", id: children[i] });
		}
	}
	return ordered;
}

/**
 * How a step is named in a refusal: the engine's own `describe_step` wording
 * (`scenario_plan.cpp`), including its zero-based index, so a pre-flight refusal
 * and the engine's own refusal for the same step read identically.
 */
function describeScenarioStep(index: number, row: ScenarioStepRow): string {
	return `step ${index} (request '${row.name}', id '${row.id}')`;
}

/**
 * Gate every step of a scenario against the allowlist *before* the run exists,
 * and return how many steps the plan has.
 *
 * A scenario is one run: there is no per-step skip the way `run_collection_smoke`
 * has one, because the engine starts the whole sequence or none of it. So a
 * single un-allowlisted step refuses the run and **nothing is started** - the
 * alternative would be an agent generating traffic against a host it was never
 * pointed at, in the middle of a sequence it cannot stop selectively.
 *
 * Composition is the engine's, by id, with the caller's environment - the same
 * call `resolve_scenario` makes for each step, which is what makes the URL this
 * gate reads the URL the run would send to. A step that will not compose refuses
 * here too: the engine resolves the identical plan before it creates the run row
 * and would refuse it for the same reason, so failing early costs nothing and
 * says so in the same words.
 *
 * Throws {@link ToolArgError} for a refusal; engine transport failures propagate
 * to the caller's `engineErrorResult`.
 */
async function preflightScenarioSteps(
	target: { collectionId: string; recursive: boolean; environmentId?: string },
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<number> {
	const rows = await scenarioStepRows(ctx.client, target.collectionId, target.recursive, signal);
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const step = describeScenarioStep(index, row);
		let composed: Record<string, unknown>;
		try {
			composed = await composeViaEngine(
				ctx.client,
				{ requestId: row.id, environmentId: target.environmentId },
				signal
			);
		} catch (err) {
			throw new ToolArgError(
				`Cannot compose ${step}: ${err instanceof Error ? err.message : String(err)}. ` +
					`Nothing was started - the engine resolves this same plan before it creates the ` +
					`run, and would refuse it for this reason too.`
			);
		}
		const url = String(composed.url ?? "");
		const gate = checkAllowlist(url, ctx.config);
		if (!gate.ok) {
			throw new ToolArgError(
				`Refusing to run this collection: ${step} sends to ${url}. ${gate.error} ` +
					`Nothing was started - a scenario runs as one sequence, so a single step the ` +
					`allowlist does not cover refuses all ${rows.length} of them.`
			);
		}
	}
	return rows.length;
}

/** The scenario block an agent passed to `start_load_run`, if it passed one. */
function readScenarioArg(
	args: Record<string, unknown>
): { collectionId: string; recursive?: boolean; data?: unknown[] } | undefined {
	const block = args.scenario;
	if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
	return block as { collectionId: string; recursive?: boolean; data?: unknown[] };
}

/**
 * `start_load_run`'s arguments that describe a *single* target, which a scenario
 * replaces wholesale, mapped to what an agent should do instead.
 *
 * Refused rather than ignored: each of these would otherwise be an argument an
 * agent believes shaped the run and that nothing on the scenario path ever reads
 * - the codebase's most-repeated defect, arriving through the front door. The
 * steps are saved requests, so their method, body, auth, protocol and scripts
 * are the stored ones, composed per step.
 */
const SINGLE_TARGET_LOAD_FIELDS: ReadonlyArray<[string, string]> = [
	["url", "a scenario's targets are the collection's saved requests"],
	["requestId", "a scenario runs a collection, not one saved request"],
	["method", "each step keeps its own stored method"],
	["headers", "each step keeps its own stored headers"],
	["body", "each step keeps its own stored body"],
	["bodyType", "each step keeps its own stored body"],
	["auth", "each step's auth is resolved from the request and its collection chain"],
	["httpVersion", "each step keeps its own stored protocol"],
	[
		"followRedirects",
		"each step keeps its own stored redirect policy - set it on the saved request",
	],
	[
		"maxRedirects",
		"each step keeps its own stored redirect policy - set it on the saved request",
	],
	[
		"data",
		"a collection run states its rows as `scenario.data`, where one row is bound per iteration and shared by every step",
	],
	[
		"disabledDefaultHeaders",
		"the engine reads a send's default-header refusals off one request's payload, and a scenario's steps are each composed from their own saved request",
	],
	["postRequestScript", "each step runs the scripts stored on it and its collection chain"],
	["tests", "each step runs the scripts stored on it and its collection chain"],
	[
		"collectionId",
		"the collection to run is `scenario.collectionId`; this argument only scopes variable resolution for a single ad-hoc target",
	],
	["maxInFlight", "in-flight requests are bounded by the virtual-user count (`concurrency`)"],
	["sloMs", "that is `capacity` mode's field, and a scenario cannot run in capacity mode"],
	["stepDuration", "that is `capacity` mode's field, and a scenario cannot run in capacity mode"],
	["stream", "run-level stream bounds are applied to a single-target run's request only"],
	[
		"maxStreamDurationMs",
		"run-level stream bounds are applied to a single-target run's request only",
	],
	[
		"maxStreamEvents",
		"run-level stream bounds are applied to a single-target run's request only",
	],
];

/** The modes the engine will drive a scenario with (`validate_scenario_load_config`). */
const SCENARIO_LOAD_MODES = ["constant_concurrency", "ramp_up", "iterations"] as const;

/**
 * Why the engine refuses the other two modes, in its own reasoning rather than a
 * bare "unsupported": an agent told *why* `constant_rps` cannot drive a sequence
 * picks `constant_concurrency`, and one told only "no" tries again.
 */
function scenarioModeRefusal(mode: string): string | null {
	if ((SCENARIO_LOAD_MODES as readonly string[]).includes(mode)) return null;
	const shared = `Scenario load runs accept ${SCENARIO_LOAD_MODES.join(", ")}.`;
	if (mode === "capacity") {
		return (
			`"capacity" is not available for scenario runs: the search judges one windowed p99, ` +
			`and a sequence has one per step - which of them is "the" latency the knee is measured ` +
			`against is a question the mode does not answer. ${shared}`
		);
	}
	if (mode === "constant_rps") {
		return (
			`"constant_rps" is not available for scenario runs: an open-loop arrival rate over a ` +
			`multi-step sequence is an arrival-rate executor, which Vayu does not implement. ` +
			`${shared} For a scenario, "concurrency" is the number of virtual users.`
		);
	}
	return `Unknown load mode "${mode}" for a scenario run. ${shared}`;
}

/**
 * Start a scenario **load** run: the collection's plan driven by virtual users
 * (issue #754, reversing #454's deferral).
 *
 * Split from `start_load_run`'s single-target path rather than folded into it,
 * because the two share only their gates: there is no request to compose here
 * (every step composes engine-side at plan time), no url to check (the
 * pre-flight walk checks every step's), and a different set of load fields
 * applies. What they do share - the allowlist, `checkLoadCaps`, the duration
 * default under the cap, and the confirmation - runs through the same helpers,
 * so a cap raised in Settings binds both paths identically.
 */
async function startScenarioLoadRun(
	args: Record<string, unknown>,
	scenario: { collectionId: string; recursive?: boolean; data?: unknown[] },
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<ToolResult> {
	const inapplicable = SINGLE_TARGET_LOAD_FIELDS.filter(([key]) => args[key] !== undefined);
	if (inapplicable.length > 0) {
		return errorResult(
			`These arguments do not apply to a scenario load run: ` +
				inapplicable.map(([key, why]) => `"${key}" (${why})`).join("; ") +
				`. Nothing was started - each of them would have been read as shaping this run ` +
				`while the scenario executor never looks at it. Remove them and retry.`
		);
	}

	const mode = str(args, "mode") ?? DEFAULT_LOAD_MODE;
	const modeRefusal = scenarioModeRefusal(mode);
	if (modeRefusal) return errorResult(modeRefusal);
	// The engine refuses a rate on either spelling, because either one selects
	// the open-loop path regardless of the declared mode.
	if (typeof args.targetRps === "number" && args.targetRps > 0) {
		return errorResult(
			`"targetRps" is not available for scenario runs: it selects an open-loop arrival rate, ` +
				`and a scenario run is closed-loop by design. Set "concurrency" - the number of ` +
				`virtual users - instead.`
		);
	}

	const monitor = args.monitor as { url?: unknown } | undefined;
	if (monitor && typeof monitor === "object") {
		const monitorGate = checkMonitorHost(String(monitor.url ?? ""), ctx.config);
		if (!monitorGate.ok) return errorResult(monitorGate.error!);
	}

	const loadParams: LoadRunParams = {
		mode,
		concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined,
		startConcurrency:
			typeof args.startConcurrency === "number" ? args.startConcurrency : undefined,
		iterations: typeof args.iterations === "number" ? args.iterations : undefined,
		duration: (args.duration as string | number | undefined) ?? undefined,
		rampUpDuration: (args.rampUpDuration as string | number | undefined) ?? undefined,
	};
	const caps = checkLoadCaps(loadParams, ctx.config);
	if (!caps.ok) return errorResult(caps.error!);

	const environmentId = str(args, "environmentId");
	const recursive = scenario.recursive === true;
	let plannedSteps: number;
	try {
		plannedSteps = await preflightScenarioSteps(
			{ collectionId: scenario.collectionId, recursive, environmentId },
			ctx,
			signal
		);
	} catch (err) {
		if (err instanceof ToolArgError) return errorResult(err.message);
		return engineErrorResult(err);
	}

	const payload: Record<string, unknown> = {
		mode,
		scenario: scenarioBlock(scenario, recursive),
		...(environmentId !== undefined ? { environmentId } : {}),
	};
	for (const key of ["concurrency", "startConcurrency", "iterations"]) {
		if (typeof args[key] === "number") payload[key] = args[key];
	}
	for (const key of ["duration", "rampUpDuration"]) {
		const v = str(args, key);
		if (v !== undefined) payload[key] = v;
	}
	// Both travel verbatim for the same reason they do on the single-target
	// path: the keys are the engine's own and it is what judges the values.
	// Neither is executor-specific - a scenario load run is a load run, with the
	// same metrics thread, monitor scrape and end-of-run threshold evaluation.
	if (args.thresholds && typeof args.thresholds === "object")
		payload.thresholds = args.thresholds;
	if (monitor && typeof monitor === "object") payload.monitor = monitor;
	// And for the same reason again: the recording knobs are read by the
	// `RunContext` both executors share, so a scenario run keeps traces on the
	// terms an agent stated exactly as a single-target run does.
	applyRecordingKnobs(args, payload);
	const cappedDuration = defaultDurationUnderCap(loadParams, ctx.config);
	if (cappedDuration !== null) payload.duration = cappedDuration;

	const unconfirmed = await confirmDestructive(args, ctx, {
		message:
			`Start a scenario load test over collection ${scenario.collectionId} ` +
			`(${plannedSteps} step(s) per iteration, mode: ${mode})?\n\n` +
			`This generates real traffic within Vayu's caps.`,
		acceptTitle: "Start the load test",
		acceptDescription: "Confirm to generate load now.",
		declined: "Load run not started - the user declined.",
		preview:
			"AWAITING CONFIRMATION - no run was started.\n\n" +
			"This is a preview. To start the load test, call start_load_run again with " +
			"confirmed: true and the same arguments.\n\n" +
			`Planned run (${plannedSteps} step(s) per iteration):\n${JSON.stringify(payload, null, 2)}`,
	});
	if (unconfirmed) return unconfirmed;

	return withCaveat(
		await callEngine(() => ctx.client.startRun(payload, signal)),
		`\n\nThe plan is ${plannedSteps} step(s) per iteration. Follow the run with ` +
			`get_run_report: its \`scenario\` section carries the virtual-user, iteration and ` +
			`per-step breakdown. Pre-request scripts DO run on a scenario load run - each virtual ` +
			`user walks the plan the way the design runner does.`
	);
}

/** The `scenario` block `POST /runs` reads, from the arguments an agent gave. */
function scenarioBlock(
	scenario: { collectionId: string; data?: unknown[] },
	recursive: boolean,
	iterations?: number
): Record<string, unknown> {
	return {
		source: "collection",
		collectionId: scenario.collectionId,
		recursive,
		// Omitted rather than defaulted: with `data` present and this absent the
		// engine sets the pass count to the row count, and a client computing
		// its own would be a second copy of a rule only one side enforces.
		...(iterations !== undefined ? { iterations } : {}),
		...(scenario.data !== undefined ? { data: scenario.data } : {}),
	};
}

/** Convert a `{key: value}` header map to the engine's KeyValueEntry[] shape. */
function toKeyValueEntries(
	headers: unknown
): Array<{ key: string; value: string; enabled: boolean }> {
	if (!headers || typeof headers !== "object") return [];
	return Object.entries(headers as Record<string, unknown>).map(([key, value]) => ({
		key,
		value: String(value),
		enabled: true,
	}));
}

// --- Cascade accounting for delete_collection --------------------------------

/**
 * A `GET /collections` row, narrowed to the fields the cascade walk reads - plus
 * the `order` a move reads, since both work from the same one list read.
 */
interface CollectionRow {
	id: string;
	name?: string;
	parentId?: string | null;
	order?: number;
}

/**
 * The collection a row sits under, or `null` for a root one.
 *
 * Two spellings reach here for "no parent": the engine serializes a root
 * collection's `parentId` as `null`, while a row that has been through a client
 * whose type calls it optional can arrive without the key at all. An empty
 * string is the third - what the cascade walk has always treated as a root.
 * Comparing raw values would file a root collection under a parent named "",
 * which is a destination that does not exist.
 */
function collectionParent(row: CollectionRow): string | null {
	// One definition of the rule, shared with the chain walk `resolve_variables`
	// does - the two disagreeing about what counts as a root is a defect neither
	// side's own tests would catch.
	return collectionParentId(row);
}

/** The collections list, dropping anything without a usable id. */
function readCollectionRows(value: unknown): CollectionRow[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is CollectionRow =>
			!!row && typeof row === "object" && typeof (row as CollectionRow).id === "string"
	);
}

/**
 * Every collection a cascade delete of `rootId` destroys, root first - itself
 * plus every descendant, since collections nest through `parentId` and
 * `DELETE /collections/:id` takes the whole subtree with it.
 *
 * Null when `rootId` is not in the list: the caller must say "no such
 * collection" rather than ask the user to confirm destroying nothing. The
 * `seen` set is what stops a malformed parent cycle from looping forever - the
 * engine rejects cycles on write, but this walk reads whatever is stored.
 */
function collectionSubtree(rows: CollectionRow[], rootId: string): string[] | null {
	if (!rows.some((row) => row.id === rootId)) return null;
	const childrenOf = new Map<string, string[]>();
	for (const row of rows) {
		const parent = typeof row.parentId === "string" ? row.parentId : "";
		if (!parent) continue;
		childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), row.id]);
	}
	const seen = new Set<string>([rootId]);
	const ordered: string[] = [rootId];
	for (let i = 0; i < ordered.length; i++) {
		for (const child of childrenOf.get(ordered[i]) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			ordered.push(child);
		}
	}
	return ordered;
}

/** What a cascade delete is about to destroy, read before the user is asked. */
interface CascadeScope {
	name: string;
	/** Descendants only - the collection itself is not counted among them. */
	descendants: number;
	requests: number;
}

/**
 * Read the subtree `collectionId` roots and count what goes with it.
 *
 * Every count here is read from the engine rather than assumed, because it is
 * the number the user agrees to: a prompt that guessed would be asking consent
 * for something other than what happens. A failed read therefore throws instead
 * of degrading to "0 requests" - `ToolArgError` for a collection that does not
 * exist, the transport error otherwise, and either way nothing is deleted.
 */
async function readCascadeScope(
	client: EngineClient,
	collectionId: string,
	signal?: AbortSignal
): Promise<CascadeScope> {
	const rows = readCollectionRows(await client.listCollections(signal));
	const subtree = collectionSubtree(rows, collectionId);
	if (subtree === null) throw new ToolArgError(`No collection with id "${collectionId}".`);
	const lists = await Promise.all(subtree.map((id) => client.listRequests(id, signal)));
	const requests = lists.reduce<number>(
		(total, list) => total + (Array.isArray(list) ? list.length : 0),
		0
	);
	const root = rows.find((row) => row.id === collectionId);
	return {
		name: typeof root?.name === "string" && root.name !== "" ? root.name : collectionId,
		descendants: subtree.length - 1,
		requests,
	};
}

/** One sentence naming everything a cascade delete destroys. */
function describeCascade(scope: CascadeScope): string {
	return (
		`Deleting "${scope.name}" also removes ${scope.descendants} sub-collection(s) and ` +
		`${scope.requests} saved request(s) inside it. All of it goes to Vayu's Trash, ` +
		`where it can be restored.`
	);
}

// --- Trash (issue #988 / #1071) ----------------------------------------------

/** One `GET /trash` row, as `purge_trash_entry` needs it to name what it destroys. */
interface TrashRow {
	kind: "collection" | "request";
	name: string;
	/** Sub-collections this row's delete took with it. Always 0 for a request. */
	collections: number;
	/** Requests this row's delete took with it. Always 0 for a request. */
	requests: number;
}

/**
 * Read one trash entry by id off `GET /trash` - there is no single-entry route,
 * the same reason {@link EngineClient.getCollection} scans the collection list.
 *
 * Thrown rather than defaulted, on {@link readCascadeScope}'s reasoning: an
 * entry nobody could read must not become a purge prompt carrying a name and
 * counts nobody verified.
 */
async function readTrashEntry(
	client: EngineClient,
	id: string,
	signal?: AbortSignal
): Promise<TrashRow> {
	const payload = await client.listTrash(signal);
	const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
	const row = items.find((item) => isRecord(item) && item.id === id) as
		Record<string, unknown> | undefined;
	if (!row) throw new ToolArgError(`Nothing in the trash with id "${id}".`);
	return {
		kind: row.kind === "request" ? "request" : "collection",
		name: typeof row.name === "string" && row.name !== "" ? row.name : id,
		collections: typeof row.collections === "number" ? row.collections : 0,
		requests: typeof row.requests === "number" ? row.requests : 0,
	};
}

/** One phrase naming what purging this entry destroys. */
function describeTrashEntry(entry: TrashRow): string {
	const subject =
		entry.kind === "collection"
			? `the collection "${entry.name}"`
			: `the saved request "${entry.name}"`;
	if (entry.collections === 0 && entry.requests === 0) return subject;
	return (
		`${subject}, with ${entry.collections} sub-collection(s) and ` +
		`${entry.requests} saved request(s) inside it`
	);
}

/**
 * The engine's own refusal text off a 404/409 `EngineRequestError` from
 * `POST /trash/:id/restore`. Both of restore's failure shapes name the fix (a
 * wrong id, or which collection to restore first, per `trash.cpp`), so this
 * surfaces that sentence rather than writing a second one that could disagree
 * with it.
 *
 * **The nested shape is the contract.** `error_response` in `routes.hpp` builds
 * `{"error": {"code", "message"}}` for every refusal these routes produce, and
 * that is the one shape issue #173 settled on. The flat `{"error": "..."}`
 * branch is a fallback rather than an alternative, for the same reason the
 * renderer's `readApiError` keeps one: the app and the engine sidecar are not
 * updated together, so a newer app can be talking to an older engine, and its
 * message beats the raw body. Anything else falls back to the body, then the
 * status line - reading a refusal must never throw.
 */
function trashRefusalMessage(err: EngineRequestError): string {
	try {
		const parsed = JSON.parse(err.body) as { error?: unknown };
		const error = parsed.error;
		if (isRecord(error) && typeof error.message === "string" && error.message) {
			return error.message;
		}
		if (typeof error === "string" && error) return error;
	} catch {
		// Not JSON - the raw body is the best we have.
	}
	return err.body || err.message;
}

// --- Mock issuer -------------------------------------------------------------

/**
 * The fields `POST /mock-issuer/start` accepts, in the engine's spelling
 * (`parse_mock_issuer_settings`, engine/src/http/routes/mock_issuer.cpp). One
 * list rather than a hand-written object literal per field, so the payload
 * builder and the tool's input schema cannot drift apart.
 */
const MOCK_ISSUER_START_KEYS = [
	"port",
	"expiresInSeconds",
	"claims",
	"clients",
	"failureMode",
	"slowMs",
	"issueRefreshTokens",
] as const;

/** The failure modes the issuer's `/token` endpoint can be put into. */
const MOCK_ISSUER_FAILURE_MODES = ["none", "slow", "server_error", "invalid_client"] as const;

/**
 * The start body, carrying only the fields the caller actually named - an
 * absent one must stay absent, because the engine reads a present field with a
 * bad type or an out-of-range value as an error rather than falling back to the
 * default, and `undefined` would serialize to `null`.
 *
 * The engine's *limits* (the 31-day expiry ceiling, the 60s slow ceiling, 32
 * clients, 8 concurrent issuers) are deliberately not restated in the schema:
 * they live in `core/constants.hpp`, an out-of-range value comes back as a
 * `400 mock_issuer_invalid_config` naming the bound, and a second copy here
 * would be a second thing to keep in step - one that refuses values the engine
 * accepts the moment either side moves. What the schema does own is the shape:
 * a claims object, an integer port, a failure mode from the closed set above.
 */
function mockIssuerStartPayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const key of MOCK_ISSUER_START_KEYS) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
	return payload;
}

/**
 * The settings `PUT /mock-issuer/:id` will change under a bound listener.
 *
 * Deliberately a subset of the start keys rather than the same list: the engine
 * refuses `port`, `clients`, `claims` and `issueRefreshTokens` on a running
 * issuer with "stop it and start a new one" (`apply_mock_issuer_patch`), so
 * offering them here would be offering a call that always fails. It is also a
 * subset of what the PUT accepts - `expiresInSeconds` is mutable engine-side
 * and is not offered, because a token's lifetime is fixed when it is minted, so
 * changing it mid-session changes nothing about the tokens already in the
 * agent's hands and only the *next* mint. #757 scoped this tool to the two
 * knobs the UI's own live edit exposes; widening it belongs to whoever finds a
 * use for it.
 */
const MOCK_ISSUER_PATCH_KEYS = ["failureMode", "slowMs"] as const;

/**
 * The merge-patch body for `update_mock_issuer`, carrying only what the caller
 * named - an omitted field keeps its current value engine-side, which is the
 * whole point of patching a live issuer rather than restarting it.
 */
function mockIssuerPatchPayload(args: Record<string, unknown>): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const key of MOCK_ISSUER_PATCH_KEYS) {
		if (args[key] !== undefined) patch[key] = args[key];
	}
	return patch;
}

// --- Collection mock server --------------------------------------------------

/**
 * The fields `POST /mock/start` accepts (`parse_mock_start`,
 * engine/src/http/routes/mock_server.cpp). `collectionId` is required and is
 * validated by {@link requireStr} before the body is built; the other three are
 * optional knobs.
 */
const MOCK_SERVER_START_KEYS = ["port", "latencyMs", "errorRatePct"] as const;

/**
 * The start body. `collectionId` always travels; a knob the caller did not name
 * stays absent, for the reason {@link mockIssuerStartPayload} records - the
 * engine reads a present field with a bad value as a 400 rather than falling
 * back to its default.
 *
 * The engine's `latencyMs` ceiling is not restated in the schema (the same
 * division of labour the issuer tools document): it lives in
 * `core/constants.hpp`, an out-of-range value comes back as a 400 naming the
 * bound, and a copy here would refuse values the engine accepts the moment
 * either side moves. `port` and `errorRatePct` are bounded in the schema
 * because their bounds are the *shape* - a port is 0-65535 everywhere and a
 * percentage is 0-100 by definition, not by an engine constant.
 */
function mockServerStartPayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = { collectionId: requireStr(args, "collectionId") };
	for (const key of MOCK_SERVER_START_KEYS) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
	return payload;
}

/**
 * What a started mock could not serve, or "" when every route has an example.
 *
 * A mock with routes but no examples answers `501` to each of them, which reads
 * as a broken mock rather than as an empty collection - so the count the engine
 * already reports (`routesWithoutExample`) is turned into a sentence instead of
 * being left for an agent to notice in the JSON. `routeCount: 0` is the sharper
 * case and gets its own line: there is nothing to point a client at.
 */
function mockServerCaveat(started: unknown): string {
	if (!isRecord(started)) return "";
	const routes = Number(started.routeCount);
	const without = Number(started.routesWithoutExample);
	if (Number.isFinite(routes) && routes === 0) {
		return (
			"\nThis mock serves no routes: the collection has no requests the mock could map. " +
			"Every path answers 404."
		);
	}
	if (!Number.isFinite(without) || without <= 0) return "";
	return (
		`\n${without} of ${routes} route(s) have no saved example, and answer 501 rather than a body. ` +
		"Save an example on those requests (or check get_mock_routes for which they are) before pointing a client at them."
	);
}

// --- Webhook inbox -----------------------------------------------------------

/**
 * The canned-response fields `POST /inbox/start` and `PUT /inbox/:id` read
 * (`apply_response_fields`, engine/src/http/routes/inbox.cpp). Both routes take
 * the same block - start applies it to the defaults, the PUT merge-patches the
 * live one - so one list serves both payload builders.
 */
const INBOX_RESPONSE_KEYS = ["status", "body", "headers", "delayMs"] as const;

/**
 * The canned response a call described, carrying only the fields it named.
 *
 * An omitted field must stay omitted rather than travel as `null`: the PUT is a
 * merge-patch, so a spelled-out `null` would be the caller saying "reset this"
 * where they said nothing at all. Bounds (a 100-599 status, a delay under 30s)
 * are the engine's and come back as a `400` naming them - the schema owns the
 * shape, the same division `mockIssuerStartPayload` documents.
 */
function inboxResponsePayload(response: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of INBOX_RESPONSE_KEYS) {
		if (response[key] !== undefined) out[key] = response[key];
	}
	return out;
}

/**
 * The `POST /inbox/start` body for a `start_webhook_inbox` call.
 *
 * **`bind` and `confirmNonLoopback` are never emitted**, whatever the arguments
 * carry. Binding a listener to a routable interface exposes it beyond this
 * machine, which epic #753 records as a non-goal for every MCP-hosted service -
 * so the guarantee lives here, in the one function that builds the body, rather
 * than in a schema an agent could be tempted to route around. With no `bind`
 * the engine uses its loopback default, and its non-loopback refusal never
 * comes into play.
 */
function inboxStartPayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	if (typeof args.port === "number") payload.port = args.port;
	if (isRecord(args.response)) payload.response = inboxResponsePayload(args.response);
	return payload;
}

/**
 * Default page for `get_inbox_captures` - the same 25 `get_run_samples` uses
 * and for the same reason: a capture is a whole recorded request, body
 * included, so a page is measured in bodies rather than rows.
 *
 * The ceiling is this side's, not the engine's. `GET /inbox/:id/requests`
 * clamps to the inbox's retention (500 by default, up to 10000 with
 * `inboxMaxCaptures` raised), and a capture body is bounded by
 * `inboxMaxBodyBytes` - 64 KB by default and configurable to 8 MB - so the
 * engine's own bound says nothing about what a tool result can carry. 100 rows
 * of bounded body is the largest page worth handing an agent; more is `offset`.
 */
export const DEFAULT_INBOX_CAPTURE_LIMIT = 25;
export const MAX_INBOX_CAPTURE_LIMIT = 100;

/**
 * Bound the bodies in one capture page.
 *
 * A capture carries the engine's own `body` / `bodyTruncated` / `bodyBytes`
 * disclosure trio - the shape {@link boundTraceNode} already speaks - so the
 * page is bounded by the same function rather than by a copy of it: a webhook
 * posting a 6 MB payload is exactly the #767 case, and the cut has to leave
 * `bodyBytes` alone where the engine already recorded the true original size.
 */
function boundInboxCaptures(value: unknown): unknown {
	if (!isRecord(value) || !Array.isArray(value.data)) return value;
	return { ...value, data: value.data.map(boundTraceNode) };
}

// --- Saved example responses -------------------------------------------------

/**
 * How much of a stored example body one result carries, and how much a whole
 * list may spend (issue #759, on the #767 / #769 precedent).
 *
 * An example body is capped engine-side at 1 MB and a request may hold 100 of
 * them, so an unbounded list is a 100 MB tool result - the same shape that made
 * `get_run_report` blow the token limit before #769 bounded its traces. The two
 * numbers are that fix's, not new ones: `MAX_INLINE_BODY_BYTES` per body, and
 * three times it across the list, which is the largest single row the per-body
 * bound can produce.
 */
export const MAX_EXAMPLES_BODY_BYTES = MAX_INLINE_BODY_BYTES * 3;

/** A list of examples with its bodies bounded, and what that cost. */
interface BoundedExamples {
	examples: unknown[];
	/** Rows whose body did not fit the list budget at all. */
	bodiesOmitted: number;
	bodyBudgetBytes: number;
}

/**
 * Bound the bodies of one request's examples, disclosing every cut.
 *
 * The flags are deliberately **not** the engine's `bodyTruncated`: that field
 * already means something else on this row - the client that captured the
 * response stored only a prefix of it - and reusing the name would leave an
 * agent unable to tell a short capture from a short *read*. So a body cut to fit
 * this result is `bodyClipped` with the stored size in `bodyBytes`, and one that
 * did not fit at all is `bodyOmitted` with the same size, keeping every scalar
 * (id, name, status, headers, order, origin) that says what the row is.
 */
function boundExampleBodies(value: unknown): BoundedExamples {
	const rows = Array.isArray(value) ? value : [];
	let spent = 0;
	let bodiesOmitted = 0;
	const examples = rows.map((row) => {
		if (!isRecord(row) || typeof row.body !== "string" || row.body === "") return row;
		const stored = Buffer.byteLength(row.body, "utf8");
		const remaining = MAX_EXAMPLES_BODY_BYTES - spent;
		if (remaining <= 0) {
			bodiesOmitted++;
			return { ...row, body: "", bodyOmitted: true, bodyBytes: stored };
		}
		const bounded = boundText(row.body, Math.min(MAX_INLINE_BODY_BYTES, remaining));
		spent += Buffer.byteLength(bounded.text, "utf8");
		if (!bounded.truncated) return row;
		return { ...row, body: bounded.text, bodyClipped: true, bodyBytes: bounded.bytes };
	});
	return { examples, bodiesOmitted, bodyBudgetBytes: MAX_EXAMPLES_BODY_BYTES };
}

/**
 * The fields an example write may state, in the engine's spelling
 * (`apply_request_example_fields`).
 *
 * **`origin` is not among them, and that is the point.** The column says who
 * wrote the row - `import` for an importer or a spec sync, `user` for what the
 * app saved from a live response - and the OpenAPI sync replaces the first kind
 * without touching the second (#588, #722). An agent that could claim `import`
 * could hand its own example to the next sync to overwrite; one that could claim
 * `user` could pin a stale imported row against the document it came from.
 * Neither is the agent's call, so the field is refused by omission: the SDK
 * strips what the schema does not declare, and the payload builder copies only
 * the keys below.
 */
const EXAMPLE_WRITE_KEYS = ["name", "status", "contentType"] as const;

/**
 * The body of an example write - the named fields only, so an update leaves
 * what it did not mention alone (the engine merge-patches on `PUT`).
 *
 * `headers` follows the request tools' rule: a string map in, the engine's
 * `{key, value, enabled}` rows out, replacing the stored list wholesale.
 */
function exampleWritePayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const key of EXAMPLE_WRITE_KEYS) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
	if (args.headers !== undefined) {
		if (!isRecord(args.headers)) {
			throw new ToolArgError('"headers" must be an object mapping header names to values.');
		}
		payload.headers = toKeyValueEntries(args.headers);
	}
	const body = str(args, "body");
	if (body !== undefined) payload.body = body;
	return payload;
}

/** One stored example named in words, for the prompt that asks to delete it. */
function describeExample(exampleId: string, example: Record<string, unknown>): string {
	const name = typeof example.name === "string" && example.name !== "" ? example.name : exampleId;
	const status = typeof example.status === "number" ? ` (status ${example.status})` : "";
	return `"${name}"${status}`;
}

// --- Moving an item to another parent ----------------------------------------

/**
 * Where a moved row lands among its new siblings.
 *
 * Two positions, not an index: `POST /reorder` writes dense positions and a
 * drag computes them from a pointer, which an agent has none of. Naming a slot
 * in the middle would mean an agent maintaining the app's ordering arithmetic
 * (`modules/collections/reorder-math.ts`) from the outside, and getting it wrong
 * is a folder that visibly reshuffles. First and last are the two an agent can
 * mean unambiguously; anything finer stays a UI gesture.
 */
const MOVE_POSITIONS = ["first", "last"] as const;

/**
 * The reorder batch that lands `movedId` at either end of its destination.
 *
 * `siblings` is the destination block **as the engine lists it** - already
 * sorted by `order`, then `createdAt`, then `id` - with the moved row itself
 * removed, so the arrangement this produces is simply that array with the row
 * put on one end. Every position in the block is then stated outright rather
 * than left to the engine's `normalize` pass, because the two would have to
 * agree about a block the moved row is still inside while it runs: normalizing
 * `[A, B, C]` and then writing `A` at `2` puts it level with `C`, and the tie
 * goes to whichever row was created first. Stating the whole arrangement cannot
 * tie.
 *
 * Only rows whose stored `order` actually changes get an entry - the rule
 * `reorder-math.ts` follows for a drag, and what keeps a move inside a large
 * collection from rewriting every row in it. The moved row is always written:
 * it is the one carrying the destination owner, which is the move.
 *
 * The scope it *left* keeps a gap where it was (the rows after it are not
 * renumbered). That is invisible - display order reads the column's relative
 * values, never its density - and closing it would double the batch for
 * nothing.
 */
function moveBatch(params: {
	type: "collection" | "request";
	movedId: string;
	position: "first" | "last";
	/** The destination's own key: `parentId` (null = the top level) or `collectionId`. */
	owner: Record<string, unknown>;
	siblings: readonly OrderedSibling[];
}): Record<string, unknown> {
	const { type, movedId, position, owner, siblings } = params;
	const offset = position === "first" ? 1 : 0;
	const moves: Record<string, unknown>[] = [
		{
			type,
			id: movedId,
			order: position === "first" ? 0 : siblings.length,
			...owner,
		},
	];
	siblings.forEach((row, index) => {
		if (row.order === index + offset) return;
		moves.push({ type, id: row.id, order: index + offset });
	});
	return { moves };
}

/** A destination row, narrowed to what a move has to know about it. */
interface OrderedSibling {
	id: string;
	order?: number;
}

/**
 * The rows of a `GET /requests?collectionId=` answer, in the order it lists
 * them - which is the order the tree displays, since the engine sorts every
 * list read by the same three keys the renderer's comparator uses.
 */
function readOrderedSiblings(value: unknown): OrderedSibling[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is OrderedSibling =>
			!!row && typeof row === "object" && typeof (row as OrderedSibling).id === "string"
	);
}

// --- OpenAPI spec bindings ---------------------------------------------------

/**
 * A collection's binding to a stored OpenAPI document, as the collection row
 * carries it (`openapi`, issue #637).
 *
 * The engine stores `{}` for the unbound state and refuses a non-empty binding
 * that names no `specId`, so a row with a string `specId` is the only shape that
 * means "bound" - and the only one this reads. `specHash` is stamped engine-side
 * from the stored document at bind time; `syncedAt` is set by a spec sync.
 */
interface SpecBinding {
	specId: string;
	specHash?: string;
	syncedAt?: number;
}

function readSpecBinding(collection: unknown): SpecBinding | null {
	if (!isRecord(collection)) return null;
	const binding = collection.openapi;
	if (!isRecord(binding) || typeof binding.specId !== "string" || binding.specId === "") {
		return null;
	}
	return {
		specId: binding.specId,
		...(typeof binding.specHash === "string" ? { specHash: binding.specHash } : {}),
		...(typeof binding.syncedAt === "number" ? { syncedAt: binding.syncedAt } : {}),
	};
}

/**
 * The document's text as `get_spec` hands it back, bounded (issue #767's rule
 * applied to a surface whose ceiling is far higher than a response body's).
 *
 * A stored spec may be up to `maxSpecDocumentBytes` - megabytes for a real one:
 * Stripe's is 12 MB, GitHub's 9.7 MB - so the whole of it in a tool result
 * exceeds the result token limit outright. The cut is `MAX_INLINE_BODY_BYTES`,
 * this codebase's existing answer to "how much text does an automated reader
 * get", and `contentBytes` beside it is the engine's own count of the whole
 * document, so a truncated read always says what it is a prefix of.
 *
 * A document with no text answers `content: null` rather than dropping the
 * field: a caller that asked for the content and got a result without it cannot
 * tell "empty" from "this tool decided not to send it".
 */
function boundSpecContent(document: unknown): Record<string, unknown> {
	if (!isRecord(document) || typeof document.content !== "string") {
		return { content: null, contentTruncated: false };
	}
	const { text, truncated } = boundText(document.content);
	return { content: text, contentTruncated: truncated };
}

/**
 * What a bind did, in a sentence (issue #862).
 *
 * The counts are already in the structured body; this says the two that change
 * what an agent should do next. **The cleared count is named on its own** - it
 * is the one thing a bind takes away rather than adds, and an agent that
 * re-bound a collection to the wrong document should learn that from the reply
 * rather than from a later run reporting no coverage. Unmatched requests are
 * named the same way, because they are what a `sync` would create operations
 * for and are the honest answer to "did this document fit this collection".
 *
 * Defensive about the shape for `readSpecBinding`'s reason: an engine answering
 * something unexpected must cost the caveat, never the result.
 */
function describeBind(outcome: unknown): string {
	const count = (value: unknown): number => (typeof value === "number" ? value : 0);
	if (!isRecord(outcome)) return "Bound.";
	const stamped = count(outcome.stamped);
	const cleared = count(outcome.cleared);
	const unmatchedRequests = Array.isArray(outcome.unmatchedRequests)
		? outcome.unmatchedRequests.length
		: 0;
	const unmatchedOperations = Array.isArray(outcome.unmatchedOperations)
		? outcome.unmatchedOperations.length
		: 0;
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

	const parts = [
		`Bound to spec ${typeof outcome.specId === "string" ? outcome.specId : "(unknown)"}.`,
		`Recorded identity on ${plural(stamped, "request")}.`,
	];
	if (cleared > 0) {
		parts.push(
			`Cleared identity from ${plural(cleared, "request")} - each named an operation only the previously bound document declared.`
		);
	}
	if (unmatchedRequests > 0 || unmatchedOperations > 0) {
		parts.push(
			`${plural(unmatchedRequests, "request")} matched no operation, and ${plural(unmatchedOperations, "operation")} matched no request; nothing was created or deleted for either.`
		);
	}
	return parts.join(" ");
}

/**
 * How many entries of one spec-diff bucket a tool result carries (issue #871).
 *
 * Nothing caps the buckets upstream: a document that renamed every operation
 * puts one `changed` entry per request in the collection, and each carries its
 * changed fields. Fifty is the number that keeps the common answer whole while
 * bounding the pathological one, and - the rule the run-report rows follow -
 * the *counts* stay true, so a cut list is visible as one rather than reading
 * as the whole drift.
 */
export const MAX_SPEC_DIFF_ENTRIES = 50;

/**
 * One bucket of `POST /specs/diff`, capped, with what it was cut from.
 *
 * The engine's own count is the second element rather than the length of the
 * first: an agent deciding whether a contract drifted reads the total, and a
 * total read off a cut list would say it did not.
 */
function boundedBucket(value: unknown, shape: (entry: Record<string, unknown>) => unknown) {
	const entries = Array.isArray(value) ? value : [];
	return {
		entries: entries.slice(0, MAX_SPEC_DIFF_ENTRIES).map((entry) => shape(asRecord(entry))),
		total: entries.length,
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

/**
 * A changed request, as an agent reads one.
 *
 * `draft` is dropped rather than passed through. It is what an apply *would*
 * write, and `POST /specs/sync` re-reads it off the document being stored
 * rather than being handed it (the same split `POST /specs/match` and
 * `POST /specs/bind` follow), so nothing on either side of this tool consumes
 * it - it would be the heaviest field in the answer and the "written but never
 * read" defect at once. The rendered `current` / `next` pair survives, which is
 * what says *what* moved; the engine already truncates both for display.
 */
function changedEntry(item: Record<string, unknown>): Record<string, unknown> {
	const fields = Array.isArray(item.fields) ? item.fields : [];
	return {
		requestId: item.requestId ?? null,
		name: item.name ?? null,
		boundOperation: item.boundOperation ?? null,
		operation: item.operation ?? null,
		matchedBy: item.matchedBy ?? null,
		renamed: item.renamed === true,
		previousUnknown: item.previousUnknown === true,
		fields: fields.map((field) => {
			const row = asRecord(field);
			return {
				field: row.field ?? null,
				current: row.current ?? null,
				next: row.next ?? null,
				userTouched: row.userTouched === true,
			};
		}),
	};
}

/** Whether any field of @p item is one a person edited by hand. */
function hasUserEdit(item: Record<string, unknown>): boolean {
	const fields = Array.isArray(item.fields) ? item.fields : [];
	return fields.some((field) => asRecord(field).userTouched === true);
}

/**
 * What a document would change, in a sentence (issue #871).
 *
 * The counts are in the structured body; this says the three things that change
 * what an agent should do next. **Hand-edited fields are named on their own**:
 * they are the one part of a drift that an apply may not take silently, and an
 * agent reading only "6 changed" would propose overwriting somebody's edit.
 * `unmapped` is named for the reason the diff reports it at all - a collection
 * half of which carries no operation is one this answer describes half of.
 *
 * Defensive about the shape for `describeBind`'s reason: an engine answering
 * something unexpected must cost the caveat, never the result.
 */
function describeSpecDiff(answer: Record<string, unknown>): string {
	const bucket = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
	const count = (value: unknown): number => (typeof value === "number" ? value : 0);
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

	if (answer.identical === true) {
		return "This document is byte-identical to the one the collection is bound to, so there is nothing to apply.";
	}

	const changed = Array.isArray(answer.changed) ? answer.changed : [];
	const edited = changed.filter((item) => hasUserEdit(asRecord(item))).length;
	const parts = [
		`${plural(bucket(answer.added), "operation")} added, ${plural(bucket(answer.removed), "request")} no longer declared, ${plural(changed.length, "request")} changed, ${count(answer.unchanged)} unchanged.`,
	];
	if (edited > 0) {
		parts.push(
			`${plural(edited, "changed request")} hold a field somebody edited by hand (userTouched) - applying the document there overwrites a person's work, not an import's.`
		);
	}
	if (count(answer.unmapped) > 0) {
		parts.push(
			`${plural(count(answer.unmapped), "request")} in this collection carry no operation at all and are not part of the comparison.`
		);
	}
	parts.push(
		"Nothing was written: this is the read half of a sync. `sync_spec` applies the safe half of it - everything the document adds, every field it moved that nobody had edited by hand, and no deletions."
	);
	return parts.join(" ");
}

/**
 * What a sync wrote, and what its policy declined, in a sentence (issue #871).
 *
 * **The declined half is not optional.** An agent reading "3 created, 5
 * updated" has been told what a safe apply did and nothing about what it
 * refused, and refusing is the point of the policy: a hand-edited field left
 * alone and a request not deleted are the two outcomes a caller would otherwise
 * assume did not exist. The counts are the engine's `skipped`, so this states
 * them rather than working them out.
 *
 * Defensive about the shape for `describeBind`'s reason: an engine answering
 * something unexpected must cost the caveat, never the result.
 */
/**
 * What an import did, in a sentence - the caveat beside the JSON.
 *
 * `meta.skipped` is the half worth reading aloud: an import that silently
 * dropped a WebSocket request, a file body or an operation's `default` response
 * looks exactly like one that had none, and every parser tallies those precisely
 * so a caller does not have to discover the loss later.
 */
function describeImport(answer: unknown): string {
	if (!isRecord(answer)) return "";
	const meta = isRecord(answer.meta) ? answer.meta : {};
	const format = typeof meta.format === "string" ? meta.format : "the document";
	const parts = [
		`${num(answer.collections)} collection(s)`,
		`${num(answer.requests)} request(s)`,
	];
	if (num(answer.environments) > 0) parts.push(`${num(answer.environments)} environment(s)`);
	if (num(answer.globals) > 0) parts.push(`${num(answer.globals)} global(s)`);
	let text = `Imported ${format}: ${parts.join(", ")}.`;
	const skipped = Array.isArray(meta.skipped) ? meta.skipped : [];
	if (skipped.length > 0) {
		const named = skipped
			.filter(isRecord)
			.map((entry) => `${num(entry.count)} ${String(entry.kind)}`)
			.join(", ");
		text += ` Not everything imported: ${named}.`;
	}
	return text;
}

/** A count the engine reported, or 0 - never `NaN` in a sentence. */
function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function describeSync(answer: unknown): string {
	const outcome = asRecord(answer);
	const count = (value: unknown): number => (typeof value === "number" ? value : 0);
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

	const parts = [
		`Applied in one transaction: ${plural(count(outcome.created), "request")} created, ${plural(count(outcome.updated), "request")} updated, ${plural(count(outcome.deleted), "request")} deleted. The document is stored and the collection is now bound to it.`,
	];

	const skipped = asRecord(outcome.skipped);
	const held = count(skipped.requests);
	const fields = count(skipped.fields);
	const deletions = count(skipped.deletions);
	if (held > 0 || fields > 0 || deletions > 0) {
		const left: string[] = [];
		if (held > 0)
			left.push(
				`${plural(held, "changed request")} left untouched (a field somebody edited by hand, or a request whose bound document could not be read)`
			);
		if (fields > 0) left.push(`${plural(fields, "field")} not written`);
		if (deletions > 0)
			left.push(
				`${plural(deletions, "request")} the document no longer declares but which was NOT deleted`
			);
		parts.push(
			`The safe policy declined the rest: ${left.join(", ")}. Applying any of that needs a person to tick it in the Vayu app (Collection -> Spec -> Sync); \`diff_spec\` shows exactly which entries they are.`
		);
	}
	return parts.join(" ");
}

// --- Tool definitions --------------------------------------------------------

export const TOOLS: McpTool[] = [
	{
		name: "get_engine_health",
		category: "read",
		invalidates: [],
		description:
			"Check the Vayu engine's status and version. Use this first to confirm Vayu is running.",
		annotations: {
			title: "Check engine health",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		outputSchema: engineHealthSchema,
		handler: async (_args, ctx, signal) => {
			try {
				const value = await ctx.client.health(signal);
				// Anything the outputSchema would reject is wrapped instead of
				// returned bare. A declared outputSchema makes the SDK reject a
				// non-error result whose `structuredContent` does not validate (and
				// one with none at all), and that rejection surfaces as "Tool
				// get_engine_health has an output schema but no structured content
				// was provided" - blaming the schema and swallowing the body an
				// operator needs to see. A mid-restart engine answering 200 with a
				// bare string or a `status`-less object is exactly when it matters.
				return isEngineHealthShape(value)
					? structuredResult(value)
					: structuredResult({ status: "unknown", raw: value ?? null });
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "list_collections",
		category: "read",
		invalidates: [],
		description:
			"List all request collections (folders that organize saved requests). Each row carries that collection's own `variables` blob; a request resolves against the whole chain from the root down, not just its own collection. " +
			precedenceNote(
				"Collection variables sit between globals and the active environment, and a nested collection outranks its ancestors."
			),
		annotations: {
			title: "List collections",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listCollections(signal)),
	},
	{
		name: "list_requests",
		category: "read",
		invalidates: [],
		description: "List the saved requests inside a collection.",
		annotations: {
			title: "List requests",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { collectionId: z.string().describe("Collection ID to list.") },
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.listRequests(requireStr(args, "collectionId"), signal)),
	},
	{
		name: "list_environments",
		category: "read",
		invalidates: [],
		description:
			"List all environments (named sets of variables like baseUrl, apiKey). The row with `isActive: true` is the one requests resolve against when a call names no environmentId. " +
			precedenceNote(
				"An environment's variables are the top scope tier: they shadow every collection and global of the same name."
			),
		annotations: {
			title: "List environments",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listEnvironments(signal)),
	},
	{
		name: "list_runs",
		category: "read",
		invalidates: [],
		description:
			"List past runs (single Design-mode requests, collection runs and load tests), " +
			`newest first - the only order the engine lists in. Returns a {data, pagination} envelope of at most ${DEFAULT_RUN_PAGE_LIMIT} runs by default (${MAX_ENGINE_PAGE_LIMIT} max); each row carries a compact summary (url/method/mode/duration/concurrency/comment), not the full config snapshot. ` +
			"Filter to find a specific run instead of paging blocks of history: by saved request, by collection (collection runs only - a design or load run stores none), by type, by status, by text over the stored config, or to pinned baselines only. " +
			"`pagination.total` and `hasMore` describe the filtered set, so a filtered page says how much more of that filter there is.",
		annotations: {
			title: "List runs",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_ENGINE_PAGE_LIMIT)
				.optional()
				.describe(
					`How many runs to return (default ${DEFAULT_RUN_PAGE_LIMIT}, max ${MAX_ENGINE_PAGE_LIMIT}). A larger value is refused, not clamped.`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many runs to skip, for paging (default 0)."),
			type: z
				.enum(RUN_TYPES)
				.optional()
				.describe(
					'Only runs of this kind: "design" (one request), "load" (a load test), "scenario" (a collection run).'
				),
			status: z
				.enum(RUN_STATUSES)
				.optional()
				.describe(
					'Only runs in this state: "pending", "running", "completed", "failed", "stopped".'
				),
			requestId: z.string().optional().describe("Only runs of this saved request."),
			collectionId: z
				.string()
				.optional()
				.describe(
					"Only collection runs of this collection. Design and load runs record no collection, so they never match."
				),
			q: z
				.string()
				.optional()
				.describe(
					"Case-insensitive substring match over the run's stored configuration (url, comment, and the rest of the snapshot)."
				),
			baseline: z
				.boolean()
				.optional()
				.describe(
					"true lists only runs pinned as a baseline, false only unpinned ones. Omit for both."
				),
		},
		handler: (args, ctx, signal) => {
			// Built before the call, not inside it: an argument the caller got
			// wrong must reach dispatch as a ToolArgError - inside `pagedRead`'s
			// try it would be reported as an engine failure.
			const query = runListQuery(args);
			return pagedRead(() => ctx.client.listRuns(query, signal), "runs");
		},
	},
	{
		name: "get_run_report",
		category: "read",
		invalidates: [],
		description:
			"Get the full report for a completed run: summary, latency percentiles (p50/p95/p99), status codes, errors, and timing breakdown. Ideal input for analyzing performance. " +
			"A run of a collection bound to an OpenAPI document also carries `coverage`: which of the contract's operations the run exercised, which of their declared responses it saw, and any statuses the document never declared. Absent - never zeros - for a run that was not measured against a contract. " +
			`Stored bodies on each row's trace (request and response) are capped at ${MAX_INLINE_BODY_BYTES} bytes for this result: a capped one carries \`bodyTruncated: true\` beside \`bodyBytes\`, the full size, and a capped \`rawRequest\` carries \`rawRequestTruncated\`. A body in full is still available in the Vayu app's own run history. ` +
			`The traces together are capped at ${MAX_REPORT_TRACE_BYTES} bytes, since a multi-step run's rows add up past any per-body cap: rows beyond the budget keep every scalar (status, latency, step identity) and carry \`traceOmitted: true\` instead of their trace, with \`tracesOmitted\` and \`traceBudgetBytes\` on the report saying how many. Non-passing steps keep their traces first, matching the engine's own rule for \`stepsStored\`, so a failure is the last thing dropped. An omitted row's trace is still in the Vayu app's own run history.`,
		annotations: {
			title: "Get run report",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { runId: z.string().describe("Run ID to fetch.") },
		handler: (args, ctx, signal) =>
			callEngine(
				() => ctx.client.getRunReport(requireStr(args, "runId"), signal),
				boundRunReport
			),
	},
	{
		name: "get_run_samples",
		category: "read",
		invalidates: [],
		description:
			"Get the response samples a load run captured - the actual headers and bodies of individual exchanges, which the report's aggregates do not carry. Only a run started with response capture on has any; a run that captured nothing returns an empty page, not an error. " +
			`Each sample carries \`resultId\`, so it joins against the report's \`results[].id\`. A binary body is reported as \`binary: true\` rather than as text, and a body the engine cut at its own capture cap carries \`bodyTruncated\`. BOUNDED: ${DEFAULT_RUN_SAMPLE_LIMIT} samples per call by default, ${MAX_ENGINE_PAGE_LIMIT} at most - a larger \`limit\` is refused, not clamped. \`pagination\` says how many exist; read the rest with \`offset\`.`,
		annotations: {
			title: "Get run samples",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID whose captured samples to read."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_ENGINE_PAGE_LIMIT)
				.optional()
				.describe(
					`How many samples to return (default ${DEFAULT_RUN_SAMPLE_LIMIT}, max ${MAX_ENGINE_PAGE_LIMIT}).`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many samples to skip, for paging (default 0)."),
		},
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			const limit = optionalPageLimit(
				args,
				"limit",
				DEFAULT_RUN_SAMPLE_LIMIT,
				MAX_ENGINE_PAGE_LIMIT
			);
			const offset = optionalOffset(args, "offset");
			return pagedRead(
				() => ctx.client.getRunSamples(runId, limit, offset, signal),
				"captured samples"
			);
		},
	},
	{
		name: "get_run_timeseries",
		category: "read",
		invalidates: [],
		description:
			"Get a completed run's per-tick time series: RPS, latency percentiles, error rate and status mix, one row per tick, oldest first. This is the stored history the app's charts are drawn from - use it to see how a run behaved over time, where get_run_report gives the totals and get_live_metrics the last few ticks of a run still going. A run with no ticks (a design run, or a load run that never started) returns an empty page, not an error. " +
			`BOUNDED: ${DEFAULT_RUN_SERIES_LIMIT} ticks per call by default, ${MAX_RUN_SERIES_LIMIT} at most - a larger \`limit\` is refused, not clamped, and the engine's own 5000-row default is far past what a tool result can carry. \`pagination\` says how many exist; read the rest with \`offset\`.`,
		annotations: {
			title: "Get run time series",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID whose time series to read."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_RUN_SERIES_LIMIT)
				.optional()
				.describe(
					`How many ticks to return (default ${DEFAULT_RUN_SERIES_LIMIT}, max ${MAX_RUN_SERIES_LIMIT}).`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many ticks to skip, for paging (default 0)."),
		},
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			const limit = optionalPageLimit(
				args,
				"limit",
				DEFAULT_RUN_SERIES_LIMIT,
				MAX_RUN_SERIES_LIMIT
			);
			const offset = optionalOffset(args, "offset");
			return pagedRead(
				() => ctx.client.getRunTimeSeries(runId, limit, offset, signal),
				"ticks"
			);
		},
	},
	{
		name: "get_run_monitor",
		category: "read",
		invalidates: [],
		description:
			"Get the server vitals scraped during a run - the target's own CPU, memory and load, sampled on the monitor's cadence rather than the tick cadence, so these rows do not line up with get_run_timeseries row for row. Answers 'was the target saturated?' beside the client-side latency the report shows. Only a run started with a `monitor` block has any; any other run returns an empty page, not an error. " +
			`BOUNDED the same way as get_run_timeseries: ${DEFAULT_RUN_SERIES_LIMIT} samples by default, ${MAX_RUN_SERIES_LIMIT} at most, refused above that. \`pagination\` says how many exist; read the rest with \`offset\`.`,
		annotations: {
			title: "Get run monitor series",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID whose monitor samples to read."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_RUN_SERIES_LIMIT)
				.optional()
				.describe(
					`How many samples to return (default ${DEFAULT_RUN_SERIES_LIMIT}, max ${MAX_RUN_SERIES_LIMIT}).`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many samples to skip, for paging (default 0)."),
		},
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			const limit = optionalPageLimit(
				args,
				"limit",
				DEFAULT_RUN_SERIES_LIMIT,
				MAX_RUN_SERIES_LIMIT
			);
			const offset = optionalOffset(args, "offset");
			return pagedRead(
				() => ctx.client.getRunMonitorSeries(runId, limit, offset, signal),
				"monitor samples"
			);
		},
	},
	{
		name: "get_engine_config",
		category: "read",
		invalidates: [],
		description:
			"Get the engine's tunable configuration entries (workers, timeouts, connection limits, buffer sizes, etc.), each with its current value, default, type, and allowed range.",
		annotations: {
			title: "Get engine config",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.getConfig(signal)),
	},
	{
		name: "run_request",
		category: "execute",
		invalidates: ["run", "cookie"],
		description:
			"Send a single HTTP request through Vayu (Design mode) and return the response, timing, and any test results. The target host must be on Vayu's MCP allowlist. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given, using the same precedence as the app. " +
			VARIABLE_PRECEDENCE_SENTENCE +
			` See ${VARIABLE_RESOLUTION_URI}.` +
			" Pass an `auth` block to have the engine apply bearer/basic/apikey/oauth2 auth. Pass a `preRequestScript` to sign or otherwise rewrite the request before it goes out - its pm.request edits are applied to what is actually sent. (To replay a saved request with its stored auth and scripts across a whole collection, use run_collection_smoke.) Certificate verification is always on for a send made this way - `verifySSL: false` is refused here, because a skipped check on a one-off call is recorded nowhere; it belongs on the saved request, where the app shows it. " +
			ENGINE_DEFAULT_HEADERS_SENTENCE +
			" " +
			`The response body is capped at ${MAX_INLINE_BODY_BYTES} bytes in this result: over that, \`bodyRaw\` holds the first ${MAX_INLINE_BODY_BYTES} bytes, \`bodyTruncated\` is true, \`bodySize\` is the real size, and the parsed \`body\` is null rather than a full copy of what was cut. A large \`rawRequest\` is capped the same way (headers kept whole) and flagged with \`rawRequestTruncated\`. \`bodyCapped\` is a different fact and is always present: it says the engine itself stopped reading the response at \`maxDesignResponseBodyBytes\`, so \`bodySize\` is the prefix it read and re-sending returns the same amount - raise that config entry to read more, where \`bodyTruncated\` is only this result showing less than the engine returned.`,
		annotations: {
			title: "Send a request",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional().describe("HTTP method (default GET)."),
			url: z.string().describe("Request URL (may contain {{variables}})."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Request headers as a string map."),
			body: z.string().optional().describe("Request body content."),
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. File parts are not supported. For graphql, a bare query document is enveloped as `{"query": ...}` and sent as application/json; an envelope you write yourself is sent unchanged. That is the POST transport: with `method` GET the same document is sent as `query`/`operationName`/`variables` query parameters and no body, which is what GraphQL-over-HTTP defines GET to mean - so use POST for a mutation, and note that a GET is what a request gets by default. For jsonrpc, a bare call object gains `"jsonrpc":"2.0"` - plus `"id":1` when it names no id - and is sent as application/json; a frame already declaring a string `"jsonrpc"` is sent byte for byte, so write the frame yourself to choose your own id or to send a notification (no id). A top-level array is a batch call and is sent unchanged. An xml `body` is sent byte for byte as application/xml; a Content-Type you set yourself wins.'
				),
			auth: authInput,
			httpVersion: z
				.enum(HTTP_VERSIONS)
				.optional()
				.describe(
					'Protocol to negotiate: "auto" | "http1.1" | "http2" (default "auto"). Mirrors the request builder\'s Settings tab picker.'
				),
			verifySSL: verifySSLSendInput,
			requestId: z.string().optional().describe("Optional saved request ID to link."),
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
			data: dataRowInput,
			disabledDefaultHeaders: defaultHeaderOptOutsInput,
			preRequestScript: z
				.string()
				.optional()
				.describe(
					"JavaScript run before the request is sent. It may edit pm.request.url / .method / .headers / .body, and those edits are what gets sent - a script-set header overrides the engine-applied auth. The sandbox is synchronous and has no network: to sign a request use pm.crypto.sha256 / pm.crypto.hmacSha256 and the btoa / atob globals. Read the `vayu://scripting/completions` resource for the full surface."
				),
			postRequestScript: validationScriptInput,
			tests: validationScriptAliasInput,
			stream: streamInput,
			maxStreamEvents: maxStreamEventsInput,
			streamBudgetMs: streamBudgetMsInput,
		},
		handler: async (args, ctx, signal) => {
			// Before anything is composed, let alone sent: a refusal that arrived
			// after the exchange would be a request already made insecurely. `true`
			// falls through - it restates the composed default (issue #795).
			if (args.verifySSL === false) return errorResult(INSECURE_TLS_REFUSAL);
			const request: Record<string, unknown> = {
				...readRequestOverrides(args),
				url: requireStr(args, "url"),
			};
			if (request.method === undefined) request.method = "GET";
			// `/execute`'s own key names for the two ad-hoc scripts. Scripts ride
			// through composition untouched - the engine never interpolates them.
			const preScript = str(args, "preRequestScript");
			if (preScript !== undefined) request.preRequestScript = preScript;
			const postScript = readValidationScript(args);
			if (postScript !== undefined) request.postRequestScript = postScript;
			const authArg = readAuthArg(args);
			if (authArg) request.auth = authArg;

			// Compose engine-side (pure), gate on the *resolved* URL, then execute
			// the composed payload. The gate is a host rule: a pre-request script
			// this call forwards can still edit `pm.request`, and since #1008 a
			// name compose could not answer is resolved before the send - neither
			// of which can reach a host the allowlist did not see, because an
			// unresolved authority is refused rather than checked (safety.ts).
			let payload: Record<string, unknown>;
			try {
				payload = await composeViaEngine(
					ctx.client,
					{
						request,
						collectionId: str(args, "collectionId"),
						environmentId: str(args, "environmentId"),
					},
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const gate = checkAllowlist(String(payload.url ?? ""), ctx.config);
			if (!gate.ok) return errorResult(gate.error!);
			// `requestId` here only links the run to a saved request for History;
			// it must not reach /compose, which would compose the *stored* row
			// instead of the arguments the agent actually gave.
			const linkId = str(args, "requestId");
			if (linkId !== undefined) payload.requestId = linkId;

			// Beside the composed payload, not through composition: `{{data.*}}`
			// survives `/compose` by design (`request_composer.hpp`), so the
			// tokens are still written when `/execute` binds them against this
			// row (issue #601). Absent means today's send, unchanged.
			const dataRow = args.data;
			if (dataRow !== undefined && dataRow !== null) payload.data = dataRow;

			// The same posture, and the same reason it is not composed: the names
			// say which of the engine's own defaults this send declines, which
			// composition neither reads nor rewrites (issue #1337).
			applyDefaultHeaderOptOuts(args, payload);

			// Stated on every call, never elided: the two answers have different
			// *shapes* - `202 {runId, eventsUrl}` against the exchange - so a
			// caller that let composition or an engine default decide would not
			// know which one it was about to parse. The same rule both app
			// clients follow for `followRedirects`.
			const streaming = args.stream === true;
			payload.stream = streaming;
			if (!streaming) {
				return callEngine(
					() => ctx.client.executeRequest(payload, signal),
					boundExecuteResponse
				);
			}
			return runStreamingRequest(args, payload, ctx, signal);
		},
	},
	{
		name: "update_engine_config",
		category: "write",
		invalidates: ["config"],
		description:
			"Update one or more engine configuration entries. GUARDED: requires write access to be enabled in Vayu Settings. Pass `entries` as a map of config key to new value; the engine validates types/ranges and rejects the whole batch on any invalid value. Some keys require an engine RESTART to take effect - the result lists those under `restartRequired`; they are saved but the running engine keeps the old value until the user restarts it (Vayu Settings → restart engine, or relaunch).",
		annotations: {
			title: "Update engine config",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			entries: z
				.record(z.string(), z.string())
				.describe('Map of config key to new value, e.g. { "workers": "8" }.'),
		},
		outputSchema: configUpdateSchema,
		handler: async (args, ctx, signal) => {
			if (!ctx.config.allowWrites) {
				return errorResult(
					"Config writes are disabled. Turn on write access in Vayu Settings → MCP to allow this."
				);
			}
			const entries = args.entries;
			if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
				return errorResult('"entries" must be an object mapping config keys to values.');
			}
			try {
				const updated = await ctx.client.updateConfig({ entries }, signal);
				const changedKeys = Object.keys(entries as Record<string, unknown>);
				// Best-effort: read back to flag restart-required keys. Failure here
				// must not fail the (already-applied) update.
				let restartRequired: string[] = [];
				try {
					const cfg = await ctx.client.getConfig(signal);
					restartRequired = restartRequiredAmong(cfg, changedKeys);
				} catch {
					/* leave restartRequired empty */
				}
				const result: Record<string, unknown> = { changedKeys, restartRequired, updated };
				if (restartRequired.length > 0) {
					const note =
						`Updated ${changedKeys.length} config key(s). ⚠ Restart required for: ` +
						`${restartRequired.join(", ")}. These are saved, but the running engine keeps ` +
						`the old values until it is restarted (Vayu Settings → restart engine, or relaunch the app).`;
					return {
						content: [
							{ type: "text", text: `${note}\n\n${JSON.stringify(result, null, 2)}` },
						],
						structuredContent: result,
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					structuredContent: result,
				};
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "create_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Create a collection (the folder saved requests live in), with the variables, auth and pre/post-request scripts every request inside it composes against. GUARDED: requires write access to be enabled in Vayu Settings. Pass `parentId` to nest it inside an existing collection; omit it for a top-level one. Returns the created collection - its `id` is what create_request takes as `collectionId`. " +
			precedenceNote(
				"Collection variables sit between globals and the active environment: they shadow globals, a nested collection shadows its ancestors, and the active environment shadows them all."
			),
		annotations: {
			title: "Create collection",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			name: z.string().describe("Display name for the collection."),
			parentId: z
				.string()
				.optional()
				.describe("Optional parent collection ID; omit for a top-level collection."),
			description: z.string().optional(),
			variables: variablesInput("the new collection"),
			auth: storedAuthInput(
				"this collection",
				'A collection is the root of an auth chain and never inherits, so "inherit" is refused by the engine; requests below it that store { mode: "inherit" } resolve to this block.'
			),
			preRequestScript: collectionScriptInput("pre"),
			postRequestScript: collectionScriptInput("post"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const payload: Record<string, unknown> = { name: requireStr(args, "name") };
			const parentId = str(args, "parentId");
			if (parentId !== undefined) payload.parentId = parentId;
			for (const field of ["description", "preRequestScript", "postRequestScript"] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			const patch = readVariablesPatch(args);
			// Merged against nothing, the way create_environment does it: on a
			// create every variable is new, which is what turns the string form
			// into a stored entry and enforces "a new variable carries a value".
			if (patch !== undefined) payload.variables = mergeVariables({}, patch, []).variables;
			return callEngine(() => ctx.client.createCollection(payload, signal));
		},
	},
	{
		name: "update_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Change a collection: its name, description, variables, auth or pre/post-request scripts - the state every request inside it composes against. GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change, and the requests inside it are never touched. Variables merge: one you do not name is left alone, and a named one keeps every flag you do not state; removeVariables deletes names outright. Auth replaces the stored block whole. This is not a move - to re-parent a collection, use move_item. " +
			precedenceNote(
				"Collection variables sit between globals and the active environment: they shadow globals, a nested collection shadows its ancestors, and the active environment shadows them all."
			),
		annotations: {
			title: "Update collection",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection ID to update."),
			name: z.string().optional().describe("New display name."),
			description: z.string().optional().describe("New description."),
			variables: variablesInput("this collection"),
			removeVariables: removeVariablesInput("this collection"),
			auth: storedAuthInput(
				"this collection",
				'A collection never inherits - it is the root of the chain - so the engine refuses "inherit" here; { mode: "none" } is how a collection stops being an auth source.'
			),
			preRequestScript: collectionScriptInput("pre"),
			postRequestScript: collectionScriptInput("post"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			// The engine merge-patches, so a body naming nothing would be a write
			// that changes nothing while reporting success. Say so instead.
			const payload: Record<string, unknown> = {};
			for (const field of [
				"name",
				"description",
				// An empty string is a value here, not an omission - the same rule
				// update_request's scripts follow, and how one gets cleared.
				"preRequestScript",
				"postRequestScript",
			] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			const patch = readVariablesPatch(args);
			const removals = removalNames(args);
			if (Object.keys(payload).length === 0 && patch === undefined && removals.length === 0) {
				return errorResult(
					'Pass at least one field to change ("name", "description", "variables", "removeVariables", "auth", "preRequestScript" or "postRequestScript").'
				);
			}
			let absentRemovals: string[] = [];
			if (patch !== undefined || removals.length > 0) {
				// `PUT /collections/:id` replaces the whole variables blob, exactly
				// as the environment PUT does, so "change one variable" is a
				// read-merge-write here too - without the read, an agent setting one
				// variable would drop every other one the collection holds.
				let existing: Record<string, unknown>;
				try {
					existing = ((await ctx.client.getCollection(collectionId, signal)) ??
						{}) as Record<string, unknown>;
				} catch (err) {
					return engineErrorResult(err);
				}
				const merged = mergeVariables(existing.variables, patch, removals);
				payload.variables = merged.variables;
				absentRemovals = merged.absentRemovals;
			}
			const result = await callEngine(() =>
				ctx.client.updateCollection(collectionId, payload, signal)
			);
			return result.isError
				? result
				: withCaveat(result, absentRemovalCaveat(absentRemovals));
		},
	},
	{
		name: "delete_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Delete a collection AND EVERYTHING INSIDE IT - every nested sub-collection and every saved request in them. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the number of sub-collections and requests this destroys; otherwise call once to see those counts, then again with `confirmed: true`. It goes to Vayu's Trash rather than disappearing outright - list_trash shows it there, and restore_trash_entry puts it back, until the retention window (`trashRetentionDays`, 30 days by default) runs out.",
		annotations: {
			title: "Delete collection",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection ID to delete, with its whole subtree."),
			confirmed: confirmedInput("actually delete the collection and its contents"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			// Read what the cascade takes before asking: an unreadable subtree is a
			// refusal, never a prompt carrying counts nobody verified.
			let scope: CascadeScope;
			try {
				scope = await readCascadeScope(ctx.client, collectionId, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const cascade = describeCascade(scope);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the collection "${scope.name}"?\n\n${cascade}`,
				acceptTitle: "Delete the collection",
				acceptDescription: "Confirm to delete it and everything inside it.",
				declined: "Collection not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`${cascade}\n\n` +
					"This is a preview. To delete it, call delete_collection again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			const result = await callEngine(() =>
				ctx.client.deleteCollection(collectionId, signal)
			);
			// The counts describe what was destroyed, so they belong only on a
			// delete that happened - a refusal wearing them would read as one.
			return result.isError
				? result
				: withCaveat(
						result,
						`\n\nDeleted "${scope.name}" with ${scope.descendants} sub-collection(s) and ${scope.requests} saved request(s).`
					);
		},
	},
	{
		name: "get_spec",
		category: "read",
		invalidates: [],
		description:
			"Read the OpenAPI document a collection is bound to - where it came from, when it was fetched, its content hash and its size - by `collectionId` (resolving the collection's binding) or by `specId` directly. The document text is NOT included by default: a real spec runs to megabytes, so pass includeContent: true to get it, capped at 32 KB with `contentBytes` reporting the true size. A collection that binds nothing answers `bound: false` rather than failing.",
		annotations: {
			title: "Get bound OpenAPI spec",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.optional()
				.describe("Collection whose binding to resolve. Pass this or specId, not both."),
			specId: z
				.string()
				.optional()
				.describe(
					"Stored document to read directly. Spec IDs come from a collection's binding - there is no list route for them."
				),
			includeContent: z
				.boolean()
				.optional()
				.describe(
					"Include the document text (capped at 32 KB). Off by default - the metadata is what describes a binding, and the text can be megabytes."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = str(args, "collectionId");
			const specIdArg = str(args, "specId");
			if (collectionId && specIdArg) {
				return errorResult(
					'Pass either "collectionId" or "specId", not both - they would have to agree, and this tool cannot say which one you meant if they do not.'
				);
			}
			const includeContent = args.includeContent === true;

			// Assigned on the first two arms below - by the binding the collection
			// resolves to, or by the argument - so it is a string by the time it is
			// read. The "neither was passed" case is the third arm rather than a
			// guard above it: as a guard, proving the `else` still holds an id is a
			// step across two conditions that `strict` control flow does not make in
			// either compiler, and the assertion it would take is the kind that stops
			// being true when someone edits the guard.
			let specId: string;
			let binding: SpecBinding | null = null;
			if (collectionId) {
				let collection: unknown;
				try {
					collection = await ctx.client.getCollection(collectionId, signal);
				} catch (err) {
					return engineErrorResult(err);
				}
				if (collection === null) {
					return errorResult(`No collection with id "${collectionId}".`);
				}
				binding = readSpecBinding(collection);
				// Unbound is an answer, not a failure: "which spec does this
				// collection use" has "none" as a legitimate reply, and an error
				// here would read as an engine or id problem.
				if (!binding) {
					return withCaveat(
						jsonResult({ collectionId, bound: false }),
						"\n\nThis collection is not bound to an OpenAPI document. Binding one is done in the Vayu app (Collection → Spec) - see https://github.com/athrvk/vayu/issues/761."
					);
				}
				specId = binding.specId;
			} else if (specIdArg) {
				specId = specIdArg;
			} else {
				return errorResult('Pass either "collectionId" or "specId".');
			}

			try {
				// The metadata route unless the text was asked for: it is the whole
				// point of `GET /specs/:id/meta` that describing a document does not
				// transfer it, and the full read carries the two extracted indexes
				// as well, which are as heavy as the document itself.
				const document = includeContent
					? await ctx.client.getSpec(specId, signal)
					: await ctx.client.getSpecMeta(specId, signal);
				const meta = isRecord(document) ? document : {};
				const value: Record<string, unknown> = {
					specId,
					sourceUrl: meta.sourceUrl ?? null,
					fetchedAt: meta.fetchedAt ?? null,
					hash: meta.hash ?? null,
					// `contentBytes` is only on the meta read; the full read carries
					// the bytes themselves, so measure them the same way the engine
					// does (`content.size()`) rather than reporting nothing.
					contentBytes:
						typeof meta.contentBytes === "number"
							? meta.contentBytes
							: typeof meta.content === "string"
								? Buffer.byteLength(meta.content, "utf8")
								: null,
					...(binding ? { collectionId, bound: true, binding } : {}),
					...(includeContent ? boundSpecContent(meta) : {}),
				};
				return jsonResult(value);
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "diff_spec",
		category: "read",
		invalidates: [],
		description:
			"Check whether an OpenAPI contract has drifted from the collection bound to it, and where. Pass the collection and the re-fetched document text; the engine compares it against the document the collection is currently bound to AND against every request in its subtree, and answers which operations the document adds, which requests it no longer declares, and which requests changed field by field with the current and next value of each. Reads only: nothing is stored, no binding moves, no request is stamped, so it is safe to ask about a document you have not decided to apply. `identical` is decided on the stored bytes and is the 'already up to date' answer. A field flagged `userTouched` is one somebody edited by hand rather than one the last import wrote - applying the document there would overwrite a person's work. `unmapped` counts requests carrying no operation identity at all, which no comparison covers. APPLYING a drift is app-only for now (Collection -> Spec -> Sync); this tool is the read half.",
		annotations: {
			title: "Diff OpenAPI spec against collection",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to compare. It must already be bound to a document - the comparison is three-way and the bound document is the middle term. Its whole subtree is read, since an imported spec files its requests under one sub-collection per tag."
				),
			content: z
				.string()
				.describe(
					"The re-fetched OpenAPI document text, JSON or YAML. Not stored - this is the candidate, compared against the bytes the collection is bound to. Capped by the maxSpecDocumentBytes setting, the same cap a bind applies."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			// The requests and the bound document are deliberately not sent: the
			// engine walks the subtree and reads the binding itself, so a caller
			// cannot make its own stale copy the "previous" side of a three-way
			// comparison. Nothing is worked out here for the same reason
			// `bind_spec` works nothing out - the comparison is the engine's
			// (`core::diff_spec`), off the bytes handed to it.
			let answer: unknown;
			try {
				answer = await ctx.client.diffSpec({ collectionId, spec: { content } }, signal);
			} catch (err) {
				// The engine's own sentence is the useful one: a 400 names the
				// collection that binds nothing and says to bind it first, a 404
				// names the collection, and a 409 names the binding whose document
				// the store no longer holds.
				return engineErrorResult(err);
			}
			const diff = asRecord(answer);
			const added = boundedBucket(diff.added, (entry) => ({
				operation: entry.operation ?? null,
				folder: entry.folder ?? null,
			}));
			const removed = boundedBucket(diff.removed, (entry) => ({
				requestId: entry.requestId ?? null,
				name: entry.name ?? null,
				operation: entry.operation ?? null,
			}));
			const changed = boundedBucket(diff.changed, changedEntry);
			const truncated = [added, removed, changed].some(
				(bucket) => bucket.entries.length < bucket.total
			);
			return withCaveat(
				jsonResult({
					collectionId,
					identical: diff.identical === true,
					// The engine's totals, not these lists' lengths - see
					// `MAX_SPEC_DIFF_ENTRIES` for why the two can differ.
					summary: {
						added: added.total,
						removed: removed.total,
						changed: changed.total,
						unchanged: typeof diff.unchanged === "number" ? diff.unchanged : 0,
						unmapped: typeof diff.unmapped === "number" ? diff.unmapped : 0,
					},
					added: added.entries,
					removed: removed.entries,
					changed: changed.entries,
					entriesTruncated: truncated,
				}),
				`\n\n${describeSpecDiff(diff)}${
					truncated
						? ` Each list here is capped at ${MAX_SPEC_DIFF_ENTRIES} entries; the counts in \`summary\` are the true totals.`
						: ""
				}`
			);
		},
	},
	{
		name: "sync_spec",
		category: "write",
		// The same set a bind uses, and for the same reason: the document and the
		// binding live on the collection row, and the requests this creates,
		// updates and deletes live beneath it. A sync moves both at once, so
		// declaring one would leave an open request list showing rows this call
		// has already rewritten.
		invalidates: ["collection", "request"],
		description:
			"Apply a drifted OpenAPI contract to the collection bound to it - the safe half of it. GUARDED: requires write access to be enabled in Vayu Settings. Pass the collection and the re-fetched document text; the engine stores the document, moves the binding to it, and creates, updates and deletes requests in ONE transaction - nothing lands unless all of it does. WHAT IT WRITES IS NOT YOURS TO CHOOSE, deliberately: this sends `policy: \"safe\"` and the engine decides, which means every operation the document adds becomes a request, every field the document moved that nobody had edited by hand is written, and NOTHING IS DELETED and NO HAND-EDITED FIELD IS OVERWRITTEN. A request whose bound document could not be read is left alone whole, since there nobody's edit can be told from the document's change. `skipped` reports what that left: requests untouched, fields not written, deletions not made. Use `diff_spec` first to see the drift and which of it is marked safe - it is the same answer this applies. To apply anything the policy declines - a deletion, or a field somebody edited - use the Vayu app (Collection -> Spec -> Sync), where a person can tick it.",
		annotations: {
			title: "Apply OpenAPI spec drift",
			readOnlyHint: false,
			// Nothing a person authored is written: the policy skips every
			// hand-edited field, deletes nothing, and leaves a request it cannot
			// reason about alone. What it does write is what the last import
			// wrote and the document has since moved - which is the document's,
			// not the user's. That is precisely what makes the safe half of a
			// sync the half an agent may have.
			destructiveHint: false,
			// The engine mints a new `spec_documents` row per call, as a bind
			// does, so syncing the same bytes twice is not the same call twice.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to sync. It must already be bound to a document - a sync moves a binding forward and binding is `bind_spec`. Its whole subtree is written, since an imported spec files its requests under one sub-collection per tag."
				),
			content: z
				.string()
				.describe(
					"The re-fetched OpenAPI document text, JSON or YAML. Stored verbatim and the binding moves to it, even when no request row changes - catching a collection up to a document that only reworded its description is a real sync. Capped by the maxSpecDocumentBytes setting."
				),
			sourceUrl: z
				.string()
				.optional()
				.describe(
					"Where the document was re-fetched from, if it came from a URL. Recorded on the document so the next sync knows what to re-fetch; omit it for one you were handed as text."
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			const sourceUrl = str(args, "sourceUrl");
			// `policy` rather than rows, and no argument offering an alternative:
			// which of a drift is safe to write is `core::safe_spec_apply`, the
			// same function whose answer `diff_spec` reports per entry. A tool
			// that let an agent name rows would be a second opinion about which
			// of a person's fields a sync may overwrite - the one judgement this
			// side must never make (issue #871).
			let outcome: unknown;
			try {
				outcome = await ctx.client.syncSpec(
					{
						collectionId,
						spec: { content, ...(sourceUrl ? { sourceUrl } : {}) },
						policy: "safe",
					},
					signal
				);
			} catch (err) {
				// The engine's own sentence: a 400 names the collection that binds
				// nothing and says to bind it first, a 404 names the collection,
				// and a 409 says a row the comparison was made against has since
				// gone - which is a re-check, not a bad request.
				return engineErrorResult(err);
			}
			return withCaveat(jsonResult(outcome), `\n\n${describeSync(outcome)}`);
		},
	},
	{
		name: "import_document",
		category: "write",
		// All three families: a Postman collection creates collections and
		// requests, an environment export creates an environment, and a globals
		// export rewrites the global scope. Which of them a given document
		// touches is not knowable until it has been read, and an entity left out
		// would leave an open list showing a tree the import has already changed.
		invalidates: ["collection", "request", "environment"],
		description:
			"Import a collection, environment or API spec from its document text. GUARDED: requires write access to be enabled in Vayu Settings. Every format Vayu accepts is read by the engine: OpenAPI 3.x and 2.0 (JSON or YAML), Postman Collection v2.1 and v2.0, a Postman environment or globals export, and an Insomnia v4 export - detection is by content, so you do not say which one it is. The whole tree lands in one transaction: a document that is refused creates nothing. An OpenAPI document is stored and the collection is bound to it, so its runs report contract coverage and its responses are schema-checked straight away, and its operations are filed under one sub-collection per tag. The result reports what was created plus `meta`, which names the format, the counts, and - in `meta.skipped` - everything the document declared that Vayu cannot represent, so a lossy import says so rather than looking complete. A Postman globals export MERGES into the existing global scope, imported values winning on a collision; nothing else here overwrites anything.",
		annotations: {
			title: "Import a document",
			readOnlyHint: false,
			// Nothing existing is removed: an import only creates. The one write
			// that touches prior state is the globals merge, which adds and
			// overwrites by key and deletes nothing.
			destructiveHint: false,
			// Two imports of one document are two collections, not one.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			content: z
				.string()
				.describe(
					"The document text, verbatim - JSON or YAML. Capped by the maxSpecDocumentBytes setting, which is what an over-large document is refused against."
				),
			importEnvironments: z
				.boolean()
				.optional()
				.describe(
					"Whether to create the environments and global variables the document carries. Defaults to true. Off, they are not created and the counts report 0 - the same toggle the import dialog offers."
				),
			importScripts: z
				.boolean()
				.optional()
				.describe(
					"Whether to import pre-request and post-request scripts. Defaults to true. Off, every script imports empty - a Postman collection's `event` blocks are code from a document you were handed."
				),
			sourceUrl: z
				.string()
				.optional()
				.describe(
					"Where the document was fetched from, if it came from a URL. Recorded on a stored OpenAPI document so a later sync knows what to re-fetch, and used to resolve a relative `servers[0].url`; omit it for a document you were handed as text."
				),
			fileName: z
				.string()
				.optional()
				.describe("What the file is called, for the result's `meta` only. Never stored."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const content = requireStr(args, "content");
			const sourceUrl = str(args, "sourceUrl");
			const fileName = str(args, "fileName");
			// External `$ref`s are not followed: resolving one means fetching a
			// URL or reading a file beside the document, which is the import
			// dialog's business (a URL proxy and a gated IPC) and not an agent's.
			// A document that names another file imports whole and says so -
			// `meta.skipped` carries no `external_ref` count here, because nothing
			// tried.
			// An option the caller did not state is left absent rather than
			// defaulted here: the engine's default is the one the import dialog
			// offers, and restating it would be a second place for it to drift.
			const importEnvironments = bool(args, "importEnvironments");
			const importScripts = bool(args, "importScripts");
			let outcome: unknown;
			try {
				outcome = await ctx.client.importDocument(
					{
						content,
						...(importEnvironments === undefined ? {} : { importEnvironments }),
						...(importScripts === undefined ? {} : { importScripts }),
						...(sourceUrl ? { sourceUrl } : {}),
						...(fileName ? { fileName } : {}),
					},
					signal
				);
			} catch (err) {
				// The engine's own sentence: "Unrecognised format" for a file no
				// format claims, a read failure naming the line for one that is
				// broken, and the cap by name for one that is too large.
				return engineErrorResult(err);
			}
			return withCaveat(jsonResult(outcome), `\n\n${describeImport(outcome)}`);
		},
	},
	{
		name: "bind_spec",
		category: "write",
		// Both families: the binding lives on the collection row, and the stamps
		// this writes and clears live on the requests beneath it. Declaring only
		// the collection would leave an open request list showing identity a bind
		// has already removed. No `spec` family - the stored document is
		// immutable under its id, and this creates a new one rather than
		// changing any cached row.
		invalidates: ["collection", "request"],
		description:
			"Bind a collection to an OpenAPI document, so its runs report contract coverage and its responses are schema-checked. GUARDED: requires write access to be enabled in Vayu Settings. Pass the document text (JSON or YAML) - the engine stores it, works out which of the collection's requests is which operation by method and path shape, and records that identity, all in one transaction: nothing is created or deleted, and a bind that fails writes nothing at all. RE-BINDING REPLACES THE CONTRACT: any request whose identity the new document does not account for has it cleared, because a stamp naming an operation of a document this collection is no longer bound to would be read as identity rather than as a gap. The result reports how many requests were stamped and how many cleared, plus the requests and operations nothing paired with.",
		annotations: {
			title: "Bind OpenAPI spec",
			readOnlyHint: false,
			// Nothing a user authored is lost: no request is created or deleted,
			// the only field written is the identity a bind exists to record, and
			// the document a collection was bound to before is still stored while
			// anything else binds it. A re-bind is undone by binding the previous
			// document again.
			destructiveHint: false,
			// The engine mints a new `spec_documents` row per call, so binding the
			// same bytes twice is not the same call twice.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to bind. Its whole subtree is matched - an imported spec files its requests under one sub-collection per tag."
				),
			content: z
				.string()
				.describe(
					"The OpenAPI document text, JSON or YAML, stored verbatim. Capped by the maxSpecDocumentBytes setting."
				),
			sourceUrl: z
				.string()
				.optional()
				.describe(
					"Where the document came from, if it came from a URL. Recorded on the document so a later sync knows what to re-fetch; omit it for a document you were handed as text."
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			const sourceUrl = str(args, "sourceUrl");
			// The document and the collection, and nothing worked out here: the
			// pairing is the engine's (`core::match_operations`), read off the
			// bytes it is about to store. An agent has no OpenAPI reader, and one
			// written here would be the second opinion about what a document
			// declares that #761's phase B moved the reader engine-side to end.
			let outcome: unknown;
			try {
				outcome = await ctx.client.bindSpec(
					{ collectionId, spec: { content, ...(sourceUrl ? { sourceUrl } : {}) } },
					signal
				);
			} catch (err) {
				return engineErrorResult(err);
			}
			return withCaveat(jsonResult(outcome), `\n\n${describeBind(outcome)}`);
		},
	},
	{
		name: "export_spec",
		category: "read",
		invalidates: [],
		description:
			"Export a collection as an OpenAPI document - its own bound document updated, or a skeleton describing its requests when it binds none. Reads only: nothing is stored, and the collection is left exactly as it is. A bound export patches the stored document, so everything Vayu does not model (vendor extensions, security schemes, unreferenced components) survives and operations no request claims are removed; a skeleton is a starting point rather than a contract, with no schema Vayu did not read off a stored example body. `notes` says what the export could not carry - a request with no operation identity, an example whose media type nobody recorded - and the document text is capped at 32 KB with `contentBytes` reporting the true size, so a large spec comes back described rather than whole.",
		annotations: {
			title: "Export collection as OpenAPI",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to export. Its whole subtree is read - an OpenAPI import files requests under one sub-collection per tag - stopping at any collection bound to a different document."
				),
			format: z
				.enum(["json", "yaml"])
				.optional()
				.describe('Serialization to write. Defaults to "json".'),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const format = str(args, "format") || "json";
			let exported: unknown;
			try {
				exported = await ctx.client.exportSpec(collectionId, format, signal);
			} catch (err) {
				// The engine's own sentence, which is the useful one here: a 404
				// names the collection, and a 409 names the binding whose document
				// it could not read and says unbinding would export a skeleton.
				return engineErrorResult(err);
			}
			const answer = isRecord(exported) ? exported : {};
			const text = typeof answer.text === "string" ? answer.text : "";
			const { text: bounded, truncated } = boundText(text);
			return jsonResult({
				collectionId,
				format,
				fileName: answer.fileName ?? null,
				notes: answer.notes ?? null,
				document: bounded,
				documentTruncated: truncated,
				contentBytes: Buffer.byteLength(text, "utf8"),
			});
		},
	},
	{
		name: "unbind_spec",
		category: "write",
		invalidates: ["collection"],
		description:
			"Detach a collection from the OpenAPI document it is bound to. GUARDED: requires write access to be enabled in Vayu Settings. The document itself is kept - other collections may bind it - and the requests keep the operation identities they were stamped with, exactly as the app's Unbind button leaves them, so re-binding the same document later costs nothing. After this the collection's runs report no contract coverage and its responses are no longer schema-checked. Re-binding is `bind_spec`, which restores this state exactly if you hand it the same document.",
		annotations: {
			title: "Unbind OpenAPI spec",
			readOnlyHint: false,
			// The binding goes, nothing it named does: the document stays stored and
			// the stamps stay on the requests, and a re-bind in the app restores the
			// state this leaves. That is not the irreversible loss the hint marks.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection to unbind from its OpenAPI document."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			let collection: unknown;
			try {
				collection = await ctx.client.getCollection(collectionId, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			if (collection === null) {
				return errorResult(`No collection with id "${collectionId}".`);
			}
			const binding = readSpecBinding(collection);
			// Read first so an unbound collection is reported as already unbound
			// rather than written to. The PUT would succeed either way - the engine
			// reads `null` as "reset to the default", and the default is unbound -
			// and an agent told "unbound" about a collection that was never bound
			// would believe it had changed something.
			if (!binding) {
				return withCaveat(
					jsonResult({ collectionId, bound: false }),
					"\n\nNothing to do: this collection was not bound to an OpenAPI document."
				);
			}
			// `null`, not `{}`: the engine reads an absent field as "keep" and null
			// as "reset to the default", which is unbound. The same value the Spec
			// tab's Unbind sends, so the two paths cannot come to mean different
			// things.
			const result = await callEngine(() =>
				ctx.client.updateCollection(collectionId, { openapi: null }, signal)
			);
			return result.isError
				? result
				: withCaveat(
						result,
						`\n\nUnbound from spec ${binding.specId}. The document is still stored (another collection may bind it), and the requests keep their recorded operation identities.`
					);
		},
	},
	{
		name: "create_request",
		category: "write",
		invalidates: ["request"],
		description:
			'Create a saved request inside a collection (stores it; does not send it), with its auth, redirect policy, protocol, stream flag and certificate-verification setting, and its pre-request and test scripts - everything the app\'s builder stores except file body parts. GUARDED: requires write access to be enabled in Vayu Settings. The URL may contain {{variables}} since it is only saved, not executed, and a stored script runs only when the request is later sent. Auth is stored as written and resolved at send time, so {{variables}} inside it are fine; leaving `auth` out stores the default "inherit", which resolves against the collection chain.',
		annotations: {
			title: "Create saved request",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection to add the request to."),
			name: z.string().describe("Display name for the saved request."),
			url: z.string().describe("Request URL (may contain {{variables}})."),
			method: z.string().optional().describe("HTTP method (default GET)."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Headers as a string map."),
			body: z.string().optional().describe("Request body content."),
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A jsonrpc `body` may be the bare call object - the engine adds `"jsonrpc":"2.0"` and `"id":1` when it names no id, and sends a frame that already declares a string `"jsonrpc"` unchanged. File parts are not supported here - a multipart file part names a path on the user\'s machine, which an agent cannot choose for them; author it in the app. A graphql `body` may be the bare query document, and the method decides how it travels: the `{"query": ...}` JSON envelope on POST, `query`/`operationName`/`variables` query parameters with no body on GET - so give a mutation `method` POST rather than leaving the GET a new request defaults to. An xml `body` is stored and sent verbatim as application/xml.'
				),
			description: z.string().optional(),
			auth: storedAuthInput(
				"this request",
				'Omit it for the stored default, "inherit", which resolves against the collection chain when the request is sent.'
			),
			...requestSettingsInput(),
			preRequestScript: storedScriptInput("pre", false),
			postRequestScript: storedScriptInput("post", false),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const payload: Record<string, unknown> = {
				collectionId: requireStr(args, "collectionId"),
				name: requireStr(args, "name"),
				url: requireStr(args, "url"),
				method: str(args, "method") ?? "GET",
			};
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			applyRequestSettings(args, payload);
			if (args.headers && typeof args.headers === "object") {
				payload.headers = toKeyValueEntries(args.headers);
			}
			const body = str(args, "body");
			if (body !== undefined) {
				const bodyType = str(args, "bodyType") ?? "text";
				// The engine stores the body blob verbatim; the canonical shape keys
				// off `mode` (not `type`), so a `type`-keyed body would not round-trip
				// in the app. `bodyType` mirrors it into the denormalized column.
				payload.body = bodyPayload(bodyType, body);
				payload.bodyType = bodyType;
			}
			// Pass-through strings: absent leaves the engine's own default (empty),
			// so only what the caller actually named is sent.
			for (const field of ["description", "preRequestScript", "postRequestScript"] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			return callEngine(() => ctx.client.createRequest(payload, signal));
		},
	},
	{
		name: "update_request",
		category: "write",
		invalidates: ["request"],
		description:
			"Correct a saved request: its name, URL, method, headers, body, auth, redirect policy, protocol, stream flag, certificate-verification setting, description or pre/post-request scripts. GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change - anything you leave out keeps its stored value. Passing `headers` replaces the whole header list, so send every header the request should end up with; passing `auth` replaces the whole auth block, so send the mode and its credentials together ({ mode: 'none' } clears it, { mode: 'inherit' } hands it back to the collection chain); passing a script replaces that script, and an empty string clears it.",
		annotations: {
			title: "Update saved request",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request ID to update."),
			name: z.string().optional().describe("New display name."),
			url: z.string().optional().describe("New URL (may contain {{variables}})."),
			method: z.string().optional().describe("New HTTP method."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Replacement headers as a string map (replaces the stored list)."),
			body: z.string().optional().describe("New request body content."),
			bodyType: z
				.string()
				.optional()
				.describe(
					"Body type for `body`: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded. Only meaningful alongside `body`. A jsonrpc `body` is enveloped engine-side exactly as `create_request` describes, and a graphql `body` travels by the same method-dependent rule that tool describes - the JSON envelope on POST, query parameters on GET; an xml `body` is stored and sent verbatim as application/xml. File parts are not supported here; a stored one is left alone unless `body` replaces the whole body."
				),
			description: z.string().optional().describe("New description."),
			auth: storedAuthInput(
				"this request",
				"Replaces the stored block whole - send the mode and its credentials together. Leave it out to keep what is stored."
			),
			...requestSettingsInput(),
			preRequestScript: storedScriptInput("pre", true),
			postRequestScript: storedScriptInput("post", true),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			/*
			 * The payload carries exactly what the caller named: `PUT /requests/:id`
			 * is a merge-patch (absent keeps, null resets), so a field omitted here
			 * is a field left alone. That is also why nothing is defaulted - a
			 * `method: "GET"` filler would silently rewrite the stored verb.
			 */
			const payload: Record<string, unknown> = {};
			for (const field of [
				"name",
				"url",
				"method",
				"description",
				// An empty string is a value here, not an omission: the engine's
				// merge-patch stores it, which is how a script gets cleared.
				"preRequestScript",
				"postRequestScript",
			] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
				payload.headers = toKeyValueEntries(args.headers);
			}
			// Auth and the five Settings fields ride the same rule as the strings
			// above: stated is written, absent is left alone. The block replaces
			// the stored one wholesale because the engine stores it as one JSON
			// column - there is no per-credential patch to offer.
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			applyRequestSettings(args, payload);
			const body = str(args, "body");
			const bodyType = str(args, "bodyType");
			if (body !== undefined) {
				// Both keys move together, the way create_request writes them: the
				// blob is what round-trips in the app, `bodyType` the denormalized
				// column beside it. Writing one without the other leaves the two
				// disagreeing about what the request sends.
				payload.body = bodyPayload(bodyType ?? "text", body);
				payload.bodyType = bodyType ?? "text";
			} else if (bodyType !== undefined) {
				return errorResult(
					'"bodyType" describes "body" - pass the body it applies to, or leave both out.'
				);
			}
			if (Object.keys(payload).length === 0) {
				return errorResult(
					"Pass at least one field to change (name, url, method, headers, body, auth, followRedirects, maxRedirects, httpVersion, stream, description, preRequestScript or postRequestScript)."
				);
			}
			return callEngine(() => ctx.client.updateRequest(requestId, payload, signal));
		},
	},
	{
		name: "delete_request",
		category: "write",
		invalidates: ["request"],
		description:
			"Delete a saved request. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the request's name and URL; otherwise call once for a preview, then again with `confirmed: true`. It goes to Vayu's Trash rather than disappearing outright - list_trash shows it there, and restore_trash_entry puts it back, until the retention window (`trashRetentionDays`, 30 days by default) runs out.",
		annotations: {
			title: "Delete saved request",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request ID to delete."),
			confirmed: confirmedInput("actually delete the request"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			// Read it first so the person answering the prompt sees what is about to
			// go, rather than an id. A 404 here is the answer, not a failure to ask.
			let stored: Record<string, unknown>;
			try {
				const value = await ctx.client.getRequest(requestId, signal);
				stored =
					value && typeof value === "object" ? (value as Record<string, unknown>) : {};
			} catch (err) {
				if (err instanceof EngineRequestError && err.status === 404) {
					return errorResult(`No saved request with id "${requestId}".`);
				}
				return engineErrorResult(err);
			}
			const name =
				typeof stored.name === "string" && stored.name !== "" ? stored.name : requestId;
			const target = [stored.method, stored.url]
				.filter((v) => typeof v === "string")
				.join(" ");
			const subject = target ? `"${name}" (${target})` : `"${name}"`;
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the saved request ${subject}?\n\nIt goes to Vayu's Trash, where it can be restored.`,
				acceptTitle: "Delete the request",
				acceptDescription: "Confirm to delete this saved request.",
				declined: "Request not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete the saved request ${subject}. It would go to Vayu's Trash, where it can be restored.\n\n` +
					"This is a preview. To delete it, call delete_request again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteRequest(requestId, signal));
		},
	},
	{
		name: "list_trash",
		category: "read",
		invalidates: [],
		description:
			"List what delete_collection / delete_request have sent to Vayu's Trash and can still be restored, newest first. Answers ROOTS ONLY - the row a delete actually targeted, never what its cascade took with it: a deleted collection's whole subtree is one entry here, with `collections` and `requests` counting the sub-collections and saved requests that same delete took (always 0 for a request). Each entry also carries `kind` ('collection' | 'request'), `name`, `deletedAt` (Unix ms) and `parentId` (the collection's old parent, or the request's owning collection). Put one back with restore_trash_entry, or destroy it for good with purge_trash_entry. Rows are also purged automatically once older than the `trashRetentionDays` config entry (30 days by default; `0` keeps them forever - see get_engine_config).",
		annotations: {
			title: "List trash",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listTrash(signal)),
	},
	{
		name: "restore_trash_entry",
		category: "write",
		// Both families: a restore can bring back either kind, and there is no
		// argument here that says which in advance - the same reasoning
		// move_item's pair carries.
		invalidates: ["collection", "request"],
		description:
			"Put a deleted collection or saved request back from Vayu's Trash, with everything its delete took along - a restored collection's whole subtree returns too, scoped to that one delete's cohort (see list_trash). GUARDED: requires write access to be enabled in Vayu Settings. This is NOT destructive - it restores data rather than removing it - so there is no confirmation step. A collection whose parent is gone, or is itself still in the trash, comes back at the top level instead of where it was (`reparentedToRoot: true` in the result); a request has no such fallback, so restoring one whose collection is itself deleted or gone is refused with a 409 naming the collection to restore first. An id the trash does not hold - a live row, or one already purged - is a 404.",
		annotations: {
			title: "Restore from Trash",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			id: z.string().describe("Trash entry ID to restore (from list_trash)."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const id = requireStr(args, "id");
			let restored: Record<string, unknown>;
			try {
				const value = await ctx.client.restoreTrashEntry(id, signal);
				restored = isRecord(value) ? value : {};
			} catch (err) {
				// The engine's own message already names the fix (a wrong id, or
				// which collection to restore first) - surface it rather than
				// writing a second sentence that could disagree with it.
				if (
					err instanceof EngineRequestError &&
					(err.status === 404 || err.status === 409)
				) {
					return errorResult(trashRefusalMessage(err));
				}
				return engineErrorResult(err);
			}
			const result = jsonResult(restored);
			// A moved folder is worth telling the caller about - it is not where it
			// used to be, even though the restore itself succeeded.
			return restored.reparentedToRoot === true
				? withCaveat(
						result,
						"\n\nRestored at the top level: its original parent is gone or itself in the trash, so it came back as a tree root rather than where it was."
					)
				: result;
		},
	},
	{
		name: "purge_trash_entry",
		category: "write",
		invalidates: ["collection", "request"],
		description:
			"Permanently destroy one entry in Vayu's Trash, with its whole subtree - requests, and the examples they own. THERE IS NO UNDO: this is the Trash's own hard delete, on top of the soft delete delete_collection / delete_request already did, and once it runs the row is gone the way a delete used to be before Trash existed. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the entry's name and what it holds; otherwise call once for a preview, then again with `confirmed: true`. An id the trash does not hold is a 404, which also stops a mistyped id from destroying anything live.",
		annotations: {
			title: "Purge from Trash",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			id: z.string().describe("Trash entry ID to destroy for good (from list_trash)."),
			confirmed: confirmedInput("actually purge this trash entry for good"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const id = requireStr(args, "id");
			// Read what the purge destroys before asking, the same reasoning
			// delete_collection reads its cascade first: an unreadable entry is a
			// refusal, never a prompt carrying a name and counts nobody verified.
			let entry: TrashRow;
			try {
				entry = await readTrashEntry(ctx.client, id, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const subject = describeTrashEntry(entry);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Permanently destroy ${subject}?\n\nThere is no undo.`,
				acceptTitle: "Purge from Trash",
				acceptDescription: "Confirm to destroy it for good.",
				declined: "Nothing purged - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was purged.\n\n" +
					`This would permanently destroy ${subject}. There is no undo.\n\n` +
					"This is a preview. To purge it, call purge_trash_entry again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.purgeTrashEntry(id, signal));
		},
	},
	{
		name: "list_request_examples",
		category: "read",
		invalidates: [],
		description:
			"List a request's saved example responses - the responses stored beside it, in the order a mock server would serve them (the first match answers). Every row carries its name, status, headers, content type, `order` and `origin` (`import` for what an importer or an OpenAPI sync wrote, `user` for what was saved from a live response). " +
			`Bodies are bounded: one over ${MAX_INLINE_BODY_BYTES} bytes comes back cut with \`bodyClipped: true\` and its stored size in \`bodyBytes\`, and once the list has spent ${MAX_EXAMPLES_BODY_BYTES} bytes the remaining bodies are dropped with \`bodyOmitted: true\` (the row's scalars are always kept). \`bodiesOmitted\` counts them. The engine's own \`bodyTruncated\` is a different fact - it says the response was already cut when it was captured.`,
		annotations: {
			title: "List saved examples",
			readOnlyHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request whose examples to list."),
		},
		handler: async (args, ctx, signal) => {
			const requestId = requireStr(args, "requestId");
			return callEngine(
				() => ctx.client.listRequestExamples(requestId, signal),
				boundExampleBodies
			);
		},
	},
	{
		name: "create_request_example",
		category: "write",
		invalidates: ["request"],
		description:
			"Save an example response on a request - what a mock server for its collection answers with, and what the Examples tab shows. GUARDED: requires write access to be enabled in Vayu Settings. Vayu assigns the id and appends the example after the request's current ones; a request already holding the maximum (100) is refused by the engine. The example is marked as written by hand: an agent cannot claim an example came from an import, because an OpenAPI sync replaces imported examples and leaves the others alone.",
		annotations: {
			title: "Create saved example",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request to attach the example to."),
			name: z.string().describe("Display name for the example (e.g. '200 OK')."),
			status: z
				.number()
				.int()
				.min(100)
				.max(599)
				.optional()
				.describe("HTTP status the example answers with (default 200)."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Response headers as a string map."),
			body: z.string().optional().describe("Response body, stored verbatim."),
			contentType: z
				.string()
				.optional()
				.describe(
					"Content type of `body` (e.g. application/json). Stored beside the headers; a mock server sends it."
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const payload = exampleWritePayload(args);
			payload.name = requireStr(args, "name");
			// Stated rather than left to the engine's default, which is `import`:
			// this row was written by an agent, and the sync that replaces
			// imported rows must not be handed one it did not write (#588, #722).
			payload.origin = "user";
			return callEngine(() => ctx.client.createRequestExample(requestId, payload, signal));
		},
	},
	{
		name: "update_request_example",
		category: "write",
		invalidates: ["request"],
		description:
			"Correct a saved example: its name, status, headers, body or content type. GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change; passing `headers` replaces the whole header list. Where the example came from is not editable - an imported example stays imported, which is what lets an OpenAPI sync tell the two apart.",
		annotations: {
			title: "Update saved example",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Request that owns the example."),
			exampleId: z.string().describe("Example ID to update."),
			name: z.string().optional().describe("New display name."),
			status: z.number().int().min(100).max(599).optional().describe("New HTTP status."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"Replacement response headers as a string map (replaces the stored list)."
				),
			body: z.string().optional().describe("New response body."),
			contentType: z.string().optional().describe("New content type for `body`."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const exampleId = requireStr(args, "exampleId");
			const payload = exampleWritePayload(args);
			if (Object.keys(payload).length === 0) {
				return errorResult(
					'Pass at least one field to change ("name", "status", "headers", "body" or "contentType").'
				);
			}
			return callEngine(() =>
				ctx.client.updateRequestExample(requestId, exampleId, payload, signal)
			);
		},
	},
	{
		name: "delete_request_example",
		category: "write",
		invalidates: ["request"],
		description:
			"Delete one saved example from a request. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the example's name and what a mock server loses; otherwise call once for a preview, then again with `confirmed: true`. There is no undo, and a mock server for this collection stops answering with it once it is restarted.",
		annotations: {
			title: "Delete saved example",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Request that owns the example."),
			exampleId: z.string().describe("Example ID to delete."),
			confirmed: confirmedInput("actually delete the example"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const exampleId = requireStr(args, "exampleId");
			// Read the list first so the prompt names the example rather than an
			// id - the same rule delete_request follows. There is no by-id read
			// for one example, and the owner check the engine makes on every
			// nested path is exactly this scan: an id stored under another
			// request is "no such example" here too.
			let stored: Record<string, unknown> | undefined;
			try {
				const rows = await ctx.client.listRequestExamples(requestId, signal);
				stored = (Array.isArray(rows) ? rows : []).find(
					(row) => isRecord(row) && row.id === exampleId
				) as Record<string, unknown> | undefined;
			} catch (err) {
				return engineErrorResult(err);
			}
			if (!stored) {
				return errorResult(`No example with id "${exampleId}" on request "${requestId}".`);
			}
			const subject = describeExample(exampleId, stored);
			const consequence =
				"A mock server for this collection stops answering with it once it is restarted. This cannot be undone.";
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the saved example ${subject}?\n\n${consequence}`,
				acceptTitle: "Delete the example",
				acceptDescription: "Confirm to delete this saved example.",
				declined: "Example not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete the saved example ${subject}. ${consequence}\n\n` +
					"This is a preview. To delete it, call delete_request_example again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteRequestExample(requestId, exampleId, signal));
		},
	},
	{
		name: "move_item",
		category: "write",
		/*
		 * Both families, and the pair is load-bearing rather than cautious. The
		 * `request` event narrows on the `collectionId` the call named, which for
		 * a move is the *destination* - the list the row left would stay stale on
		 * its own. `collection` is the coarse one (`collections.all` +
		 * `requests.all`), so it covers the source list, the two parents' orders,
		 * and the subtree a moved collection took with it.
		 */
		invalidates: ["collection", "request"],
		description:
			"Move a collection or a saved request into another collection - the row menu's 'Move to...', over MCP. GUARDED: requires write access to be enabled in Vayu Settings. It lands at the end of its new parent by default, or at the front with `position: 'first'`; positions in between stay a UI gesture, because naming one means doing the app's ordering arithmetic from the outside. A collection may move to the top level (`parentId: null`); a request always belongs to a collection. Refused, with nothing written, when a collection would move into itself or into its own subtree.",
		annotations: {
			title: "Move an item",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: z
				.enum(["collection", "request"])
				.describe("What is being moved: a collection (folder) or a saved request."),
			id: z.string().describe("ID of the collection or request to move."),
			parentId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Destination for a collection: another collection's id, or null for the top level. Required when `type` is 'collection'."
				),
			collectionId: z
				.string()
				.optional()
				.describe(
					"Destination collection for a request. Required when `type` is 'request'."
				),
			position: z
				.enum(MOVE_POSITIONS)
				.optional()
				.describe("Where it lands among its new siblings: 'last' (default) or 'first'."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const type = requireStr(args, "type");
			if (type !== "collection" && type !== "request") {
				return errorResult('"type" must be "collection" or "request".');
			}
			const id = requireStr(args, "id");
			// Read off the raw value rather than through `str`, which answers
			// `undefined` for a non-string: a `position: 0` would then default to
			// "last" and land the row at the opposite end of the one it named.
			const position = args.position === undefined ? "last" : args.position;
			if (position !== "first" && position !== "last") {
				return errorResult('"position" must be "first" or "last".');
			}

			let batch: Record<string, unknown>;
			try {
				if (type === "collection") {
					// Stated, not inferred: `parentId` absent would have to mean
					// either "the top level" or "leave it where it is", and a move
					// that guessed wrong is a folder somewhere nobody asked for.
					if (!("parentId" in args)) {
						return errorResult(
							'Moving a collection needs "parentId" - another collection\'s id, or null for the top level.'
						);
					}
					const parentId = args.parentId === null ? null : str(args, "parentId");
					if (parentId === undefined) {
						return errorResult('"parentId" must be a collection id or null.');
					}
					const rows = readCollectionRows(await ctx.client.listCollections(signal));
					const subtree = collectionSubtree(rows, id);
					if (subtree === null) return errorResult(`No collection with id "${id}".`);
					// The UI's own refusal set, walked here so the answer names the
					// problem. The engine rejects the same batch under its lock -
					// that check is the one that is race-free and stays the
					// authority; this one exists so an agent is told "into its own
					// subtree" rather than handed a 400 about a move entry.
					if (parentId !== null && subtree.includes(parentId)) {
						return errorResult(
							parentId === id
								? `A collection cannot be moved into itself ("${id}").`
								: `"${id}" cannot be moved into "${parentId}" - that collection is inside it.`
						);
					}
					if (parentId !== null && !rows.some((row) => row.id === parentId)) {
						return errorResult(`No collection with id "${parentId}".`);
					}
					batch = moveBatch({
						type,
						movedId: id,
						position,
						owner: { parentId },
						siblings: rows.filter(
							(row) => collectionParent(row) === parentId && row.id !== id
						),
					});
				} else {
					const collectionId = str(args, "collectionId");
					if (collectionId === undefined) {
						return errorResult(
							'Moving a request needs "collectionId" - the collection it should end up in.'
						);
					}
					const siblings = readOrderedSiblings(
						await ctx.client.listRequests(collectionId, signal)
					).filter((row) => row.id !== id);
					batch = moveBatch({
						type,
						movedId: id,
						position,
						owner: { collectionId },
						siblings,
					});
				}
			} catch (err) {
				return engineErrorResult(err);
			}
			return callEngine(() => ctx.client.reorder(batch, signal));
		},
	},
	{
		name: "create_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Create an environment - a named set of {{variables}} a request resolves against. Populate it in the same call, with plain values or with the secret/type/enabled flags. The environment is created inactive: activate_environment is what makes it the one requests resolve against. Vayu assigns the id and returns it. GUARDED: requires write access to be enabled in Vayu Settings. " +
			precedenceNote(
				"An environment's variables are the top scope tier: once this one is active they shadow every collection and global of the same name."
			),
		annotations: {
			title: "Create environment",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			name: z.string().describe("Display name for the environment."),
			description: z.string().optional().describe("Optional description."),
			variables: variablesInput("the new environment"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const name = requireStr(args, "name");
			const patch = isRecord(args.variables) ? args.variables : undefined;
			if (args.variables !== undefined && patch === undefined) {
				return errorResult('"variables" must be an object mapping names to values.');
			}
			// Merged against nothing, which is what turns the string form into a
			// stored entry and enforces "a new variable carries a value" - on a
			// create every variable is new.
			const merged = mergeVariables({}, patch, []);
			// No `id`: the engine assigns every id it stores and answers a body
			// carrying one with a 400 (issue #97), so the tool does not offer a
			// field it would only have to refuse.
			const payload: Record<string, unknown> = { name, variables: merged.variables };
			const description = str(args, "description");
			if (description !== undefined) payload.description = description;
			return callEngine(() => ctx.client.createEnvironment(payload, signal));
		},
	},
	{
		name: "update_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Set, re-flag or remove an environment's variables, and rename it. Merges: variables you do not name are left alone, and a named one keeps every flag you do not state - so rotating a secret leaves it masked and writing to a disabled variable leaves it disabled. Pass a variable as a string to set its value, or as an object to set any of value/secret/type/enabled. removeVariables deletes names outright, which blanking a value cannot do. GUARDED: requires write access to be enabled in Vayu Settings. " +
			precedenceNote(
				"An environment's variables are the top scope tier: while this environment is active they shadow every collection and global of the same name. Writing here to an inactive environment changes nothing a request resolves until activate_environment makes it current."
			),
		annotations: {
			title: "Update environment",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z.string().describe("Environment ID to update."),
			variables: variablesInput("this environment"),
			removeVariables: removeVariablesInput("this environment"),
			name: z.string().optional().describe("Optional new name for the environment."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const environmentId = requireStr(args, "environmentId");
			const patch = isRecord(args.variables) ? args.variables : undefined;
			if (args.variables !== undefined && patch === undefined) {
				return errorResult('"variables" must be an object mapping names to values.');
			}
			const removals = removalNames(args);
			const rename = str(args, "name");
			if (patch === undefined && removals.length === 0 && rename === undefined) {
				return errorResult(
					'Pass at least one change: "variables", "removeVariables" or "name".'
				);
			}
			// Fetch the current env so we merge (the PUT replaces the whole blob)
			// and keep the existing name (which the engine requires).
			let existing: Record<string, unknown>;
			try {
				existing = ((await ctx.client.getEnvironment(environmentId, signal)) ??
					{}) as Record<string, unknown>;
			} catch (err) {
				return engineErrorResult(err);
			}
			const merged = mergeVariables(existing.variables, patch, removals);
			// PUT carries the id in the path, so the body is the patch only. The
			// name is still sent because the engine treats it as having no
			// default - omitting it would keep the stored name, but sending the
			// caller's rename in the same call is the point of the `name` arg.
			const payload: Record<string, unknown> = {
				name: rename ?? (typeof existing.name === "string" ? existing.name : ""),
				variables: merged.variables,
			};
			const result = await callEngine(() =>
				ctx.client.updateEnvironment(environmentId, payload, signal)
			);
			return result.isError
				? result
				: withCaveat(result, absentRemovalCaveat(merged.absentRemovals));
		},
	},
	{
		name: "activate_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			'Make an environment the active one - the set {{variables}} resolve against when a call names no environmentId of its own, and what the app\'s own switcher shows. Exactly one environment is active at a time: activating one deactivates the previous in the same write. Pass "none" to leave no environment active, the switcher\'s "No Environment" option. Tools that take an explicit environmentId (run_request, start_load_run, run_collection) are unaffected by this - it is the default, not an override. GUARDED: requires write access to be enabled in Vayu Settings. ' +
			precedenceNote(
				"This is the one call that changes which tier answers without changing any value: the newly active environment shadows every collection and global of the same name, so a name can start resolving differently with nothing else edited."
			),
		annotations: {
			title: "Activate environment",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z
				.string()
				.describe('Environment ID to activate, or "none" to leave none active.'),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const environmentId = requireStr(args, "environmentId");
			if (environmentId !== "none") {
				// `isActive: true` is the whole switch: the DB layer clears the
				// previously active row in the same transaction
				// (`deactivate_other_environments_locked`), so a companion write
				// would be a second definition of the same rule. No `name` - absent
				// on a PUT means keep.
				return callEngine(() =>
					ctx.client.updateEnvironment(environmentId, { isActive: true }, signal)
				);
			}
			// There is no "no environment" row to write true to, so clearing is
			// spelled as deactivating whichever row holds the flag - the same shape
			// `useSetActiveEnvironmentMutation` sends. Which row that is has to be
			// read: the engine has no "deactivate all" verb.
			let active: Record<string, unknown> | undefined;
			try {
				const listed = await ctx.client.listEnvironments(signal);
				const rows = Array.isArray(listed) ? listed : [];
				active = rows.find((row) => isRecord(row) && row.isActive === true) as
					Record<string, unknown> | undefined;
			} catch (err) {
				return engineErrorResult(err);
			}
			const activeId = active && typeof active.id === "string" ? active.id : undefined;
			if (activeId === undefined) {
				// Successful and deliberately without effect, so it emits no
				// data-changed event - there is nothing for the renderer to refetch.
				return unchanged(
					textResult("No environment was active, so there was nothing to deactivate.")
				);
			}
			return callEngine(() =>
				ctx.client.updateEnvironment(activeId, { isActive: false }, signal)
			);
		},
	},
	{
		name: "delete_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Delete an environment and every variable in it. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the environment's name and how many variables go with it; otherwise call once for a preview, then again with `confirmed: true`. There is no undo, and a saved request that referenced those variables keeps its {{placeholders}} with nothing to resolve them.",
		annotations: {
			title: "Delete environment",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z.string().describe("Environment ID to delete."),
			confirmed: confirmedInput("actually delete the environment and its variables"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const environmentId = requireStr(args, "environmentId");
			// Read it first so the prompt names the environment and its variable
			// count rather than an id - the read-before-prompt every delete here
			// does. `getEnvironment` resolves from the list (the engine has no
			// `GET /environments/:id`) and answers null for an id nothing matches.
			let environment: Record<string, unknown>;
			try {
				const found = await ctx.client.getEnvironment(environmentId, signal);
				if (!isRecord(found))
					return errorResult(`No environment with id "${environmentId}".`);
				environment = found;
			} catch (err) {
				return engineErrorResult(err);
			}
			const subject = describeEnvironment(environmentId, environment);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete ${subject}?\n\nEvery variable in it goes with it. This cannot be undone.`,
				acceptTitle: "Delete the environment",
				acceptDescription: "Confirm to delete this environment and its variables.",
				declined: "Environment not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete ${subject}, along with every variable in it. This cannot be undone.\n\n` +
					"This is a preview. To delete it, call delete_environment again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteEnvironment(environmentId, signal));
		},
	},
	{
		name: "get_globals",
		category: "read",
		invalidates: [],
		description:
			"Read the global variables - used by every request whatever environment is active. An engine that has never had any answers an empty set rather than an error. " +
			precedenceNote(
				"Globals are the bottom tier, so a value read back here is not necessarily the one a request resolves: use resolve_variables to see which definition actually wins."
			),
		annotations: {
			title: "Get global variables",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.getGlobals(signal)),
	},
	{
		name: "resolve_variables",
		category: "read",
		invalidates: [],
		description:
			'Answer which definition of a variable name actually wins in a given context, and list the ones it beat - the question get_globals and list_environments cannot, because each shows one tier in isolation. For every name it reports the winning value with the scope and source that supplied it, then every shadowed definition highest-precedence-first, each saying whether it was outranked by a higher tier or simply switched off (`enabled: false`). A switched-off row is the more common answer to "why is this not the value I set?", and a name whose every definition is disabled resolves to nothing at all rather than to an empty string. ' +
			precedenceNote(
				"Pass no environmentId to use the active environment, the same default a send takes; pass a collectionId to include its chain."
			) +
			" Secret values are withheld here (`valueWithheld: true`) to match the app's popover - note that list_environments, get_globals and vayu://environments still return every value in full, so this is not a security boundary. Reports what is stored: it resolves nothing on the wire and starts no run.",
		annotations: {
			title: "Resolve variables",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.optional()
				.describe(
					"Optional collection ID. Includes that collection's chain, merged root-first, between globals and the environment."
				),
			environmentId: z
				.string()
				.optional()
				.describe(
					'Optional environment ID. Omit for the active environment (the default a send takes); pass "none" to resolve as if no environment were active.'
				),
			names: z
				.array(z.string())
				.optional()
				.describe(
					"Optional variable names to report. Omit for every name defined anywhere in the context. A name nothing defines is reported as unresolved rather than omitted."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = str(args, "collectionId");
			const environmentId = str(args, "environmentId");
			const names = stringArray(args, "names");

			let scopes: OriginScopes;
			let context: Record<string, unknown>;
			try {
				scopes = await gatherVariableScopes(ctx, collectionId, environmentId, signal);
				context = describeScopes(scopes, collectionId, environmentId);
			} catch (err) {
				// A bad id is the caller's mistake and must not be reported as an
				// engine failure - the same split `pagedRead`'s callers keep.
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}

			const variables = resolveVariableReports(scopes, names);
			return structuredResult({
				context,
				variables,
				summary: {
					reported: variables.length,
					resolved: variables.filter((v) => v.resolved).length,
					shadowed: variables.filter((v) => v.shadowedBy.length > 0).length,
				},
			});
		},
	},
	{
		name: "update_globals",
		category: "write",
		invalidates: ["environment"],
		description:
			"Set, re-flag or remove global variables - the ones every request can resolve, whatever environment is active. Merges exactly as update_environment does: globals you do not name are left alone, and a named one keeps every flag you do not state. GUARDED: requires write access to be enabled in Vayu Settings. " +
			precedenceNote(
				"Globals are the bottom tier: any collection or active-environment definition of the same name shadows what you write here, so a request whose value does not change after this call is usually shadowed rather than unwritten - resolve_variables names the definition that won."
			),
		annotations: {
			title: "Update global variables",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			variables: variablesInput("the globals"),
			removeVariables: removeVariablesInput("the globals"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const patch = isRecord(args.variables) ? args.variables : undefined;
			if (args.variables !== undefined && patch === undefined) {
				return errorResult('"variables" must be an object mapping names to values.');
			}
			const removals = removalNames(args);
			if (patch === undefined && removals.length === 0) {
				return errorResult('Pass at least one change: "variables" or "removeVariables".');
			}
			// `POST /globals` saves the singleton whole - it is the one resource
			// with no create/update split, so an absent `variables` there means
			// `{}`, not "keep". The read is what makes this a merge rather than a
			// replace.
			let stored: unknown;
			try {
				stored = await ctx.client.getGlobals(signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			const merged = mergeVariables(
				isRecord(stored) ? stored.variables : undefined,
				patch,
				removals
			);
			const result = await callEngine(() =>
				ctx.client.saveGlobals({ variables: merged.variables }, signal)
			);
			return result.isError
				? result
				: withCaveat(result, absentRemovalCaveat(merged.absentRemovals));
		},
	},
	{
		name: "get_cookies",
		category: "read",
		invalidates: [],
		description:
			"Read the design-mode cookie jars - one entry per environment that holds anything, plus the jar used when no environment is selected, each cookie with its name, value, domain, path, secure/httpOnly flags and expiry. This is how 'why is this request already authenticated' gets answered: run_request and run_collection_smoke send through these jars and store what comes back, and the same jars serve the user's own sends in that environment.",
		annotations: {
			title: "Get cookie jars",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.getCookies(signal)),
	},
	{
		name: "clear_cookies",
		category: "write",
		invalidates: ["cookie"],
		description:
			"Drop stored cookies, so the next request starts a fresh session - the tool equivalent of Settings -> General -> Cookies. Omit environmentId to clear every jar, pass an id to clear that environment's, or pass null to clear the jar used when no environment is selected. Returns how many cookies were dropped. No confirmation: nothing saved is lost, only session state a re-login restores. GUARDED: requires write access to be enabled in Vayu Settings.",
		annotations: {
			title: "Clear cookie jars",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z
				.string()
				.nullable()
				.optional()
				.describe(
					'Scope to clear: an environment ID for that environment\'s jar, null for the no-environment jar, or omitted for every jar. Omitting and passing null are different calls - "all" and "the unnamed one".'
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			// Null, not falsy: `null` is a scope of its own here (the jar no
			// environment id can name), so it has to stay distinguishable from an
			// absent argument all the way to the query string.
			const stated = args.environmentId;
			if (stated !== undefined && stated !== null && typeof stated !== "string") {
				return errorResult(
					'"environmentId" must be an environment ID, null for the no-environment jar, or omitted for every jar.'
				);
			}
			const scope: string | null | undefined =
				stated === null ? null : str(args, "environmentId");
			return callEngine(() => ctx.client.clearCookies(scope, signal));
		},
	},
	{
		name: "run_collection_smoke",
		category: "execute",
		invalidates: ["run", "cookie"],
		description:
			"Execute a collection's own saved requests once each and return a pass/fail matrix (a request passes on a 2xx/3xx status with all its tests passing and, when the collection is bound to an OpenAPI document, a response matching the schema that document declares - a response the document declares no schema for is reported as unchecked and never fails the request; pass failOnSchemaError: false to keep that verdict on every row without letting it decide pass/fail). A row whose request ran assertions carries `tests` - `total`, `failed`, and the failing `name: message` lines (at most 10; `failed` is the true count) - so a request that failed on its tests says which, not just ok:false. Scope is the collection's DIRECT requests: nested sub-collections are not run, and the result discloses how many were left out - call this tool on each of them to cover them. Requests run one at a time, so a large collection takes as long as its requests do added together. Each request is composed exactly as the app would send it: {{variables}} resolved in the order " +
			VARIABLE_RESOLUTION_URI +
			" states, the request's stored auth applied (inheriting from the collection chain, incl. OAuth2), and its collection-chain + own pre/post scripts run. Each request's resolved host must be on the allowlist; requests whose host still cannot be verified (e.g. a variable did not resolve and allow-all is off) are skipped. Sends real traffic but does not modify Vayu data. " +
			ENGINE_DEFAULT_HEADERS_SENTENCE,
		annotations: {
			title: "Run collection smoke test",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection whose requests to run."),
			environmentId: z
				.string()
				.optional()
				.describe("Environment for variable resolution during execution."),
			failOnSchemaError: failOnSchemaErrorInput({
				unit: "request",
				defaultsOn: true,
				guidance:
					"Set false to report the schema verdict on each row without letting it decide pass/fail - useful against a document known to lag its API.",
			}),
		},
		outputSchema: smokeResultSchema,
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const environmentId = str(args, "environmentId");
			// Absent means the gate stays on - this tool's behaviour since #681.
			// Read once, before any traffic: it decides how every row is judged,
			// and a per-row read of one argument could only ever be wrong twice.
			const failOnSchemaError = args.failOnSchemaError !== false;
			let requests: unknown;
			try {
				requests = await ctx.client.listRequests(collectionId, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			const list = Array.isArray(requests) ? requests : [];
			// Read before any traffic flows: after the loop this call competes with
			// a cancellation the run itself may have raised, and the disclosure has
			// to survive that.
			const children = await childCollectionNames(ctx.client, collectionId, signal);
			const results: Array<Record<string, unknown>> = [];
			let passed = 0;
			let failed = 0;
			let skipped = 0;

			for (const item of list) {
				const req = (item ?? {}) as {
					id?: string;
					name?: string;
					method?: string;
					url?: string;
				};
				const name = String(req.name ?? req.id ?? "request");
				// Compose the request the same way the app's Send does - engine-side
				// (`POST /compose`): variables resolved, stored/inherited auth
				// applied, and the chain's + its own scripts attached.
				let outgoing: Record<string, unknown>;
				try {
					outgoing = await composeViaEngine(
						ctx.client,
						{ requestId: String(req.id ?? ""), environmentId },
						signal
					);
				} catch (err) {
					results.push({
						name,
						method: String(req.method ?? "GET"),
						url: String(req.url ?? ""),
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
					failed++;
					continue;
				}
				const method = String(outgoing.method ?? "GET");
				const url = String(outgoing.url ?? "");

				const gate = checkAllowlist(url, ctx.config);
				if (!gate.ok) {
					results.push({
						name,
						method,
						url,
						ok: false,
						skipped: true,
						reason: gate.error,
					});
					skipped++;
					continue;
				}
				try {
					const resp = ((await ctx.client.executeRequest(outgoing, signal)) ??
						{}) as Record<string, unknown>;
					const code =
						typeof resp.status === "number"
							? resp.status
							: typeof resp.statusCode === "number"
								? resp.statusCode
								: 0;
					// One reading of the assertions decides `ok` *and* rides the
					// row (issue #733): a row that fails on tests has to be able
					// to say which, and a second walk here could disagree with
					// the list the agent is shown.
					const tests = readTestVerdict(resp);
					const testsOk = !tests || tests.failed === 0;
					// The contract's own verdict, folded in the way `testResults`
					// folds (issue #681): a response the document declares a
					// schema for and that does not match it is a failed request.
					// Only a *checked* verdict can fail one - `checked: false`
					// says the response could not be judged, which is not the
					// same as judged and wrong, and failing a smoke run on it
					// would make an undocumented status look like a broken API.
					//
					// `failOnSchemaError: false` unfolds it (issue #720): the
					// verdict still rides the row, it just stops deciding `ok`.
					const schema = readSchemaVerdict(resp);
					const schemaOk =
						!failOnSchemaError || !(schema?.checked === true && schema.valid === false);
					const ok = code >= 200 && code < 400 && testsOk && schemaOk;
					results.push({
						name,
						method,
						url,
						ok,
						statusCode: code,
						...(schema ? { schema } : {}),
						...(tests ? { tests } : {}),
					});
					if (ok) passed++;
					else failed++;
				} catch (err) {
					results.push({
						name,
						method,
						url,
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
					failed++;
				}
			}

			return withCaveat(
				structuredResult({
					collectionId,
					total: list.length,
					passed,
					failed,
					skipped,
					results,
				}),
				smokeScopeCaveat(children)
			);
		},
	},
	{
		name: "run_collection",
		category: "execute",
		invalidates: ["run", "cookie"],
		description:
			"Run a collection as the product means collections to be run: its saved requests executed as an ordered sequence, one step at a time, by the engine's design-mode runner. Unlike run_collection_smoke this is ONE run with a run id - steps share a cookie jar, `pm.execution` flow control (setNextRequest, skipRequest) works, pre-request scripts run, and passing `data` repeats the sequence once per row with {{data.column}} bound and pm.iterationData set. Pass recursive: true to include sub-collections, in the sidebar's order. The collection tree IS the sequence: there is no step list to give. Every step's resolved host must be on the allowlist - unlike the smoke matrix, which skips an off-allowlist request and runs the rest, a scenario is one run, so a single step the allowlist does not cover refuses the whole run and nothing is sent. Returns the run id immediately; the run continues engine-side and get_run_report reads its outcome. For a collection bound to an OpenAPI document, pass failOnSchemaError: true to make that contract a gate, as the app's Run Collection checkbox does - off by default, the verdict is reported without deciding pass/fail. Sends real traffic but does not modify Vayu data. For a load test over the same sequence, use start_load_run's `scenario` argument.",
		annotations: {
			title: "Run collection",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection whose requests make up the sequence."),
			environmentId: z
				.string()
				.optional()
				.describe(
					"Environment whose variables resolve {{templates}} in every step, and whose cookie jar the run uses."
				),
			recursive: scenarioRecursiveInput,
			// Positive: the engine reads the count as a pass total, so a zero is a
			// run with nothing to do and a negative is not a count at all. Named
			// rather than clamped, like every other count in this registry.
			iterations: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"How many passes over the sequence (default 1, or the row count when `data` is given). With more passes than rows the row index wraps."
				),
			data: scenarioDataInput,
			// The Run Collection dialog's checkbox, which had no MCP writer at all
			// (issue #766). Design-mode only, because only this runner demotes a
			// step on a schema failure - see the refusal on `start_load_run`.
			failOnSchemaError: failOnSchemaErrorInput({
				unit: "step",
				defaultsOn: false,
				guidance:
					"Set true to make the bound contract a gate, the way the app's Run Collection checkbox does: a step whose response does not match its schema fails, and the run's report records that it was judged that way. Only a step that passed everything else is demoted - one already failing keeps the error that named it. Left off, the verdict still rides every step and the report's schemaValidation totals; it just does not decide pass/fail.",
			}),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const environmentId = str(args, "environmentId");
			const recursive = args.recursive === true;
			const iterations = typeof args.iterations === "number" ? args.iterations : undefined;
			const data = Array.isArray(args.data) ? (args.data as unknown[]) : undefined;

			let plannedSteps: number;
			try {
				plannedSteps = await preflightScenarioSteps(
					{ collectionId, recursive, environmentId },
					ctx,
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}

			const payload: Record<string, unknown> = {
				scenario: scenarioBlock({ collectionId, data }, recursive, iterations),
				...(environmentId !== undefined ? { environmentId } : {}),
				// Top-level, beside `scenario` rather than inside it: that is where
				// `read_fail_on_schema_error` looks, and where the app's dialog puts
				// it. Omitted when off - the engine's default - so a run snapshot
				// carries the key exactly when it changed what "failed" meant, which
				// is what keeps a payload written before the flag existed reading the
				// way it always did.
				...(args.failOnSchemaError === true ? { failOnSchemaError: true } : {}),
			};

			let started: unknown;
			try {
				started = await ctx.client.startRun(payload, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			// The engine's 202 body is the answer; anything else is handed back as
			// it came rather than dressed up as a started run.
			if (!started || typeof started !== "object" || Array.isArray(started)) {
				return jsonResult(started);
			}
			return structuredResult({
				...(started as Record<string, unknown>),
				plannedSteps,
				nextStep:
					`The run executes engine-side. Read it with get_run_report(runId): the ` +
					`\`scenario\` section carries the iteration and pass/fail/skip totals plus ` +
					`\`stepsStored\`/\`stepsDropped\`, and \`results\` returns at most 100 step rows ` +
					`(non-passing steps are kept first). Each row's \`trace\` carries that step's ` +
					`request and response bodies inline, so a long plan against large responses ` +
					`makes for a large report - read the totals first and the rows when you need ` +
					`them. stop_run ends the run early.`,
			});
		},
	},
	{
		name: "start_load_run",
		category: "load",
		invalidates: ["run"],
		description:
			"Start a load test against a URL, or against a saved request via `requestId` - which composes it exactly as the app does, including the collection chain's and its own test scripts, so a load run checks the same assertions a Send does. GUARDED: the host must be on the allowlist, and RPS/concurrency/duration must be within Vayu's caps. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given; pass an `auth` block to authenticate the load (bearer/basic/apikey/oauth2, applied engine-side). Pass a `postRequestScript` - the same assertions you would give run_request - to validate responses under load; it runs against sampled responses. A pre-request script is not offered here for a single target: the engine runs one on a single request only, never on a load run. Pass `scenario` INSTEAD of url/requestId to load-test a collection's ordered sequence: `concurrency` then means virtual users, each walking the plan with its own cookies and running every step's stored scripts, and only constant_concurrency, ramp_up and iterations can drive it. `{{$vu}}` and `{{$iteration}}` in the URL, headers or body are bound fresh by the engine immediately before each send, never at compose time: for a scenario run `{{$vu}}` is the sending virtual user's own 1-based number and `{{$iteration}}` its 0-based pass through the plan; for a single-target run (no `scenario`) `{{$vu}}` is always 1 - one URL repeated under load is one user's iterations, however many are in flight - and `{{$iteration}}` is the 0-based submission index. What the run *keeps* is yours to set too - `successSamplePeriod`, `slowRequestThresholdMs` and `saveTimingBreakdown` decide which responses are traced, and `comment` stamps the run with why it exists; all four apply to a scenario run as well. There is no per-request timeout on a run: the engine's `defaultTimeout` setting governs every transfer (change it with update_engine_config), so a slow target is a config change and not an argument here. Confirmation is required: if the client supports elicitation the user is prompted directly; otherwise call once for a preview, then again with `confirmed: true`. " +
			ENGINE_DEFAULT_HEADERS_SENTENCE +
			" A load run reads `loadNegotiateCompression` rather than `negotiateCompression` for the Accept-Encoding decision, because decompressing every response changes what the run measures.",
		annotations: {
			title: "Start load test",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional(),
			url: z
				.string()
				.optional()
				.describe(
					"Target URL (may contain {{variables}}). Required unless `requestId` names a saved request to load-test; supplying both retargets that request at this URL."
				),
			headers: z.record(z.string(), z.string()).optional(),
			body: z.string().optional().describe("Request body content."),
			// The two sibling tools have carried this text since they existed and
			// this one carried nothing, so an agent load-testing a GraphQL endpoint
			// had no way to discover the mode from the schema. The GET transport
			// rule is part of that: a load run goes out through the event loop's
			// `wire_url` / `has_wire_body` pair like any other send (#1228), so a
			// GraphQL run left on the default GET carries no body at all.
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A graphql `body` may be the bare query document, and the method decides how it travels: the `{"query": ...}` JSON envelope on POST, `query`/`operationName`/`variables` query parameters with no body on GET - so give a mutation `method` POST rather than leaving the run on the GET an unnamed method defaults to. A jsonrpc `body` may be the bare call object - the engine adds `"jsonrpc":"2.0"` and `"id":1` when it names no id, and sends a frame that already declares a string `"jsonrpc"` unchanged. File parts are not supported here - a multipart file part names a path on the user\'s machine, which an agent cannot choose for them; author it in the app. An xml `body` is stored and sent verbatim as application/xml.'
				),
			auth: authInput,
			httpVersion: z
				.enum(HTTP_VERSIONS)
				.optional()
				.describe(
					'Protocol to negotiate for this ad-hoc run: "auto" | "http1.1" | "http2" (default "auto"). There is no saved request behind this call, so this is how the protocol gets specified at all - not an override of a per-run setting.'
				),
			mode: z
				.string()
				.optional()
				.describe("constant_rps | constant_concurrency | ramp_up | iterations | capacity."),
			// Positive, because an agent's natural guess for "unlimited" is -1 or
			// 0, and the engine reads concurrency as an eager per-worker
			// pre-allocation count. It rejects those with a 400; failing here
			// names the field instead of surfacing an HTTP error.
			concurrency: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Target in-flight requests."),
			// Positive for the same reason `concurrency` is: the ramp is seeded
			// with this count, so a negative casts to ~1.8e19 engine-side and a
			// zero start is a ramp that begins with no traffic at all.
			startConcurrency: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Ramp start concurrency (ramp_up). Above `concurrency` ramps down."),
			duration: z
				.string()
				.optional()
				.describe(
					'Duration with an optional ms/s/m/h unit, e.g. "500ms", "30s", "5m", "2h"; a bare number is seconds (non-iterations modes).'
				),
			rampUpDuration: z
				.string()
				.optional()
				.describe("Ramp time (ramp_up), same units as `duration`."),
			// Capacity discovery reuses `startConcurrency` (where the search
			// begins), `concurrency` (the ceiling it will not climb past) and
			// `duration` (the whole search's deadline), so it adds only these
			// two. The `sloMs` bound is the engine's, so a value this schema
			// accepts is one POST /runs accepts.
			sloMs: z
				.number()
				.positive()
				.max(60_000)
				.optional()
				.describe("p99 budget the capacity search looks for the edge of, in ms."),
			stepDuration: z
				.string()
				.optional()
				.describe(
					"How long each concurrency level is held before it is judged (capacity), same units as `duration`."
				),
			// An iterations run stops on this count and reads no duration, so it
			// is the only thing bounding the run; `-1` would cast to ~1.8e19.
			iterations: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Iteration count (iterations mode)."),
			targetRps: z.number().optional().describe("Target RPS (constant_rps)."),
			// Streaming under load (issue #576). Forwarded verbatim and bounded
			// only by the engine's own `constants::sse` ranges, on the
			// thresholds precedent: the engine validates before the run row
			// exists, so a value this schema accepts is one `POST /runs`
			// accepts, and re-deriving the rule here would be a second copy to
			// keep in step. The caps are refused there without `stream`, which
			// is what keeps an unbounded run from being mistaken for a capped
			// one - so this schema does not quietly drop them either.
			stream: z
				.boolean()
				.optional()
				.describe(
					"Consume each response as a text/event-stream. Under load a stream is bounded by construction: reaching a cap below completes it successfully rather than failing it."
				),
			maxStreamDurationMs: z
				.number()
				.int()
				.min(1000)
				.max(86_400_000)
				.optional()
				.describe(
					"Wall-clock cap on one stream, in ms (requires `stream`). Defaults to the engine's sseMaxStreamDurationMs."
				),
			maxStreamEvents: z
				.number()
				.int()
				.min(1)
				.max(10_000_000)
				.optional()
				.describe(
					"Event cap on one stream (requires `stream`). Defaults to the engine's sseMaxStreamEvents."
				),
			// A pending-request ceiling read as a `size_t`, so `-1` - the natural
			// "unlimited" spelling - removes the ceiling instead of tightening it.
			// The upper bound is the engine's, so a value this schema accepts is
			// one `POST /runs` accepts.
			maxInFlight: z
				.number()
				.int()
				.positive()
				.max(MAX_IN_FLIGHT_BOUND)
				.optional()
				.describe(
					`In-flight cap (constant_rps only), 1-${MAX_IN_FLIGHT_BOUND}. Default max(targetRps * 10, 1000).`
				),
			// Pass/fail budgets for the whole run. The bounds mirror the
			// engine's, so a value this schema accepts is one POST /runs
			// accepts; an empty object is rejected there rather than starting a
			// run nothing will judge, so it is rejected here too, by name.
			thresholds: z
				.object({
					latencyP50Ms: z.number().positive().max(86_400_000).optional(),
					latencyP95Ms: z.number().positive().max(86_400_000).optional(),
					latencyP99Ms: z.number().positive().max(86_400_000).optional(),
					maxErrorRatePct: z.number().min(0).max(100).optional(),
					minThroughputRps: z.number().positive().max(1_000_000_000).optional(),
				})
				.refine((t) => Object.keys(t).length > 0, {
					// `error`, not zod 3's `message`: v4 still reads the old key as a
					// deprecated alias, and a deprecated alias is what the next major
					// takes away.
					error: "Declare at least one budget, or omit `thresholds` entirely.",
				})
				.optional()
				.describe(
					"Pass/fail budgets for this run. The report comes back with `thresholdValidation`: one check per budget plus a verdict of passed/failed. Omit for a run that is measured but not judged."
				),
			// Shaped exactly as the engine's `monitor` block and forwarded
			// verbatim. The value bounds are deliberately not mirrored here the
			// way `thresholds`' are: `monitor.series`' ceiling is the
			// `monitorMaxSeries` **setting**, so a second copy in this schema
			// would refuse blocks the engine accepts as soon as the user raises
			// it - and `validate_run_config` already answers each one by field
			// name. This layer types the shape; the engine owns the ranges.
			monitor: z
				.object({
					url: z
						.string()
						.describe(
							"http(s) URL of a Prometheus /metrics or flat-JSON endpoint on the target. A loopback or private-network URL needs no allowlist entry; a public one is checked against the allowlist like the target URL is."
						),
					intervalMs: z
						.number()
						.optional()
						.describe(
							"Scrape cadence in ms, 250-60000 (default: the engine's setting)."
						),
					format: z
						.enum(["prometheus", "json"])
						.optional()
						.describe(
							'Body format: "prometheus" text exposition, or "json" (a flat object of numbers). Default "prometheus".'
						),
					series: z
						.array(z.string())
						.describe(
							'Metric names to read out of each scrape, e.g. ["process_cpu_seconds_total"]. At least one; the ceiling is the `monitorMaxSeries` setting (8 by default).'
						),
				})
				.optional()
				.describe(
					"Scrape the target's own metrics endpoint for the life of the run, so its CPU or memory can be read on the same timeline as p99 and throughput. The report comes back with a `monitor` section: per-series min/max/avg plus the sample and failed-scrape counts. Omit for a run that measures only the client side."
				),
			// The redirect policy of the request being load-tested. A saved
			// request carries its own (composed in, never elided), so these are
			// the override; an ad-hoc target has none, so they are the only way to
			// state one at all. Load-shape arguments they are not - which is why a
			// scenario run refuses them by name rather than ignoring them.
			followRedirects: z
				.boolean()
				.optional()
				.describe(
					"Whether a 3xx is followed (engine default: true). With `requestId`, overrides the policy stored on that request; on an ad-hoc target this is how the policy is stated at all. A load test that follows redirects measures the whole chain, so its latency is the chain's, not the first hop's."
				),
			maxRedirects: z
				.number()
				.int()
				.min(0)
				.max(MAX_REDIRECTS_BOUND)
				.optional()
				.describe(
					`How many redirects may be followed, 0-${MAX_REDIRECTS_BOUND} (engine default: 10; 0 means a 3xx is returned as the response). Requires \`followRedirects\` to be on to have any effect.`
				),
			// The recording knobs the app's load dialog sets. None of them changes
			// what the run *sends* - they decide what it keeps - so none takes a
			// gate of its own beyond the ones the run already passed.
			comment: z
				.string()
				.optional()
				.describe(
					"A note stamped on the run, shown beside it in History and in the report's `metadata.configuration`. Use it to say what the run was for - the reason a report is worth keeping is rarely recoverable from its numbers."
				),
			successSamplePeriod: z
				.number()
				.int()
				.min(1)
				.max(MAX_SUCCESS_SAMPLE_PERIOD)
				.optional()
				.describe(
					`Keep 1 in N successful responses (the engine's \`success_sample_rate\`, which is a period and not a percentage): 1 keeps every one, 100 keeps 1%. Default 100. Only sampled responses carry a timing breakdown, and only if \`saveTimingBreakdown\` is on. Range 1-${MAX_SUCCESS_SAMPLE_PERIOD}; 0 is a division by zero engine-side and is refused here.`
				),
			slowRequestThresholdMs: z
				.number()
				.int()
				.min(0)
				.max(MAX_SLOW_THRESHOLD_MS)
				.optional()
				.describe(
					'Capture any completion at or above this many milliseconds as an outlier, whatever the sampling period keeps. 0 disables outlier capture. This is the knob that answers "what did the slow 1% look like" - the sampled subset is uniform and will not contain them.'
				),
			saveTimingBreakdown: z
				.boolean()
				.optional()
				.describe(
					"Store the per-phase timing (DNS, connect, TLS, TTFB) of each sampled success, which is what fills the report's timing-breakdown section. Off by default - a breakdown is stored per retained record, so it is the knob that decides whether the run keeps traces at all."
				),
			requestId: z
				.string()
				.optional()
				.describe(
					"Load-test a saved request. It is composed the way the app composes it: {{variables}} resolved, its stored auth applied (inheriting through the collection chain), and its collection-chain + own test scripts run against sampled responses. Any field you also pass explicitly (url, method, headers, body, auth, tests) overrides the saved one. Omit this and `url` is required, for an ad-hoc run."
				),
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
			postRequestScript: validationScriptInput,
			tests: validationScriptAliasInput,
			disabledDefaultHeaders: defaultHeaderOptOutsInput,
			// The single-target data set (issue #993). Bounded by the engine's
			// own `maxScenarioDataRows` / `maxScenarioDataBytes`, whose 400 is
			// surfaced verbatim rather than re-derived here - the same posture
			// `scenarioDataInput` takes, and for the same reason: a copy of a
			// limit the user can raise in Settings would refuse payloads the
			// engine accepts.
			data: z
				.array(z.record(z.string(), z.unknown()))
				.optional()
				.describe(
					'Data rows for a single-target run, one flat object per row (e.g. [{"id":"1"},{"id":"2"}]). One row is bound per request sent, claimed off a run-wide cursor that wraps, so a run longer than the set repeats it. Every {{data.column}} in the URL, headers, body and auth credentials binds per submission, and the post-request script reads that submission\'s row as pm.iterationData. A present-but-empty array is refused by the engine, as is `data` beside a `scenario` block - a collection run states its rows as scenario.data instead. The set is not persisted (only its count is recorded on the run), but a bound value travels in the request that carried it and is stored with the run\'s retained traces.'
				),
			// The other shape POST /runs accepts (issue #754). Mutually exclusive
			// with every single-target argument, which the handler refuses by name
			// rather than ignoring - see SINGLE_TARGET_LOAD_FIELDS.
			//
			// No `iterations` inside the block, unlike the design-mode runner's:
			// a load run reads the *top-level* `iterations` (`scenario_load.cpp`
			// takes it from the run config), and `scenario.iterations` is the
			// design runner's per-run pass count, which this executor never looks
			// at. Offering it here would be an argument written and never read.
			scenario: z
				.object({
					collectionId: z
						.string()
						.describe("Collection whose saved requests are the sequence."),
					recursive: scenarioRecursiveInput,
					data: scenarioDataInput,
				})
				.optional()
				.describe(
					"Load-test a collection's ordered sequence instead of one target. Cannot be combined with url/requestId or any single-target field. `concurrency` is the number of virtual users, each walking the whole plan with its own cookies; `iterations` (top level) is the total passes across all of them in iterations mode. Modes: constant_concurrency (default), ramp_up, iterations - constant_rps and capacity are refused, with the engine's reasoning."
				),
			// Declared only so it can be refused by name - see
			// LOAD_RUN_SCHEMA_GATE_REFUSAL for why an undeclared key would be
			// dropped in silence instead.
			failOnSchemaError: z
				.boolean()
				.optional()
				.describe(
					"Not available on a load run, and refused rather than ignored: the load executor validates sampled responses once the run has drained and never demotes a step, so this gate would decide nothing. Use run_collection to run the same collection in design mode with the contract as a gate. The schema verdict is reported either way, in the report's schemaValidation block."
				),
			confirmed: confirmedInput("actually start the run"),
		},
		handler: async (args, ctx, signal) => {
			// Before the branch, because the reason is the executor rather than the
			// shape of the target: no load path reads the flag, so a single-target
			// run would swallow it exactly as a scenario one would.
			if (args.failOnSchemaError !== undefined) {
				return errorResult(LOAD_RUN_SCHEMA_GATE_REFUSAL);
			}

			// A scenario replaces the single target wholesale - there is nothing to
			// compose here, so the branch comes before composition rather than
			// inside it.
			const scenario = readScenarioArg(args);
			if (scenario) return startScenarioLoadRun(args, scenario, ctx, signal);

			let composed;
			try {
				composed = await composeLoadRunRequest(args, ctx, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const url = String(composed.payload.url ?? "");
			if (!url) {
				return errorResult(
					`Saved request "${str(args, "requestId")}" has no URL to load-test.`
				);
			}
			const gate = checkAllowlist(url, ctx.config);
			if (!gate.ok) return errorResult(gate.error!);

			// A monitored run contacts a second host, so it gets a second gate.
			// The scrape needs no duration cap of its own: the monitor thread is
			// joined when the run ends, so whatever bounds the run bounds it.
			const monitor = args.monitor as { url?: unknown } | undefined;
			if (monitor && typeof monitor === "object") {
				const monitorGate = checkMonitorHost(String(monitor.url ?? ""), ctx.config);
				if (!monitorGate.ok) return errorResult(monitorGate.error!);
			}

			// One mode string for both the guard and the payload: which strategy
			// the engine picks decides which cap applies, so a guard reading a
			// different mode than the run uses is a guard reading the wrong run.
			const mode = str(args, "mode") ?? DEFAULT_LOAD_MODE;
			const loadParams: LoadRunParams = {
				mode,
				targetRps: typeof args.targetRps === "number" ? args.targetRps : undefined,
				concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined,
				startConcurrency:
					typeof args.startConcurrency === "number" ? args.startConcurrency : undefined,
				iterations: typeof args.iterations === "number" ? args.iterations : undefined,
				duration: (args.duration as string | number | undefined) ?? undefined,
				rampUpDuration: (args.rampUpDuration as string | number | undefined) ?? undefined,
				stepDuration: (args.stepDuration as string | number | undefined) ?? undefined,
			};
			const caps = checkLoadCaps(loadParams, ctx.config);
			if (!caps.ok) return errorResult(caps.error!);

			const payload: Record<string, unknown> = {
				...composed.payload,
				mode,
			};
			for (const key of [
				"concurrency",
				"startConcurrency",
				"iterations",
				"targetRps",
				"maxInFlight",
				"sloMs",
				"maxStreamDurationMs",
				"maxStreamEvents",
			]) {
				if (typeof args[key] === "number") payload[key] = args[key];
			}
			// Forwarded only when present: the engine refuses a cap on a
			// non-streaming run, and refuses `stream` beside `transient`, so a
			// defaulted `false` here would turn "the caller said nothing" into
			// a claim the engine then has to judge (issue #576).
			if (typeof args.stream === "boolean") payload.stream = args.stream;
			for (const key of ["duration", "rampUpDuration", "stepDuration"]) {
				const v = str(args, key);
				if (v !== undefined) payload[key] = v;
			}
			// Forwarded verbatim, rows and all: the engine validates the set
			// before the run row exists and its refusal names the field, so a
			// second copy of those rules here could only drift (issue #993).
			if (Array.isArray(args.data)) payload.data = args.data;
			// Forwarded verbatim - the keys are the engine's own metric names,
			// and they come back unchanged in `get_run_report`'s
			// `thresholdValidation`. Zod has already bounded every value.
			if (args.thresholds && typeof args.thresholds === "object") {
				payload.thresholds = args.thresholds;
			}
			// Same posture as `thresholds`: the keys are the engine's own and
			// `validate_run_config` is what judges the values, so the block
			// travels unchanged rather than being rebuilt field by field here.
			if (monitor && typeof monitor === "object") {
				payload.monitor = monitor;
			}
			applyRecordingKnobs(args, payload);
			// A single target's own send-time refusals (issue #1337). A scenario
			// run never reaches here: it refuses the field by name, because its
			// steps are composed one by one and nothing reads a run-level
			// opt-out - see SINGLE_TARGET_LOAD_FIELDS.
			applyDefaultHeaderOptOuts(args, payload);
			// An omitted duration is 60s engine-side, not "unbounded" and not
			// "capped" - so a cap under 60s has to be sent as an explicit field
			// or it never reaches the run.
			const cappedDuration = defaultDurationUnderCap(loadParams, ctx.config);
			if (cappedDuration !== null) payload.duration = cappedDuration;

			// A saved request's pre-request script cannot run under load - the
			// engine has no such hook on POST /runs. Say so rather than let an agent
			// believe the request was prepared the way a Send prepares it.
			const caveat =
				composed.droppedPreRequestScripts > 0
					? `\n\nNote: ${composed.droppedPreRequestScripts} pre-request script(s) on this saved request were NOT applied - POST /runs has no pre-request hook, so anything they sign or rewrite is missing from the requests this run sends.`
					: "";

			const summary = `Start a load test against ${payload.url} (mode: ${payload.mode})?`;

			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `${summary}\n\nThis generates real traffic within Vayu's caps.`,
				acceptTitle: "Start the load test",
				acceptDescription: "Confirm to generate load now.",
				declined: "Load run not started - the user declined.",
				preview:
					"AWAITING CONFIRMATION - no run was started.\n\n" +
					"This is a preview. To start the load test, call start_load_run again with confirmed: true and the same arguments.\n\n" +
					`Planned run:\n${JSON.stringify(payload, null, 2)}${caveat}`,
			});
			if (unconfirmed) return unconfirmed;

			return withCaveat(await callEngine(() => ctx.client.startRun(payload, signal)), caveat);
		},
	},
	{
		name: "stop_run",
		category: "load",
		invalidates: ["run"],
		description: "Stop an in-progress load test.",
		annotations: {
			title: "Stop run",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { runId: z.string().describe("Run ID to stop.") },
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopRun(requireStr(args, "runId"), signal)),
	},
	{
		name: "set_run_baseline",
		category: "write",
		invalidates: ["run"],
		description:
			"Pin a run as the baseline for its saved request, or unpin it. The baseline is the known-good run later runs are compared against: once pinned, compare_runs can be called with only `targetRunId` and resolves this run as the base. It is also the one run history retention will not expire. One pin per request - pinning another run moves it. A run of an unsaved request has no request to be the baseline of, so pinning it changes what nothing reads. GUARDED: requires write access to be enabled in Vayu Settings.",
		annotations: {
			title: "Pin run as baseline",
			readOnlyHint: false,
			// It rewrites one flag on one row and is undone by calling it again
			// with the opposite value - the opposite of the deletes this hint
			// exists to warn about.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID to pin or unpin."),
			baseline: z.boolean().describe("true pins this run as the baseline, false unpins it."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const runId = requireStr(args, "runId");
			if (typeof args.baseline !== "boolean") {
				throw new ToolArgError('"baseline" is required and must be true or false.');
			}
			const baseline = args.baseline;
			return callEngine(() => ctx.client.setRunBaseline(runId, baseline, signal));
		},
	},
	{
		name: "delete_run",
		category: "write",
		invalidates: ["run"],
		description:
			"Delete a run and everything recorded against it - its report, metrics, captured samples and step traces. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with what the run was, otherwise call once for a preview and again with `confirmed: true`. There is no undo. A run still executing is stopped first and deleted once its worker has settled; if it does not settle in time nothing is deleted and the call says to retry.",
		annotations: {
			title: "Delete run",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID to delete."),
			confirmed: confirmedInput("actually delete the run"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const runId = requireStr(args, "runId");
			// Read it first so the person answering the prompt sees which run is
			// about to go, not an id - the same reason delete_request does.
			let stored: Record<string, unknown>;
			try {
				const value = await ctx.client.getRun(runId, signal);
				if (!isRecord(value)) return errorResult(`No run with id "${runId}".`);
				stored = value;
			} catch (err) {
				if (err instanceof EngineRequestError && err.status === 404) {
					return errorResult(`No run with id "${runId}".`);
				}
				return engineErrorResult(err);
			}
			const subject = describeRun(runId, stored);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete ${subject}?\n\nIts report, metrics and captured samples go with it. This cannot be undone.`,
				acceptTitle: "Delete the run",
				acceptDescription: "Confirm to delete this run and everything recorded against it.",
				declined: "Run not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete ${subject}, along with its report, metrics and captured samples. This cannot be undone.\n\n` +
					"This is a preview. To delete it, call delete_run again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			try {
				return jsonResult(await ctx.client.deleteRun(runId, signal));
			} catch (err) {
				// The engine refuses rather than half-deletes a run whose worker is
				// still writing (409). That is a "try again in a moment", not a
				// failure of the request - say which one it is.
				if (err instanceof EngineRequestError && err.status === 409) {
					return errorResult(
						`Run ${runId} is still stopping and was NOT deleted. It has been asked to stop - call delete_run again once it reports a terminal status (check with list_runs).`
					);
				}
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "get_live_metrics",
		category: "read",
		invalidates: [],
		description:
			"Get a snapshot of the most recent live metrics ticks for a run (RPS, latency percentiles, error rate, status mix). Returns the last N ticks; does not stream.",
		annotations: {
			title: "Get live metrics",
			readOnlyHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID to sample."),
			limit: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("How many recent ticks to return (default 10). Must be 1 or more."),
		},
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			// Guarded here as well as in the schema: the SDK validates arguments
			// before dispatch, but the handler is the layer that knows a
			// non-positive limit reaches `slice(-limit)` and inverts the bound.
			const limit = optionalPositiveInt(args, "limit", 10);
			return callEngine(() =>
				ctx.client.getLiveMetricsSnapshot(runId, limit, undefined, signal)
			);
		},
	},
	{
		name: "compare_runs",
		category: "read",
		invalidates: [],
		description:
			"Compare two completed runs and return the deltas in latency percentiles, throughput, error rate, and status-code mix, each labelled with which direction is an improvement. Use to answer 'did this change regress performance?'. Omit baseRunId to compare against the run pinned as the baseline for the same saved request.",
		annotations: {
			title: "Compare runs",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			baseRunId: z
				.string()
				.optional()
				.describe(
					"Baseline run ID (e.g. main). Omit to use the run pinned as baseline for the target's saved request."
				),
			targetRunId: z.string().describe("Comparison run ID (e.g. the change)."),
		},
		outputSchema: runComparisonSchema,
		handler: async (args, ctx, signal) => {
			const targetRunId = requireStr(args, "targetRunId");
			try {
				const baseRunId =
					str(args, "baseRunId") || (await resolveBaseline(targetRunId, ctx, signal));
				const [base, target] = await Promise.all([
					ctx.client.getRunReport(baseRunId, signal),
					ctx.client.getRunReport(targetRunId, signal),
				]);
				const comparison = compareReports(
					baseRunId,
					targetRunId,
					base as Record<string, unknown>,
					target as Record<string, unknown>
				);
				return structuredResult(comparison as unknown as Record<string, unknown>);
			} catch (err) {
				// A baseline that could not be resolved is an argument problem the
				// caller can fix, not an engine failure - it must not be reported
				// as one.
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "fetch_oauth2_token",
		category: "execute",
		invalidates: ["oauth"],
		description:
			"Acquire an OAuth 2.0 token for a client_credentials or password config and cache it engine-side, so the next run_request / start_load_run carrying the same config authenticates without a round trip - and so a token problem surfaces here, named, instead of as a wall of 401s inside a run. Pass `force: true` to refresh a token that is cached but stale. The interactive authorization_code grant is refused: it needs a browser and a loopback redirect the app owns, so authorize it there once and the cache this tool reads is the same one. GUARDED: the token endpoint's host must be on Vayu's MCP allowlist. The access token itself is never returned - what comes back is the cache entry's shape (key, type, scope, expiry, whether a refresh token came with it), because the engine applies the token to requests and nothing an agent does with the bearer needs its bytes.",
		annotations: {
			title: "Fetch OAuth 2.0 token",
			readOnlyHint: false,
			// It contacts a third party and writes a credential into the engine's
			// cache, replacing whatever was there for that key.
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			config: oauth2ConfigInput,
			force: z
				.boolean()
				.optional()
				.describe(
					"Refresh even when a valid token is cached. The engine uses the stored refresh token when the config allows it and falls back to a fresh grant. Default false - a cached, unexpired token is returned as-is."
				),
		},
		handler: async (args, ctx, signal) => {
			const config = isRecord(args.config) ? args.config : undefined;
			if (!config) return errorResult('"config" must be an OAuth 2.0 config object.');
			const grantType = str(config, "grantType");
			if (grantType === "authorization_code") {
				return errorResult(OAUTH2_INTERACTIVE_REFUSAL);
			}
			// Both URLs the engine may post to. The refresh URL defaults to the
			// token URL engine-side, so it is only checked when it names a
			// different host - a gate that read one of the two would be a gate a
			// config can walk around.
			for (const key of ["accessTokenUrl", "refreshTokenUrl"]) {
				const url = str(config, key);
				if (url === undefined || url === "") continue;
				const gate = checkAllowlist(url, ctx.config);
				if (!gate.ok) return errorResult(`${key}: ${gate.error!}`);
			}
			const payload: Record<string, unknown> = { config };
			if (args.force === true) payload.force = true;
			return callEngine(
				() => ctx.client.fetchOAuth2Token(payload, signal),
				(answer) => projectOAuth2Token(answer)
			);
		},
	},
	{
		name: "get_oauth2_token_status",
		category: "read",
		invalidates: [],
		description:
			"Ask whether a token is cached for a cache key, and whether it has expired - the read behind 'is this flow failing because the token went stale?'. The cache key is the `cacheKey` fetch_oauth2_token returned; the engine derives it from the token URL, client id, credentials id and (for password grants) the username, so configs differing only in scope share one entry. An absent entry is an answer (`found: false`), not an error. The access token is never returned, only the shape of the entry - see fetch_oauth2_token.",
		annotations: {
			title: "OAuth 2.0 token status",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { cacheKey: oauth2CacheKeyInput },
		handler: (args, ctx, signal) =>
			callEngine(
				() => ctx.client.getOAuth2TokenStatus(requireStr(args, "cacheKey"), signal),
				(answer) => projectOAuth2Status(answer)
			),
	},
	{
		name: "clear_oauth2_token",
		category: "write",
		invalidates: ["oauth"],
		description:
			"Drop the cached token for a cache key, so the next request that uses that config acquires a fresh one - the tool equivalent of the auth tab's Clear button. Use it when a provider has revoked or rotated credentials and the cache is still serving the old token. Idempotent: clearing a key nothing is cached under reports `deleted: false` rather than failing. No confirmation - nothing saved is lost, only a credential a re-fetch restores. GUARDED: requires write access to be enabled in Vayu Settings.",
		annotations: {
			title: "Clear OAuth 2.0 token",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { cacheKey: oauth2CacheKeyInput },
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			return callEngine(() =>
				ctx.client.clearOAuth2Token(requireStr(args, "cacheKey"), signal)
			);
		},
	},
	{
		name: "start_mock_issuer",
		category: "execute",
		// #502's Services drawer reads the issuer list and #756 added the
		// `service` entity; #757 is where the issuer tools take it, so an
		// MCP-started issuer appears without waiting out the drawer's poll.
		invalidates: ["service"],
		description:
			"Start a local OAuth 2.0 mock issuer and return its id, token URL, authorize URL and signing key. Use it to test an auth flow offline: start an issuer, point a request's oauth2 auth at the returned tokenUrl, run it with run_request, and assert on what the target received - no real identity provider, so no 2FA prompts, provider rate limits or account lockouts in the loop. It needs no allowlist entry: the engine binds every issuer to 127.0.0.1 and takes no host for it, so it is unreachable off this machine. The access token is an HS256 JWT signed with the returned signingKey - hand that key to the service under test and it can verify the mock's tokens. Set a short expiresInSeconds (with issueRefreshTokens) to exercise the 401-then-refresh path, and failureMode to exercise retry handling. At most 8 issuers run at once; stop yours with stop_mock_issuer when you are done.",
		annotations: {
			title: "Start mock OAuth issuer",
			readOnlyHint: false,
			// It binds a loopback listener and mints tokens for it: it destroys no
			// saved data and reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe("Port to bind on 127.0.0.1. Default 0 - the engine picks a free one."),
			expiresInSeconds: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"Lifetime of a minted access token, in seconds (default 3600). Set it low to make a token expire mid-test."
				),
			claims: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					'Extra JWT claims, e.g. {"sub": "alice", "roles": ["admin"]}. iss, iat, exp and jti are always the issuer\'s own; sub, client_id and scope are filled in only when you do not set them.'
				),
			clients: z
				.array(
					z.object({
						clientId: z.string().min(1).describe("Client id this issuer accepts."),
						clientSecret: z
							.string()
							.optional()
							.describe("Secret that client must then present."),
					})
				)
				.optional()
				.describe(
					"Clients the issuer accepts. Omit (the default) to accept any client id."
				),
			failureMode: z
				.enum(MOCK_ISSUER_FAILURE_MODES)
				.optional()
				.describe(
					'How /token misbehaves: "none" (default), "slow" (answers after slowMs), "server_error" (500), "invalid_client" (401).'
				),
			slowMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe('Delay before /token answers, in milliseconds. Only "slow" reads it.'),
			issueRefreshTokens: z
				.boolean()
				.optional()
				.describe(
					"Return a refresh_token alongside the access token, so a refresh grant can be tested. A refresh rotates its token - the presented one is spent."
				),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.startMockIssuer(mockIssuerStartPayload(args), signal)),
	},
	{
		name: "list_mock_issuers",
		category: "read",
		invalidates: [],
		description:
			"List the OAuth 2.0 mock issuers running right now, each with its id, urls, signing key, port, token expiry, failure mode and configured client count. Use it to find an issuer started earlier in the session, or to confirm one was stopped.",
		annotations: {
			title: "List mock OAuth issuers",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listMockIssuers(signal)),
	},
	{
		name: "stop_mock_issuer",
		category: "execute",
		invalidates: ["service"],
		description:
			"Stop a running OAuth 2.0 mock issuer and free its port. Tokens it already minted stay valid until they expire - nothing verifies them against the issuer once it is gone. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop mock OAuth issuer",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			issuerId: z.string().describe("Issuer ID to stop (from start_mock_issuer)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopMockIssuer(requireStr(args, "issuerId"), signal)),
	},
	{
		name: "update_mock_issuer",
		category: "execute",
		invalidates: ["service"],
		description:
			"Change how a running OAuth 2.0 mock issuer's /token endpoint behaves, live: its failure mode and its slow-mode delay. Use it to walk a client through a sequence - mint a token against a healthy issuer, flip it to server_error to see the retry, flip it back - without stopping the issuer, which would invalidate the token URL the request under test is already pointed at and change the signing key. This is a merge-patch: a field you omit keeps its current value. Only these two settings can change under a running issuer; the port, client list, claims and refresh-token setting are fixed when it starts, and asking to change one is an error telling you to start a new issuer.",
		annotations: {
			title: "Update mock OAuth issuer",
			readOnlyHint: false,
			// It rewrites two settings of a loopback listener; nothing recorded is
			// lost and the same patch applied twice is the same issuer.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			issuerId: z.string().describe("Issuer ID to update (from start_mock_issuer)."),
			failureMode: z
				.enum(MOCK_ISSUER_FAILURE_MODES)
				.optional()
				.describe(
					'How /token should misbehave from now on: "none" (healthy), "slow" (answers after slowMs), "server_error" (500), "invalid_client" (401). Omit to leave it unchanged.'
				),
			slowMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					'New delay before /token answers, in milliseconds (engine cap 60000). Only "slow" reads it. Omit to leave it unchanged.'
				),
		},
		handler: (args, ctx, signal) => {
			const issuerId = requireStr(args, "issuerId");
			const patch = mockIssuerPatchPayload(args);
			if (Object.keys(patch).length === 0) {
				// The engine accepts an empty patch and changes nothing, so a
				// success here would report a call that did not do what it was
				// asked - the `update_inbox_response` precedent.
				throw new ToolArgError('Name at least one of "failureMode" or "slowMs" to change.');
			}
			return callEngine(() => ctx.client.updateMockIssuer(issuerId, patch, signal));
		},
	},
	{
		name: "start_mock_server",
		category: "execute",
		invalidates: ["service"],
		description:
			"Start a local mock server that answers a collection's saved examples, and return its id and base URL. Use it to stand up the API a client under test expects without that API existing: point the client at the returned url and every request whose method and path match a saved request in the collection gets that request's example back - status, headers and body. A route whose request has no saved example answers 501, and a path that matches nothing answers 404, so the returned routeCount and routesWithoutExample are what say whether the mock is usable; get_mock_routes lists them. latencyMs and errorRatePct are how a client's timeout and retry handling get exercised - errorRatePct injects synthesized 500s at that rate. It needs no allowlist entry: the engine binds every mock to 127.0.0.1 and takes no host for it, so it is unreachable off this machine. Stop it with stop_mock_server when you are done; a mock keeps its port until then.",
		annotations: {
			title: "Start mock server",
			readOnlyHint: false,
			// A loopback listener over data it only reads: it destroys nothing and
			// reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection whose saved examples the mock serves (from list_collections). Its sub-collections are included."
				),
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe("Port to bind on 127.0.0.1. Default 0 - the engine picks a free one."),
			latencyMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"Artificial delay before every answer, in milliseconds (default 0). Use it to make a client's timeout handling fire."
				),
			errorRatePct: z
				.number()
				.int()
				.min(0)
				.max(100)
				.optional()
				.describe(
					"Percentage of answers replaced with a synthesized 500 (default 0). 0 and 100 are exact; in between it is a per-request roll."
				),
		},
		handler: async (args, ctx, signal) => {
			const payload = mockServerStartPayload(args);
			let started: unknown;
			try {
				started = await ctx.client.startMockServer(payload, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			// The caveat rides on the result rather than being left in the JSON:
			// "the mock started" and "the mock can answer" are different answers,
			// and only the second one is what the agent asked for. Read off the
			// engine's reply, which is why this is `pagedRead`'s shape rather
			// than a plain `callEngine`.
			return withCaveat(jsonResult(started), mockServerCaveat(started));
		},
	},
	{
		name: "list_mock_servers",
		category: "read",
		invalidates: [],
		description:
			"List the mock servers running right now, each with its id, the collection it serves and that collection's name, its base URL and port, its latency and error-rate knobs, and how many routes it has. A stopped mock is gone rather than listed - its record dies with its listener - so this is also how to confirm one stopped.",
		annotations: {
			title: "List mock servers",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listMockServers(signal)),
	},
	{
		name: "get_mock_routes",
		category: "read",
		invalidates: [],
		description:
			"List the routes one mock server is serving: method, path template, the saved request behind each, and whether that request has an example (hasExample false means the route answers 501). This is how 'the mock answers 404' gets diagnosed without sending a request per guess. The table is a snapshot taken when the mock started and cannot change under it - editing the collection means restarting the mock - so a second read answers the same thing.",
		annotations: {
			title: "Get mock server routes",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			mockId: z.string().describe("Mock server ID (from start_mock_server)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.getMockServerRoutes(requireStr(args, "mockId"), signal)),
	},
	{
		name: "stop_mock_server",
		category: "execute",
		invalidates: ["service"],
		description:
			"Stop a running mock server and free its port. Unlike a webhook inbox there is nothing left to read afterwards - a mock records nothing, so its record goes with its listener and it disappears from list_mock_servers. Requests sent to the URL after this are refused by the machine. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop mock server",
			readOnlyHint: false,
			// Nothing recorded is lost: a mock serves stored examples and keeps no
			// state of its own.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			mockId: z.string().describe("Mock server ID to stop (from start_mock_server)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopMockServer(requireStr(args, "mockId"), signal)),
	},
	{
		name: "start_webhook_inbox",
		category: "execute",
		invalidates: ["service"],
		description:
			"Start a local webhook inbox and return its id and URL. It records every request sent to it - method, path, query, headers, body, caller address - so an agent can point a webhook at the URL, trigger it, and then assert on what actually arrived with get_inbox_captures. It needs no allowlist entry: the inbox listens on this machine's loopback interface only, which MCP does not let you change, so it is unreachable from off the machine. Give it a canned `response` to make the sender see a specific status, body, headers or delay - the reply every captured request gets, changeable later with update_inbox_response. Stop it with stop_webhook_inbox when you are done (the captures survive a stop), or delete_webhook_inbox to remove it and them.",
		annotations: {
			title: "Start webhook inbox",
			readOnlyHint: false,
			// It binds a loopback listener and records what arrives: it destroys
			// no saved data and reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe(
					"Port to listen on, on this machine's loopback interface. Default 0 - the engine picks a free one. The interface itself is not configurable over MCP."
				),
			response: z
				.object({
					status: z
						.number()
						.int()
						.min(100)
						.max(599)
						.optional()
						.describe("Status code the inbox answers with (default 200)."),
					body: z.string().optional().describe("Response body the inbox answers with."),
					headers: z
						.record(z.string(), z.string())
						.optional()
						.describe(
							'Response headers, e.g. {"Content-Type": "application/json"}. Replaces the current set rather than merging into it.'
						),
					delayMs: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe(
							"Milliseconds to wait before answering, for testing a sender's timeout handling. The engine caps this at 30000."
						),
				})
				.optional()
				.describe(
					"The canned reply every request to this inbox receives. Omit for the engine's default (200, empty body)."
				),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.startInbox(inboxStartPayload(args), signal)),
	},
	{
		name: "list_webhook_inboxes",
		category: "read",
		invalidates: [],
		description:
			"List the webhook inboxes this engine has started, running and stopped alike, each with its id, URL, port, whether it is still listening, how many requests it has captured, and its canned response. A stopped inbox stays listed with its captures readable until it is deleted, so this is also how to find an inbox started earlier in the session.",
		annotations: {
			title: "List webhook inboxes",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listInboxes(signal)),
	},
	{
		name: "stop_webhook_inbox",
		category: "execute",
		invalidates: ["service"],
		description:
			"Stop a webhook inbox's listener and free its port. This is NOT a delete: the inbox stays listed and everything it captured stays readable with get_inbox_captures - use delete_webhook_inbox to remove the record and its captures. Requests sent to the URL after this are refused by the machine, not recorded. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop webhook inbox",
			readOnlyHint: false,
			// Nothing recorded is lost - the captures outlive the listener.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID to stop (from start_webhook_inbox)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopInbox(requireStr(args, "inboxId"), signal)),
	},
	{
		name: "delete_webhook_inbox",
		category: "write",
		invalidates: ["service"],
		description:
			"Delete a webhook inbox: stop its listener if it is still running, drop the record, and destroy every request it captured. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation - if the client supports elicitation the user is prompted with how many captures go with it, otherwise call once for a preview and again with `confirmed: true`. There is no undo, and the captures are the part that cannot be recreated. To keep them, use stop_webhook_inbox instead.",
		annotations: {
			title: "Delete webhook inbox",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID to delete."),
			confirmed: confirmedInput("actually delete the inbox and its captures"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const inboxId = requireStr(args, "inboxId");
			// Read the list first so the prompt states the real capture count and
			// the URL, not an id - the same read-before-prompt `delete_collection`
			// and `delete_run` do. `GET /inbox` is the only read that answers for
			// a single inbox: the engine has no `GET /inbox/:id`.
			let inbox: Record<string, unknown>;
			try {
				const listed = await ctx.client.listInboxes(signal);
				const rows = isRecord(listed) && Array.isArray(listed.data) ? listed.data : [];
				const found = rows.find((row) => isRecord(row) && row.inboxId === inboxId);
				if (!isRecord(found)) return errorResult(`No webhook inbox with id "${inboxId}".`);
				inbox = found;
			} catch (err) {
				return engineErrorResult(err);
			}
			const subject = describeInbox(inboxId, inbox);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete ${subject}?\n\nEverything it captured is destroyed with it. This cannot be undone.`,
				acceptTitle: "Delete the inbox",
				acceptDescription: "Confirm to delete this inbox and every request it captured.",
				declined: "Inbox not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete ${subject}, along with every request it captured. This cannot be undone; stop_webhook_inbox frees the port and keeps them.\n\n` +
					"This is a preview. To delete it, call delete_webhook_inbox again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteInbox(inboxId, signal));
		},
	},
	{
		name: "get_inbox_captures",
		category: "read",
		invalidates: [],
		description:
			"Read what a webhook inbox recorded, newest first. Each row is the whole captured request - method, path, query string, headers, body and the caller's address - so this is the assertion half of a webhook test: start an inbox, trigger the sender, read the captures. An inbox that has received nothing returns an empty page, not an error. " +
			`A body the engine cut at its capture cap carries \`bodyTruncated\` beside \`bodyBytes\`, the true original size. BOUNDED: ${DEFAULT_INBOX_CAPTURE_LIMIT} captures per call by default, ${MAX_INBOX_CAPTURE_LIMIT} at most - a larger \`limit\` is refused, not clamped - and each body is cut to ${MAX_INLINE_BODY_BYTES / 1024} KB for this result. \`pagination\` says how many exist; read the rest with \`offset\`. There is no live stream over MCP: poll this after triggering the sender.`,
		annotations: {
			title: "Get inbox captures",
			readOnlyHint: true,
			// The newest-first page moves as captures arrive, exactly as
			// `get_live_metrics` does - the same reason that one is not idempotent.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID whose captures to read."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_INBOX_CAPTURE_LIMIT)
				.optional()
				.describe(
					`How many captures to return (default ${DEFAULT_INBOX_CAPTURE_LIMIT}, max ${MAX_INBOX_CAPTURE_LIMIT}).`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many captures to skip, for paging (default 0)."),
		},
		handler: (args, ctx, signal) => {
			const inboxId = requireStr(args, "inboxId");
			const limit = optionalPageLimit(
				args,
				"limit",
				DEFAULT_INBOX_CAPTURE_LIMIT,
				MAX_INBOX_CAPTURE_LIMIT
			);
			const offset = optionalOffset(args, "offset");
			return pagedRead(
				() => ctx.client.getInboxCaptures(inboxId, limit, offset, signal),
				"captures",
				boundInboxCaptures
			);
		},
	},
	{
		name: "clear_inbox_captures",
		category: "write",
		invalidates: ["service"],
		description:
			"Delete every request a webhook inbox has captured, keeping the listener running on the same URL. Use it to start a fresh assertion window between triggers. GUARDED: requires write access to be enabled in Vayu Settings; unlike delete_webhook_inbox it needs no confirmation, because the inbox survives and the next trigger records again. The captures themselves do not come back.",
		annotations: {
			title: "Clear inbox captures",
			readOnlyHint: false,
			// It destroys recorded data, which is what this hint is for - the
			// listener surviving does not make the captures recoverable.
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID whose captures to clear."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const inboxId = requireStr(args, "inboxId");
			return callEngine(() => ctx.client.clearInboxCaptures(inboxId, signal));
		},
	},
	{
		name: "update_inbox_response",
		category: "execute",
		invalidates: ["service"],
		description:
			"Change what a running webhook inbox answers, live: status, body, headers or delay. The next request to arrive gets the new reply - nothing restarts and no captures are lost - so one inbox can answer 200 for the first trigger and 500 for the next, which is how a sender's retry or error handling gets exercised. This is a merge-patch: fields you omit keep their current value, and `headers` replaces the whole header set rather than merging into it.",
		annotations: {
			title: "Update inbox response",
			readOnlyHint: false,
			// It rewrites the canned reply of a listener and destroys nothing;
			// calling it again with the same block is a no-op.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID whose canned response to change."),
			status: z
				.number()
				.int()
				.min(100)
				.max(599)
				.optional()
				.describe("New status code. Omit to leave it unchanged."),
			body: z.string().optional().describe("New response body. Omit to leave it unchanged."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"New response header set, replacing the current one entirely. Omit to leave it unchanged."
				),
			delayMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"New delay before answering, in milliseconds (engine cap 30000). Omit to leave it unchanged."
				),
		},
		handler: (args, ctx, signal) => {
			const inboxId = requireStr(args, "inboxId");
			const response = inboxResponsePayload(args);
			if (Object.keys(response).length === 0) {
				// An empty merge-patch is accepted by the engine and changes
				// nothing, which would report success for a call that did not do
				// what it was asked. Say which fields exist instead.
				throw new ToolArgError(
					'Name at least one of "status", "body", "headers" or "delayMs" to change.'
				);
			}
			return callEngine(() => ctx.client.updateInboxResponse(inboxId, response, signal));
		},
	},
];

/** Look up a tool by name. Only `dispatchTool` needs this, so it stays local. */
function findTool(name: string): McpTool | undefined {
	return TOOLS.find((t) => t.name === name);
}

/** IPC-safe metadata for every tool, for the Settings tool list. */
export function toolCatalog(): McpToolInfo[] {
	return TOOLS.map((t) => ({
		name: t.name,
		description: t.description,
		category: t.category,
	}));
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
		return errorResult(`Tool "${name}" is disabled in Vayu Settings → MCP.`);
	}
	let result: ToolResult;
	try {
		result = await tool.handler(args, ctx, signal);
	} catch (err) {
		if (err instanceof ToolArgError) return errorResult(err.message);
		return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	}
	// Only a call that succeeded changed anything. A tool that returned an error
	// result may still have got as far as the engine, but it cannot say so, and
	// an invalidation storm on every rejected call would be worse than the one
	// stale list a genuinely-partial failure leaves behind. A confirmation
	// preview is the third case: successful, and deliberately without effect.
	if (!result.isError && !NOTHING_CHANGED.has(result)) notifyDataChanged(tool, args, ctx);
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
function notifyDataChanged(tool: McpTool, args: Record<string, unknown>, ctx: ToolContext): void {
	if (!ctx.onDataChanged || tool.invalidates.length === 0) return;
	const collectionId = str(args, "collectionId");
	const requestId = str(args, "requestId");
	const runId = str(args, "runId");
	const inboxId = str(args, "inboxId");
	const mockId = str(args, "mockId");
	for (const entity of tool.invalidates) {
		try {
			ctx.onDataChanged({
				entity,
				...(collectionId !== undefined ? { collectionId } : {}),
				...(requestId !== undefined ? { requestId } : {}),
				...(runId !== undefined ? { runId } : {}),
				...(inboxId !== undefined ? { inboxId } : {}),
				...(mockId !== undefined ? { mockId } : {}),
			});
		} catch (err) {
			console.error(`[MCP] Failed to notify "${entity}" change from ${tool.name}:`, err);
		}
	}
}
