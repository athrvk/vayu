/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy as cURL from a Console row (#3634): the command carries the row's
 * masked values as written, so a credential the ring withheld is `<redacted>`
 * in the copy too, and the codegen path neither re-encodes the marker nor puts
 * anything back.
 *
 * Mutation check: drop `disableUrlEncoding` in `consoleRowCurl` and the URL
 * case fails, the marker turned into `%3Credacted%3E`.
 */

import { describe, expect, it } from "vitest";
import type { ConsoleScriptRequestRow, ConsoleSendRow } from "@/stores/console-store";
import { consoleRowCurl, curlBodyIsCut } from "./console-curl";

const sendRow = (overrides: Partial<ConsoleSendRow> = {}): ConsoleSendRow => ({
	kind: "send",
	method: "POST",
	url: "https://api.test/orders?access_token=<redacted>&page=2",
	status: 201,
	timeMs: 12,
	sizeBytes: 2,
	exchange: {
		requestHeaders: {
			Authorization: "<redacted>",
			"X-Api-Key": "<redacted>",
			"Content-Type": "application/json",
		},
		requestBody: { text: '{"sku":"a-1"}' },
		responseHeaders: {},
	},
	...overrides,
});

describe("a Console row as cURL", () => {
	it("keeps the URL's marker as written, not percent-encoded", () => {
		const code = consoleRowCurl(sendRow());
		expect(code).toContain("'https://api.test/orders?access_token=<redacted>&page=2'");
		expect(code).not.toContain("%3C");
	});

	it("carries each masked header as the marker", () => {
		const code = consoleRowCurl(sendRow());
		expect(code).toContain("-H 'Authorization: <redacted>'");
		expect(code).toContain("-H 'X-Api-Key: <redacted>'");
		expect(code).toContain("-H 'Content-Type: application/json'");
	});

	it("sends the recorded body as written, with the row's method", () => {
		const code = consoleRowCurl(sendRow());
		expect(code.startsWith("curl -X POST ")).toBe(true);
		expect(code).toContain(`--data-raw '{"sku":"a-1"}'`);
	});

	it("reads a script request's row the same way", () => {
		const row: ConsoleScriptRequestRow = {
			kind: "scriptRequest",
			source: "pre",
			method: "GET",
			url: "http://localhost:4000/token?client_secret=<redacted>",
			status: 200,
			timeMs: 3,
			sizeBytes: 40,
			exchange: { requestHeaders: { Cookie: "<redacted>" }, responseHeaders: {} },
		};
		const code = consoleRowCurl(row);
		expect(code).toContain("'http://localhost:4000/token?client_secret=<redacted>'");
		expect(code).toContain("-H 'Cookie: <redacted>'");
		expect(code).not.toContain("--data-raw");
	});

	it("says when the body the row kept was cut", () => {
		expect(curlBodyIsCut(sendRow())).toBe(false);
		const cut = sendRow();
		cut.exchange.requestBody = { text: "x", cut: true };
		expect(curlBodyIsCut(cut)).toBe(true);
	});
});
