/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An MCP reply read for the response pane (#3841).
 *
 * The body of an `mcp` request is the raw reply (`engine/include/vayu/http/mcp_reply.hpp`):
 * one JSON-RPC response, or a `text/event-stream` whose last `message` event
 * carrying a `result` or `error` is that response. This reads it into the
 * parts the pane draws - the `content[]` blocks, `isError`, `structuredContent`
 * - and answers `null` for anything it cannot read as a tool result, so the
 * caller falls back to the raw JSON alone.
 *
 * The engine keeps the final response to itself; the app has no other copy, so
 * this is a second reader of that one rule. It reads only what the pane draws
 * and never the request id, which a stream's matching depends on: a stream
 * that carries a second response is shown by its last.
 */

import { LARGE_BODY_BYTES } from "./utils";

export type McpContentBlock =
	| { kind: "text"; text: string }
	| { kind: "image"; mimeType: string; data: string }
	| { kind: "audio"; mimeType: string; data: string }
	| {
			kind: "resource_link";
			uri: string;
			name?: string;
			title?: string;
			description?: string;
			mimeType?: string;
	  }
	| { kind: "resource"; uri: string; mimeType?: string; text?: string; blob?: string }
	/** A `type` this reader does not draw (or a known one missing its fields). */
	| { kind: "unknown"; type: string };

export type McpResult =
	| {
			kind: "result";
			isError: boolean;
			blocks: McpContentBlock[];
			/** Present when the result carried the key, whatever its value. */
			structuredContent?: unknown;
	  }
	| { kind: "error"; code?: number; message: string };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return typeof value === "string" ? value : undefined;
}

/** The decoded size of a base64 string, without decoding it. */
export function base64ByteLength(base64: string): number {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function readMedia(kind: "image" | "audio", raw: JsonObject): McpContentBlock {
	const data = stringField(raw, "data");
	const mimeType = stringField(raw, "mimeType");
	return data !== undefined && mimeType !== undefined
		? { kind, mimeType, data }
		: { kind: "unknown", type: kind };
}

function readResourceLink(raw: JsonObject): McpContentBlock {
	const uri = stringField(raw, "uri");
	if (uri === undefined) return { kind: "unknown", type: "resource_link" };
	return {
		kind: "resource_link",
		uri,
		name: stringField(raw, "name"),
		title: stringField(raw, "title"),
		description: stringField(raw, "description"),
		mimeType: stringField(raw, "mimeType"),
	};
}

function readEmbeddedResource(raw: JsonObject): McpContentBlock {
	const resource = raw.resource;
	const uri = isObject(resource) ? stringField(resource, "uri") : undefined;
	if (!isObject(resource) || uri === undefined) return { kind: "unknown", type: "resource" };
	return {
		kind: "resource",
		uri,
		mimeType: stringField(resource, "mimeType"),
		text: stringField(resource, "text"),
		blob: stringField(resource, "blob"),
	};
}

function readBlock(raw: unknown): McpContentBlock {
	if (!isObject(raw)) return { kind: "unknown", type: "" };
	const type = stringField(raw, "type") ?? "";
	switch (type) {
		case "text": {
			const text = stringField(raw, "text");
			return text === undefined ? { kind: "unknown", type } : { kind: "text", text };
		}
		case "image":
		case "audio":
			return readMedia(type, raw);
		case "resource_link":
			return readResourceLink(raw);
		case "resource":
			return readEmbeddedResource(raw);
		default:
			return { kind: "unknown", type };
	}
}

/** The server-sent events of a stream, each as its type and joined `data` lines. */
function* sseEvents(text: string): Generator<{ type: string; data: string }> {
	let type = "";
	let data: string[] = [];
	for (const line of text.split(/\r\n|\r|\n/)) {
		if (line === "") {
			if (data.length > 0) yield { type: type || "message", data: data.join("\n") };
			type = "";
			data = [];
			continue;
		}
		if (line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") type = value;
		else if (field === "data") data.push(value);
	}
	// A stream cut mid-event ends with no blank line.
	if (data.length > 0) yield { type: type || "message", data: data.join("\n") };
}

function parseJsonObject(text: string): JsonObject | null {
	try {
		const value: unknown = JSON.parse(text);
		return isObject(value) ? value : null;
	} catch {
		return null;
	}
}

const isResponse = (reply: JsonObject): boolean => "result" in reply || "error" in reply;

/** The last `message` event whose data is a JSON-RPC response. */
function finalStreamResponse(text: string): JsonObject | null {
	let final: JsonObject | null = null;
	for (const event of sseEvents(text)) {
		if (event.type !== "message") continue;
		const message = parseJsonObject(event.data);
		if (message && isResponse(message)) final = message;
	}
	return final;
}

function readEnvelope(reply: JsonObject): McpResult | null {
	const { error, result } = reply;
	if (isObject(error)) {
		const message = stringField(error, "message");
		const code = error.code;
		if (message === undefined) return null;
		return { kind: "error", message, ...(typeof code === "number" && { code }) };
	}
	// Any other result (`tools/list`, `initialize`) has no content to draw.
	if (!isObject(result)) return null;
	const hasContent = Array.isArray(result.content);
	const hasStructured = "structuredContent" in result;
	if (!hasContent && !hasStructured) return null;
	return {
		kind: "result",
		isError: result.isError === true,
		blocks: hasContent ? (result.content as unknown[]).map(readBlock) : [],
		...(hasStructured && { structuredContent: result.structuredContent }),
	};
}

/**
 * The tool result or JSON-RPC error a reply carries, or `null` when the text
 * is not one: malformed, a reply that is not a tool result, or past the size
 * the pane formats (`LARGE_BODY_BYTES`), which it does not parse.
 */
export function readMcpResult(text: string): McpResult | null {
	if (text.length > LARGE_BODY_BYTES) return null;
	const reply = parseJsonObject(text) ?? finalStreamResponse(text);
	return reply ? readEnvelope(reply) : null;
}
