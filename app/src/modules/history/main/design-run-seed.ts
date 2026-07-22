/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turn a stored design run into starting values for the request builder.
 *
 * Pure on purpose: no hooks, no queries, no store. The view that renders it
 * then has nothing to prove but rendering.
 *
 * Three sources, each for what only it has:
 *
 *   configSnapshot    the payload that was sent
 *   result.trace      what went out, after the engine applied auth
 *   the live request  credentials, which are never stored - the engine's
 *                     sanitize_config_snapshot keeps only the auth mode
 */

import type { Run, Request, ScriptPart, KeyValueEntry } from "@/types";
import type { RequestState } from "@/modules/request-builder/types";
import { authToEditor } from "@/modules/request-builder/utils/auth-mapping";
import { toKeyValueItems } from "@/modules/request-builder/utils/key-value";
import { parseQueryParams } from "@/modules/request-builder/utils/url";
import { createDefaultRequestState } from "@/modules/request-builder/utils/request-state";
import { DEFAULT_FOLLOW_REDIRECTS, DEFAULT_MAX_REDIRECTS } from "@/constants/request";

/** The part of a design run's snapshot this reads. */
interface DesignSnapshot {
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: { mode?: string; content?: string; fields?: KeyValueEntry[] };
	auth?: { mode?: string };
	preRequestScripts?: ScriptPart[];
	postRequestScripts?: ScriptPart[];
	preRequestScript?: string;
	postRequestScript?: string;
	followRedirects?: boolean;
	maxRedirects?: number;
}

export interface DesignRunSeed {
	/** Starting values. `id` is null, and that is what detaches the copy. */
	request: Partial<RequestState>;
	/**
	 * Collection parts, to show read-only next to the request's own and to
	 * replay unchanged.
	 *
	 * Split by which hook they run on, not merged: `ScriptPart` records where a
	 * part came from but not when it runs, so a single list cannot be filtered
	 * back apart. Merging them would replay the collection's *test* scripts as
	 * *pre-request* scripts, and would show every part under both labels.
	 */
	collectionPreScripts: ScriptPart[];
	collectionPostScripts: ScriptPart[];
	/** Set only for a run stored before script parts existed. */
	legacyPreScript?: string;
	legacyPostScript?: string;
}

function toHeaderItems(headers: Record<string, string> | undefined) {
	return toKeyValueItems(
		Object.entries(headers ?? {}).map(([key, value]) => ({
			key,
			value,
			enabled: true,
		}))
	);
}

/** The request's own part, or "" when the run predates script parts. */
function ownScript(parts: ScriptPart[] | undefined): string {
	return parts?.find((p) => p.origin === "request")?.script ?? "";
}

/** The chain's parts, in recorded order, without the request's own. */
function collectionParts(parts: ScriptPart[] | undefined): ScriptPart[] {
	return (parts ?? []).filter((p) => p.origin === "collection");
}

export function seedFromRun(run: Run, liveRequest?: Request | null): DesignRunSeed {
	const snapshot = (run.configSnapshot ?? {}) as DesignSnapshot;
	const trace = run.result?.trace;

	/*
	 * Headers and auth move together. With a live request we show its current
	 * auth, because that is what a fresh resolution will send, and the snapshot
	 * headers hold no credential. Without one there is nothing to resolve, so
	 * the wire headers are used as they are - the recorded Authorization
	 * included - and the copy replays exactly what ran.
	 */
	const headers = liveRequest
		? toHeaderItems(snapshot.headers)
		: toHeaderItems(trace?.request?.headers);
	const auth = liveRequest
		? authToEditor(liveRequest.auth)
		: { authType: "none" as const, authConfig: {} };

	const body = snapshot.body;
	const bodyMode = (body?.mode ?? "none") as RequestState["bodyMode"];

	return {
		request: {
			...createDefaultRequestState(),
			id: null,
			collectionId: null,
			method: (snapshot.method ?? "GET") as RequestState["method"],
			url: snapshot.url ?? "",
			params: parseQueryParams(snapshot.url ?? ""),
			headers,
			bodyMode,
			body: body?.content ?? "",
			formData: toKeyValueItems(bodyMode === "form-data" ? (body?.fields ?? []) : []),
			urlEncoded: toKeyValueItems(
				bodyMode === "x-www-form-urlencoded" ? (body?.fields ?? []) : []
			),
			authType: auth.authType,
			authConfig: auth.authConfig,
			preRequestScript: ownScript(snapshot.preRequestScripts),
			testScript: ownScript(snapshot.postRequestScripts),
			followRedirects: snapshot.followRedirects ?? DEFAULT_FOLLOW_REDIRECTS,
			maxRedirects: snapshot.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
		},
		collectionPreScripts: collectionParts(snapshot.preRequestScripts),
		collectionPostScripts: collectionParts(snapshot.postRequestScripts),
		legacyPreScript: snapshot.preRequestScripts ? undefined : snapshot.preRequestScript,
		legacyPostScript: snapshot.postRequestScripts ? undefined : snapshot.postRequestScript,
	};
}
