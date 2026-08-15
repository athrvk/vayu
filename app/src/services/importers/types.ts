/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type {
	HttpMethod,
	KeyValueEntry,
	RequestBody,
	RequestAuth,
	SpecOperation,
	VariableValue,
} from "@/types";

export interface ImportOptions {
	importEnvironments: boolean;
	importScripts: boolean;
}

/**
 * Something the parser could not import. Mostly a resource or body Vayu can't
 * represent (file/binary, ws, grpc). Three are not about representability:
 * `unsupported_method` is an operation whose HTTP method has no `HttpMethod`
 * (OpenAPI 3's `trace`), and `malformed_item` / `malformed_spec` are shapes the
 * source file got wrong - a Postman `item[]` entry that is not an object (see
 * `pmFolder`), an OpenAPI path item or `parameters` list that is not what the
 * spec allows - which are stepped over rather than allowed to abort the file.
 */
export interface SkippedItem {
	kind:
		| "websocket"
		| "grpc"
		| "api_spec"
		| "unit_test"
		| "file_body"
		| "malformed_item"
		| "unsupported_method"
		| "malformed_spec"
		/**
		 * An OpenAPI response whose key is not a numeric status - `default`, or a
		 * `2XX` wildcard. It documents a real response, but a saved example is
		 * served under one status line and there is no honest value to pick, so it
		 * is dropped and counted rather than guessed at (issue #481).
		 */
		| "example_no_status"
		/**
		 * A `$ref` naming a file the import could not reach - unfetchable,
		 * unparseable, or relative in a pasted document that has no directory and
		 * no URL to be relative to (issue #649). Counted per ref, because each one
		 * is an operation that imported without the schema it declared. Not
		 * produced by a parser: bundling runs before parse and hands its count to
		 * the factory, which is also why it is the one kind that says nothing about
		 * Vayu's own representability.
		 */
		| "external_ref";
	count: number;
}

export interface ImportMeta {
	format: string;
	fileName?: string;
	requestCount: number;
	folderCount: number;
	environmentCount: number;
	/** Variables destined for Vayu's globals scope. Only a Postman globals export produces any. */
	globalCount: number;
	/**
	 * Saved example responses found across every request (issue #481). Required
	 * rather than optional so each parser states its answer - a format with no
	 * examples reports 0, which is different from a parser that forgot to look.
	 * Shown in the import preview beside the request and folder counts.
	 */
	exampleCount: number;
	// TODO: populated by parsers so the Preview can warn the user about lossy imports.
	// Vayu is HTTP-only and has no OAuth execution path; WebSocket/gRPC are dropped and
	// oauth2/digest/aws/ntlm auth is stored-but-not-executed. Surface both rather than
	// letting items silently vanish. See ImportModal Preview state.
	skipped: SkippedItem[];
	nonExecutableAuth: number;
	/**
	 * Form-data file parts that arrived without a file to send. An OpenAPI spec
	 * documents that a field is an upload and never which file it uploads, so the
	 * row imports complete-but-empty and the user attaches the file. Surfaced in
	 * the preview beside the skip counters: a row the user must finish is honest,
	 * a field that looks filled in and sends nothing is the defect (#425).
	 * Required rather than optional so every parser states its answer - all of
	 * them get it from `unattachedFileParts`, which reads the drafts.
	 */
	unattachedFileParts: number;
}

/**
 * A saved example response found next to a request in the source file (issue
 * #481) - Postman's `item.response[]`, an OpenAPI operation's `responses`.
 *
 * Until the engine had somewhere to keep these, every parser dropped them
 * without even counting the loss. They carry no id: the engine assigns one when
 * the import is applied, and nothing in the payload references an example.
 */
export interface ExampleDraft {
	name: string;
	/** The status the example documents. Sources that state none import as 200. */
	status: number;
	/** Response headers, in source order and with duplicates intact (`Set-Cookie`). */
	headers: KeyValueEntry[];
	body: string;
	/**
	 * Denormalized from `headers` when the source states a content type, so a
	 * viewer can pick a renderer without re-scanning the header list. `""` when
	 * the source says nothing - not a guess.
	 */
	contentType: string;
}

export interface RequestDraft {
	tempId?: string; // assigned by assign-ids pre-pass; opaque, never stored
	name: string;
	description: string;
	method: HttpMethod;
	url: string;
	params: KeyValueEntry[];
	headers: KeyValueEntry[];
	body: RequestBody;
	auth: RequestAuth; // "inherit" allowed; resolved at execution
	preRequestScript: string;
	postRequestScript: string;
	/**
	 * Per-request redirect settings, when the source states them (Postman's
	 * item-level `protocolProfileBehavior`; Insomnia's `settingFollowRedirects`,
	 * which has no limit to go with it). Absent means "engine default" -
	 * `followRedirects: true`, `maxRedirects: 10` - which is why they are optional
	 * rather than defaulted here: a parser that says nothing must not look like a
	 * parser that said `true`.
	 */
	followRedirects?: boolean;
	maxRedirects?: number;
	/**
	 * Saved example responses, in the order the source listed them - which the
	 * engine stores as their `order`, because "the first example" is what a mock
	 * server will answer with. Optional: a parser that has no concept of
	 * examples must not look like one that found none.
	 */
	examples?: ExampleDraft[];
	/**
	 * Which operation of the source spec this request is (issue #637). Only the
	 * OpenAPI parsers set it - every other format describes requests, not a
	 * contract, and a `specOperation` invented for a Postman item would be an
	 * identity a re-fetch could never match.
	 */
	specOperation?: SpecOperation;
}

/**
 * The spec document an import was parsed from, carried on the root collection so
 * it can be stored and bound in the same `POST /import/apply` (issue #637).
 *
 * The **document**, verbatim, not a re-serialization of the parse: the engine
 * hashes what it stores and a re-fetch is diffed against those bytes, so a
 * round-trip through `JSON.parse` would make every YAML spec drift on its first
 * sync.
 *
 * One exception, and only one: a document that referenced other files carries
 * the **bundle** those were inlined into (issue #649). There is no verbatim text
 * for a spec that is several files, and storing the entry file alone would store
 * a document naming files nothing downstream can reach. Bundling is
 * deterministic, so the hash is still stable across re-fetches; a single-file
 * spec is untouched.
 */
export interface SpecDraft {
	tempId?: string; // assigned by assign-ids pre-pass; opaque, never stored
	content: string;
	/** Set only for a URL-sourced import - a file or a paste has no URL to re-fetch. */
	sourceUrl?: string;
}

export interface CollectionDraft {
	tempId?: string; // assigned by assign-ids pre-pass; opaque, never stored
	name: string;
	description: string;
	variables: Record<string, VariableValue>;
	auth: Exclude<RequestAuth, { mode: "inherit" }>; // collections never inherit
	preRequestScript: string;
	postRequestScript: string;
	children: CollectionDraft[];
	requests: RequestDraft[];
	/**
	 * The spec this collection was imported from, on the root only (issue #637).
	 * A tag sub-collection is part of the same document, not a document of its
	 * own, so binding it too would store the spec once per tag.
	 */
	spec?: SpecDraft;
}

export interface EnvironmentDraft {
	tempId?: string; // assigned by assign-ids pre-pass; opaque, never stored
	name: string;
	description: string;
	variables: Record<string, VariableValue>;
}

export interface ImportResult {
	collections: CollectionDraft[]; // roots (parentId = null)
	environments: EnvironmentDraft[];
	/**
	 * Variables for Vayu's globals scope, keyed by name. Not a draft list like the
	 * two above: globals are a singleton on the engine (`POST /globals` replaces the
	 * whole set), so there is nothing to name and no id to assign. Required rather
	 * than optional so every parser states its answer - `{}` for all but the Postman
	 * globals export.
	 */
	globals: Record<string, VariableValue>;
	meta: ImportMeta;
}

export interface ImportParser {
	readonly formatName: string; // "Postman Collection v2.1"
	readonly formatKey: string; // "postman-v21"
	// Factory parses raw once (JSON, then YAML fallback) and passes the parsed object.
	// Conscious divergence from the PRD's detect(raw: string).
	detect(parsed: unknown, raw: string): boolean;
	parse(parsed: unknown, raw: string, opts: ImportOptions): ImportResult;
}

export class UnrecognisedFormatError extends Error {
	constructor() {
		super("Unrecognised format");
		this.name = "UnrecognisedFormatError";
	}
}
