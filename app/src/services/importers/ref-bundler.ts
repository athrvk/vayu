/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Bundling a multi-file OpenAPI document into one, before it is parsed
 * (issue #649).
 *
 * **The defect this closes.** The parsers resolve `#/`-rooted pointers against
 * the document they were handed, and nothing else. A `$ref` naming another file
 * - `"./schemas/pet.yaml#/Pet"`, `"https://acme.dev/common.yaml#/Error"` - keeps
 * its whole string as the pointer, so the walk lands on `undefined` and the
 * caller reads that as *the spec documented nothing here*: an empty body stub,
 * a parameter that vanished, an example that never imported. No error, no count,
 * nothing the preview could name. Multi-file specs are the norm at the size of
 * API this feature exists for.
 *
 * So this runs first, replaces every external ref it can reach with an
 * in-document one, and **counts the ones it cannot** so the import preview can
 * say so. Nothing here guesses: an unreachable ref is left exactly as written
 * and reported, never quietly deleted.
 *
 * **Two intakes, because a spec arrives two ways.** A URL-sourced document
 * resolves its relative refs against that URL and fetches them through the
 * engine's existing `POST /import/fetch` - reused as-is, not widened. A
 * file-picked document reads its siblings through the `specFile:read` IPC, which
 * is gated in the main process (see `app/electron/spec-file.ts`). An absolute
 * `http(s)` ref is fetchable either way. A pasted document has neither, so its
 * relative refs are unresolvable by construction - and are reported as such
 * rather than silently dropped.
 *
 * **Where the resolved documents land.** Each one is inlined whole under a root
 * `x-vayu-bundled` map and every ref that pointed into it is rewritten to that
 * location. A root `x-` extension key is legal in Swagger 2.0 and OpenAPI 3.x
 * alike, so this is one rule for both parsers and does not have to choose
 * between `definitions` and `components/schemas` - and it survives the schema
 * validator a later phase brings in. A bundled document's *own* in-document refs
 * are rewritten too: `#/definitions/Pet` inside `pets.yaml` means Pet in
 * `pets.yaml`, not Pet in the root document.
 *
 * **Determinism is load-bearing**, not tidiness: the bundled text is what gets
 * stored as the spec document, and sync (#627) decides "unchanged" by comparing
 * hashes of exactly this output. Targets are therefore bundled in sorted order
 * with slugs derived only from the target itself.
 *
 * **A document that needed no bundling is returned byte for byte.** `SpecDraft`
 * promises the engine the document verbatim - a re-serialization would make
 * every YAML spec drift on its first sync - and that promise is kept for every
 * single-file spec, which is the common case. Only a document that genuinely is
 * several files is stored as the bundle, because there is no single verbatim
 * text for one of those to begin with.
 */

import { asRecord, asStr } from "@/lib/json-node";
import { parseRaw } from "./parse-raw";

/** Root key the resolved documents are inlined under. */
export const BUNDLE_KEY = "x-vayu-bundled";

/** How the bundler reaches the files a document names. */
export interface ExternalRefIntake {
	/**
	 * The engine's live `maxSpecDocumentBytes`. The bundle has to fit what the
	 * engine will store, and the number is fetched rather than restated.
	 */
	maxBytes: number;
	/** The URL the document was fetched from; relative refs resolve against it. */
	sourceUrl?: string;
	/** Fetch an absolute URL's text (the engine proxy). Absent = no URL intake. */
	fetchUrl?: (url: string) => Promise<string>;
	/**
	 * Read a file beside the picked document, by the path the ref wrote,
	 * normalized. Absent = the document was not picked from disk.
	 */
	readSibling?: (relativePath: string) => Promise<string>;
}

export interface BundleResult {
	/** What to parse, and what to store. Identical to the input when `bundled` is 0. */
	text: string;
	/** Distinct external documents inlined. */
	bundled: number;
	/** External refs left unresolved - reported to the user, never silent. */
	unresolvedRefs: number;
}

/**
 * A bundle that outgrew the engine's cap. Fatal rather than tallied: the engine
 * would refuse to store the document, so continuing would import a collection
 * bound to nothing.
 */
export class SpecBundleTooLargeError extends Error {
	constructor(bytes: number, maxBytes: number) {
		super(
			`The spec and the files it references come to ${bytes} bytes, over the ${maxBytes} one document may hold. Raise the maxSpecDocumentBytes engine setting, or import a bundled spec.`
		);
		this.name = "SpecBundleTooLargeError";
	}
}

/** `$ref` targets that are absolute URLs, which either intake can fetch. */
const ABSOLUTE_URL = /^https?:\/\//i;

/** One external document, once, however many refs point at it. */
interface BundledDoc {
	/** Canonical target - an absolute URL, or a path relative to the picked file. */
	key: string;
	/** Where refs *inside* this document resolve from. */
	base: DocumentBase;
	slug: string;
	value: unknown;
}

/** What a document's own relative refs are relative to. */
type DocumentBase = { kind: "url"; url: string } | { kind: "file"; dir: string } | { kind: "none" };

/**
 * Is this a document the bundler should even look at?
 *
 * Only the OpenAPI family uses `$ref` to name other files; a Postman or Insomnia
 * export has no such notion, and walking one to prove it would be work with a
 * guaranteed answer. This is the same discrimination `detect()` makes, kept
 * deliberately loose - a version string it does not recognise is still an
 * OpenAPI document with refs to resolve.
 */
function isOpenApiDocument(value: unknown): boolean {
	const record = asRecord(value);
	if (!record) return false;
	return typeof record.openapi === "string" || typeof record.swagger === "string";
}

/** Split `"./pets.yaml#/components/schemas/Pet"` into its file and its pointer. */
function splitRef(ref: string): { target: string; pointer: string } {
	const hash = ref.indexOf("#");
	if (hash < 0) return { target: ref, pointer: "" };
	return { target: ref.slice(0, hash), pointer: ref.slice(hash + 1) };
}

/**
 * Normalize a relative path against a directory, keeping `..` that cannot be
 * cancelled.
 *
 * A spec laid out as `spec/openapi.yaml` referencing `../shared/error.yaml` is
 * ordinary, so an escaping segment is preserved and handed to the main process,
 * which is where the gate lives. Collapsing it here would silently read a
 * different file than the document named.
 *
 * Exported for the batch layer (`batch.ts`), which resolves the same ref against
 * the same rules to find the file *inside the picked set* - a second normalizer
 * would be free to disagree with this one about `..`, and the two answers would
 * be two different files.
 */
export function joinRelative(dir: string, target: string): string {
	const out: string[] = [];
	for (const segment of [...dir.split("/"), ...target.split("/")]) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			const last = out[out.length - 1];
			if (out.length > 0 && last !== "..") out.pop();
			else out.push("..");
			continue;
		}
		out.push(segment);
	}
	return out.join("/");
}

/** The directory part of a normalized relative path (`""` for a top-level file). */
export function dirOf(relativePath: string): string {
	const cut = relativePath.lastIndexOf("/");
	return cut < 0 ? "" : relativePath.slice(0, cut);
}

/**
 * The canonical identity of a ref target, or `undefined` when this document has
 * no way to name it (a relative ref in a pasted spec).
 */
function resolveTarget(target: string, base: DocumentBase): BundledDoc["key"] | undefined {
	if (ABSOLUTE_URL.test(target)) {
		try {
			return new URL(target).toString();
		} catch {
			return undefined;
		}
	}
	if (base.kind === "url") {
		try {
			return new URL(target, base.url).toString();
		} catch {
			return undefined;
		}
	}
	if (base.kind === "file") return joinRelative(base.dir, target);
	return undefined;
}

/** Where refs inside a document that was loaded from @p key resolve from. */
function baseOf(key: string): DocumentBase {
	return ABSOLUTE_URL.test(key) ? { kind: "url", url: key } : { kind: "file", dir: dirOf(key) };
}

/**
 * FNV-1a, so two different targets with the same file name get different slugs.
 * A hash and not a counter: the slug has to depend on the target alone for the
 * output to be reproducible.
 */
function hash32(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * A JSON Pointer segment naming one bundled document: readable enough to
 * recognise in the stored text, and free of `/` and `~` so it needs no escaping.
 */
function slugFor(key: string): string {
	const tail = key.split(/[/\\]/).pop() || key;
	const readable = tail.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
	return `${readable}-${hash32(key)}`;
}

/** Every `$ref` string in a value, in document order. */
function collectRefs(value: unknown, found: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) collectRefs(item, found);
		return found;
	}
	const record = asRecord(value);
	if (!record) return found;
	const ref = asStr(record.$ref);
	if (ref) found.push(ref);
	for (const child of Object.values(record)) collectRefs(child, found);
	return found;
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Rewrite one document's refs for its new home.
 *
 * @param inBundle where this document now lives (`undefined` for the root), so
 * its own `#/...` refs follow it.
 */
function rewriteRefs(
	value: unknown,
	base: DocumentBase,
	loaded: Map<string, BundledDoc>,
	inBundle: string | undefined
): unknown {
	if (Array.isArray(value)) return value.map((item) => rewriteRefs(item, base, loaded, inBundle));
	const record = asRecord(value);
	if (!record) return value;

	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		if (key === "$ref" && typeof child === "string") {
			out[key] = rewriteRef(child, base, loaded, inBundle);
			continue;
		}
		out[key] = rewriteRefs(child, base, loaded, inBundle);
	}
	return out;
}

function rewriteRef(
	ref: string,
	base: DocumentBase,
	loaded: Map<string, BundledDoc>,
	inBundle: string | undefined
): string {
	const { target, pointer } = splitRef(ref);
	if (!target) {
		// In-document. Inside a bundled file that means *this file*, which now
		// lives one level down; in the root document it already points at itself.
		return inBundle ? bundledPointer(inBundle, pointer) : ref;
	}
	const key = resolveTarget(target, base);
	const doc = key ? loaded.get(key) : undefined;
	// An unresolved ref is left exactly as the document wrote it. It has already
	// been counted, and rewriting it would invent a location nothing is at.
	return doc ? bundledPointer(doc.slug, pointer) : ref;
}

/**
 * A pointer into one bundled document. Slugs carry no `/` or `~`, so no JSON
 * Pointer escaping is needed for the segment this adds.
 */
function bundledPointer(slug: string, pointer: string): string {
	const rest =
		pointer && pointer !== "/" ? (pointer.startsWith("/") ? pointer : `/${pointer}`) : "";
	return `#/${BUNDLE_KEY}/${slug}${rest}`;
}

/**
 * External refs this document names that nothing resolved - counted **per ref**,
 * because that is what the user lost: two operations pointing at the same
 * unreachable file are two operations that imported short.
 */
function countUnresolved(
	value: unknown,
	base: DocumentBase,
	loaded: Map<string, BundledDoc>
): number {
	let count = 0;
	for (const ref of collectRefs(value)) {
		const { target } = splitRef(ref);
		if (!target) continue;
		const key = resolveTarget(target, base);
		if (!key || !loaded.has(key)) count += 1;
	}
	return count;
}

/**
 * Resolve every external `$ref` a document names, transitively.
 *
 * Returns the input unchanged - byte for byte - when there was nothing external
 * to resolve, which is every single-file spec.
 *
 * @throws {SpecBundleTooLargeError} when the documents together exceed the
 * engine's cap. Every other failure (unreachable, unparseable, no intake for
 * this source) is counted into `unresolvedRefs` and leaves the ref as written.
 */
export async function bundleExternalRefs(
	raw: string,
	intake: ExternalRefIntake
): Promise<BundleResult> {
	let root: unknown;
	try {
		root = parseRaw(raw);
	} catch {
		// Not parseable at all - the format detector reports that, with a message
		// about the file rather than about its refs.
		return { text: raw, bundled: 0, unresolvedRefs: 0 };
	}
	if (!isOpenApiDocument(root)) return { text: raw, bundled: 0, unresolvedRefs: 0 };

	const rootBase: DocumentBase = intake.sourceUrl
		? { kind: "url", url: intake.sourceUrl }
		: intake.readSibling
			? { kind: "file", dir: "" }
			: { kind: "none" };

	const loaded = new Map<string, BundledDoc>();
	/** Targets already tried and refused, so a second ref does not retry them. */
	const failed = new Set<string>();
	/** Targets seen but not yet loaded, with the base that named them. */
	const pending: { key: string; base: DocumentBase }[] = [];
	let bytes = byteLength(raw);

	const enqueue = (value: unknown, base: DocumentBase): void => {
		for (const ref of collectRefs(value)) {
			const { target } = splitRef(ref);
			if (!target) continue;
			// A relative ref with nothing to be relative to - a pasted document -
			// resolves to no key at all, and is counted in the pass below.
			const key = resolveTarget(target, base);
			if (!key || failed.has(key) || loaded.has(key)) continue;
			if (!pending.some((p) => p.key === key)) pending.push({ key, base });
		}
	};

	enqueue(root, rootBase);

	// Breadth-first, one load per target however many refs name it. A document
	// already loaded is never re-enqueued, which is what terminates a cycle.
	while (pending.length > 0) {
		const next = pending.shift()!;
		const text = await loadTarget(next.key, intake);
		if (text === undefined) {
			failed.add(next.key);
			continue;
		}
		bytes += byteLength(text);
		if (bytes > intake.maxBytes) throw new SpecBundleTooLargeError(bytes, intake.maxBytes);

		let value: unknown;
		try {
			value = parseRaw(text);
		} catch {
			failed.add(next.key);
			continue;
		}
		const base = baseOf(next.key);
		loaded.set(next.key, { key: next.key, base, slug: slugFor(next.key), value });
		enqueue(value, base);
	}

	// Counted after loading, over every document in the bundle: a ref inside a
	// resolved file that names a fourth file nobody could reach is the same loss.
	let unresolvedRefs = countUnresolved(root, rootBase, loaded);
	for (const doc of loaded.values())
		unresolvedRefs += countUnresolved(doc.value, doc.base, loaded);

	if (loaded.size === 0) return { text: raw, bundled: 0, unresolvedRefs };

	// Sorted, so the same inputs always serialize to the same bytes - sync
	// compares hashes of this text.
	const bundle: Record<string, unknown> = {};
	for (const doc of [...loaded.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
		bundle[doc.slug] = rewriteRefs(doc.value, doc.base, loaded, doc.slug);
	}

	const rewritten = rewriteRefs(root, rootBase, loaded, undefined) as Record<string, unknown>;
	const text = JSON.stringify({ ...rewritten, [BUNDLE_KEY]: bundle }, null, 2);
	if (byteLength(text) > intake.maxBytes) {
		throw new SpecBundleTooLargeError(byteLength(text), intake.maxBytes);
	}
	return { text, bundled: loaded.size, unresolvedRefs };
}

/** The text at one target, or `undefined` when this import cannot reach it. */
async function loadTarget(key: string, intake: ExternalRefIntake): Promise<string | undefined> {
	try {
		if (ABSOLUTE_URL.test(key)) return await intake.fetchUrl?.(key);
		return await intake.readSibling?.(key);
	} catch {
		// Unreachable, refused by a gate, or over the engine's own cap. The count
		// is what the user sees; the reason belongs to the channel that refused.
		return undefined;
	}
}
