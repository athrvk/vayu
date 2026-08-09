/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { HttpMethod, KeyValueEntry, RequestBody, RequestAuth, VariableValue } from "@/types";

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
		| "malformed_spec";
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
