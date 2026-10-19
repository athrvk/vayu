/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file output-schemas.ts
 * @brief The structured output schemas, and the readers that fill them: run
 *        comparison, engine health, the smoke matrix and the config update.
 */

import { z } from "zod";
import type { EngineClient } from "../engine-client.js";
import { secretsShape, withholdRequestUrl } from "../withhold.js";
import type { ToolContext } from "./contract.js";

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

export const runComparisonSchema = z.object({
	baseRunId: z.string(),
	targetRunId: z.string(),
	latency: z.array(metricDeltaSchema),
	throughput: z.array(metricDeltaSchema),
	reliability: z.array(metricDeltaSchema),
	statusCodes: z.record(z.string(), z.object({ base: z.number(), target: z.number() })),
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
export function readTestVerdict(
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

/** The disclosure `run_collection_smoke` attaches about folders it did not run. */
export function smokeScopeCaveat(children: string[] | null): string {
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
