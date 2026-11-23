/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an `assert.snapshot` baseline is recorded from (#3807): the list an MCP
 * server answered to the request on screen. The element's `baseline` is that
 * array as the reply carried it; the engine cuts both sides to the fields a
 * client reads when it compares, so nothing is trimmed here.
 *
 * The reply is the JSON-RPC envelope the Response pane holds, either one JSON
 * object or an event stream whose last JSON-RPC message is the answer. The
 * engine's own reply reader (`docs/engine/api-reference.md#the-mcp-reply`)
 * is the authority on which message that is; a recording that finds none is
 * refused rather than guessed at.
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

/** The `data:` payload of each event of an event-stream body, in arrival order. */
function eventPayloads(body: string): string[] {
	return body.split(/\r?\n\r?\n/).map((event) =>
		event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).replace(/^ /, ""))
			.join("\n")
	);
}

/** The last JSON-RPC response in @p body, or `undefined` when it holds none. */
function finalReply(body: string): Record<string, unknown> | undefined {
	const whole = parseJson(body);
	if (isJsonRpcMessage(whole)) return whole;
	const messages = eventPayloads(body).map(parseJson).filter(isJsonRpcMessage);
	return messages[messages.length - 1];
}

/**
 * The items @p body's reply lists for @p method, or `null` when it has none to
 * record: a body that is no JSON-RPC response, an error response, a method the
 * snapshot does not cover, or a result without that list. An empty list is a
 * list, so a server that answers none records an empty baseline.
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
