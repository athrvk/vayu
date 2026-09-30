/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Postman's protocol switches on the way from a parsed draft to the apply
 * payload (issue #1765).
 *
 * The engine-side flattener is pinned against this one by
 * `orchestrator.payload-conformance.test.ts`; what this file adds is the
 * absent-versus-stated rule for the four new keys, which a conformance case
 * built from a document that states them cannot show on its own.
 */

import { describe, it, expect } from "vitest";
import { requestFieldsFromDraft } from "./request-payload";
import type { RequestDraft } from "./types";

const draft: RequestDraft = {
	name: "Get user",
	description: "",
	method: "GET",
	url: "https://x/users/:id",
	params: [],
	headers: [],
	body: { mode: "none" },
	auth: { mode: "inherit" },
	elements: [],
};

describe("requestFieldsFromDraft - protocol switches", () => {
	it("sends none of the four keys for a draft that states none", () => {
		// Absent is "engine default"; a `false` or `[]` here would read as the
		// source having said so, and a `null` carrier as "clear it".
		const fields = requestFieldsFromDraft(draft);
		for (const key of [
			"disableCookies",
			"disabledSystemHeaders",
			"disableUrlEncoding",
			"postmanProtocolBehavior",
		]) {
			expect(key in fields).toBe(false);
		}
	});

	it("carries each one the draft states, the carrier verbatim", () => {
		const carrier = {
			disableUrlEncoding: false,
			disabledSystemHeaders: {},
			disableBodyPruning: true,
		};
		const fields = requestFieldsFromDraft({
			...draft,
			disableCookies: false,
			disabledSystemHeaders: ["user-agent"],
			disableUrlEncoding: true,
			postmanProtocolBehavior: carrier,
		});
		expect(fields).toMatchObject({
			disableCookies: false,
			disabledSystemHeaders: ["user-agent"],
			disableUrlEncoding: true,
			postmanProtocolBehavior: carrier,
		});
	});

	it("forwards the engine parse's text carrier unchanged, member order and all", () => {
		// The engine writes the carrier as JSON text so its member order
		// survives to the export; an object would be reordered by its reader.
		const carrier = '{"strictSSL":true,"disabledSystemHeaders":{},"followRedirects":true}';
		const fields = requestFieldsFromDraft({ ...draft, postmanProtocolBehavior: carrier });
		expect(fields.postmanProtocolBehavior).toBe(carrier);
	});
});
