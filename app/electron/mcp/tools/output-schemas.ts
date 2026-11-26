/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief The structured output schemas, and the readers that fill them: run
 *        comparison, engine health, the smoke matrix and the config update,
 *        plus the loose schemas of the other object-rooted reads.
 */

import { z } from "zod";
import { ERROR_CLASS_KEYS } from "../compare.js";
import type { EngineClient } from "../engine-client.js";
import { secretsShape, withholdRequestUrl } from "../withhold.js";
import type { ToolContext } from "./contract.js";
import { TERMINAL_STATUS_WORDS } from "./run-status.js";

// `id` makes the row a `$defs` entry that the five arrays of `runComparisonSchema`
// point at, instead of five inline copies in `tools/list` (#3781; ceilings in
// `tool-list-budget.test.ts`). The id is global to zod's registry, so no other
// schema may take "MetricDelta".
const metricDeltaSchema = z
	.object({
		metric: z.string(),
		base: z.number().nullable(),
		target: z.number().nullable(),
		delta: z.number().nullable(),
		pctChange: z.number().nullable(),
		// Which way is an improvement. Without it a reader has to know that falling
		// latency is good and falling throughput is not; `neutral` marks the metric
		// (total requests) where neither direction is a verdict.
		direction: z.enum(["lower-is-better", "higher-is-better", "neutral"]),
	})
	.meta({ id: "MetricDelta" });

export const runComparisonSchema = z.object({
	baseRunId: z.string(),
	targetRunId: z.string(),
	latency: z.array(metricDeltaSchema),
	throughput: z.array(metricDeltaSchema),
	reliability: z.array(metricDeltaSchema),
	statusCodes: z.record(z.string(), z.object({ base: z.number(), target: z.number() })),
	// The mcp failure classes (issue #3828) of two runs that both recorded
	// them: each class either run counted, the other side's missing count 0.
	// `{}` when either run did not record them (a run stored before the engine
	// counted them) - never a zero, which would read as a regression. The
	// engine's `protocolCodes` split is not compared.
	errorClasses: z.partialRecord(
		z.enum(ERROR_CLASS_KEYS),
		z.object({ base: z.number(), target: z.number() })
	),
	// Rows only where both runs carry the figure (issue #3781), never a null
	// side: the top-level `stream` figures, and each custom metric both runs
	// recorded under one type (`p50`/`p95` for a trend, `value` otherwise),
	// always `neutral`.
	stream: z.array(metricDeltaSchema),
	customMetrics: z.array(metricDeltaSchema),
	// Whether the two runs negotiated a compressed response differently
	// (issue #1488) - true means the byte and latency deltas above are not
	// measuring the same thing. A run recorded before this field existed
	// reads as not negotiated, same as an explicit false. The same fact is
	// the `compression` entry of `comparability`.
	compressionNegotiationDiffers: z.boolean(),
	// Every way the two runs were not the same experiment (issue #2162), in a
	// fixed order, `run_type` first; empty for a like-for-like pair. `base` and
	// `target` are the two values already formatted for a reader ("20 s"
	// against "3 s, stopped", or "not recorded"). Mirrors
	// `ComparabilityWarning` in compare.ts.
	comparability: z.array(
		z.object({ code: z.string(), message: z.string(), base: z.string(), target: z.string() })
	),
});

/** The engine's `pagination` block, plus the cursor `pagedRead` writes into it. */
const paginationSchema = z.looseObject({
	total: z.number().optional(),
	limit: z.number().optional(),
	offset: z.number().optional(),
	returned: z.number().optional(),
	hasMore: z.boolean().optional(),
	/** The `offset` to read next; null when this page is the last. */
	nextOffset: z.number().nullable().optional(),
	/** The bound in words, present only while `hasMore` is true. */
	note: z.string().optional(),
});

/**
 * The `{data, pagination}` envelope a paged read answers (`pagedRead`), with @p rowSchema for each
 * row. Loose throughout, every field optional: the SDK turns a result its declared schema rejects
 * into a protocol error that hides the whole answer, so this names what an agent can rely on
 * without refusing a field the engine adds. A non-object answer arrives wrapped as `{ raw }`.
 */
export function pagedEnvelopeSchema(rowSchema: z.ZodType = z.record(z.string(), z.unknown())) {
	return z.looseObject({
		data: z.array(rowSchema).optional(),
		pagination: paginationSchema.optional(),
	});
}

/** `list_runs`: a run row's id, the handle every other run tool takes. */
export const runPageSchema = pagedEnvelopeSchema(z.looseObject({ id: z.string().optional() }));

/** `get_run_samples`: `resultId` joins a sample to the report's `results[].id`. */
export const runSamplePageSchema = pagedEnvelopeSchema(
	z.looseObject({ resultId: z.number().optional() })
);

/** `get_run_timeseries` / `get_run_monitor`: stored payloads, with no key every row is held to. */
export const runSeriesPageSchema = pagedEnvelopeSchema();

/** `get_inbox_captures`: the capture's numeric id. */
export const inboxCapturePageSchema = pagedEnvelopeSchema(
	z.looseObject({ id: z.number().optional() })
);

// --- The other reads that answer a JSON object (#2445) -----------------------
//
// Loose and all-optional for the reason `pagedEnvelopeSchema` gives: a field
// named here is one an agent can rely on, a field not named still arrives, and
// nothing the engine sends can turn into a protocol error. `nullish` where the
// answer states "none" as null.

const optStr = z.string().optional();
const optNum = z.number().optional();
const optBool = z.boolean().optional();
const nullStr = z.string().nullish();
const nullNum = z.number().nullish();
const anyRecord = z.record(z.string(), z.unknown());
const anyList = z.array(z.unknown()).optional();
const rowsOf = (row: z.ZodType = anyRecord) => z.array(row).optional();
const countOf = z.looseObject({ count: optNum });

/** The `{data}` list the mock-server and inbox reads answer, with no `pagination`. */
const dataListSchema = (row?: z.ZodType) => z.looseObject({ data: rowsOf(row) });

export const appFocusSchema = z.looseObject({
	activeTab: z.looseObject({ type: optStr, entityId: nullStr, label: optStr }).nullish(),
	run: z.looseObject({ runId: optStr }).nullish(),
	activeEnvironment: z.looseObject({ id: optStr, name: optStr }).nullish(),
});

export const resolveVariablesSchema = z.looseObject({
	context: anyRecord.optional(),
	variables: rowsOf(z.looseObject({ name: optStr, resolved: optBool })),
	summary: anyRecord.optional(),
});

/** `get_request`: the stored row's identity. */
export const requestRowSchema = z.looseObject({
	id: optStr,
	name: optStr,
	method: optStr,
	url: optStr,
});

/** `list_requests`: each row's identity, summary and full alike. */
export const requestPageSchema = pagedEnvelopeSchema(requestRowSchema);

/** `list_collections`: `parentId` is null at the tree root. */
export const collectionPageSchema = pagedEnvelopeSchema(
	z.looseObject({ id: optStr, name: optStr, parentId: nullStr })
);

/**
 * A row's stored trace, as `boundRunReport` leaves it (#767, #769, #2458).
 * Unioned with anything because the engine hands back a trace it cannot parse
 * as the stored string (`read_body` names that case), and a declared shape that
 * refused it would turn the whole report into an error.
 */
const reportTraceSchema = z
	.looseObject({
		request: z
			.looseObject({
				rawRequestTruncated: optBool.describe("Its body half was cut, never the headers."),
			})
			.optional()
			.describe("Its body is cut and flagged as `response`'s is."),
		response: z
			.looseObject({
				bodyTruncated: optBool.describe(
					"Cut for this result; read_body pages out the rest."
				),
				bodyBytes: optNum.describe("The full size, in decoded bytes when base64."),
				bodyEncoding: optStr.describe(
					'"base64": decode `body`, never read it as text; a cut keeps whole 4-character groups.'
				),
			})
			.optional(),
		failures: anyList.describe(
			"The replay row's distinct failures; its console is `testValidation.console` (a step's: `tests.console`)."
		),
		failureCounts: anyList.describe("How often each failed."),
	})
	.or(z.unknown())
	.optional();

/**
 * `get_run_report`: what each field an agent acts on means, so the tool description carries only
 * the rules (#3749). Loose and all-optional: an older engine omits some, and nothing returned today
 * may be refused. `summary.partial` and `summary.summaryMissing` are a different statement from the
 * top-level `partial`, made of a failed run whose counts the engine could not fully record (#2895).
 */
export const runReportSchema = z.looseObject({
	metadata: z
		.looseObject({
			runId: optStr,
			runType: optStr,
			status: optStr,
			endTime: nullNum.describe(`Null until the run is ${TERMINAL_STATUS_WORDS}.`),
		})
		.optional(),
	summary: z
		.looseObject({
			partial: optBool.describe(
				"Final totals not saved: the counts are a floor; latency, peakConcurrency and avgQueueWaitMs are absent. Never false."
			),
			summaryMissing: optBool.describe(
				"No summary saved: the counts are not run totals; latency, peakConcurrency and avgQueueWaitMs are absent. Never false."
			),
			errorClasses: z
				.unknown()
				.optional()
				.describe(
					"Failed mcp replies per class (`transport`, `protocol`, `tool`, `protocolCodes` by JSON-RPC code), when counted. `{}`: none failed; absent: not recorded."
				),
			drainCut: z
				.looseObject({ cancelled: optNum })
				.optional()
				.describe(
					'A Stop cut the drain: figures cover only answered requests; the app shows "Not judged".'
				),
		})
		.optional(),
	warnings: anyList.describe(
		"`{code, message, ...counts}`: what can skew even clean numbers, e.g. an unresolved `{{token}}`."
	),
	slowRequests: z
		.looseObject({
			count: optNum.describe("Exact count past the slow threshold."),
			tracesStored: optNum.describe("Kept as traces; can be below `count`."),
		})
		.optional(),
	coverage: anyRecord
		.optional()
		.describe(
			"Against a bound OpenAPI document: operations hit, responses seen, undeclared statuses. Else absent, never zeros."
		),
	elements: anyList.describe(
		"Element rows (a step's: `scenario.steps[].elements`): a script's `messages` say why it failed, `console` what it logged; `*Dropped` counts the cut."
	),
	testValidation: z.looseObject({ console: anyList }).optional(),
	results: rowsOf(
		z.looseObject({
			id: optNum.describe("read_body's `resultId`."),
			trace: reportTraceSchema,
			traceOmitted: optBool.describe(
				"The trace budget ran out: scalars kept, trace dropped."
			),
		})
	),
	resultsStored: optNum.describe(
		"Rows stored; above `resultsCap`, `results` is a selection. Absent on an older engine."
	),
	resultsCap: optNum.describe(
		"100, or every stored step for a scenario run; past it, failing rows (outside 2xx/3xx, or 0) are kept first, listed in time order."
	),
	tracesOmitted: optNum.describe("Rows carrying `traceOmitted`, past `traceBudgetBytes`."),
	traceBudgetBytes: optNum,
	partial: optBool,
	unknownStatus: optBool.describe(
		"An unrecognised `metadata.status`, which counts as unfinished."
	),
	note: optStr,
});

/**
 * `run_request`: the exchange `boundExecuteResponse` leaves, or the events a
 * streamed send read (`runStreamingRequest`). One loose schema for both, every
 * member optional, so no answer either path gives today is refused (#3749). The
 * stream members (`completed`, `capReached`, `events`...) are left undeclared:
 * the `stream` argument states them, and naming them here again costs every
 * session bytes for nothing.
 */
export const runRequestResultSchema = z.looseObject({
	body: z.unknown().optional().describe("The parsed body; null when cut, base64 or not JSON."),
	bodyRaw: optStr.describe("The body as received, in `bodyEncoding`."),
	bodyEncoding: optStr.describe('"utf8" or "base64".'),
	bodyTruncated: optBool.describe("`bodyRaw` was cut to the cap for this result."),
	bodySize: optNum.describe(
		"The real size, in decoded bytes when base64; under `bodyCapped`, the prefix read."
	),
	bodyCapped: optBool.describe("Always present."),
	rawRequestTruncated: optBool.describe(
		'`rawRequest`\'s body was cut, headers kept whole; read_body `part: "request"` reads it.'
	),
	headers: anyRecord.optional().describe("The final response's headers, folded."),
	headerLines: anyList.describe(
		"As received: one `{name, value}` a line, in wire order, each `Set-Cookie` its own row."
	),
	redirects: anyList.describe(
		"Each 3xx followed, in order: `{status, statusText, url, schemeDowngrade, headerLines}` as that hop sent them."
	),
	requestHeaders: anyRecord
		.optional()
		.describe('Folded: a repeat joined with ", ", `Cookie` with "; ".'),
	requestHeaderLines: anyList.describe(
		"As sent: one `{name, value}` a line, in wire order, a repeated name as written."
	),
	runId: optStr.describe("Absent, with `resultId`, when nothing was stored."),
	resultId: optNum,
	mcp: z
		.looseObject({
			errorClass: optStr.describe('"transport", "protocol" or "tool" (HTTP 200, isError).'),
			code: optNum.describe("The JSON-RPC error code, when the failure has one."),
			message: optStr,
		})
		.optional()
		.describe("An `mcp` request's failure; `{}` on success. A buffered send only."),
});

export const runStatusSchema = z.looseObject({
	id: nullStr,
	status: nullStr,
	terminal: optBool,
	unknownStatus: optBool,
	progress: nullNum,
	nextStep: optStr,
});

/** `get_live_metrics`: the ticks, whether the run had ended, and (only then) the empty-window caveat. */
export const liveMetricsSchema = z.looseObject({
	ticks: anyList,
	completed: optBool,
	note: optStr,
});

export const engineConfigSchema = z.looseObject({
	entries: rowsOf(z.looseObject({ key: optStr })),
});

/** `list_element_kinds`: `kinds` without a `kind` argument, that one kind's entry with it. */
export const elementKindsSchema = z.looseObject({
	kinds: rowsOf(z.looseObject({ kind: optStr, category: optStr, label: optStr })),
	kind: optStr,
	configSchema: anyRecord.optional(),
});

/** `get_script_api`: `documentation` rides only on the entries a `q` matched. */
export const scriptApiSchema = z.looseObject({
	completions: rowsOf(z.looseObject({ label: optStr, detail: optStr, documentation: optStr })),
});

export const graphqlSdlSchema = z.looseObject({
	endpoint: nullStr,
	fetchedAt: optNum,
	sdl: optStr,
	sdlTruncated: optBool,
	sdlBytes: optNum,
	types: z.array(z.string()).optional(),
	unknownTypes: z.array(z.string()).optional(),
});

/** `get_spec`: `bound` and `collectionId` appear when the read resolved a binding or found none. */
export const specReadSchema = z.looseObject({
	specId: optStr,
	collectionId: optStr,
	bound: optBool,
	sourceUrl: nullStr,
	hash: nullStr,
	contentBytes: nullNum,
});

export const specDiffSchema = z.looseObject({
	collectionId: optStr,
	identical: optBool,
	summary: anyRecord.optional(),
	added: anyList,
	declined: anyList,
	removed: anyList,
	changed: anyList,
	entriesTruncated: optBool,
});

export const importPreviewSchema = z.looseObject({
	collections: rowsOf(),
	environments: z.array(z.string()).optional(),
	globals: optNum,
	clientCertificates: optNum,
	meta: anyRecord.optional(),
});

export const bindPreviewSchema = z.looseObject({
	title: optStr,
	operations: optNum,
	matched: optNum,
	wouldClear: countOf.optional(),
	unmatchedRequests: countOf.optional(),
	unmatchedOperations: countOf.optional(),
});

/** `export_spec` and `export_postman`; `format` and `mode` are the former's alone. */
export const exportDocumentSchema = z.looseObject({
	collectionId: optStr,
	format: optStr,
	mode: optStr,
	fileName: nullStr,
	document: optStr,
	documentTruncated: optBool,
	contentBytes: optNum,
});

/** `list_trash`: a root's id and its kind - a collection, a request, an environment, a saved example or a client certificate. */
export const trashPageSchema = pagedEnvelopeSchema(z.looseObject({ id: optStr, kind: optStr }));

export const requestExamplesSchema = z.looseObject({
	examples: rowsOf(z.looseObject({ id: optStr })),
	bodiesOmitted: optNum,
	bodyBudgetBytes: optNum,
});

/**
 * `read_body`: one page of a stored body. A shape this layer builds, so it is
 * held exactly: `text` on a window, `find` / `matchCount` / `matches` on a
 * search, the rest on both.
 */
export const bodyPageSchema = z.object({
	text: optStr,
	find: optStr,
	matchCount: optNum,
	matches: z
		.array(z.object({ offset: z.number(), contextOffset: z.number(), context: z.string() }))
		.optional(),
	offset: z.number(),
	nextOffset: z.number(),
	totalBytes: z.number(),
	encoding: z.enum(["utf8", "base64"]),
	done: z.boolean(),
	storedTruncated: optBool,
});

const diffSideSchema = z.object({
	totalBytes: z.number(),
	encoding: z.enum(["utf8", "base64"]),
	storedTruncated: optBool,
});

/**
 * `diff_bodies`: the difference between two stored bodies, held exactly. A
 * JSON difference has a `pointer`, a text one a `line`; a binary pair carries
 * no list, only `equal` and the two sides.
 */
export const bodyDiffSchema = z.object({
	kind: z.enum(["json", "text", "binary"]),
	equal: z.boolean(),
	a: diffSideSchema,
	b: diffSideSchema,
	coarse: optBool,
	differenceCount: optNum,
	differences: z
		.array(
			z.object({
				op: z.enum(["changed", "added", "removed"]),
				pointer: optStr,
				line: optNum,
				old: optStr,
				new: optStr,
				truncated: optBool,
			})
		)
		.optional(),
	omitted: optNum,
});

export const globalsSchema = z.looseObject({
	id: optStr,
	variables: z.unknown().optional(),
	updatedAt: optNum,
});

/** `get_cookies`: one cookie a row, null `environmentId` for the no-environment jar. */
export const cookiePageSchema = pagedEnvelopeSchema(
	z.looseObject({ environmentId: nullStr, name: optStr, domain: optStr })
);

export const oauthStatusSchema = z.looseObject({
	found: optBool,
	expired: optBool,
	token: anyRecord.optional(),
});

export const mockIssuerListSchema = z.looseObject({
	issuers: rowsOf(z.looseObject({ issuerId: optStr })),
});

export const mockServerListSchema = dataListSchema(z.looseObject({ mockId: optStr }));
export const mockRoutesSchema = dataListSchema(
	z.looseObject({ requestId: optStr, method: optStr, path: optStr, hasExample: optBool })
);
/** `get_mock_activity`: one page of the engine's activity ring, paged here (the route has no `offset`). */
export const mockActivitySchema = pagedEnvelopeSchema();
export const inboxListSchema = dataListSchema(z.looseObject({ inboxId: optStr }));

/**
 * `get_safety_config`: the session's guardrails as numbers, flags and the
 * allowlist. A fixed shape this layer builds, so nothing is optional. The gate
 * fields are booleans by type, which is what keeps a secret value out of them.
 */
export const safetyConfigSchema = z.object({
	allowlist: z.object({ allowAll: z.boolean(), hosts: z.array(z.string()) }),
	caps: z.object({
		maxRps: z.number(),
		maxConcurrency: z.number(),
		maxDurationSeconds: z.number(),
		maxIterations: z.number(),
	}),
	gates: z.object({
		allowWrites: z.boolean(),
		allowNetworkSettings: z.boolean(),
		revealSecretsToAgents: z.boolean(),
	}),
	disabledToolCount: z.number(),
});

export const engineHealthSchema = z
	.object({ status: z.string(), version: z.string().optional() })
	.passthrough();

/**
 * The engine config keys behind `allowNetworkSettings`: the proxy entries
 * (`proxyMode`, `proxyUrl`, `proxySystemUrl`, `proxyBypass`) and the extra
 * trust anchors (`engine/src/db/config_seeds/network.cpp`). By prefix rather
 * than by list, so a proxy key the engine adds later is gated the day it ships;
 * case-insensitive so the gate never rests on how the engine matches a key.
 */
export function isNetworkConfigKey(key: string): boolean {
	const lowered = key.toLowerCase();
	return lowered.startsWith("proxy") || lowered === "customcacertificates";
}

/** Whether a `GET /health` body can be returned as `structuredContent` as-is. */
export function isEngineHealthShape(value: unknown): value is Record<string, unknown> {
	return engineHealthSchema.safeParse(value).success;
}

export const smokeResultSchema = z.object({
	collectionId: z.string(),
	/** Rows run in this call (`passed + failed + skipped`), not the collection's size: that is `requestTotal`. */
	total: z.number(),
	passed: z.number(),
	failed: z.number(),
	skipped: z.number(),
	/** Requests the collection holds in scope, before the page was cut. */
	requestTotal: z.number().optional(),
	/** Whether requests past this page remain; true on a cancelled call. */
	hasMore: z.boolean().optional(),
	/** Where the next call resumes; present only while `hasMore` is true. */
	next: z.object({ offset: z.number() }).optional(),
	/** True when the call was cancelled mid-run and `results` holds the rows finished by then. */
	cancelled: z.boolean().optional(),
	/** The page in words; absent when this call ran everything in scope. */
	note: z.string().optional(),
	results: z.array(
		z.object({
			name: z.string(),
			/** Collections above the request, root first; only on a `recursive` run. */
			folder: z.string().optional(),
			method: z.string(),
			url: z.string(),
			ok: z.boolean(),
			statusCode: z.number().optional(),
			skipped: z.boolean().optional(),
			reason: z.string().optional(),
			error: z.string().optional(),
			/*
			 * An `mcp` request's own failure (#3809): present only when the engine
			 * named a class. A tool-class failure answers HTTP 200, so `statusCode`
			 * alone reads as success. Absent for a request that is not `mcp`, one
			 * that succeeded, and one whose exchange failed (`error` says so).
			 */
			mcp: z
				.object({
					errorClass: z.string(),
					code: z.number().optional(),
					message: z.string(),
				})
				.optional(),
			/*
			 * What the collection's bound OpenAPI document says about this response (issue #681).
			 * Absent for a collection bound to nothing (a response nobody judged against a contract
			 * did not fail one), and declared here because a field returned but not declared is
			 * rejected by the SDK before an agent sees it.
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
			 * What this request's own post-request script asserted (issue #733). A schema verdict
			 * explains itself on the row; a test failure did not: `ok:false` beside
			 * `statusCode: 200` named no reason while the detail sat in the `/execute` body this
			 * tool had just read. Absent when the response carried no test results, which is not
			 * the same as every assertion passing.
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
 * How many failed-test names one smoke row carries. Ten, the number the engine caps a schema
 * verdict's `failures` at (`constants::schema_validation::MAX_FAILURES`), because the two lists
 * ride the same row and are read the same way. Nothing caps `testResults` upstream (a script may
 * write as many assertions as it likes), so the cap is here, and `failed` stays the true total so a
 * cut list is visible as one.
 */
const MAX_TEST_FAILURES_PER_ROW = 10;

/** `[collection] ` / `[folder] ` for an inherited level's assertion; nothing for the request's own. */
function inheritedLevelMarker(scope: unknown): string {
	return scope === "collection" || scope === "folder" ? `[${scope}] ` : "";
}

/**
 * Both scripts' assertions, flattened for a tool result (#733). Rendered `name: message` for the
 * reason the schema failures are: an agent reads this as text. `undefined` means the response
 * carried no test results at all, the one state that must not become `{total: 0, failed: 0}`, which
 * would say the script asserted nothing and everything held when no script ran.
 *
 * A pre-request assertion is labelled (issue #810): the engine lists both scripts' assertions, and
 * one made before the request went out fails for different reasons than one about the response, so
 * an agent told only the name would read every failure as the latter. Nothing labels the
 * post-request ones.
 *
 * An assertion from an inherited level is labelled too (issue #2522): a request runs its
 * collection's and its folders' scripts, and an agent told only the name would look for the failing
 * assertion in the request's own script. The level marker leads the source one; the request's own
 * assertion and an entry with no `scope` (a trace stored before the field) carry none.
 */
export function readTestVerdict(
	resp: Record<string, unknown>
): { total: number; failed: number; failures?: string[] } | undefined {
	if (!Array.isArray(resp.testResults)) return undefined;
	const tests = resp.testResults as Array<{
		name?: unknown;
		passed?: unknown;
		error?: unknown;
		source?: unknown;
		scope?: unknown;
	}>;
	if (tests.length === 0) return undefined;
	const failed = tests.filter((t) => t.passed === false);
	const failures = failed.slice(0, MAX_TEST_FAILURES_PER_ROW).map((t) => {
		const bare = typeof t.name === "string" && t.name ? t.name : "(unnamed test)";
		const name = `${inheritedLevelMarker(t.scope)}${t.source === "pre" ? "[pre-request] " : ""}${bare}`;
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
 * The schema verdict a `POST /execute` body carries, flattened for a tool result (issue #681). The
 * failures are rendered `path: message` rather than passed through as objects: an agent reads this
 * as text, and the engine has already capped the list. `undefined` means the engine wrote no
 * verdict at all, the one state that must not become `{checked: false}`, which would say the
 * contract could not judge this response when there was no contract.
 */
export function readSchemaVerdict(
	resp: Record<string, unknown>
): Record<string, unknown> | undefined {
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

export const configUpdateSchema = z
	.object({
		changedKeys: z.array(z.string()),
		restartRequired: z.array(z.string()),
	})
	.passthrough();

/**
 * Of the changed config keys, which require an engine restart to take effect. The engine says so in
 * a typed `requiresRestart` field on each entry (`engine/src/http/routes/config.cpp`), read here
 * and in `SettingsMain.tsx`. Strictly `=== true`: this decides whether the tool result tells an
 * agent its change is live, and a payload that omits the field (an engine older than the app it is
 * paired with) has not said that it does not need one.
 */
export function restartRequiredAmong(configResponse: unknown, changedKeys: string[]): string[] {
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
 * The `url` a `run_collection_smoke` row echoes: credentials blanked as in a
 * saved-request read, unless the user reveals secrets (#1840). `runOutputShape`
 * masks only the values it knows to be secret, so a literal typed into the URL
 * would pass it. @p auth names the API-key query parameter.
 */
export function smokeRowUrl(ctx: ToolContext, url: unknown, auth: unknown): string {
	const shown = secretsShape(ctx, (value) => withholdRequestUrl(value, auth))(url);
	return String(shown ?? "");
}

/**
 * The direct sub-collections of `collectionId`, by name. `GET /requests?collectionId=` returns a
 * collection's *direct* requests only (the DB filters on `collection_id ==`), while collections
 * nest via `parentId`, so a smoke run on a parent leaves every descendant folder untested; this
 * names them so the result can say so. Returns `null` when the collection list could not be read:
 * the caller discloses "could not check" rather than the absence of children, since the two are not
 * the same claim.
 */
export async function childCollectionNames(
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

/** `limit` default and ceiling of `run_collection_smoke`: a serial run of real traffic, so a page is small. */
export const DEFAULT_SMOKE_LIMIT = 25;
export const MAX_SMOKE_LIMIT = 100;

/** What a smoke call knows about its page once the loop has ended. */
export interface SmokePage {
	/** Requests in scope, before paging. */
	requestTotal: number;
	offset: number;
	/** Rows finished in this call. */
	ran: number;
	/** Rows the page held, which a cancelled call did not finish. */
	planned: number;
	cancelled: boolean;
}

/**
 * The paging fields of a smoke result, in the result itself: a page cut that only the caller's
 * arithmetic reveals reads as the whole collection passing. `note` is absent when the call ran
 * everything in scope, so it appears only when there is something to act on. A cancelled call's row
 * in flight is not among the rows, and `next.offset` points at it: it may have reached the API
 * before the cancellation did, and the resume sends it again.
 */
export function smokePageFields(page: SmokePage): Record<string, unknown> {
	const { requestTotal, offset, ran, cancelled } = page;
	const nextOffset = offset + ran;
	const hasMore = nextOffset < requestTotal;
	return {
		requestTotal,
		hasMore,
		...(hasMore ? { next: { offset: nextOffset } } : {}),
		...(cancelled ? { cancelled: true } : {}),
		...smokePageNote(page, hasMore),
	};
}

function smokePageNote(page: SmokePage, hasMore: boolean): { note?: string } {
	const { requestTotal, offset, ran, planned, cancelled } = page;
	const nextOffset = offset + ran;
	if (cancelled) {
		return {
			note:
				`Cancelled after ${ran} of ${planned} requests; \`results\` holds those. The request ` +
				`in flight is not among them and may have been sent. Resume with offset: ${nextOffset}.`,
		};
	}
	if (hasMore) {
		return {
			note:
				`Ran ${ran} of ${requestTotal} requests, starting at offset ${offset}; ` +
				`call again with offset: ${nextOffset} for the rest.`,
		};
	}
	if (offset > 0 && ran === 0) {
		return {
			note: `offset ${offset} is past the end: the collection has ${requestTotal} requests in scope, so none ran.`,
		};
	}
	return {};
}

/** The two ways past a direct-only smoke run, as the caveat names them. */
const SMOKE_RECURSIVE_PATHS =
	"Pass `recursive: true` to run the whole tree in this tool, or use `run_collection` with " +
	"`recursive: true` for one stored run with a run id (preferred for a large tree).";

/** The disclosure `run_collection_smoke` attaches about folders it did not run. */
export function smokeScopeCaveat(children: string[] | null): string {
	if (children === null) {
		return (
			"\n\nNote: could not read the collection list, so any sub-collections could not be " +
			"checked. This tool runs a collection's direct requests only - requests in nested " +
			`folders are never included. ${SMOKE_RECURSIVE_PATHS}`
		);
	}
	if (children.length === 0) return "";
	return (
		`\n\nNote: ${children.length} sub-collection(s) were NOT run - this tool runs a ` +
		`collection's direct requests only, and the counts above exclude every request nested ` +
		`inside: ${children.join(", ")}. ${SMOKE_RECURSIVE_PATHS}`
	);
}
