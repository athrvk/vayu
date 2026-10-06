/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file withhold.test.ts
 * @brief The shapes `withholdDiagnoseCredentials` leaves alone (#1805): an
 *        answer with nothing to strip is returned as it came.
 */

import { describe, expect, test } from "vitest";
import { withholdDiagnoseCredentials } from "./withhold.js";

describe("withholdDiagnoseCredentials", () => {
	test("strips userinfo from proxy.url and marks the proxy node", () => {
		const answer = {
			outcome: "ok",
			proxy: { mode: "manual", url: "socks5h://bob:pw@sys.proxy:1080" },
		};
		expect(withholdDiagnoseCredentials(answer)).toEqual({
			outcome: "ok",
			proxy: { mode: "manual", url: "socks5h://sys.proxy:1080", credentialsWithheld: true },
		});
		expect(answer.proxy.url).toBe("socks5h://bob:pw@sys.proxy:1080");
	});

	test.each([
		["no proxy node", { outcome: "ok" }],
		["a proxy node that is not an object", { outcome: "ok", proxy: "manual" }],
		["no proxy.url", { outcome: "ok", proxy: { mode: "environment" } }],
		["a non-string proxy.url", { outcome: "ok", proxy: { mode: "manual", url: 8080 } }],
		[
			"a proxy.url with no credentials",
			{ outcome: "ok", proxy: { mode: "manual", url: "http://proxy.corp:8080" } },
		],
		["a non-object answer", "proxy_failed"],
		["a null answer", null],
	])("passes %s through untouched", (_name, answer) => {
		expect(withholdDiagnoseCredentials(answer)).toBe(answer);
	});
});
