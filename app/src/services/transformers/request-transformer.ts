/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Request Transformer
 *
 * Transforms backend request format to frontend domain Request type.
 * Handles timestamp conversion and provides safe defaults for new fields.
 */

import type {
	Request,
	BodyMode,
	HttpMethod,
	KeyValueEntry,
	RequestBody,
	RequestAuth,
} from "@/types";
import { asRecord, asStr } from "@/lib/json-node";
import {
	DEFAULT_FOLLOW_REDIRECTS,
	DEFAULT_HTTP_VERSION,
	DEFAULT_MAX_REDIRECTS,
	MAX_MAX_REDIRECTS,
	MIN_MAX_REDIRECTS,
	isHttpVersion,
	type HttpVersion,
} from "@/constants/request";

export type BackendRequest = Omit<Request, "createdAt" | "updatedAt"> & {
	createdAt: number | string;
	updatedAt: number | string;
};

/**
 * A request row as the engine sends it. Typed as a bag of unknowns rather than
 * as `Request`: the wire row carries numeric timestamps and may predate a
 * column, which is exactly what this transformer exists to reconcile.
 */
export type RawRequest = Record<string, unknown>;

/**
 * Coerce a raw `maxRedirects` into the range the Settings tab offers. Anything
 * missing or non-numeric falls back to the engine default; a stored value
 * outside the range is clamped rather than dropped, matching what the engine
 * does with the same payload.
 */
function clampMaxRedirects(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_REDIRECTS;
	return Math.min(MAX_MAX_REDIRECTS, Math.max(MIN_MAX_REDIRECTS, Math.trunc(raw)));
}

/**
 * Coerce a raw `httpVersion` into a value the app knows how to render. A row
 * saved before this column existed comes back without it, and a row written
 * by a newer engine version (or a corrupted one) can carry a protocol this
 * build has never heard of - both must read as the engine default rather than
 * as `undefined`, which the Settings tab picker can't select.
 */
function coerceHttpVersion(raw: unknown): HttpVersion {
	return isHttpVersion(raw) ? raw : DEFAULT_HTTP_VERSION;
}

export class RequestTransformer {
	static toFrontend(raw: RawRequest): Request {
		const id = asStr(raw.id);
		if (!id) throw new Error("Request must have an id");

		// Params: array of KeyValueEntry (new) or legacy empty object {}
		const params: KeyValueEntry[] = Array.isArray(raw.params)
			? (raw.params as KeyValueEntry[])
			: [];

		// Headers: array of KeyValueEntry (new) or legacy empty object {}
		const headers: KeyValueEntry[] = Array.isArray(raw.headers)
			? (raw.headers as KeyValueEntry[])
			: [];

		// Body: discriminated union (new) or legacy string
		let body: RequestBody = { mode: "none" };
		const rawBody = asRecord(raw.body);
		if (rawBody?.mode) body = rawBody as RequestBody;

		// Auth: RequestAuth (new) or legacy object
		let auth: RequestAuth = { mode: "inherit" };
		const rawAuth = asRecord(raw.auth);
		if (rawAuth?.mode) auth = rawAuth as RequestAuth;

		return {
			id,
			collectionId: asStr(raw.collectionId) ?? "",
			name: asStr(raw.name) ?? "",
			description: asStr(raw.description) ?? "",
			method: (asStr(raw.method) as HttpMethod) ?? "GET",
			url: asStr(raw.url) ?? "",
			params,
			headers,
			body,
			bodyType: (asStr(raw.bodyType) as BodyMode) ?? body.mode ?? "none",
			auth,
			preRequestScript: asStr(raw.preRequestScript) ?? "",
			postRequestScript: asStr(raw.postRequestScript) ?? "",
			// Redirect policy: a request stored before these columns existed
			// comes back without them, and must read as the engine default
			// rather than as "do not follow" / "zero hops".
			followRedirects:
				typeof raw.followRedirects === "boolean"
					? raw.followRedirects
					: DEFAULT_FOLLOW_REDIRECTS,
			maxRedirects: clampMaxRedirects(raw.maxRedirects),
			// HTTP protocol: a row stored before this column existed, or one
			// carrying a value this build doesn't recognise, reads as the
			// engine default rather than as an unselectable value.
			httpVersion: coerceHttpVersion(raw.httpVersion),
			order: typeof raw.order === "number" ? raw.order : 0,
			createdAt: new Date(raw.createdAt as string | number).toISOString(),
			updatedAt: new Date(raw.updatedAt as string | number).toISOString(),
		};
	}
}
