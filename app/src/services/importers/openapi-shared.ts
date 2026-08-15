/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { KeyValueEntry, SpecOperation } from "@/types";
import type { ExampleDraft, SkippedItem } from "./types";
import { asRecord, asStr, prop } from "@/lib/json-node";

export type RefResolver = (ref: string) => unknown;

/**
 * The in-document `$ref` resolver, once (issue #649).
 *
 * Both parsers built this by hand, identically - the repo's hand-rolled-copy
 * defect, in the one helper every other helper here takes as an argument. The
 * two escapes are the JSON Pointer ones (`~1` is `/`, `~0` is `~`), and the walk
 * is `prop()` per segment so a pointer into a non-object yields `undefined`
 * rather than throwing.
 *
 * **In-document only, and that is now a guarantee rather than a gap.** A ref
 * naming another file (`./pets.yaml#/Pet`) has no `#/` prefix to strip, so every
 * segment names a key no document has and the walk lands on `undefined` - which
 * a caller cannot tell from "the spec documented nothing here". External refs
 * are therefore resolved *before* parse by `ref-bundler.ts`, which inlines what
 * it can reach and counts what it cannot into the skip tally. Anything still
 * external by the time this runs is a ref the user has already been told about.
 */
export function createRefResolver(document: unknown): RefResolver {
	return (ref: string): unknown => {
		const path = ref
			.replace(/^#\//, "")
			.split("/")
			.map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
		let cur: unknown = document;
		for (const seg of path) cur = prop(cur, seg);
		return cur;
	};
}

/**
 * The identity of one operation: its method, the **templated** path as the
 * document writes it, and its `operationId` when it declares one (issue #637).
 *
 * The path is the document's own key (`/pets/{petId}`), deliberately *not* the
 * `{{petId}}` rewrite that goes into the request's URL: this is what a re-fetched
 * spec is diffed against, and diffing against Vayu's variable syntax would
 * compare a URL to a document that never contained one.
 *
 * `undefined` for a path that does not start with `/`, which the engine refuses
 * (`400`, `specOperation.path`). A `paths` map is keyed by path templates and
 * every real one starts with a slash, so this is a malformed document - and one
 * bad key must not turn the whole import into a rejected payload. The request
 * still imports; it simply names no operation, which is exactly the state of a
 * request the spec never described.
 */
export function specOperationOf(
	method: string,
	path: string,
	operationId: unknown
): SpecOperation | undefined {
	if (!path.startsWith("/")) return undefined;
	const id = asStr(operationId);
	return { ...(id ? { operationId: id } : {}), method: method.toUpperCase(), path };
}

/**
 * Helpers shared by the two OpenAPI/Swagger parsers. They are structural clones of
 * each other, which is how both ended up with the same unguarded `parameters` spread
 * and the same hardcoded `skipped: []`; a second copy of these three would drift the
 * same way.
 */

/**
 * Resolve a Path Item Object that is itself `{"$ref": "..."}` - legal in 3.0 and 3.1,
 * and what bundlers emit when they hoist a shared path item into `components.pathItems`.
 * Such an item carries no method keys, so an unresolved one drops every operation under
 * that path.
 *
 * Single-hop, like the parameter and `requestBody` refs the parsers already resolve: a
 * ref-to-a-ref is not a shape generators emit, and chasing one needs a cycle guard.
 * Returns `undefined` when there is nothing iterable to read methods off, so the caller
 * records the drop instead of silently looping over a non-object.
 */
export function resolvePathItem(
	pathItem: unknown,
	resolveRef: RefResolver
): Record<string, unknown> | undefined {
	if (!pathItem || typeof pathItem !== "object") return undefined;
	const ref = (pathItem as { $ref?: unknown }).$ref;
	if (typeof ref !== "string") return pathItem as Record<string, unknown>;
	let resolved: unknown;
	try {
		resolved = resolveRef(ref);
	} catch {
		return undefined;
	}
	return resolved && typeof resolved === "object"
		? (resolved as Record<string, unknown>)
		: undefined;
}

/**
 * Running count of what a parse had to drop, emitted as `meta.skipped` so the import
 * preview (`ImportModal`) can name it. Insertion-ordered, and only non-zero kinds are
 * emitted - an empty tally yields `[]`, exactly what both parsers used to hardcode.
 */
export class SkipTally {
	private readonly counts = new Map<SkippedItem["kind"], number>();

	add(kind: SkippedItem["kind"], count = 1): void {
		if (count <= 0) return;
		this.counts.set(kind, (this.counts.get(kind) ?? 0) + count);
	}

	/**
	 * The `parameters` of a path item or operation, guarded. The spec says array; a
	 * missing `-` in hand-written YAML makes it a mapping, and spreading that threw
	 * `not iterable` and aborted the whole file. Absent is normal and not counted;
	 * present-but-not-an-array is stepped over and tallied.
	 */
	params(parameters: unknown): unknown[] {
		if (Array.isArray(parameters)) return parameters;
		if (parameters != null) this.add("malformed_spec");
		return [];
	}

	items(): SkippedItem[] {
		return [...this.counts].map(([kind, count]) => ({ kind, count }));
	}
}

/**
 * Turn one entry of an operation's `responses` into an example draft (issue
 * #481), or `undefined` when it cannot be stored as one.
 *
 * Shared because the two parsers disagree only about where the payload lives -
 * v3 nests it under `content[mediaType]`, v2 puts `schema` and `examples`
 * directly on the response - while everything around it (which status codes are
 * representable, how the example is named, how the body is serialized) is the
 * same decision twice. @p payload is the per-version half: it returns the body
 * text and the media type, or `undefined` when the response documents no body.
 *
 * A key that is not a numeric status (`default`, `2XX`) has no status line to
 * be served under, so it is skipped and tallied rather than guessed at - the
 * caller passes the tally, and the preview names the loss.
 */
export function responseExample(
	code: string,
	response: unknown,
	tally: SkipTally,
	payload: (
		response: Record<string, unknown>
	) => { body: string; contentType: string } | undefined
): ExampleDraft | undefined {
	const node = asRecord(response);
	if (!node) {
		tally.add("malformed_spec");
		return undefined;
	}
	const status = Number(code);
	if (!/^\d{3}$/.test(code) || status < 100 || status > 599) {
		tally.add("example_no_status");
		return undefined;
	}

	const found = payload(node);
	const description = asStr(node.description);
	return {
		// "200 - A user" when the spec describes the response, "200" when it does
		// not. The status leads because that is what the reader scans a list of
		// examples for.
		name: description ? `${code} - ${description}` : code,
		status,
		headers: found ? [{ key: "Content-Type", value: found.contentType, enabled: true }] : [],
		body: found?.body ?? "",
		contentType: found?.contentType ?? "",
	};
}

/** The JSON media type of an OpenAPI 3 `content` map, by the same rule request bodies use. */
export function findJsonMediaType(content: Record<string, unknown>): string | undefined {
	if (content["application/json"]) return "application/json";
	return Object.keys(content).find(
		(k) => k.startsWith("application/json") || k.endsWith("+json")
	);
}

/**
 * The first entry of an OpenAPI 3 `examples` map, unwrapped from its Example
 * Object. `{"examples": {"user": {"value": {...}}}}` documents `{...}`, not the
 * wrapper - importing the wrapper would store a body no server would send.
 */
export function firstNamedExample(examples: unknown): unknown {
	const map = asRecord(examples);
	if (!map) return undefined;
	const first = Object.values(map)[0];
	const entry = asRecord(first);
	if (!entry) return undefined;
	// `externalValue` names a URL rather than carrying a payload; there is
	// nothing to store without fetching it, which an import must not do.
	return "value" in entry ? entry.value : undefined;
}

/** Serialize a sampled/declared example payload the way a JSON response body reads. */
export function exampleBodyText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * A value a spec declares for a query parameter, as the text a Params row holds -
 * or `undefined` when there is nothing Vayu can put on the wire.
 *
 * Only scalars convert. An array or object value is serialized by the parameter's
 * `style`/`explode` (v3) or `collectionFormat` (v2), neither of which this importer
 * reads; a row holds one string, so picking a separator here would send a value the
 * spec did not declare. An empty string is `undefined` too - the Params table writes
 * a bare key for an empty value, so `?flag=` is not a shape a row can express, and a
 * declared `""` is indistinguishable from no value at all.
 */
export function paramValueText(declared: unknown): string | undefined {
	if (typeof declared === "string") return declared || undefined;
	if (typeof declared === "number" || typeof declared === "boolean") return String(declared);
	return undefined;
}

/**
 * One `in: "query"` parameter as a Params row (issue #622).
 *
 * A spec's parameter list declares what the endpoint *accepts*, not what every
 * request should *send*. An optional parameter with no declared value has nothing
 * to send, so it imports **disabled**: the row stays in the Params table, one click
 * from use, while the `url` - which since #590 carries every enabled row - does not
 * gain a bare `?verbose` nobody chose. Some APIs read that bare key as `verbose=true`,
 * so importing it enabled changed the wire for imported collections.
 *
 * Two things override that, and only these two:
 *
 * - `required: true` - a spec saying the parameter must be sent is an instruction,
 *   not documentation. The row imports enabled even with no value, and the bare key
 *   is the user's cue to fill it in.
 * - a declared value - a row carrying `?status=available` sends what the spec said,
 *   which is the case enabling was ever right for.
 */
export function queryParamRow(
	name: string,
	declared: unknown,
	required: unknown,
	description?: string
): KeyValueEntry {
	const value = paramValueText(declared) ?? "";
	return {
		key: name,
		value,
		enabled: required === true || value !== "",
		...(description ? { description } : {}),
	};
}

/** A `$ref`-following read of `prop(node, key)`, single-hop like the rest of these. */
export function deref(value: unknown, resolveRef: RefResolver): unknown {
	const ref = asStr(prop(value, "$ref"));
	if (!ref) return value;
	try {
		return resolveRef(ref);
	} catch {
		return undefined;
	}
}
