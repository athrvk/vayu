/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The inline `POST /compose` body for an editor state (#2638), the one place the mapping is
 * written, so every send site (Send buffered and streaming, the load run, the History replay) sends
 * the same request and a new field reaches all. Raw (#226): the engine resolves `{{variables}}` and
 * inherit auth at compose time, and resolving here would interpolate twice. Inline, not by id,
 * because the editor state may be ahead of the saved row.
 */

import type {
	Collection,
	ComposeRequestRequest,
	ElementKindSchema,
	ResolvedElement,
} from "@/types";
import type { LeftOutElement } from "@/lib/elements";
import type { RequestState, ResponseState } from "../types";
import { buildExecBody, execIdentity, protocolSettings } from "./execute-mapping";
import { elementsParts, sendElementsParts } from "./elements-parts";
import { bodyModeHeaders, toHeaderRows } from "./key-value";
import { composePathParams } from "./path-variables";

/**
 * Where the composed elements come from. `chain` is live: the chain root to leaf, then the
 * request's own, minus what any `inherit.disable` names (`elementsParts`, #1512). `resolved` is a
 * caller-built list: the History replay runs the collection scripts as recorded. `onlyRunnable` is
 * Send's and code generation's (#3066): the request's own disabled or check-failing draft elements
 * (against `kinds`) are left out (`sendElementsParts`); a load run composes without it, carrying
 * every element.
 */
export type ComposeElementsSource =
	| {
			chain: Collection[];
			ownerId: string | undefined;
			onlyRunnable?: { kinds: ElementKindSchema[] };
	  }
	| { resolved: ResolvedElement[] | undefined };

export interface ComposeBodyInput {
	request: RequestState;
	elements: ComposeElementsSource;
	/** Scopes the inherit walk and the variable chain; absent for an orphaned replay. */
	collectionId?: string;
	/** The active environment; an empty or null id is no environment. */
	environmentId?: string | null;
	/**
	 * Bare column names a row binds after this composition (#1007); names only, as a value would be
	 * one row's in a once-composed payload.
	 */
	dataColumns?: string[];
	/**
	 * Leave the `{{$guid}}` family unresolved for a payload repeated per iteration (#995); set only
	 * by a run starter.
	 */
	deferDynamicVariables?: boolean;
}

export interface ComposeBody {
	body: ComposeRequestRequest;
	/** The resolved elements the body carries, for the caller's after-send checks. */
	elements: ResolvedElement[] | undefined;
	/** Incomplete draft elements `onlyRunnable` left out; empty when not asked for. */
	leftOut: LeftOutElement[];
}

function composedElements(
	source: ComposeElementsSource,
	request: RequestState
): Pick<ComposeBody, "elements" | "leftOut"> {
	if ("resolved" in source) return { elements: source.resolved, leftOut: [] };
	const { chain, ownerId, onlyRunnable } = source;
	if (!onlyRunnable)
		return { elements: elementsParts(chain, ownerId, request.elements), leftOut: [] };
	const { parts, leftOut } = sendElementsParts(
		chain,
		ownerId,
		request.elements,
		onlyRunnable.kinds
	);
	return { elements: parts, leftOut };
}

export function buildComposeBody(input: ComposeBodyInput): ComposeBody {
	const { request } = input;
	const { elements, leftOut } = composedElements(input.elements, request);

	const body: ComposeRequestRequest = {
		request: {
			method: request.method,
			url: request.url,
			// Always sent, `[]` included (#1764); see composePathParams.
			params: composePathParams(request.params),
			// The user's enabled header rows as ordered lines, nothing else: what Vayu adds is the
			// engine's (#1229).
			headers: toHeaderRows(request.headers),
			// Which of those the body mode wrote (issue #1765).
			...bodyModeHeaders(request.headers),
			body: buildExecBody(request, (s) => s),
			auth: { ...request.auth },
			elements,
			// The next four are always sent, never elided, as each has an engine default that would
			// win silently: following redirects is the default, so an omitted `false` follows what
			// the user asked to see, and `verify_ssl` defaults to true, so an omitted `false`
			// verifies a certificate the user exempted (#706).
			followRedirects: request.followRedirects,
			maxRedirects: request.maxRedirects,
			httpVersion: request.httpVersion,
			verifySSL: request.verifySSL,
			// The one setting not always sent (#2937): unset, the key stays off so the engine reads
			// `defaultTimeout` at the send, where a copy here would pin today's value.
			...(request.timeout !== null ? { timeout: request.timeout } : {}),
			// Postman's protocol switches (#1765), always sent for the same reason: the editor's
			// value, not the saved row's.
			...protocolSettings(request),
			// Identity for the script sandbox (pm.info), not an HTTP field; it rides through
			// composition into `/execute` and `config_snapshot`.
			...execIdentity(request),
		},
		...(input.collectionId !== undefined ? { collectionId: input.collectionId } : {}),
		...(input.environmentId ? { environmentId: input.environmentId } : {}),
		...(input.dataColumns ? { dataColumns: input.dataColumns } : {}),
		...(input.deferDynamicVariables ? { deferDynamicVariables: true } : {}),
	};

	return { body, elements, leftOut };
}

/**
 * Attaches its Send's left-out elements (#3066) to @p response; unchanged when none, so the field
 * stays absent, not `[]`.
 */
export function withLeftOut<T extends ResponseState>(response: T, leftOut: LeftOutElement[]): T {
	return leftOut.length > 0 ? { ...response, leftOutElements: leftOut } : response;
}
