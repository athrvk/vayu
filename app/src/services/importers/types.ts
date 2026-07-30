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

/** A request body skipped because Vayu can't represent it (file/binary, ws, grpc, etc.). */
export interface SkippedItem {
	kind: "websocket" | "grpc" | "api_spec" | "unit_test" | "file_body";
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
	/**
	 * Follow 3xx `Location` responses. Absent means "leave the engine's default",
	 * which is `true` - so a parser sets this only when the source file states it.
	 * Sending an omitted `false` as `true` would follow a redirect the user turned
	 * off; sending an absent value as `false` would stop one they never touched.
	 */
	followRedirects?: boolean;
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
