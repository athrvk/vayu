/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Pure mappings between the domain {@link RequestAuth} (discriminated by `mode`)
 * and the request builder's flat editor state ({@link AuthType} +
 * {@link AuthConfigState}). Centralized here so the load, save, and execute
 * paths share one implementation and it can be unit-tested in isolation.
 *
 * Note the field rename: domain apikey uses `in`, the editor uses `addTo`.
 *
 * Modes the editor cannot edit (digest/aws/ntlm) are *not* collapsed to "none".
 * That collapse is the data-loss bug this file used to have: an imported digest
 * request read as "No Auth", and the very next autosave wrote `{ mode: "none" }`
 * back, destroying config the user was never shown. The mode is now carried
 * through verbatim (see {@link AuthConfigState.nonEditable}) and round-trips
 * unchanged - the AuthPanel surfaces it, mirroring the collection AuthTab.
 */

import type { Collection, RequestAuth } from "@/types";
import { defaultOAuth2Config } from "@/services/oauth/defaults";
import type { AuthType, AuthConfigState } from "../types";

/** domain RequestAuth → editor state. */
export function authToEditor(auth: RequestAuth): {
	authType: AuthType;
	authConfig: AuthConfigState;
} {
	switch (auth.mode) {
		case "bearer":
			return { authType: "bearer", authConfig: { token: auth.token } };
		case "basic":
			return {
				authType: "basic",
				authConfig: { username: auth.username, password: auth.password },
			};
		case "apikey":
			return {
				authType: "api-key",
				authConfig: { key: auth.key, value: auth.value, addTo: auth.in },
			};
		case "oauth2":
			return { authType: "oauth2", authConfig: { oauth2: auth.config } };
		case "inherit":
			return { authType: "inherit", authConfig: {} };
		case "digest":
		case "aws":
		case "ntlm":
			// Stored but not editable: keep the whole config so the round-trip
			// through the editor returns it unchanged instead of dropping it.
			return { authType: auth.mode, authConfig: { nonEditable: auth } };
		default:
			return { authType: "none", authConfig: {} };
	}
}

/** editor state → domain RequestAuth. */
export function editorToAuth(authType: AuthType, authConfig: AuthConfigState): RequestAuth {
	switch (authType) {
		case "bearer":
			return { mode: "bearer", token: authConfig.token ?? "" };
		case "basic":
			return {
				mode: "basic",
				username: authConfig.username ?? "",
				password: authConfig.password ?? "",
			};
		case "api-key":
			return {
				mode: "apikey",
				key: authConfig.key ?? "",
				value: authConfig.value ?? "",
				in: authConfig.addTo ?? "header",
			};
		case "oauth2":
			return { mode: "oauth2", config: authConfig.oauth2 ?? defaultOAuth2Config() };
		case "inherit":
			return { mode: "inherit" };
		case "digest":
		case "aws":
		case "ntlm":
			// Hand back exactly what was loaded. The fallback only fires if the
			// mode was set without its config, which the mappers never do.
			return authConfig.nonEditable ?? { mode: authType, config: {} };
		default:
			return { mode: "none" };
	}
}

/**
 * Walk the ancestor chain leaf-first and return the first non-none auth.
 * Collections are always concrete auth sources (never inherit), so the first
 * non-none one found is the effective inherited auth for the request.
 *
 * Lives here rather than in the builder's `index.tsx`, where it started, because
 * the History run view resolves auth the same way when it replays a run.
 * `CLAUDE.md` forbids a third copy of the resolution rules, and a second one was
 * already one too many.
 */
export function resolveInheritedAuth(ancestors: Collection[]): Record<string, unknown> | undefined {
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const auth = ancestors[i].auth;
		if (auth.mode !== "none") {
			// Spread the discriminated union into a plain record for the engine
			return { ...auth } as Record<string, unknown>;
		}
	}
	return undefined;
}

/** Convert a concrete RequestAuth (non-inherit) to the flat record the engine expects. */
export function authToRecord(
	auth: Exclude<RequestAuth, { mode: "inherit" }>
): Record<string, unknown> | undefined {
	if (auth.mode === "none") return undefined;
	return { ...auth } as Record<string, unknown>;
}
