/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The inline `POST /compose` body for an editor state (issue #2638): the one
 * place the request-to-compose mapping is written, so every send site puts the
 * same request on the wire. Send (buffered and streaming), the load run and the
 * History replay all build through it; a field added here reaches all of them.
 *
 * Raw: since #226 the engine resolves `{{variables}}` and inherit auth at
 * compose time, so the editor state goes over as-is - resolving here too would
 * interpolate the payload twice. The inline shape (not compose-by-id) is
 * deliberate: the editor state may be ahead of the saved row.
 */

import type { Collection, ComposeRequestRequest, ResolvedElement } from "@/types";
import type { RequestState } from "../types";
import { buildExecBody, execIdentity, protocolSettings } from "./execute-mapping";
import { elementsParts } from "./elements-parts";
import { bodyModeHeaders, toHeaderRows } from "./key-value";
import { composePathParams } from "./path-variables";

/**
 * Where the composed request's elements come from.
 *
 * `chain` is the live case: the collection chain root to leaf, then the
 * request's own, minus whatever an `inherit.disable` entry at any level of
 * that chain names (`elementsParts`, issue #1512). `resolved` is a list the caller already
 * built - the History replay runs the collection scripts as the run recorded
 * them, not as the chain reads now.
 */
export type ComposeElementsSource =
	| { chain: Collection[]; ownerId: string | undefined }
	| { resolved: ResolvedElement[] | undefined };

export interface ComposeBodyInput {
	request: RequestState;
	elements: ComposeElementsSource;
	/** Scopes the inherit walk and the variable chain; absent for an orphaned replay. */
	collectionId?: string;
	/** The active environment; an empty or null id is no environment. */
	environmentId?: string | null;
	/**
	 * The bare column names a data row will bind after this composition (issue
	 * #1007). Names only: a value here would be one row's value written into a
	 * payload composed once. Absent composes exactly as without a data set.
	 */
	dataColumns?: string[];
	/**
	 * Leave the `{{$guid}}` family unresolved for a payload repeated per
	 * iteration (issue #995). Only a caller that starts a run sets it.
	 */
	deferDynamicVariables?: boolean;
}

export interface ComposeBody {
	body: ComposeRequestRequest;
	/** The resolved elements the body carries, for the caller's after-send checks. */
	elements: ResolvedElement[] | undefined;
}

export function buildComposeBody(input: ComposeBodyInput): ComposeBody {
	const { request } = input;
	const elements =
		"resolved" in input.elements
			? input.elements.resolved
			: elementsParts(input.elements.chain, input.elements.ownerId, request.elements);

	const body: ComposeRequestRequest = {
		request: {
			method: request.method,
			url: request.url,
			// Always sent, `[]` included (#1764) - see composePathParams.
			params: composePathParams(request.params),
			// The user's enabled header rows as ordered lines and nothing else:
			// what Vayu adds is the engine's since issue #1229.
			headers: toHeaderRows(request.headers),
			// Which of those the body mode wrote (issue #1765).
			...bodyModeHeaders(request.headers),
			body: buildExecBody(request, (s) => s),
			auth: { ...request.auth },
			elements,
			// The next four are always sent, never elided: each has an
			// engine-side default that would otherwise win silently. Following
			// redirects is the engine's default, so an omitted `false` follows
			// the redirect the user asked to see; and `verify_ssl` defaults to
			// true, so an omitted `false` verifies the certificate the user
			// turned verification off for (issue #706).
			followRedirects: request.followRedirects,
			maxRedirects: request.maxRedirects,
			httpVersion: request.httpVersion,
			verifySSL: request.verifySSL,
			// The one setting not always sent (issue #2937): unset, the key stays off
			// the body so the engine reads the `defaultTimeout` setting at the send,
			// where a copy of it here would pin today's value into the request.
			...(request.timeout !== null ? { timeout: request.timeout } : {}),
			// Postman's protocol switches (issue #1765), always sent for the same
			// reason: the editor's value, not the saved row's.
			...protocolSettings(request),
			// Identity for the script sandbox (pm.info), not an HTTP field - it
			// rides through composition into `/execute` and `config_snapshot`.
			...execIdentity(request),
		},
		...(input.collectionId !== undefined ? { collectionId: input.collectionId } : {}),
		...(input.environmentId ? { environmentId: input.environmentId } : {}),
		...(input.dataColumns ? { dataColumns: input.dataColumns } : {}),
		...(input.deferDynamicVariables ? { deferDynamicVariables: true } : {}),
	};

	return { body, elements };
}
