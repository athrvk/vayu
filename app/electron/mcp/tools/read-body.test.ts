/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `read_body` (#3704): a stored body past the inline cap, a page at a time,
 * masked whole before any page is cut from it.
 */

import { describe, expect, test, vi } from "vitest";
import { resolveSafetyConfig, type McpSafetyConfig } from "../config.js";
import { EngineRequestError, type EngineClient } from "../engine-client.js";
import { dispatchTool, TOOLS, type ToolContext, type ToolResult } from "../tools.js";
import { REDACTED_MARKER } from "../withhold.js";
import { MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { bodyPageSchema } from "./output-schemas.js";
import { FIND_CONTEXT_BYTES, MAX_FIND_MATCHES } from "./read-body.js";

const SECRET = "s3cr3t-token-value";

/** An environment holding {@link SECRET} as a secret variable, so the masking has something to mask. */
const ENVIRONMENTS = [
	{ id: "env_1", name: "Dev", variables: { token: { value: SECRET, secret: true } } },
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

/** A run result row as `GET /runs/:runId/results/:resultId` answers it. */
function resultRow(trace: unknown) {
	return { id: 42, timestamp: 1, statusCode: 200, statusText: "OK", latencyMs: 3, trace };
}

/** An engine holding one result whose response body is @p body. */
function resultEngine(body: string, response: Record<string, unknown> = {}) {
	return engineWith({
		getRunResult: vi.fn().mockResolvedValue(
			resultRow({
				request: { method: "GET", url: "https://h/x" },
				response: { body, ...response },
			})
		),
	});
}

const RESULT = { runId: "run_1", resultId: 42 };

interface BodyPage {
	text?: string;
	offset: number;
	nextOffset: number;
	totalBytes: number;
	encoding: "utf8" | "base64";
	done: boolean;
	storedTruncated?: boolean;
	find?: string;
	matchCount?: number;
	matches?: { offset: number; contextOffset: number; context: string }[];
}

/** One read_body call that succeeded, its structured page held to the tool's schema. */
async function readBody(args: Record<string, unknown>, engine: Engine): Promise<BodyPage> {
	const result = await dispatchTool("read_body", args, ctxWith(engine));
	expect(result.isError, result.content[0].text).toBeFalsy();
	expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
	return bodyPageSchema.parse(result.structuredContent) as BodyPage;
}

/** Every page of a body, read on from `nextOffset` until `done`. */
async function readAll(args: Record<string, unknown>, engine: Engine): Promise<BodyPage[]> {
	const pages: BodyPage[] = [];
	let offset = 0;
	for (;;) {
		const page = await readBody({ ...args, offset }, engine);
		pages.push(page);
		if (page.done) return pages;
		expect(page.nextOffset).toBeGreaterThan(offset);
		offset = page.nextOffset;
	}
}

const textOf = (result: ToolResult) => result.content.map((block) => block.text).join("\n");

describe("read_body masks the whole body before it pages", () => {
	// Mutation check: cut the page from the unmasked record and mask only the
	// page (`readBodyPage(bodyNodeOf(source, record), view)` handed to
	// `callEngineForRunOutput` as the answer) and the first page ends in a
	// prefix of the secret that no secret form matches, so this fails.
	test("a secret straddling the page boundary is redacted in both pages", async () => {
		const lead = "a".repeat(MAX_INLINE_BODY_BYTES - 5);
		const engine = resultEngine(`${lead}${SECRET}${"b".repeat(100)}`);
		const [first, second] = await readAll(RESULT, engine);

		const masked = `${lead}${REDACTED_MARKER}${"b".repeat(100)}`;
		expect(first.text! + second.text!).toBe(masked);
		expect(first.text).not.toContain("s3cr3");
		expect(second.text).not.toContain("value");
		expect(first.totalBytes).toBe(Buffer.byteLength(masked));
	});

	test("the pages of a 140 KB body concatenate to the whole masked body", async () => {
		const unit = `{"name":"Zoë ☃ 🎉","token":"${SECRET}","pad":"${"x".repeat(200)}"},`;
		const body = `[${unit.repeat(Math.ceil(140_000 / unit.length))}{}]`;
		const pages = await readAll(RESULT, resultEngine(body));

		const masked = body.split(SECRET).join(REDACTED_MARKER);
		expect(pages.length).toBeGreaterThan(4);
		expect(pages.map((page) => page.text).join("")).toBe(masked);
		for (const page of pages) {
			expect(Buffer.byteLength(page.text!)).toBeLessThanOrEqual(MAX_INLINE_BODY_BYTES);
			expect(page.text).not.toContain("�");
		}
		expect(pages[pages.length - 1].nextOffset).toBe(Buffer.byteLength(masked));
	});

	test("a lookup the masking needs that fails refuses the read and returns no body", async () => {
		const engine = {
			...resultEngine(`visible ${SECRET}`),
			listEnvironments: vi.fn().mockRejectedValue(new Error("fetch failed")),
		};
		const result = await dispatchTool("read_body", RESULT, ctxWith(engine));
		expect(result.isError).toBe(true);
		expect(textOf(result)).not.toContain("visible");
		expect(textOf(result)).not.toContain(SECRET);
		expect(textOf(result)).toMatch(/withheld whole/);
	});

	test("with reveal on, the body is read as stored", async () => {
		const result = await dispatchTool(
			"read_body",
			RESULT,
			ctxWith(resultEngine(`a ${SECRET}`), { revealSecretsToAgents: true })
		);
		expect(result.structuredContent?.text).toBe(`a ${SECRET}`);
	});
});

describe("read_body windows", () => {
	const euro = "€"; // three UTF-8 bytes

	test("a text window starting inside a character steps back to its start", async () => {
		const page = await readBody(
			{ ...RESULT, offset: 4, length: 3 },
			resultEngine(euro.repeat(4))
		);
		expect(page).toMatchObject({ text: euro, offset: 3, nextOffset: 6, totalBytes: 12 });
	});

	test("a text window ending inside a character ends before it, and nextOffset says where", async () => {
		const page = await readBody({ ...RESULT, length: 3 }, resultEngine(`a${euro.repeat(3)}`));
		expect(page).toMatchObject({ text: "a", offset: 0, nextOffset: 1, done: false });
	});

	test("a character longer than the window comes back whole, so the read moves on", async () => {
		const page = await readBody({ ...RESULT, length: 1 }, resultEngine("🎉x"));
		expect(page).toMatchObject({ text: "🎉", offset: 0, nextOffset: 4, done: false });
	});

	test("a base64 body pages in decoded bytes on whole 3-byte groups", async () => {
		const bytes = Buffer.from(Array.from({ length: 10 }, (_, i) => 250 - i));
		const engine = resultEngine(bytes.toString("base64"), { bodyEncoding: "base64" });
		const pages = await readAll({ ...RESULT, length: 5 }, engine);

		expect(pages.map((page) => [page.offset, page.nextOffset])).toEqual([
			[0, 3],
			[3, 6],
			[6, 9],
			[9, 10],
		]);
		expect(pages.every((page) => page.encoding === "base64" && page.totalBytes === 10)).toBe(
			true
		);
		const joined = pages.map((page) => page.text).join("");
		expect(joined).toBe(bytes.toString("base64"));
	});

	test("a base64 body is masked in its decoded bytes", async () => {
		const bytes = Buffer.concat([
			Buffer.from([0xff, 0x00]),
			Buffer.from(SECRET),
			Buffer.from([0xfe]),
		]);
		const engine = resultEngine(bytes.toString("base64"), { bodyEncoding: "base64" });
		const page = await readBody(RESULT, engine);
		const decoded = Buffer.from(page.text!, "base64");
		expect(decoded.toString("latin1")).toBe(`\xff\x00${REDACTED_MARKER}\xfe`);
		expect(page.totalBytes).toBe(decoded.length);
	});

	test("an offset past the end is refused, and one at the end is an empty last page", async () => {
		const engine = resultEngine("abc");
		const past = await dispatchTool("read_body", { ...RESULT, offset: 4 }, ctxWith(engine));
		expect(past.isError).toBe(true);
		expect(textOf(past)).toContain("past the end");
		const end = await readBody({ ...RESULT, offset: 3 }, engine);
		expect(end).toMatchObject({ text: "", offset: 3, nextOffset: 3, done: true });
	});

	test("a body the store itself cut says so", async () => {
		const page = await readBody(
			RESULT,
			resultEngine("abc", { bodyTruncated: true, bodyBytes: 9 })
		);
		expect(page.storedTruncated).toBe(true);
		const whole = await readBody(RESULT, resultEngine("abc"));
		expect(whole).not.toHaveProperty("storedTruncated");
	});
});

describe("read_body find", () => {
	test("lists the first matches with their offsets and context, and counts them all", async () => {
		const unit = "....needle";
		const body = unit.repeat(MAX_FIND_MATCHES + 5);
		const engine = resultEngine(body);
		const first = await readBody({ ...RESULT, find: "needle" }, engine);

		expect(first.matchCount).toBe(MAX_FIND_MATCHES + 5);
		expect(first.matches).toHaveLength(MAX_FIND_MATCHES);
		expect(first.matches!.slice(0, 2).map((match) => match.offset)).toEqual([4, 14]);
		const second = first.matches![1];
		expect(second.contextOffset).toBe(0);
		expect(body.slice(second.contextOffset).startsWith(second.context)).toBe(true);
		expect(Buffer.byteLength(second.context)).toBeLessThanOrEqual(6 + 2 * FIND_CONTEXT_BYTES);
		expect(first.done).toBe(false);
		expect(first.nextOffset).toBe(first.matches![MAX_FIND_MATCHES - 1].offset + 6);

		const rest = await readBody(
			{ ...RESULT, find: "needle", offset: first.nextOffset },
			engine
		);
		expect(rest.matches).toHaveLength(5);
		expect(rest.matchCount).toBe(MAX_FIND_MATCHES + 5);
		expect(rest.done).toBe(true);
	});

	test("searches the masked body, so a secret is not found by its value", async () => {
		const engine = resultEngine(`one ${SECRET} two`);
		const bySecret = await readBody({ ...RESULT, find: SECRET }, engine);
		expect(bySecret.matchCount).toBe(0);
		const byMarker = await readBody({ ...RESULT, find: REDACTED_MARKER }, engine);
		expect(byMarker.matches).toEqual([
			{ offset: 4, contextOffset: 0, context: `one ${REDACTED_MARKER} two` },
		]);
	});

	test("refuses a length beside find", async () => {
		const result = await dispatchTool(
			"read_body",
			{ ...RESULT, find: "x", length: 10 },
			ctxWith(resultEngine("x"))
		);
		expect(result.isError).toBe(true);
	});
});

describe("read_body pointer", () => {
	const doc =
		'{"b":1,"a":{"z":0},"data":[{"id":12345678901234567890,"name":"Zoë","x/y":true,"t~":null}],"a":{"k":"last","j":[1,2]}}';

	test("reads the named subtree from the parse: keys sorted, last repeated key, numbers as written", async () => {
		const engine = resultEngine(doc);
		const item = await readBody({ ...RESULT, pointer: "/data/0" }, engine);
		expect(item.text).toBe('{"id":12345678901234567890,"name":"Zoë","t~":null,"x/y":true}');
		const repeated = await readBody({ ...RESULT, pointer: "/a" }, engine);
		expect(repeated.text).toBe('{"j":[1,2],"k":"last"}');
		const escaped = await readBody({ ...RESULT, pointer: "/data/0/x~1y" }, engine);
		expect(escaped.text).toBe("true");
		const tilde = await readBody({ ...RESULT, pointer: "/data/0/t~0" }, engine);
		expect(tilde.text).toBe("null");
	});

	test("pages the subtree, sized by its own bytes", async () => {
		const big = JSON.stringify({
			list: Array.from({ length: 3000 }, (_, i) => ({ i, pad: "p".repeat(20) })),
		});
		const pages = await readAll({ ...RESULT, pointer: "/list" }, resultEngine(big));
		const whole = pages.map((page) => page.text).join("");
		expect(pages.length).toBeGreaterThan(1);
		expect(JSON.parse(whole)).toEqual((JSON.parse(big) as { list: unknown }).list);
		expect(pages[0].totalBytes).toBe(Buffer.byteLength(whole));
	});

	test.each([
		["/data/1", "names nothing"],
		["/missing", "names nothing"],
		["/data/0/id/x", "names nothing"],
		["data", "RFC 6901"],
	])("refuses %s", async (pointer, words) => {
		const result = await dispatchTool(
			"read_body",
			{ ...RESULT, pointer },
			ctxWith(resultEngine(doc))
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(words);
	});

	test("refuses a body that is not JSON, and a base64 one", async () => {
		const text = await dispatchTool(
			"read_body",
			{ ...RESULT, pointer: "" },
			ctxWith(resultEngine("<html>"))
		);
		expect(textOf(text)).toContain("does not parse");
		const binary = await dispatchTool(
			"read_body",
			{ ...RESULT, pointer: "" },
			ctxWith(resultEngine("AAEC", { bodyEncoding: "base64" }))
		);
		expect(textOf(binary)).toContain("base64");
	});
});

describe("read_body sources", () => {
	test("a run result: the response by default, the request, and a script request record", async () => {
		const getRunResult = vi.fn().mockResolvedValue(
			resultRow({
				request: { method: "POST", url: "https://h/x", body: "sent" },
				response: { body: "received" },
				scripts: {
					scriptRequests: [
						{ source: "pre", request: { body: "" }, response: { body: "token reply" } },
					],
				},
			})
		);
		const engine = engineWith({ getRunResult });
		expect((await readBody(RESULT, engine)).text).toBe("received");
		expect((await readBody({ ...RESULT, part: "request" }, engine)).text).toBe("sent");
		expect((await readBody({ ...RESULT, scriptRequest: 0 }, engine)).text).toBe("token reply");
		expect(getRunResult).toHaveBeenCalledWith("run_1", 42, undefined);

		const beyond = await dispatchTool(
			"read_body",
			{ ...RESULT, scriptRequest: 1 },
			ctxWith(engine)
		);
		expect(textOf(beyond)).toContain("1 pm.sendRequest record");
	});

	test("a result with no trace says where its exchanges are", async () => {
		const engine = engineWith({
			getRunResult: vi.fn().mockResolvedValue(resultRow(undefined)),
		});
		const result = await dispatchTool("read_body", RESULT, ctxWith(engine));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("get_run_samples");
	});

	test("an inbox capture, read by id in one engine call (#3723)", async () => {
		const getInboxCapture = vi.fn().mockResolvedValue({
			id: 7,
			method: "POST",
			body: `webhook ${SECRET}`,
			bodyEncoding: "utf8",
		});
		const getInboxCaptures = vi.fn();
		const page = await readBody(
			{ inboxId: "inbox_1", captureId: 7 },
			engineWith({ getInboxCapture, getInboxCaptures })
		);
		expect(page.text).toBe(`webhook ${REDACTED_MARKER}`);
		expect(getInboxCapture).toHaveBeenCalledTimes(1);
		expect(getInboxCapture).toHaveBeenCalledWith("inbox_1", 7, undefined);
		expect(getInboxCaptures).not.toHaveBeenCalled();
	});

	test("a saved example", async () => {
		const listRequestExamples = vi.fn().mockResolvedValue([
			{ id: "exa_1", name: "200", body: "first" },
			{ id: "exa_2", name: "404", body: "second" },
		]);
		const page = await readBody(
			{ requestId: "req_1", exampleId: "exa_2" },
			engineWith({ listRequestExamples })
		);
		expect(page.text).toBe("second");
		expect(listRequestExamples).toHaveBeenCalledWith("req_1", undefined);
	});

	test.each([
		[{}, "Name the body to read"],
		[{ runId: "run_1" }, '"resultId" is required'],
		[{ ...RESULT, inboxId: "inbox_1", captureId: 1 }, "more than one body"],
		[{ part: "request" }, '"runId" is required'],
		[{ ...RESULT, part: "headers" }, '"part" must be'],
	])("refuses %j", async (args, words) => {
		const result = await dispatchTool("read_body", args, ctxWith(resultEngine("x")));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(words);
	});
});

describe("read_body unknown ids", () => {
	const notFound = (message: string) =>
		new EngineRequestError(
			"404",
			404,
			JSON.stringify({ error: { code: "not_found", message } })
		);

	test.each([
		["Result not found", 'No result with id "42"'],
		["Run not found", 'No run with id "run_1"'],
	])("an engine 404 %s names the id", async (message, words) => {
		const engine = engineWith({ getRunResult: vi.fn().mockRejectedValue(notFound(message)) });
		const result = await dispatchTool("read_body", RESULT, ctxWith(engine));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(words);
		expect((result.structuredContent as { error: { class: string } }).error.class).toBe(
			"not_found"
		);
	});

	test.each([
		["Inbox not found", 'No inbox with id "inbox_1"'],
		["Capture not found", 'No capture with id "5"'],
	])("an engine 404 %s on a capture names the id", async (message, words) => {
		const engine = engineWith({
			getInboxCapture: vi.fn().mockRejectedValue(notFound(message)),
		});
		const result = await dispatchTool(
			"read_body",
			{ inboxId: "inbox_1", captureId: 5 },
			ctxWith(engine)
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(words);
		expect((result.structuredContent as { error: { class: string } }).error.class).toBe(
			"not_found"
		);
	});

	test("an example the request does not hold is the tool's own not_found", async () => {
		const engine = engineWith({
			listRequestExamples: vi.fn().mockResolvedValue([{ id: "exa_1", body: "x" }]),
		});
		const result = await dispatchTool(
			"read_body",
			{ requestId: "req_1", exampleId: "exa_9" },
			ctxWith(engine)
		);
		expect(textOf(result)).toContain('No example with id "exa_9"');
		expect((result.structuredContent as { error: { class: string } }).error.class).toBe(
			"not_found"
		);
	});
});

describe("the cap sentences name read_body", () => {
	test.each(["run_request", "get_run_report", "get_inbox_captures", "list_request_examples"])(
		"%s",
		(name) => {
			const tool = TOOLS.find((candidate) => candidate.name === name);
			expect(tool).toBeDefined();
			const description =
				typeof tool!.description === "string"
					? tool!.description
					: tool!.description(resolveSafetyConfig({}));
			expect(description).toContain("read_body");
			expect(description).not.toMatch(/run history|own history/);
		}
	);
});
