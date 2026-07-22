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

import type { Request, KeyValueEntry, RequestBody, RequestAuth } from "@/types";
import {
	DEFAULT_FOLLOW_REDIRECTS,
	DEFAULT_MAX_REDIRECTS,
	MAX_MAX_REDIRECTS,
	MIN_MAX_REDIRECTS,
} from "@/constants/request";

export type BackendRequest = Omit<Request, "createdAt" | "updatedAt"> & {
	createdAt: number | string;
	updatedAt: number | string;
};

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

export class RequestTransformer {
	static toFrontend(raw: Record<string, any>): Request {
		if (!raw.id) throw new Error("Request must have an id");

		// Params: array of KeyValueEntry (new) or legacy empty object {}
		const params: KeyValueEntry[] = Array.isArray(raw.params) ? raw.params : [];

		// Headers: array of KeyValueEntry (new) or legacy empty object {}
		const headers: KeyValueEntry[] = Array.isArray(raw.headers) ? raw.headers : [];

		// Body: discriminated union (new) or legacy string
		let body: RequestBody = { mode: "none" };
		if (raw.body && typeof raw.body === "object" && raw.body.mode) {
			body = raw.body as RequestBody;
		}

		// Auth: RequestAuth (new) or legacy object
		let auth: RequestAuth = { mode: "inherit" };
		if (raw.auth && typeof raw.auth === "object" && raw.auth.mode) {
			auth = raw.auth as RequestAuth;
		}

		return {
			id: raw.id,
			collectionId: raw.collectionId ?? "",
			name: raw.name ?? "",
			description: raw.description ?? "",
			method: raw.method ?? "GET",
			url: raw.url ?? "",
			params,
			headers,
			body,
			bodyType: raw.bodyType ?? body.mode ?? "none",
			auth,
			preRequestScript: raw.preRequestScript ?? "",
			postRequestScript: raw.postRequestScript ?? "",
			// Redirect policy: a request stored before these columns existed
			// comes back without them, and must read as the engine default
			// rather than as "do not follow" / "zero hops".
			followRedirects:
				typeof raw.followRedirects === "boolean"
					? raw.followRedirects
					: DEFAULT_FOLLOW_REDIRECTS,
			maxRedirects: clampMaxRedirects(raw.maxRedirects),
			order: raw.order ?? 0,
			createdAt: new Date(raw.createdAt).toISOString(),
			updatedAt: new Date(raw.updatedAt).toISOString(),
		};
	}
}
