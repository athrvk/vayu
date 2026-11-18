/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `boundRunReport` on the `pm.sendRequest` records a stored trace and a
 * `lifecycle` row carry (#3633). The main exchange's bounds are pinned through
 * `get_run_report` in `tools.test.ts`; these cases drive the function itself,
 * since the records add nothing to the dispatch path.
 */

import { describe, expect, test } from "vitest";
import {
	boundRunReport,
	MAX_INLINE_BODY_BYTES,
	MAX_REPORT_TRACE_BYTES,
} from "./inline-body-bounds.js";

type Json = Record<string, unknown>;

const huge = "x".repeat(MAX_INLINE_BODY_BYTES * 4);

/** One `pm.sendRequest` record in the trace's own shape. */
function record(requestBody: string, responseBody: string): Json {
	return {
		source: "pre",
		scope: "collection",
		status: 200,
		request: {
			method: "POST",
			url: "http://127.0.0.1:7000/token",
			headers: { "Content-Type": "application/json" },
			body: requestBody,
		},
		response: { headers: { "content-type": "application/json" }, body: responseBody },
		totalMs: 12,
	};
}

function traceWith(responseBody: string, records: Json[]): Json {
	return {
		request: { url: "https://api.test/orders" },
		response: { body: responseBody },
		scripts: { consoleLogs: [], scriptRequests: records },
	};
}

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function bound(report: Json): Json {
	return boundRunReport(report) as Json;
}

function rows(report: Json): Json[] {
	return report.results as Json[];
}

function scriptsOf(row: Json): Json {
	return (row.trace as Json).scripts as Json;
}

function recordsOf(holder: Json): Json[] {
	return holder.scriptRequests as Json[];
}

function node(rec: Json, key: "request" | "response"): Json {
	return rec[key] as Json;
}

describe("a stored trace's script requests (#3633)", () => {
	// Mutation check: bound only `trace.request` / `trace.response` again and
	// both bodies come back whole.
	test("each record's request and response body is cut per node, with its true size", () => {
		const out = bound({ results: [{ id: 1, trace: traceWith("ok", [record(huge, huge)]) }] });

		const [rec] = recordsOf(scriptsOf(rows(out)[0]));
		for (const key of ["request", "response"] as const) {
			const cut = node(rec, key);
			expect(Buffer.byteLength(cut.body as string, "utf8")).toBe(MAX_INLINE_BODY_BYTES);
			expect(cut.bodyTruncated).toBe(true);
			expect(cut.bodyBytes).toBe(huge.length);
		}
		// 64 KiB of records fit the budget beside a small exchange: nothing shed.
		expect(scriptsOf(rows(out)[0])).not.toHaveProperty("scriptRequestBodiesOmitted");
	});

	// Mutation check: drop the shedding step in `fitTrace` and the lone row is
	// kept at 128 KiB, past the budget.
	test("a lone row over the budget gives up its records' bodies and keeps its exchange", () => {
		const records = [record(huge, huge), record("", huge)];
		const out = bound({ results: [{ id: 1, trace: traceWith(huge, records) }] });

		const row = rows(out)[0];
		const trace = row.trace as Json;
		expect(row).not.toHaveProperty("traceOmitted");
		expect(out).not.toHaveProperty("tracesOmitted");
		expect(bytesOf(trace)).toBeLessThanOrEqual(MAX_REPORT_TRACE_BYTES);
		// The main exchange is cut per node, never shed.
		expect(Buffer.byteLength(node(trace, "response").body as string, "utf8")).toBe(
			MAX_INLINE_BODY_BYTES
		);

		const scripts = scriptsOf(row);
		expect(scripts.scriptRequestBodiesOmitted).toBe(true);
		const [first, second] = recordsOf(scripts);
		for (const shed of [
			node(first, "request"),
			node(first, "response"),
			node(second, "response"),
		]) {
			expect(shed).toMatchObject({ body: "", bodyTruncated: true, bodyBytes: huge.length });
		}
		// An empty body had nothing to give up and gains no disclosure.
		expect(node(second, "request")).toEqual(node(records[1], "request"));
		// The calls themselves survive the shed.
		expect(first).toMatchObject({ status: 200, totalMs: 12 });
		expect(node(first, "request").url).toBe("http://127.0.0.1:7000/token");
	});

	// Mutation check: drop the shedding step and the second step loses its
	// whole trace to `traceOmitted`.
	test("a later row past what is left sheds its records' bodies before it loses its trace", () => {
		const step = (index: number, trace: Json) => ({
			id: index + 1,
			trace: { ...trace, stepIndex: index, outcome: "passed" },
		});
		const out = bound({
			results: [step(0, traceWith(huge, [])), step(1, traceWith(huge, [record(huge, huge)]))],
		});

		expect(out).not.toHaveProperty("tracesOmitted");
		const later = rows(out)[1];
		expect(later).not.toHaveProperty("traceOmitted");
		expect(
			Buffer.byteLength(node(later.trace as Json, "response").body as string, "utf8")
		).toBe(MAX_INLINE_BODY_BYTES);
		const scripts = scriptsOf(later);
		expect(scripts.scriptRequestBodiesOmitted).toBe(true);
		expect(node(recordsOf(scripts)[0], "response")).toMatchObject({
			body: "",
			bodyBytes: huge.length,
		});
		const carried = rows(out).reduce((sum, row) => sum + bytesOf(row.trace), 0);
		expect(carried).toBeLessThanOrEqual(MAX_REPORT_TRACE_BYTES);
	});

	/**
	 * A record that is all metadata: 100 request headers and 20 redirect hops,
	 * about 10 KiB with no body at all.
	 */
	function heavyRecord(url = "http://127.0.0.1:7000/token"): Json {
		const headers = Object.fromEntries(
			Array.from({ length: 100 }, (_, i) => [`X-Trace-${i}`, "v".repeat(64)])
		);
		const hop = { status: 302, url, headers: { Location: url } };
		const base = record("", "");
		return {
			...base,
			request: { ...node(base, "request"), url, headers },
			response: {
				...node(base, "response"),
				redirects: Array.from({ length: 20 }, () => hop),
			},
			error_type: "",
		};
	}

	const passedStep = (index: number, trace: Json) => ({
		id: index + 1,
		trace: { ...trace, stepIndex: index, outcome: "passed" },
	});

	// Mutation check: drop `summarizeScriptRequests` from the shed steps and the
	// records go whole (`scriptRequestsOmitted`); drop it and
	// `omitScriptRequests` both and the later row loses its trace.
	test("a later row whose records are over even without bodies keeps its exchange and each call's summary", () => {
		const records = Array.from({ length: 10 }, () => heavyRecord());
		expect(bytesOf(records)).toBeGreaterThan(MAX_REPORT_TRACE_BYTES);
		const out = bound({
			results: [passedStep(0, traceWith(huge, [])), passedStep(1, traceWith(huge, records))],
		});

		expect(out).not.toHaveProperty("tracesOmitted");
		const later = rows(out)[1];
		expect(later).not.toHaveProperty("traceOmitted");
		const trace = later.trace as Json;
		expect(Buffer.byteLength(node(trace, "response").body as string, "utf8")).toBe(
			MAX_INLINE_BODY_BYTES
		);
		expect(node(trace, "request")).toEqual({ url: "https://api.test/orders" });

		const scripts = scriptsOf(later);
		expect(scripts.scriptRequestDetailOmitted).toBe(true);
		const summaries = recordsOf(scripts);
		expect(summaries).toHaveLength(records.length);
		for (const summary of summaries) {
			expect(summary).toEqual({
				source: "pre",
				scope: "collection",
				status: 200,
				error_type: "",
				totalMs: 12,
				request: { method: "POST", url: "http://127.0.0.1:7000/token" },
			});
		}
		const carried = rows(out).reduce((sum, row) => sum + bytesOf(row.trace), 0);
		expect(carried).toBeLessThanOrEqual(MAX_REPORT_TRACE_BYTES);
	});

	// Mutation check: drop `omitScriptRequests` from the shed steps and the later
	// row loses its trace.
	test("a later row whose records' summaries are still over gives the records up, counted, and keeps its exchange", () => {
		const longUrl = `http://127.0.0.1:7000/token?q=${"u".repeat(8_000)}`;
		const records = Array.from({ length: 10 }, () => heavyRecord(longUrl));
		const out = bound({
			results: [passedStep(0, traceWith(huge, [])), passedStep(1, traceWith(huge, records))],
		});

		expect(out).not.toHaveProperty("tracesOmitted");
		const later = rows(out)[1];
		expect(later).not.toHaveProperty("traceOmitted");
		expect(
			Buffer.byteLength(node(later.trace as Json, "response").body as string, "utf8")
		).toBe(MAX_INLINE_BODY_BYTES);
		const scripts = scriptsOf(later);
		expect(scripts).toEqual({ consoleLogs: [], scriptRequestsOmitted: records.length });
	});

	test("a shed body the engine had already cut keeps the size the engine recorded", () => {
		const engineCut = {
			...record("", ""),
			response: { body: huge, bodyTruncated: true, bodyBytes: 9_000_000 },
		};
		const out = bound({
			results: [{ id: 1, trace: traceWith(huge, [engineCut, record(huge, huge)]) }],
		});

		const [rec] = recordsOf(scriptsOf(rows(out)[0]));
		expect(node(rec, "response")).toMatchObject({ body: "", bodyBytes: 9_000_000 });
	});

	test("a report whose records are under both bounds comes back as the engine returned it", () => {
		const report = {
			results: [{ id: 1, trace: traceWith('{"ok":true}', [record("{}", '{"token":"t"}')]) }],
		};
		expect(boundRunReport(report)).toBe(report);
	});
});

describe("a lifecycle row's script requests (#3633)", () => {
	function lifecycleRow(id: string, records: Json[]): Json {
		return { id, kind: "script.setup", outcome: "ok", scriptRequests: records };
	}

	test("each record is cut per node, and the rows' records share one budget in run order", () => {
		const out = bound({
			results: [],
			lifecycle: {
				setup: [lifecycleRow("el_1", [record(huge, huge)])],
				teardown: [lifecycleRow("el_2", [record(huge, huge)])],
			},
		});

		const lifecycle = out.lifecycle as { setup: Json[]; teardown: Json[] };
		// Setup spends 64 KiB of the budget, cut per node and kept whole.
		const [setup] = lifecycle.setup;
		expect(setup).not.toHaveProperty("scriptRequestBodiesOmitted");
		expect(node(recordsOf(setup)[0], "response")).toMatchObject({
			bodyTruncated: true,
			bodyBytes: huge.length,
		});
		expect(Buffer.byteLength(node(recordsOf(setup)[0], "response").body as string)).toBe(
			MAX_INLINE_BODY_BYTES
		);
		// Teardown's 64 KiB more is past what is left: its bodies go, its call stays.
		const [teardown] = lifecycle.teardown;
		expect(teardown.scriptRequestBodiesOmitted).toBe(true);
		expect(recordsOf(teardown)[0]).toMatchObject({
			status: 200,
			response: { body: "", bodyTruncated: true, bodyBytes: huge.length },
		});
		expect(teardown).toMatchObject({ id: "el_2", outcome: "ok" });
	});

	// Mutation check: drop `summarizeScriptRequests` from the shed steps and
	// teardown's records go whole (`scriptRequestsOmitted`).
	test("a row past what is left, still over without bodies, keeps each call's summary", () => {
		const headers = Object.fromEntries(
			Array.from({ length: 400 }, (_, i) => [`X-Trace-${i}`, "v".repeat(64)])
		);
		const metadataOnly = { ...record("", ""), response: { headers, body: "" } };
		const out = bound({
			lifecycle: {
				setup: [lifecycleRow("el_1", [record(huge, huge)])],
				teardown: [lifecycleRow("el_2", [metadataOnly, metadataOnly])],
			},
		});

		const [teardown] = (out.lifecycle as { teardown: Json[] }).teardown;
		expect(teardown.scriptRequestDetailOmitted).toBe(true);
		expect(recordsOf(teardown)).toEqual([
			expect.objectContaining({
				status: 200,
				request: { method: "POST", url: expect.any(String) },
			}),
			expect.objectContaining({ status: 200 }),
		]);
		expect(recordsOf(teardown)[0]).not.toHaveProperty("response");
		expect(teardown).toMatchObject({ id: "el_2", outcome: "ok" });
	});

	test("a lifecycle with no records, or records under the bound, is left as it came", () => {
		const report = {
			lifecycle: {
				setup: [{ id: "el_1", kind: "script.setup", outcome: "ok" }],
				teardown: [lifecycleRow("el_2", [record("", '{"ok":true}')])],
			},
		};
		expect(boundRunReport(report)).toBe(report);
	});
});
