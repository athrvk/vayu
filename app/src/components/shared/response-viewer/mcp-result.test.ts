/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `readMcpResult`: the reply of an `mcp` request read into what the pane draws
 * (#3841). The engine's own reader is `mcp_reply.hpp`; these hold the app's
 * reading of the same two shapes and the cases it must decline.
 */

import { describe, expect, it } from "vitest";
import { LARGE_BODY_BYTES } from "./utils";
import { base64ByteLength, readMcpResult } from "./mcp-result";

const envelope = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

describe("readMcpResult - a JSON reply", () => {
	it("reads every content block kind", () => {
		const reply = readMcpResult(
			envelope({
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", mimeType: "image/png", data: "AAAA" },
					{ type: "audio", mimeType: "audio/wav", data: "AAAA" },
					{ type: "resource_link", uri: "https://example.test/a", name: "a" },
					{
						type: "resource",
						resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "body" },
					},
				],
			})
		);

		expect(reply).toEqual({
			kind: "result",
			isError: false,
			blocks: [
				{ kind: "text", text: "hello" },
				{ kind: "image", mimeType: "image/png", data: "AAAA" },
				{ kind: "audio", mimeType: "audio/wav", data: "AAAA" },
				{
					kind: "resource_link",
					uri: "https://example.test/a",
					name: "a",
					title: undefined,
					description: undefined,
					mimeType: undefined,
				},
				{
					kind: "resource",
					uri: "file:///a.txt",
					mimeType: "text/plain",
					text: "body",
					blob: undefined,
				},
			],
		});
	});

	it("reports isError only when it is true", () => {
		const read = (isError: unknown) =>
			readMcpResult(envelope({ content: [], isError })) as { isError: boolean };

		expect(read(true).isError).toBe(true);
		expect(read(false).isError).toBe(false);
		expect(read("true").isError).toBe(false);
	});

	it("carries structuredContent, whatever its value", () => {
		expect(readMcpResult(envelope({ content: [], structuredContent: { n: 1 } }))).toMatchObject(
			{
				structuredContent: { n: 1 },
			}
		);
		// `null` is a value the server sent; absent is not.
		const withNull = readMcpResult(envelope({ content: [], structuredContent: null }));
		expect(withNull).toHaveProperty("structuredContent", null);
		expect(readMcpResult(envelope({ content: [] }))).not.toHaveProperty("structuredContent");
	});

	it("reads a result with structuredContent and no content", () => {
		expect(readMcpResult(envelope({ structuredContent: [1] }))).toEqual({
			kind: "result",
			isError: false,
			blocks: [],
			structuredContent: [1],
		});
	});

	it("keeps a block it cannot draw as unknown, in place", () => {
		const reply = readMcpResult(
			envelope({
				content: [
					{ type: "text", text: 4 },
					{ type: "video", url: "x" },
					"nope",
					{ type: "image", mimeType: "image/png" },
					{ type: "resource", resource: {} },
				],
			})
		);

		expect(reply).toMatchObject({
			blocks: [
				{ kind: "unknown", type: "text" },
				{ kind: "unknown", type: "video" },
				{ kind: "unknown", type: "" },
				{ kind: "unknown", type: "image" },
				{ kind: "unknown", type: "resource" },
			],
		});
	});
});

describe("readMcpResult - a JSON-RPC error", () => {
	it("reads the code and message", () => {
		const reply = readMcpResult(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32602, message: "Bad params" },
			})
		);

		expect(reply).toEqual({ kind: "error", code: -32602, message: "Bad params" });
	});

	it("reads an error with no numeric code", () => {
		expect(readMcpResult(JSON.stringify({ error: { message: "nope" } }))).toEqual({
			kind: "error",
			message: "nope",
		});
	});

	it("declines an error with no message", () => {
		expect(readMcpResult(JSON.stringify({ error: { code: 1 } }))).toBeNull();
	});
});

describe("readMcpResult - an event stream", () => {
	const message = (data: unknown) => `event: message\ndata: ${JSON.stringify(data)}\n\n`;

	it("reads the final response after progress notifications", () => {
		const stream =
			message({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) +
			message({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: "done" }] },
			});

		expect(readMcpResult(stream)).toMatchObject({
			kind: "result",
			blocks: [{ kind: "text", text: "done" }],
		});
	});

	it("takes the last response and ignores other event types", () => {
		const stream =
			message({ id: 1, result: { content: [{ type: "text", text: "first" }] } }) +
			message({ id: 1, result: { content: [{ type: "text", text: "last" }] } }) +
			`event: ping\ndata: ${JSON.stringify({ id: 1, result: { content: [] } })}\n\n`;

		expect(readMcpResult(stream)).toMatchObject({ blocks: [{ kind: "text", text: "last" }] });
	});

	it("takes an event with no type as a message, across CRLF lines and joined data", () => {
		const stream = ': comment\r\ndata: {"id":1,\r\ndata: "result":{"content":[]}}\r\n\r\n';

		expect(readMcpResult(stream)).toEqual({ kind: "result", isError: false, blocks: [] });
	});

	it("reads an error carried by the stream", () => {
		expect(readMcpResult(message({ id: 1, error: { code: -1, message: "boom" } }))).toEqual({
			kind: "error",
			code: -1,
			message: "boom",
		});
	});

	it("reads a final event the stream ended inside", () => {
		expect(readMcpResult('data: {"id":1,"result":{"content":[]}}')).toMatchObject({
			kind: "result",
		});
	});

	it("declines a stream with no response", () => {
		const stream = message({ jsonrpc: "2.0", method: "notifications/progress" });

		expect(readMcpResult(stream)).toBeNull();
	});
});

describe("readMcpResult - what is not a tool result", () => {
	it.each([
		["malformed JSON", '{"result":{"content":['],
		["empty", ""],
		["an array", "[1,2]"],
		["a scalar", "42"],
		["a result with no content", envelope({ tools: [] })],
		["a null result", envelope(null)],
		["plain text", "Internal Server Error"],
	])("declines %s", (_name, text) => {
		expect(readMcpResult(text)).toBeNull();
	});

	it("declines a body past the size the pane formats, without parsing it", () => {
		const padding = "x".repeat(LARGE_BODY_BYTES);
		const text = envelope({ content: [{ type: "text", text: padding }] });

		expect(text.length).toBeGreaterThan(LARGE_BODY_BYTES);
		expect(readMcpResult(text)).toBeNull();
	});
});

describe("base64ByteLength", () => {
	it.each([
		["", 0],
		["QQ==", 1],
		["QUI=", 2],
		["QUJD", 3],
	])("sizes %j as %i bytes", (base64, size) => {
		expect(base64ByteLength(base64)).toBe(size);
	});
});
