/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { createDefaultRequestState } from "./request-state";
import { requestHasTokens } from "./request-tokens";
import type { RequestState } from "../types";

const row = (extra: Record<string, unknown>) =>
	({ id: "r", key: "", value: "", enabled: true, ...extra }) as RequestState["headers"][number];

describe("requestHasTokens", () => {
	it("is false for a request that is all literal text", () => {
		const request: RequestState = {
			...createDefaultRequestState(),
			url: "https://api.test/v1?page=1",
			headers: [row({ key: "Accept", value: "application/json" })],
			body: '{"a":1}',
		};
		expect(requestHasTokens(request)).toBe(false);
	});

	it.each<[string, Partial<RequestState>]>([
		["the URL", { url: "https://{{host}}/" }],
		["a param", { params: [row({ value: "{{page}}" })] }],
		["a header name", { headers: [row({ key: "{{name}}" })] }],
		["a header value", { headers: [row({ value: "Bearer {{token}}" })] }],
		["the body", { body: '{"id":"{{id}}"}' }],
		["a form field", { formData: [row({ value: "{{v}}" })] }],
		["a form file part's path", { formData: [row({ src: "{{dir}}/a.png" })] }],
		["an urlencoded field", { urlEncoded: [row({ key: "{{k}}" })] }],
		["the binary file", { binaryFile: { src: "{{dir}}/a.bin" } }],
		["a bearer token", { auth: { mode: "bearer", token: "{{token}}" } }],
		[
			"an OAuth 2.0 config",
			{
				auth: {
					mode: "oauth2",
					config: { accessTokenUrl: "{{idp}}/token" },
				} as unknown as RequestState["auth"],
			},
		],
	])("is true for a token in %s", (_label, patch) => {
		expect(requestHasTokens({ ...createDefaultRequestState(), ...patch })).toBe(true);
	});
});
