/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `diff_bodies` (#3705): two stored bodies masked in one pass, then diffed -
 * by RFC 6901 pointer for JSON, by line for other text - within one bound.
 */

import { describe, expect, test, vi } from "vitest";
import { resolveSafetyConfig, type McpSafetyConfig } from "../config.js";
import { EngineRequestError, type EngineClient } from "../engine-client.js";
import { dispatchTool, type ToolContext, type ToolResult } from "../tools.js";
import { REDACTED_MARKER } from "../withhold.js";
import { MAX_DIFF_VALUE_BYTES, MAX_LINE_DIFF_CELLS, type BodyDiff } from "./diff-bodies.js";
import { MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { bodyDiffSchema } from "./output-schemas.js";

const PROD_SECRET = "prod-s3cr3t-token";
const STAGING_SECRET = "staging-s3cr3t-token";

/** Two environments, each holding its own token as a secret variable. */
const ENVIRONMENTS = [
	{ id: "env_prod", name: "Prod", variables: { token: { value: PROD_SECRET, secret: true } } },
	{
		id: "env_staging",
		name: "Staging",
		variables: { token: { value: STAGING_SECRET, secret: true } },
	},
];

type Engine = Partial<Record<keyof EngineClient, unknown>>;

/** The workspace reads masking makes, beside @p over. */
function engineWith(over: Engine): Engine {
	return {
		getGlobals: vi.fn().mockResolvedValue({ id: "globals", variables: {} }),
		listEnvironments: vi.fn().mockResolvedValue(ENVIRONMENTS),
		listCollections: vi.fn().mockResolvedValue([]),
		listAllRequests: vi.fn().mockResolvedValue([]),
		...over,
	};
}

function ctxWith(engine: Engine, safety: Partial<McpSafetyConfig> = {}): ToolContext {
	return {
		client: engine as unknown as EngineClient,
		config: resolveSafetyConfig(safety),
		host: "app",
	};
}

/**
 * An engine whose run "run_1" holds result 1 with response body @p a and
 * result 2 with @p b, each node carrying @p extra.
 */
function pairEngine(
	a: string,
	b: string,
	extra: { a?: Record<string, unknown>; b?: Record<string, unknown> } = {}
) {
	const rows: Record<number, unknown> = {
		1: { id: 1, trace: { request: {}, response: { body: a, ...extra.a } } },
		2: { id: 2, trace: { request: {}, response: { body: b, ...extra.b } } },
	};
	return engineWith({
		getRunResult: vi.fn((_run: string, id: number) => Promise.resolve(rows[id])),
	});
}

const PAIR = { a: { runId: "run_1", resultId: 1 }, b: { runId: "run_1", resultId: 2 } };

const textOf = (result: ToolResult) => result.content.map((block) => block.text).join("\n");

/** One diff_bodies call that succeeded, its answer held to the tool's schema and the bound. */
async function diff(
	engine: Engine,
	args: Record<string, unknown> = PAIR,
	safety: Partial<McpSafetyConfig> = {}
): Promise<BodyDiff> {
	const result = await dispatchTool("diff_bodies", args, ctxWith(engine, safety));
	expect(result.isError, textOf(result)).toBeFalsy();
	expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
	expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MAX_INLINE_BODY_BYTES);
	return bodyDiffSchema.parse(result.structuredContent) as BodyDiff;
}

describe("diff_bodies on two JSON bodies", () => {
	test("three differences are three entries, in sorted-key order, with old and new", async () => {
		const a = JSON.stringify({ status: "ok", items: [1, 2], meta: { region: "eu" } });
		const b = JSON.stringify({ status: "degraded", items: [1, 2, 3], meta: {} });
		const answer = await diff(pairEngine(a, b));

		expect(answer).toMatchObject({
			kind: "json",
			equal: false,
			differenceCount: 3,
			omitted: 0,
		});
		expect(answer.differences).toEqual([
			{ op: "added", pointer: "/items/2", new: "3" },
			{ op: "removed", pointer: "/meta/region", old: '"eu"' },
			{ op: "changed", pointer: "/status", old: '"ok"', new: '"degraded"' },
		]);
	});

	test("is compared on the parse: key order and a repeated key's earlier value are no difference", async () => {
		const answer = await diff(pairEngine('{"x":1,"y":{"k":0,"k":2}}', '{"y":{"k":2},"x":1}'));
		expect(answer).toMatchObject({ kind: "json", equal: true, differenceCount: 0, omitted: 0 });
		expect(answer.differences).toEqual([]);
	});

	test("numbers compare by their text, so 1.0 and 1 differ and a 20-digit id is not rounded", async () => {
		const answer = await diff(
			pairEngine('{"n":1.0,"id":12345678901234567890}', '{"n":1,"id":12345678901234567891}')
		);
		expect(answer.differences).toEqual([
			{
				op: "changed",
				pointer: "/id",
				old: "12345678901234567890",
				new: "12345678901234567891",
			},
			{ op: "changed", pointer: "/n", old: "1.0", new: "1" },
		]);
	});

	test("a key holding ~ or / is escaped in its pointer (~0, then ~1)", async () => {
		const answer = await diff(
			pairEngine('{"a/b":1,"m~n":1,"~1":1}', '{"a/b":2,"m~n":2,"~1":2}')
		);
		expect(answer.differences!.map((entry) => entry.pointer)).toEqual([
			"/a~1b",
			"/m~0n",
			"/~01",
		]);
	});

	test("a change of type is one change at its root, not a walk", async () => {
		const answer = await diff(pairEngine('{"v":{"a":1}}', '{"v":[1]}'));
		expect(answer.differences).toEqual([
			{ op: "changed", pointer: "/v", old: '{"a":1}', new: "[1]" },
		]);
	});
});

describe("diff_bodies masks both bodies before it diffs", () => {
	// Mutation check: hand `diffBodies` the records as fetched (bypass the
	// masking `callEngineForRunOutput` applies to `{ a, b }`) and both tokens
	// come back, the first as a "changed" difference at /token, so this fails.
	test("a secret that differs between the bodies reads <redacted> on both sides", async () => {
		const a = JSON.stringify({ token: PROD_SECRET, nested: { t: PROD_SECRET }, n: 1 });
		const b = JSON.stringify({ token: STAGING_SECRET, nested: [STAGING_SECRET], n: 2 });
		const result = await dispatchTool("diff_bodies", PAIR, ctxWith(pairEngine(a, b)));
		const answer = result.structuredContent as unknown as BodyDiff;

		expect(textOf(result)).not.toContain(PROD_SECRET);
		expect(textOf(result)).not.toContain(STAGING_SECRET);
		expect(answer.differences).toEqual([
			{ op: "changed", pointer: "/n", old: "1", new: "2" },
			{
				op: "changed",
				pointer: "/nested",
				old: `{"t":"${REDACTED_MARKER}"}`,
				new: `["${REDACTED_MARKER}"]`,
			},
		]);
	});

	test("a lookup the masking needs that fails refuses the diff and returns neither body", async () => {
		const engine = {
			...pairEngine(`visible ${PROD_SECRET}`, "other"),
			listEnvironments: vi.fn().mockRejectedValue(new Error("fetch failed")),
		};
		const result = await dispatchTool("diff_bodies", PAIR, ctxWith(engine));
		expect(result.isError).toBe(true);
		expect(textOf(result)).not.toContain("visible");
		expect(textOf(result)).not.toContain(PROD_SECRET);
		expect(textOf(result)).toMatch(/withheld whole/);
	});

	test("with reveal on, the secrets are compared as stored", async () => {
		const answer = await diff(
			pairEngine(`{"token":"${PROD_SECRET}"}`, `{"token":"${STAGING_SECRET}"}`),
			PAIR,
			{ revealSecretsToAgents: true }
		);
		expect(answer.differences).toEqual([
			{
				op: "changed",
				pointer: "/token",
				old: `"${PROD_SECRET}"`,
				new: `"${STAGING_SECRET}"`,
			},
		]);
	});
});

describe("diff_bodies bounds its answer", () => {
	test("a diff past the bound lists a prefix in order, and counts the rest as omitted", async () => {
		const keys = Array.from({ length: 2000 }, (_, i) => `k${String(i).padStart(4, "0")}`);
		const side = (value: string) =>
			JSON.stringify(
				Object.fromEntries(keys.map((key) => [key, `${value}-${"p".repeat(40)}`]))
			);
		const answer = await diff(pairEngine(side("prod"), side("staging")));

		expect(answer.differenceCount).toBe(2000);
		const listed = answer.differences!;
		expect(listed.length).toBeGreaterThan(100);
		expect(listed.length).toBeLessThan(2000);
		expect(answer.omitted).toBe(2000 - listed.length);
		expect(listed.map((entry) => entry.pointer)).toEqual(
			keys.slice(0, listed.length).map((key) => `/${key}`)
		);
	});

	test("a value past the per-value bound is cut on a character boundary and marked", async () => {
		const long = "é".repeat(MAX_DIFF_VALUE_BYTES);
		const answer = await diff(pairEngine(`{"v":"${long}"}`, '{"v":"short"}'));
		const [entry] = answer.differences!;

		expect(entry).toMatchObject({
			op: "changed",
			pointer: "/v",
			new: '"short"',
			truncated: true,
		});
		expect(Buffer.byteLength(entry.old!)).toBeLessThanOrEqual(MAX_DIFF_VALUE_BYTES);
		expect(entry.old).not.toContain("�");
		expect(entry.old!.startsWith('"éé')).toBe(true);
	});

	test("a body the store cut says so on its side", async () => {
		const answer = await diff(pairEngine("abc", "abd", { b: { bodyTruncated: true } }));
		expect(answer.a).toEqual({ totalBytes: 3, encoding: "utf8" });
		expect(answer.b).toEqual({ totalBytes: 3, encoding: "utf8", storedTruncated: true });
	});
});

describe("diff_bodies on text and binary bodies", () => {
	test("two bodies that are not both JSON get a line diff", async () => {
		const answer = await diff(pairEngine("one\ntwo\nthree\nfour", "one\n2\nthree\nfour\nfive"));
		expect(answer).toMatchObject({
			kind: "text",
			equal: false,
			differenceCount: 3,
			omitted: 0,
		});
		expect(answer).not.toHaveProperty("coarse");
		expect(answer.differences).toEqual([
			{ op: "removed", line: 2, old: "two" },
			{ op: "added", line: 2, new: "2" },
			{ op: "added", line: 5, new: "five" },
		]);
	});

	test("one JSON body against a text one is a line diff, and equal text is equal", async () => {
		const mixed = await diff(pairEngine('{"a":1}', "<html>"));
		expect(mixed).toMatchObject({ kind: "text", differenceCount: 2 });
		const same = await diff(pairEngine("<html>\n", "<html>\n"));
		expect(same).toMatchObject({ kind: "text", equal: true, differenceCount: 0 });
	});

	test("a changed region too large to align is listed whole, removed then added", async () => {
		const lines = Math.floor(Math.sqrt(MAX_LINE_DIFF_CELLS)) + 1;
		const body = (tag: string) =>
			["head", ...Array.from({ length: lines }, (_, i) => `${tag}${i}`), "tail"].join("\n");
		const answer = await diff(pairEngine(body("a"), body("b")));

		expect(answer).toMatchObject({ kind: "text", coarse: true, differenceCount: 2 * lines });
		expect(answer.differences![0]).toEqual({ op: "removed", line: 2, old: "a0" });
		expect(answer.omitted).toBe(2 * lines - answer.differences!.length);
	});

	test("a base64 body is reported as binary, with decoded sizes, and not diffed", async () => {
		const bytes = Buffer.from([0xff, 0x00, 0xfe]);
		const base64 = { bodyEncoding: "base64" };
		const differ = await diff(pairEngine(bytes.toString("base64"), "text", { a: base64 }));
		expect(differ).toEqual({
			kind: "binary",
			equal: false,
			a: { totalBytes: 3, encoding: "base64" },
			b: { totalBytes: 4, encoding: "utf8" },
		});
		const same = await diff(
			pairEngine(bytes.toString("base64"), bytes.toString("base64"), { a: base64, b: base64 })
		);
		expect(same).toMatchObject({ kind: "binary", equal: true });
	});
});

describe("diff_bodies names the side a refusal is about", () => {
	const notFound = (message: string) =>
		new EngineRequestError(
			"404",
			404,
			JSON.stringify({ error: { code: "not_found", message } })
		);
	const classOf = (result: ToolResult) =>
		(result.structuredContent as { error: { class: string } }).error.class;

	test("an example the request does not hold, on side b", async () => {
		const engine = engineWith({
			listRequestExamples: vi.fn().mockResolvedValue([{ id: "exa_1", body: "x" }]),
		});
		const result = await dispatchTool(
			"diff_bodies",
			{
				a: { requestId: "req_1", exampleId: "exa_1" },
				b: { requestId: "req_1", exampleId: "exa_9" },
			},
			ctxWith(engine)
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/^Body "b": No example with id "exa_9"/);
		expect(classOf(result)).toBe("not_found");
	});

	test("the engine's 404 for a run, on side a", async () => {
		const engine = engineWith({
			getRunResult: vi.fn((runId: string) =>
				runId === "run_gone"
					? Promise.reject(notFound("Run not found"))
					: Promise.resolve({ id: 1, trace: { response: { body: "x" } } })
			),
		});
		const result = await dispatchTool(
			"diff_bodies",
			{ ...PAIR, a: { runId: "run_gone", resultId: 1 } },
			ctxWith(engine)
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/^Body "a": No run with id "run_gone"/);
		expect(classOf(result)).toBe("not_found");
	});

	test.each([
		[{ ...PAIR, b: { runId: "run_1" } }, 'Body "b": "resultId" is required'],
		[{ ...PAIR, a: {} }, 'Body "a": Name the body to read'],
		[{ b: PAIR.b }, '"a" must be an object'],
	])("refuses %j", async (args, words) => {
		const result = await dispatchTool("diff_bodies", args, ctxWith(pairEngine("x", "y")));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(words);
	});

	test("a result with no trace names its side", async () => {
		const engine = engineWith({
			getRunResult: vi.fn((_run: string, id: number) =>
				Promise.resolve(
					id === 2 ? { id: 2 } : { id: 1, trace: { response: { body: "x" } } }
				)
			),
		});
		const result = await dispatchTool("diff_bodies", PAIR, ctxWith(engine));
		expect(textOf(result)).toMatch(/^Body "b": .*get_run_samples/);
	});
});
