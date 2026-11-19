/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The cuts `maskUrlCredentials` shares with the engine's
 * `redact_url_credentials`: the userinfo password, the auth-written query
 * name, a lone `{{variable}}`, and every other byte kept.
 *
 * Mutation check: return `head` unchanged from `dropUserinfoPassword` and the
 * userinfo cases fail; ignore `extraParamNames` in `maskPair` and the
 * auth-written case fails.
 */

import { describe, expect, it } from "vitest";
import { maskUrlCredentials } from "./url-credentials";

describe("maskUrlCredentials", () => {
	it.each([
		["https://user:secret@h/p", "https://user@h/p"],
		["http://u:p@ss@h:8080/x", "http://u@h:8080/x"],
		["user:pw@proxy:8080/x", "user@proxy:8080/x"],
	])("drops the password of %s and keeps the user", (url, masked) => {
		expect(maskUrlCredentials(url)).toBe(masked);
	});

	it.each([
		"https://user@h/p",
		"https://user:@h/p",
		"https://user:{{password}}@h/p",
		"https://h/p@q",
		"https://h/p?email=a@b.c",
		"https://h/p?code=abc&key=1&page=2",
		"https://h/p?access_token=&token",
		"https://h/p?access_token={{token}}",
		"",
	])("leaves %s as written", (url) => {
		expect(maskUrlCredentials(url)).toBe(url);
	});

	it("masks the query parameter the request's auth wrote, in any case", () => {
		const url = "https://h/p?tenant_key=S&page=2";
		expect(maskUrlCredentials(url)).toBe(url);
		expect(maskUrlCredentials(url, ["Tenant_Key"])).toBe(
			"https://h/p?tenant_key=<redacted>&page=2"
		);
	});

	it("masks a repeated credential pair at each place it appears", () => {
		expect(maskUrlCredentials("https://h/p?token=a&x=1&token=b#token=c")).toBe(
			"https://h/p?token=<redacted>&x=1&token=<redacted>#token=<redacted>"
		);
	});

	it("masks the password and the query together", () => {
		expect(maskUrlCredentials("https://u:p@h/p?access_token=T", [])).toBe(
			"https://u@h/p?access_token=<redacted>"
		);
	});
});
