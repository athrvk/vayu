/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { KeyValueEntry, SpecOperation } from "@/types";
import type {
	CollectionDraft,
	ExampleDraft,
	FolderStrategy,
	RequestDraft,
	SkippedItem,
} from "./types";
import { asArray, asRecord, asStr, prop } from "@/lib/json-node";

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
 *
 * Deliberately not exported: a parser reaching for this one operation at a time
 * cannot see that another operation already claimed the same `operationId`, and
 * stamping that id twice is what {@link createOperationIdentifier} exists to
 * prevent (issue #715). Parsers take the identifier; this is what it is built on.
 */
function specOperationOf(
	method: string,
	path: string,
	operationId: unknown
): SpecOperation | undefined {
	if (!path.startsWith("/")) return undefined;
	const id = asStr(operationId);
	return { ...(id ? { operationId: id } : {}), method: method.toUpperCase(), path };
}

/**
 * The status patterns an operation's `responses` map declares.
 *
 * Identical between Swagger 2.0 and OpenAPI 3.x - both key `responses` by status
 * pattern - which is why it is here rather than once per parser. Keys are taken
 * as written; a `$ref`-ed response object still declares its status *key* in the
 * operation, so nothing needs resolving to read them.
 */
export function declaredResponsesOf(responses: unknown): string[] {
	const map = asRecord(responses);
	if (!map) return [];
	return Object.keys(map).filter((key) => key.length > 0);
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

/** A path segment that names the API's version rather than a resource. */
const VERSION_SEGMENT = /^v\d+(\.\d+)*$/i;

/** A path segment that is entirely a `{template}`, which names a value, not a resource. */
const TEMPLATE_SEGMENT = /^\{.*\}$/;

/**
 * The folder an untagged operation belongs in, read off its path (issue #710) -
 * or `undefined` when the path names no resource to group by.
 *
 * A document whose operations carry no `tags` is not a broken document: Stripe's
 * official spec declares root-level tags that **no operation references**, so
 * every one of its 568 operations grouped by tag alone lands in one flat list.
 * The first meaningful path segment is what the vendor's own documentation is
 * organized by (`/v1/checkout/sessions` is "checkout"), so it is the grouping the
 * reader already expects.
 *
 * Leading segments that name no resource are stepped over: a version (`v1`,
 * `v2.1`), the ubiquitous `api` mount point, and a `{template}` segment, which
 * holds a value rather than naming anything. `/api/v2/{tenant}/orders` is
 * therefore "orders". A path with nothing left after that - `/`, `/v1`, `/{id}` -
 * yields `undefined`, and its request stays on the root rather than getting a
 * folder named after a placeholder.
 *
 * The segment is taken exactly as written (`account_links`, not "Account links"):
 * a prettified name is one the document never contained, and it is the name a
 * user matches against the vendor's docs.
 */
export function pathFolderName(path: string): string | undefined {
	for (const segment of path.split("/")) {
		if (!segment) continue;
		if (TEMPLATE_SEGMENT.test(segment)) continue;
		if (VERSION_SEGMENT.test(segment) || segment.toLowerCase() === "api") continue;
		return segment;
	}
	return undefined;
}

/**
 * Where each operation's request goes: a folder named by the operation's first
 * tag, a folder named by its path (issue #710), or the root collection.
 *
 * Shared rather than written per parser because it is one decision the two make
 * identically - both used to keep their own `Map<string, CollectionDraft>` plus
 * the same tag-description lookup, and the path fallback would have been the
 * third copy of the same routing to drift.
 *
 * **Only the first tag groups an operation**, unchanged from before: an operation
 * tagged `["a", "b"]` lands in `a` alone, because a request duplicated into two
 * folders is two requests to edit.
 */
export class OperationFolders {
	private readonly folders = new Map<string, CollectionDraft>();
	private readonly root: RequestDraft[] = [];
	private tagged = false;
	private pathed = false;

	/** @param declaredTags the document's top-level `tags[]`, for folder descriptions. */
	constructor(private readonly declaredTags: unknown) {}

	place(request: RequestDraft, path: string, tags: unknown): void {
		const tag = asStr(asArray(tags)[0]);
		const name = tag ?? pathFolderName(path);
		if (!name) {
			this.root.push(request);
			return;
		}
		if (tag) this.tagged = true;
		else this.pathed = true;
		let folder = this.folders.get(name);
		if (!folder) {
			folder = {
				name,
				description: tag ? this.describe(tag) : "",
				variables: {},
				auth: { mode: "none" },
				preRequestScript: "",
				postRequestScript: "",
				children: [],
				requests: [],
			};
			this.folders.set(name, folder);
		} else if (tag && !folder.description) {
			// A path segment can be spelled exactly like a tag, in which case the
			// folder already exists with no description. The tag's description still
			// describes what is in it, so it is filled in rather than dropped.
			folder.description = this.describe(tag);
		}
		folder.requests.push(request);
	}

	/** The folders, in first-encounter order. */
	children(): CollectionDraft[] {
		return [...this.folders.values()];
	}

	/** Requests whose operation had neither a tag nor a groupable path. */
	rootRequests(): RequestDraft[] {
		return this.root;
	}

	count(): number {
		return this.folders.size;
	}

	/**
	 * Which rule produced the folders, so the preview can say so - a spec that
	 * declares no operation tags gets a folder tree the document never spelled
	 * out, and that must not be a surprise. `undefined` when there are no folders
	 * to explain.
	 */
	strategy(): FolderStrategy | undefined {
		if (this.tagged && this.pathed) return "mixed";
		if (this.tagged) return "tags";
		if (this.pathed) return "paths";
		return undefined;
	}

	private describe(tag: string): string {
		const def = asArray(this.declaredTags).find((t) => prop(t, "name") === tag);
		return asStr(prop(def, "description")) ?? "";
	}
}

/**
 * {@link specOperationOf} for a whole document, with a **duplicated
 * `operationId` kept on its first declaration only** (issue #715).
 *
 * A document declaring one id on two operations is invalid OpenAPI and common
 * in generated specs, and stamping it verbatim on both requests is what turns
 * that upstream sloppiness into local corruption: the sync diff follows an id
 * before a path, so the second declaration's request resolves to the *first*
 * declaration's operation, reads as renamed toward an operation it never was,
 * and a default-ticked apply then rewrites its method, URL and identity. The
 * same ambiguity reaches the engine's coverage index, which resolves by id
 * first as well.
 *
 * So a repeated id is dropped rather than repeated: the later operation imports
 * with the identity it can still state unambiguously - its method and templated
 * path - which is what the engine's sync diff then follows it by. First declaration wins
 * because document order is stable across re-fetches of the same file, so two
 * syncs of an unchanged document agree about which request holds the id. The
 * drop is counted, because a request quietly missing the identity the document
 * appeared to give it is the kind of loss the import preview exists to name.
 *
 * One call per operation: the count is per duplicate declaration, and calling
 * it twice for the same operation would report a duplicate the document does
 * not contain.
 */
export function createOperationIdentifier(
	tally: SkipTally
): (method: string, path: string, operationId: unknown) => SpecOperation | undefined {
	const claimed = new Set<string>();
	return (method, path, operationId) => {
		const identity = specOperationOf(method, path, operationId);
		const id = identity?.operationId;
		if (!identity || !id) return identity;
		if (!claimed.has(id)) {
			claimed.add(id);
			return identity;
		}
		tally.add("duplicate_operation_id");
		return { method: identity.method, path: identity.path };
	};
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
 * caller passes the tally, and the preview names it.
 *
 * `default` gets a counter of its own (issue #710). It is the spec-conformant
 * catch-all every major vendor declares on every operation - Stripe on all 568,
 * GitHub likewise - so counting it beside malformed keys reported a fully valid
 * document as one defect per operation, in the same red as the one warning that
 * needed action. Same behaviour, told apart so the preview can rank them.
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
	if (code === "default") {
		tally.add("default_response");
		return undefined;
	}
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
 * A value a spec declares for a query or header parameter, as the text its row
 * holds - or `undefined` when there is nothing Vayu can put on the wire.
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
 * One declared `in: "query"` or `in: "header"` parameter as a table row
 * (issues #622, #658).
 *
 * A spec's parameter list declares what the endpoint *accepts*, not what every
 * request should *send*. An optional parameter with no declared value has nothing
 * to send, so it imports **disabled**: the row stays in its table, one click from
 * use, and off the wire. Enabled it was a choice nobody made - for a query row the
 * `url`, which since #590 carries every enabled row, gained a bare `?verbose` that
 * some APIs read as `verbose=true`; for a header row the request claimed to send
 * `X-Request-Id` with an empty value, which is not a header any spec asked for.
 *
 * Two things override that, and only these two:
 *
 * - `required: true` - a spec saying the parameter must be sent is an instruction,
 *   not documentation. The row imports enabled even with no value, and the empty
 *   value is the user's cue to fill it in.
 * - a declared value - a row carrying `?status=available` sends what the spec said,
 *   which is the case enabling was ever right for.
 */
export function declaredParamRow(
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
