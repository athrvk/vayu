/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { authToEditor, editorToAuth } from "./auth-mapping";
import { defaultOAuth2Config } from "@/services/oauth/defaults";
import type { RequestAuth } from "@/types";

describe("auth-mapping", () => {
	it("round-trips every editable mode", () => {
		const cases: RequestAuth[] = [
			{ mode: "none" },
			{ mode: "inherit" },
			{ mode: "bearer", token: "abc" },
			{ mode: "basic", username: "u", password: "p" },
			{ mode: "apikey", key: "X-Key", value: "v", in: "query" },
			{ mode: "oauth2", config: { ...defaultOAuth2Config(), clientId: "cid" } },
		];
		for (const auth of cases) {
			const { authType, authConfig } = authToEditor(auth);
			expect(editorToAuth(authType, authConfig)).toEqual(auth);
		}
	});

	it("renames apikey in/addTo across the boundary", () => {
		const { authConfig } = authToEditor({ mode: "apikey", key: "k", value: "v", in: "header" });
		expect(authConfig.addTo).toBe("header");
		expect(authConfig).not.toHaveProperty("in");
	});

	it("keeps the oauth2 config nested under authConfig.oauth2", () => {
		const config = { ...defaultOAuth2Config(), accessTokenUrl: "https://x/token" };
		const { authType, authConfig } = authToEditor({ mode: "oauth2", config });
		expect(authType).toBe("oauth2");
		expect(authConfig.oauth2).toEqual(config);
	});

	it("editorToAuth defaults a missing oauth2 config", () => {
		const auth = editorToAuth("oauth2", {});
		expect(auth).toEqual({ mode: "oauth2", config: defaultOAuth2Config() });
	});

	// Regression: the editor cannot edit digest/aws/ntlm, but it used to collapse
	// them to "none" on load. The next autosave then wrote `{ mode: "none" }`
	// back, destroying imported config the user was never shown. They must now
	// carry the real mode and round-trip byte-for-byte.
	it("preserves stored-but-not-editable modes instead of collapsing to none", () => {
		const cases: RequestAuth[] = [
			{ mode: "digest", config: { username: "u", realm: "r", nonce: "n" } },
			{ mode: "aws", config: { accessKey: "AK", secretKey: "SK", region: "us-east-1" } },
			{ mode: "ntlm", config: { domain: "CORP", username: "u", password: "p" } },
		];
		for (const auth of cases) {
			const { authType, authConfig } = authToEditor(auth);
			// The picker never offers these, but the mode is carried so the panel
			// can name it rather than reading "No Auth".
			expect(authType).toBe(auth.mode);
			expect(editorToAuth(authType, authConfig)).toEqual(auth);
		}
	});
});
