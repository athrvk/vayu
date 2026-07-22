/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file resolve.ts
 * @brief Request-composition pipeline for the MCP layer.
 *
 * When the Vayu app sends a request, the **renderer** - not the engine - does
 * the preparation: it resolves `{{variables}}`, walks the collection ancestor
 * chain to resolve `inherit` auth, and composes the collection-chain pre/post
 * scripts with the request's own. The engine only *applies* a concrete `auth`
 * block (bearer/basic/apikey/oauth2, incl. the OAuth2 token cache) and *runs*
 * whatever script strings arrive in the body; it performs **no** `{{var}}`
 * interpolation and explicitly drops `{"mode":"inherit"}` auth as
 * "resolved app-side" (see engine `auth_resolver.cpp::parse_auth`).
 *
 * MCP talks to the engine directly, bypassing the renderer, so without this
 * module MCP requests would ship unresolved `{{vars}}`, no auth, and no scripts.
 * This module is the main-process counterpart of the renderer pipeline
 * (`useVariableResolver.ts` + `request-builder/index.tsx` +
 * `utils/auth-mapping.ts`); the two must stay in agreement on precedence and
 * `inherit`/script semantics. Everything here is pure and transport-agnostic
 * except {@link loadResolutionContext}, which reads the data it needs via the
 * engine client.
 *
 * Shapes mirror the engine's camelCase JSON (see docs/engine/db-schema.md).
 */

import type { EngineClient } from "./engine-client.js";

// --- Engine JSON shapes (loose; validated defensively) -----------------------

/** One variable as stored in an environment / collection / globals blob. */
export interface VariableValue {
	value?: string;
	enabled?: boolean;
	secret?: boolean;
	type?: string;
}

/** `Record<name, VariableValue>` - the shape of every `variables` field. */
export type VariableBag = Record<string, VariableValue>;

/** A `params`/`headers` row as the engine serializes it. */
export interface KeyValueEntry {
	key: string;
	value: string;
	enabled?: boolean;
}

/** Request/collection body discriminated union (only the fields we forward). */
export interface RequestBodyLike {
	mode?: string;
	content?: string;
	fields?: KeyValueEntry[];
}

/** An auth block as stored/forwarded (discriminated by `mode`). */
export type AuthRecord = Record<string, unknown> & { mode?: string };

/** A collection row (`GET /collections`). Collections never store `inherit`. */
export interface CollectionLike {
	id: string;
	parentId?: string | null;
	variables?: VariableBag;
	auth?: AuthRecord;
	preRequestScript?: string;
	postRequestScript?: string;
}

/** A saved request row (`GET /requests?collectionId=`). */
export interface SavedRequestLike {
	id?: string;
	collectionId?: string;
	name?: string;
	method?: string;
	url?: string;
	headers?: KeyValueEntry[];
	body?: RequestBodyLike;
	/** Defaults to `{"mode":"inherit"}` server-side when absent. */
	auth?: AuthRecord;
	preRequestScript?: string;
	postRequestScript?: string;
	/** Redirect policy. Absent on rows saved before the columns existed. */
	followRedirects?: boolean;
	maxRedirects?: number;
}

/** The fully-composed body the engine's `POST /request` and `/run` accept. */
export interface OutgoingRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: RequestBodyLike;
	auth?: AuthRecord;
	preRequestScript?: string;
	postRequestScript?: string;
	followRedirects?: boolean;
	maxRedirects?: number;
	requestId?: string;
	environmentId?: string;
}

// --- Variable resolution -----------------------------------------------------

/**
 * Matches `{{name}}` (no nested braces), same as the renderer's pattern. A
 * single global-flagged RegExp is reused via `.replace`, which resets lastIndex
 * per call, so it is safe to share.
 */
const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

/** Read a `variables` blob into an enabled-only `name -> value` map. */
function collectEnabled(bag: VariableBag | undefined, into: Map<string, string>): void {
	if (!bag || typeof bag !== "object") return;
	for (const [name, raw] of Object.entries(bag)) {
		if (raw && typeof raw === "object" && raw.enabled !== false) {
			into.set(name, typeof raw.value === "string" ? raw.value : String(raw.value ?? ""));
		}
	}
}

/**
 * Build the effective variable map with the app's precedence (highest wins):
 * environment > collection chain (leaf over root) > globals. Only enabled
 * variables participate. The chain is passed root-first so later (leaf) entries
 * overwrite earlier (root) ones.
 */
export function buildVariableMap(input: {
	globals?: VariableBag;
	chain?: CollectionLike[];
	environment?: VariableBag;
}): Map<string, string> {
	const map = new Map<string, string>();
	collectEnabled(input.globals, map); // 1. globals (lowest)
	for (const col of input.chain ?? []) collectEnabled(col.variables, map); // 2. chain root→leaf
	collectEnabled(input.environment, map); // 3. environment (highest)
	return map;
}

export interface Resolver {
	/** Substitute `{{var}}` in a string; unknown variables become "" (renderer parity). */
	resolveString: (input: string) => string;
	/** Deep-resolve every string in a value, preserving structure. */
	resolveObject: <T>(value: T) => T;
}

/** Build a {@link Resolver} over a variable map. */
export function makeResolver(vars: Map<string, string>): Resolver {
	const resolveString = (input: string): string => {
		if (typeof input !== "string" || input.length === 0) return input;
		return input.replace(VARIABLE_PATTERN, (_m, name: string) => vars.get(name.trim()) ?? "");
	};
	const resolveObject = <T>(value: T): T => {
		if (typeof value === "string") return resolveString(value) as unknown as T;
		if (Array.isArray(value)) return value.map((v) => resolveObject(v)) as unknown as T;
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				out[k] = resolveObject(v);
			}
			return out as T;
		}
		return value;
	};
	return { resolveString, resolveObject };
}

// --- Collection chain --------------------------------------------------------

/**
 * Build the root-first ancestor chain for a collection (inclusive of the
 * collection itself). Mirrors the renderer's `buildCollectionChain`; guards
 * against cycles so a corrupted `parentId` link cannot loop forever.
 */
export function buildCollectionChain(
	startId: string | undefined,
	collections: CollectionLike[]
): CollectionLike[] {
	const chain: CollectionLike[] = [];
	if (!startId) return chain;
	const byId = new Map(collections.map((c) => [c.id, c]));
	const seen = new Set<string>();
	let currentId: string | undefined = startId;
	while (currentId && !seen.has(currentId)) {
		seen.add(currentId);
		const col = byId.get(currentId);
		if (!col) break;
		chain.unshift(col); // root ends up first
		currentId = col.parentId ?? undefined;
	}
	return chain;
}

// --- Auth composition --------------------------------------------------------

/** True for auth blocks that carry no credential (nothing to forward). */
function isEmptyAuth(auth: AuthRecord | undefined): boolean {
	return !auth || !auth.mode || auth.mode === "none";
}

/**
 * The effective auth for a request, resolved to a concrete block the engine can
 * apply, or `undefined` for no auth. `inherit` walks the ancestor chain
 * leaf→root and takes the first collection with concrete auth (collections are
 * always concrete auth sources - they never store `inherit`). Variables inside
 * the chosen block (e.g. `{{token}}`, an OAuth2 `config`) are resolved.
 */
export function composeAuth(
	requestAuth: AuthRecord | undefined,
	chain: CollectionLike[],
	resolver: Resolver
): AuthRecord | undefined {
	// A saved request with no auth field defaults to `inherit` server-side.
	const auth: AuthRecord = requestAuth ?? { mode: "inherit" };

	let effective: AuthRecord | undefined;
	if (auth.mode === "inherit") {
		for (let i = chain.length - 1; i >= 0; i--) {
			if (!isEmptyAuth(chain[i].auth)) {
				effective = chain[i].auth;
				break;
			}
		}
	} else if (!isEmptyAuth(auth)) {
		effective = auth;
	}

	return effective ? resolver.resolveObject({ ...effective }) : undefined;
}

// --- Script composition ------------------------------------------------------

function joinScripts(parts: Array<string | undefined>): string | undefined {
	const composed = parts.filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
	return composed.length > 0 ? composed : undefined;
}

/**
 * Compose the effective pre/post scripts: collection-chain scripts (root→leaf)
 * followed by the request's own, joined with blank lines - the same order the
 * renderer sends so parent-collection setup runs before the request's script.
 */
export function composeScripts(
	request: SavedRequestLike,
	chain: CollectionLike[]
): { preRequestScript?: string; postRequestScript?: string } {
	return {
		preRequestScript: joinScripts([
			...chain.map((c) => c.preRequestScript),
			request.preRequestScript,
		]),
		postRequestScript: joinScripts([
			...chain.map((c) => c.postRequestScript),
			request.postRequestScript,
		]),
	};
}

// --- Headers & body ----------------------------------------------------------

/**
 * Flatten a `KeyValueEntry[]` into the object map the engine's `POST /request`
 * expects, keeping only enabled rows and resolving variables in keys and
 * values. Later duplicates win, matching header-map semantics.
 */
export function resolveHeaders(
	headers: KeyValueEntry[] | undefined,
	resolver: Resolver
): Record<string, string> | undefined {
	if (!Array.isArray(headers) || headers.length === 0) return undefined;
	const out: Record<string, string> = {};
	for (const h of headers) {
		if (!h || h.enabled === false || typeof h.key !== "string" || h.key === "") continue;
		out[resolver.resolveString(h.key)] = resolver.resolveString(String(h.value ?? ""));
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Resolve variables inside a request body, preserving its discriminated shape. */
export function resolveBody(
	body: RequestBodyLike | undefined,
	resolver: Resolver
): RequestBodyLike | undefined {
	if (!body || typeof body !== "object" || !body.mode || body.mode === "none") return undefined;
	const out: RequestBodyLike = { mode: body.mode };
	if (typeof body.content === "string") out.content = resolver.resolveString(body.content);
	if (Array.isArray(body.fields)) {
		out.fields = body.fields.map((f) => ({
			key: resolver.resolveString(String(f.key ?? "")),
			value: resolver.resolveString(String(f.value ?? "")),
			enabled: f.enabled !== false,
		}));
	}
	return out;
}

// --- Redirect policy ---------------------------------------------------------

/**
 * Engine defaults for the redirect policy, restated here because the main
 * process shares no module graph with the renderer (`electron/` has no `@/`
 * alias). Keep in step with `src/constants/request.ts` and with
 * `vayu::Request` in `engine/include/vayu/types.hpp`.
 */
const DEFAULT_FOLLOW_REDIRECTS = true;
const DEFAULT_MAX_REDIRECTS = 10;
const MIN_MAX_REDIRECTS = 0;
const MAX_MAX_REDIRECTS = 100;

/**
 * The redirect policy to forward for a saved request. Both fields are always
 * sent - the engine defaults to following, so eliding a stored
 * `followRedirects: false` would quietly follow the redirect the request opted
 * out of. Missing or out-of-range values fall back the same way the renderer's
 * `RequestTransformer` does, so MCP and the UI execute a row identically.
 */
export function composeRedirectPolicy(request: SavedRequestLike): {
	followRedirects: boolean;
	maxRedirects: number;
} {
	const followRedirects =
		typeof request.followRedirects === "boolean"
			? request.followRedirects
			: DEFAULT_FOLLOW_REDIRECTS;
	const raw = request.maxRedirects;
	const maxRedirects =
		typeof raw === "number" && Number.isFinite(raw)
			? Math.min(MAX_MAX_REDIRECTS, Math.max(MIN_MAX_REDIRECTS, Math.trunc(raw)))
			: DEFAULT_MAX_REDIRECTS;
	return { followRedirects, maxRedirects };
}

// --- High-level composition --------------------------------------------------

/**
 * Compose a saved request into the fully-resolved payload the engine executes -
 * the MCP equivalent of the app clicking **Send** on that request. Variables are
 * resolved in the URL, headers, and body; `inherit`/chain auth is resolved to a
 * concrete block; the collection-chain + request scripts are composed; and the
 * request's redirect policy is forwarded.
 */
export function composeSavedRequest(
	request: SavedRequestLike,
	chain: CollectionLike[],
	resolver: Resolver,
	environmentId?: string
): OutgoingRequest {
	const scripts = composeScripts(request, chain);
	const out: OutgoingRequest = {
		method: (request.method ?? "GET").toUpperCase(),
		url: resolver.resolveString(String(request.url ?? "")),
	};
	const headers = resolveHeaders(request.headers, resolver);
	if (headers) out.headers = headers;
	const body = resolveBody(request.body, resolver);
	if (body) out.body = body;
	const auth = composeAuth(request.auth, chain, resolver);
	if (auth) out.auth = auth;
	if (scripts.preRequestScript) out.preRequestScript = scripts.preRequestScript;
	if (scripts.postRequestScript) out.postRequestScript = scripts.postRequestScript;
	const redirects = composeRedirectPolicy(request);
	out.followRedirects = redirects.followRedirects;
	out.maxRedirects = redirects.maxRedirects;
	if (typeof request.id === "string") out.requestId = request.id;
	if (environmentId) out.environmentId = environmentId;
	return out;
}

// --- Data loading ------------------------------------------------------------

/** Narrow an unknown engine payload to an array of collection-like rows. */
function asCollections(value: unknown): CollectionLike[] {
	return Array.isArray(value) ? (value as CollectionLike[]) : [];
}

/** Narrow an unknown `variables`-bearing payload (environment/globals) to its bag. */
function asVariableBag(value: unknown): VariableBag {
	if (value && typeof value === "object") {
		const vars = (value as { variables?: unknown }).variables;
		if (vars && typeof vars === "object") return vars as VariableBag;
	}
	return {};
}

/**
 * A resolution scope: the collection ancestor chain plus a {@link Resolver} over
 * the effective variable map. Built once per tool call and reused across every
 * request it composes (e.g. all requests in a collection smoke run).
 */
export interface ResolutionContext extends Resolver {
	chain: CollectionLike[];
}

/**
 * Load the data a request-composition needs from the engine and build a
 * {@link ResolutionContext}. Fetches globals always (lowest-precedence layer),
 * the collection list only when a `collectionId` scopes the chain, and the
 * environment only when one is selected. Fetches run concurrently.
 */
export async function loadResolutionContext(
	client: EngineClient,
	opts: { collectionId?: string; environmentId?: string; signal?: AbortSignal }
): Promise<ResolutionContext> {
	const [globalsRaw, collectionsRaw, environmentRaw] = await Promise.all([
		client.getGlobals(opts.signal).catch(() => ({})),
		opts.collectionId
			? client.listCollections(opts.signal).catch(() => [])
			: Promise.resolve([]),
		opts.environmentId
			? client.getEnvironment(opts.environmentId, opts.signal).catch(() => ({}))
			: Promise.resolve({}),
	]);

	const chain = buildCollectionChain(opts.collectionId, asCollections(collectionsRaw));
	const vars = buildVariableMap({
		globals: asVariableBag(globalsRaw),
		chain,
		environment: asVariableBag(environmentRaw),
	});
	return { chain, ...makeResolver(vars) };
}
