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
 */

import type { RequestAuth } from "@/types";
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
		default:
			// none, plus the stored-but-not-editable modes (digest/aws/ntlm)
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
		default:
			return { mode: "none" };
	}
}
