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
 * Something the parse had to drop: a resource Vayu can't represent (ws, grpc, a
 * file/binary body), an operation whose HTTP method it has no `HttpMethod` for
 * (`unsupported_method` - OpenAPI 3's `trace`), or a shape the parser stepped over
 * to keep the rest of the file importable (`malformed_spec`).
 */
export interface SkippedItem {
	kind:
		| "websocket"
		| "grpc"
		| "api_spec"
		| "unit_test"
		| "file_body"
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
