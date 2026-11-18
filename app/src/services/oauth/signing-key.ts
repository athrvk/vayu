/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's half of the `jwt_bearer` signing-key rule (#3632).
 *
 * A key is one `{{variable}}` reference or a file the user picked, never text
 * the renderer holds: the engine resolves the reference where the token is
 * acquired, so the PEM it names never passes through a config this app builds,
 * logs or caches. Both halves of that live here so the form that refuses a typed
 * key and the hosts that resolve a config for a token request cannot disagree.
 */

import { isVariableToken } from "@/constants/variables";
import type { OAuth2Config, OAuth2TokenRequest } from "@/types";

/** The first line of every PEM block; what a typed key is recognised by. */
const PEM_MARKER = "-----BEGIN";

/** Whether @p text is, or holds, a PEM block. */
export function holdsPem(text: string): boolean {
	return text.includes(PEM_MARKER);
}

/** The variable name when @p text is exactly one `{{name}}`, else null. */
export function singleReferenceName(text: string | undefined): string | null {
	const written = text?.trim() ?? "";
	return isVariableToken(written) ? written.slice(2, -2).trim() : null;
}

/**
 * @p resolved with `privateKey` as @p raw wrote it.
 *
 * Every host that variable-resolves a config for a token request resolves the
 * whole object, and a resolved reference would put the PEM into the request the
 * renderer sends; the engine resolves it from the scopes the request names
 * instead (`environmentId`, `collectionId`).
 */
export function keepSigningKeyReference(resolved: OAuth2Config, raw: OAuth2Config): OAuth2Config {
	if (raw.privateKey === undefined) return resolved;
	return { ...resolved, privateKey: raw.privateKey };
}

/**
 * `keepSigningKeyReference` for an auth record (`{ mode, config }`, what
 * `resolveAuthForSend` flattens to): another mode passes through untouched.
 */
export function keepSigningKeyReferenceInAuth(
	resolved: Record<string, unknown>,
	raw: Record<string, unknown>
): Record<string, unknown> {
	if (raw.mode !== "oauth2" || !raw.config || !resolved.config) return resolved;
	return {
		...resolved,
		config: keepSigningKeyReference(
			resolved.config as OAuth2Config,
			raw.config as OAuth2Config
		),
	};
}

/**
 * The scopes the engine resolves a `privateKey` reference against, for the
 * ones that are known: the active environment and the request's collection.
 */
export function tokenScopeIds(
	environmentId: string | null | undefined,
	collectionId: string | null | undefined
): Pick<OAuth2TokenRequest, "environmentId" | "collectionId"> {
	return {
		...(environmentId ? { environmentId } : {}),
		...(collectionId ? { collectionId } : {}),
	};
}
