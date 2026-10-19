/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file graphql-schema.ts
 * @brief `get_graphql_schema`'s pure parts: the introspection payload, the
 *        reading of the endpoint's answer, and the SDL printer (#2097).
 *
 * `graphql` is imported on demand inside the calls that need it, never at the
 * top: the MCP barrel loads every tool file, and an agent that never asks for
 * a schema should not pay for parsing the library.
 */

import type { IntrospectionQuery } from "graphql";
import { readRequestOverrides } from "./compose.js";
import { isRecord, str, ToolArgError } from "./kit.js";
import { MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";

/**
 * The largest introspection answer read, in bytes of the raw body: the
 * renderer's `MAX_INTROSPECTION_CHARS` figure. `JSON.parse` and
 * `buildClientSchema` are synchronous, so an unbounded answer is an unbounded
 * stall of the MCP host's thread, which in the app is the main process.
 */
export const MAX_INTROSPECTION_BYTES = 20 * 1024 * 1024;

/**
 * How much SDL one answer carries. Eight times the inline body bound, because
 * 32 KB holds a schema of roughly 600 lines and a query is written against the
 * whole document; a GitHub-scale schema still prints past 1 MB, and `types` is
 * the way to read that one in parts.
 */
export const MAX_SCHEMA_SDL_BYTES = MAX_INLINE_BODY_BYTES * 8;

/** A server that says this in its errors has introspection turned off. */
const INTROSPECTION_DISABLED = /introspection/i;

/** Fields only the inline (`url`) form reads; a saved request composes as stored. */
const INLINE_ONLY_ARGS = ["url", "headers", "auth", "collectionId"] as const;

/**
 * The `POST /compose` body for the call: the saved request by id, or an
 * inline POST to `url`. Exactly one of the two, because the stored row would
 * silently win over inline fields given beside its id.
 */
export function schemaComposeBody(
	args: Record<string, unknown>,
	auth: Record<string, unknown> | undefined
): Record<string, unknown> {
	const requestId = str(args, "requestId");
	const environmentId = str(args, "environmentId");
	if (requestId !== undefined) {
		const inline = INLINE_ONLY_ARGS.filter((key) => args[key] !== undefined);
		if (inline.length > 0) {
			throw new ToolArgError(
				`${inline.map((key) => `"${key}"`).join(", ")} cannot be combined with "requestId": a saved request is composed as stored, through its own collection, so they would be ignored. Pass "requestId" alone, or "url" for an endpoint with no saved request.`
			);
		}
		return { requestId, environmentId };
	}
	const url = str(args, "url");
	if (url === undefined || url === "") {
		throw new ToolArgError(
			'Pass "requestId" to read a saved request\'s schema, or "url" for an endpoint with no saved request.'
		);
	}
	const { headers } = readRequestOverrides({ headers: args.headers });
	return {
		request: {
			method: "POST",
			url,
			...(headers !== undefined ? { headers } : {}),
			...(auth !== undefined ? { auth } : {}),
		},
		collectionId: str(args, "collectionId"),
		environmentId,
	};
}

/**
 * A composed payload's `headers` as `{ name, value }` lines: the ordered array
 * `POST /compose` returns (issue #2466), or the older single-valued record. The
 * main-process twin of `headerLinesOf` (`src/lib/header-lines.ts`).
 */
function headerLinesOf(headers: unknown): Array<{ name: string; value: string }> {
	if (Array.isArray(headers)) {
		return headers.filter(isRecord).map((line) => ({
			name: String(line.name),
			value: String(line.value),
		}));
	}
	if (!isRecord(headers)) return [];
	return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * The introspection query overlaid onto a composed payload: the main-process
 * twin of the renderer's `buildIntrospectionRequest`
 * (`src/lib/graphql/introspect.ts`), which this tree cannot import.
 * `introspection-payload.conformance.test.ts` holds the two to one answer.
 *
 * Only url, headers and a concrete auth are carried over; the composed body,
 * elements and the rest belong to sending the request, not to reading its
 * schema. `transient` files no run row (#382), and `environmentId` scopes the
 * cookie jar the engine sends through.
 */
export async function introspectionPayload(
	composed: Record<string, unknown>,
	environmentId?: string
): Promise<Record<string, unknown>> {
	const { getIntrospectionQuery } = await import("graphql");
	const payload: Record<string, unknown> = {
		method: "POST",
		url: composed.url,
		headers: [
			...headerLinesOf(composed.headers).filter(
				(line) => line.name.toLowerCase() !== "content-type"
			),
			{ name: "Content-Type", value: "application/json" },
		],
		body: { mode: "json", content: JSON.stringify({ query: getIntrospectionQuery() }) },
		transient: true,
		...(environmentId ? { environmentId } : {}),
	};
	if (isRecord(composed.auth) && composed.auth.mode !== "inherit") payload.auth = composed.auth;
	return payload;
}

/** The host an error names; the whole URL when it does not parse. */
function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/** Why an exchange that never reached the endpoint (`status: 0`) failed. */
function unreachedError(answer: Record<string, unknown>, url: string): string {
	const code = typeof answer.errorCode === "string" ? answer.errorCode : "";
	const detail = typeof answer.errorMessage === "string" ? ` ${answer.errorMessage}` : "";
	const named = code ? ` (${code})` : "";
	if (code === "AUTH_REQUIRED" || code === "AUTH_FAILED") {
		return `Couldn't get an OAuth 2.0 token for the introspection request${named}.${detail}`;
	}
	return `Couldn't reach ${hostOf(url)}${named}.${detail}`;
}

/** Why a non-2xx answer is not a schema; null for a 2xx. */
function statusError(status: number): string | null {
	if (status === 401 || status === 403) {
		return `The endpoint rejected these credentials (HTTP ${status}). Check the request's auth.`;
	}
	if (status < 200 || status >= 300) {
		return `The endpoint answered HTTP ${status}; introspection needs a 2xx.`;
	}
	return null;
}

const NOT_JSON = "The endpoint answered, but not with JSON - it may not be a GraphQL endpoint.";

/** Why a parsed 2xx body is not an introspection result; null when it is one. */
function bodyError(parsed: unknown): string | null {
	if (!isRecord(parsed)) return "The endpoint's answer is not an introspection result.";
	const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
	if (errors.length > 0) {
		const messages = errors.map((e) => (isRecord(e) ? String(e.message ?? "") : ""));
		return messages.some((m) => INTROSPECTION_DISABLED.test(m))
			? "This endpoint disallows introspection, so its schema cannot be read through it."
			: `The endpoint answered with ${errors.length} GraphQL error(s) rather than an introspection result.`;
	}
	if (!parsed.data) {
		return "The endpoint answered with no introspection data - it may not be a GraphQL endpoint.";
	}
	return null;
}

/**
 * The introspection data in an `/execute` answer, or the error saying why
 * there is none, in the renderer's ladder (`introspectSchema`). No error
 * echoes the response body: it is the endpoint's to write, and an agent reads
 * every byte of a tool result.
 */
export function readIntrospectionAnswer(
	answer: unknown,
	url: string
): { data: unknown } | { error: string } {
	if (!isRecord(answer)) return { error: "Engine returned an unusable answer to the send." };
	const status = typeof answer.status === "number" ? answer.status : 0;
	if (status === 0) return { error: unreachedError(answer, url) };
	const refused = statusError(status);
	if (refused) return { error: refused };
	// A body the engine could not hold as UTF-8 text is not a JSON document,
	// and its `bodyRaw` is base64 whose length is not the body's (issue #2458).
	if (answer.bodyEncoding === "base64") return { error: NOT_JSON };
	const raw = typeof answer.bodyRaw === "string" ? answer.bodyRaw : "";
	const bytes = Buffer.byteLength(raw, "utf8");
	if (bytes > MAX_INTROSPECTION_BYTES) {
		return {
			error: `The introspection response is too large: ${Math.round(bytes / (1024 * 1024))} MB, over the ${MAX_INTROSPECTION_BYTES / (1024 * 1024)} MB limit.`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: NOT_JSON };
	}
	const unreadable = bodyError(parsed);
	return unreadable ? { error: unreadable } : { data: (parsed as { data: unknown }).data };
}

/** A schema printed as SDL, whole or as the named types asked for. */
export interface PrintedSchema {
	sdl: string;
	/** The named types `sdl` holds, in the order printed. */
	types: string[];
	/** Names asked for that the schema does not declare. */
	unknownTypes: string[];
}

/**
 * Print an introspection result as SDL: the whole schema, or with @p only
 * each named type in the order given, separated by a blank line. Throws when
 * `buildClientSchema` refuses the data as an introspection result.
 */
export async function printSdl(
	introspection: unknown,
	only?: readonly string[]
): Promise<PrintedSchema> {
	const {
		buildClientSchema,
		isIntrospectionType,
		isSpecifiedScalarType,
		printSchema,
		printType,
	} = await import("graphql");
	const schema = buildClientSchema(introspection as IntrospectionQuery);
	if (only === undefined || only.length === 0) {
		const types = Object.values(schema.getTypeMap())
			.filter((type) => !isIntrospectionType(type) && !isSpecifiedScalarType(type))
			.map((type) => type.name);
		return { sdl: printSchema(schema), types, unknownTypes: [] };
	}
	const names = [...new Set(only)];
	const found = names.flatMap((name) => {
		const type = schema.getType(name);
		return type ? [type] : [];
	});
	return {
		sdl: found.map((type) => printType(type)).join("\n\n"),
		types: found.map((type) => type.name),
		unknownTypes: names.filter((name) => !schema.getType(name)),
	};
}
