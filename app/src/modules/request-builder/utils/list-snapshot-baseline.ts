/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an `assert.snapshot` baseline is recorded from (#3807): the list an MCP server answered to
 * the request on screen. The `baseline` is that array as the reply carried it; the engine trims
 * both sides to the fields a client compares, so nothing is trimmed here. The reply is the JSON-RPC
 * envelope the Response pane holds, one JSON object or an event stream. The engine's reader
 * (`docs/engine/api-reference/request-body.md#the-mcp-reply`) decides which message answers: the
 * last `message` event that is a JSON-RPC response with the request's `id`. The app does not know
 * the id, so it reads a stream only when its responses share one `id`, and skips events not named
 * `message`. A recording that finds no answer, or cannot tell which, is refused rather than
 * guessed.
 */

/**
 * The result key each list method answers under, restating `snapshot_lists()`
 * in the engine's `core/list_snapshot`; `element-kinds.conformance.test.tsx`
 * holds the keys to the catalogue's `method` enum.
 */
export const SNAPSHOT_RESULT_KEYS: Readonly<Record<string, string>> = {
	"tools/list": "tools",
	"resources/list": "resources",
	"prompts/list": "prompts",
};

/** The method an element without one checks; the catalogue's `default`. */
export const DEFAULT_SNAPSHOT_METHOD = "tools/list";

/** The element's list method, its default while it names none. */
export function snapshotMethodOf(config: Record<string, unknown>): string {
	return typeof config.method === "string" ? config.method : DEFAULT_SNAPSHOT_METHOD;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		("result" in value || "error" in value)
	);
}

/** The value of the first @p field line of one event, `undefined` when it has none. */
function fieldOf(lines: string[], field: string): string | undefined {
	const prefix = `${field}:`;
	const line = lines.find((l) => l.startsWith(prefix));
	return line?.slice(prefix.length).replace(/^ /, "");
}

/**
 * Each `message` event's `data:` payload in arrival order; an event without an `event:` line is a
 * message, an `error` or other named event is not a frame the reader reads.
 */
function messagePayloads(body: string): string[] {
	return body
		.split(/\r?\n\r?\n/)
		.map((event) => event.split(/\r?\n/))
		.filter((lines) => (fieldOf(lines, "event") ?? "message") === "message")
		.map((lines) =>
			lines
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice("data:".length).replace(/^ /, ""))
				.join("\n")
		);
}

/**
 * The final JSON-RPC response in @p body, or `undefined`. The engine takes a stream's last response
 * with the request's `id`; the app has no id, so a stream with more than one distinct `id` is
 * refused.
 */
function finalReply(body: string): Record<string, unknown> | undefined {
	const whole = parseJson(body);
	if (isJsonRpcMessage(whole)) return whole;
	const responses = messagePayloads(body).map(parseJson).filter(isJsonRpcMessage);
	const ids = new Set(responses.map((response) => JSON.stringify(response.id ?? null)));
	if (ids.size > 1) return undefined;
	return responses[responses.length - 1];
}

/**
 * The items @p body's reply lists for @p method, or `null` with none to record: no JSON-RPC
 * response, an error response, a method the snapshot does not cover, or no such list. An empty list
 * is a list, so a server answering none records an empty baseline.
 */
export function baselineFromReply(body: string, method: string): unknown[] | null {
	const key = Object.prototype.hasOwnProperty.call(SNAPSHOT_RESULT_KEYS, method)
		? SNAPSHOT_RESULT_KEYS[method]
		: null;
	const result = key && finalReply(body)?.result;
	if (!key || typeof result !== "object" || result === null) return null;
	const items = (result as Record<string, unknown>)[key];
	return Array.isArray(items) ? items : null;
}
