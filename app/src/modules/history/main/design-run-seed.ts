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

import type {
	Run,
	Request,
	RequestAuth,
	ScriptPart,
	ElementDef,
	KeyValueEntry,
	FileRef,
} from "@/types";
import type { RequestState } from "@/modules/request-builder/types";
import { toKeyValueItems } from "@/components/shared/KeyValueEditor/key-value";
import { parseQueryParams } from "@/modules/request-builder/utils/url";
import { pathRowsFromUrl, pathRowsOf } from "@/modules/request-builder/utils/path-variables";
import { generateId } from "@/lib/id";
import { sentBodyFileOf, type SentBodyFile } from "@/lib/sent-body-file";
import { createDefaultRequestState } from "@/modules/request-builder/utils/request-state";
import { isLegacyManagedHeader } from "@/modules/request-builder/utils/system-headers";
import {
	DEFAULT_DISABLE_COOKIES,
	DEFAULT_DISABLE_URL_ENCODING,
	DEFAULT_FOLLOW_REDIRECTS,
	DEFAULT_HTTP_VERSION,
	DEFAULT_MAX_REDIRECTS,
	DEFAULT_VERIFY_SSL,
	isHttpVersion,
} from "@/constants/request";

/** The part of a design run's snapshot this reads. */
interface DesignSnapshot {
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	/**
	 * The path rows composition could not write into `url` (issue #1764): a
	 * value still holding a token, left at `:name` for the send to answer.
	 * Absent when every `:name` was written, which is the usual case.
	 */
	params?: KeyValueEntry[];
	body?: {
		mode?: string;
		content?: string;
		fields?: KeyValueEntry[];
		/** A `binary` body's file. Read defensively: the snapshot is not typed engine-side. */
		file?: unknown;
		/** Set by `sanitize_config_snapshot` when `content` exceeded `maxTraceBodyBytes`. */
		bodyTruncated?: boolean;
		/** The body's original byte length, present only when truncated. */
		bodyBytes?: number;
	};
	auth?: { mode?: string };
	preRequestScripts?: ScriptPart[];
	postRequestScripts?: ScriptPart[];
	preRequestScript?: string;
	postRequestScript?: string;
	followRedirects?: boolean;
	maxRedirects?: number;
	httpVersion?: string;
	verifySSL?: boolean;
	disableCookies?: boolean;
	disabledSystemHeaders?: unknown;
	disableUrlEncoding?: boolean;
	/** The `headers` names the body mode wrote (issue #1765). */
	bodyModeHeaders?: unknown;
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
	/**
	 * The auth mode this run actually sent, from the snapshot. Only the *mode*
	 * survives storage (`sanitize_config_snapshot` strips the credential), so
	 * this is all there is - but shown read-only next to the live request's
	 * current auth it answers "did the request's auth change since this ran?",
	 * which the editor alone cannot, because the editor shows the *current*
	 * mode. `undefined` when the run recorded no auth (mode "none" or absent).
	 */
	recordedAuthMode?: string;
	/**
	 * True when the engine truncated this run's stored request body
	 * (`maxTraceBodyBytes`), on the trace or on the config snapshot itself -
	 * both are capped at the same limit. "Save to request" must
	 * not write a possibly-incomplete body back - see {@link applyRunToRequest}.
	 */
	requestBodyTruncated?: boolean;
	/**
	 * What a `binary` body sent, as the engine recorded it at send time:
	 * the file's name, its size and its sha256 - never its bytes, and never
	 * its path. Read off the trace's request node (`request.bodyFile`), and
	 * absent for every other body and for a run stored before the field.
	 */
	requestBodyFile?: SentBodyFile;
}

/** A snapshot body's `file` as an editor `FileRef`, or an empty one. */
function fileRefOf(node: unknown): FileRef {
	if (!node || typeof node !== "object") return { src: "" };
	const raw = node as Record<string, unknown>;
	const file: FileRef = { src: typeof raw.src === "string" ? raw.src : "" };
	if (typeof raw.fileName === "string" && raw.fileName) file.fileName = raw.fileName;
	if (typeof raw.contentType === "string" && raw.contentType) file.contentType = raw.contentType;
	if (raw.unresolved === true) file.unresolved = true;
	return file;
}

/**
 * A run's recorded headers as editor rows, minus the ones a pre-#1229 client
 * put on the wire itself.
 *
 * A run row is the one place those survive the engine's startup repair, which
 * rewrites stored *requests* and never traces - so without this a replay of an
 * old run would seed the copy with that run's frozen `X-Request-ID` and the
 * version string of the day it ran, and send both again as ordinary user
 * headers. Same rule as the request loader's, from the same definition.
 */
function toHeaderItems(headers: Record<string, string> | undefined, bodyMode: unknown = []) {
	// The run's `bodyModeHeaders` (issue #1765) put back on their rows, so the
	// replay tells the engine the same thing the recorded Send did: these are
	// the body mode's own, which a `content-type` opt-out removes.
	const marked = new Set(Array.isArray(bodyMode) ? bodyMode : []);
	return toKeyValueItems(
		Object.entries(headers ?? {})
			.filter(([key, value]) => !isLegacyManagedHeader(key, value))
			.map(([key, value]) => ({
				key,
				value,
				enabled: true,
				...(marked.has(key) ? { source: "body-mode" as const } : {}),
			}))
	);
}

/**
 * The copy's Params rows: the URL's query, then the path rows the run sent.
 *
 * A `:name` still in the recorded URL is one composition left for the send to
 * answer (its value held a token), and the value is in the snapshot's own
 * `params`, not in the URL - so a copy seeded from the URL alone would replay
 * `:name` literally, and "Save to request" would blank the row. A name the
 * snapshot has no row for (a run recorded before #1764) gets an empty one.
 */
function paramsFromSnapshot(snapshot: DesignSnapshot) {
	const url = snapshot.url ?? "";
	const recorded = pathRowsOf(Array.isArray(snapshot.params) ? snapshot.params : []).map(
		(row) => ({ ...row, id: generateId() })
	);
	const held = new Set(recorded.map((row) => row.key));
	return [
		...parseQueryParams(url),
		...recorded,
		...pathRowsFromUrl(url).filter((row) => !held.has(row.key)),
	];
}

/** The request's own part, or "" when the run predates script parts. */
function ownScript(parts: ScriptPart[] | undefined): string {
	return parts?.find((p) => p.origin === "request")?.script ?? "";
}

/** The chain's parts, in recorded order, without the request's own. */
function collectionParts(parts: ScriptPart[] | undefined): ScriptPart[] {
	return (parts ?? []).filter((p) => p.origin === "collection");
}

/**
 * A recorded script part as a `script.pre` / `script.post` element (issue
 * #1512), so a run's historical parts can ride the same `elements` wire field
 * a replay now sends - see `DesignRunView.tsx`'s `handleExecute`. Only the
 * script text and origin survive a stored run; `enabled` is always true,
 * since a disabled element was never recorded as a part in the first place.
 */
export function scriptPartToElement(
	part: ScriptPart,
	kind: "script.pre" | "script.post"
): ElementDef {
	return {
		id: part.id ? `${part.id}-${kind}` : `legacy-${kind}`,
		kind,
		enabled: true,
		...(part.name ? { name: part.name } : {}),
		config: { script: part.script },
	};
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
		? toHeaderItems(snapshot.headers, snapshot.bodyModeHeaders)
		: toHeaderItems(trace?.request?.headers);
	const auth: RequestAuth = liveRequest ? liveRequest.auth : { mode: "none" };

	const body = snapshot.body;
	const bodyMode = (body?.mode ?? "none") as RequestState["bodyMode"];

	return {
		request: {
			...createDefaultRequestState(),
			id: null,
			collectionId: null,
			method: (snapshot.method ?? "GET") as RequestState["method"],
			url: snapshot.url ?? "",
			params: paramsFromSnapshot(snapshot),
			headers,
			bodyMode,
			body: body?.content ?? "",
			formData: toKeyValueItems(bodyMode === "form-data" ? (body?.fields ?? []) : []),
			urlEncoded: toKeyValueItems(
				bodyMode === "x-www-form-urlencoded" ? (body?.fields ?? []) : []
			),
			binaryFile: bodyMode === "binary" ? fileRefOf(body?.file) : { src: "" },
			auth,
			elements: [
				...(ownScript(snapshot.preRequestScripts).trim()
					? [
							{
								id: "seed-script-pre",
								kind: "script.pre",
								enabled: true,
								config: { script: ownScript(snapshot.preRequestScripts) },
							} satisfies ElementDef,
						]
					: []),
				...(ownScript(snapshot.postRequestScripts).trim()
					? [
							{
								id: "seed-script-post",
								kind: "script.post",
								enabled: true,
								config: { script: ownScript(snapshot.postRequestScripts) },
							} satisfies ElementDef,
						]
					: []),
			],
			followRedirects: snapshot.followRedirects ?? DEFAULT_FOLLOW_REDIRECTS,
			maxRedirects: snapshot.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
			httpVersion: isHttpVersion(snapshot.httpVersion)
				? snapshot.httpVersion
				: DEFAULT_HTTP_VERSION,
			// A run recorded before the field was sent has no key, and reads as
			// verifying - the same direction every other default here takes,
			// and the only safe one for this field.
			verifySSL: snapshot.verifySSL ?? DEFAULT_VERIFY_SSL,
			// Postman's protocol switches (issue #1765), same direction: a run
			// recorded before they existed used the jar, encoded its URL and
			// suppressed no automatic header.
			disableCookies: snapshot.disableCookies ?? DEFAULT_DISABLE_COOKIES,
			disabledSystemHeaders: Array.isArray(snapshot.disabledSystemHeaders)
				? (snapshot.disabledSystemHeaders as unknown[]).filter(
						(name): name is string => typeof name === "string"
					)
				: [],
			disableUrlEncoding: snapshot.disableUrlEncoding ?? DEFAULT_DISABLE_URL_ENCODING,
		},
		collectionPreScripts: collectionParts(snapshot.preRequestScripts),
		collectionPostScripts: collectionParts(snapshot.postRequestScripts),
		legacyPreScript: snapshot.preRequestScripts ? undefined : snapshot.preRequestScript,
		legacyPostScript: snapshot.postRequestScripts ? undefined : snapshot.postRequestScript,
		// "none" carries no information the absence would not, so normalise it away.
		recordedAuthMode:
			snapshot.auth?.mode && snapshot.auth.mode !== "none" ? snapshot.auth.mode : undefined,
		// Only surfaces `true`; an untruncated run leaves it undefined. Either
		// source cutting the body is enough - the trace and the config snapshot
		// are capped independently, at the same limit.
		requestBodyTruncated:
			trace?.request?.bodyTruncated || body?.bodyTruncated ? true : undefined,
		requestBodyFile: sentBodyFileOf(trace?.request?.bodyFile),
	};
}
