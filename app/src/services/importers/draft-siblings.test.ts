/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import { draftSiblings, siblingPositions } from "./draft-siblings";
import type { CollectionDraft, RequestDraft } from "./types";

function request(over: Partial<RequestDraft>): RequestDraft {
	return {
		name: "request",
		description: "",
		method: "GET",
		url: "https://api.example.com",
		params: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "inherit" },
		elements: [],
		...over,
	};
}

function collection(over: Partial<CollectionDraft>): CollectionDraft {
	return {
		name: "collection",
		description: "",
		variables: {},
		auth: { mode: "none" },
		elements: [],
		children: [],
		requests: [],
		...over,
	};
}

function listing(parent: CollectionDraft): string[] {
	return draftSiblings(parent).map((sibling) => `${sibling.kind}:${sibling.draft.name}`);
}

describe("draftSiblings", () => {
	it("lists folders first, then requests, when no draft states an order", () => {
		const parent = collection({
			requests: [request({ name: "first" }), request({ name: "second" })],
			children: [collection({ name: "folder" })],
		});
		expect(listing(parent)).toEqual(["folder:folder", "request:first", "request:second"]);
		expect(siblingPositions(parent)).toEqual({ folders: [0], requests: [1, 2] });
	});

	it("places each draft by its stated order, a request before and between folders", () => {
		// Postman's own collection-v2 example: two requests, then a folder, at the root.
		const parent = collection({
			requests: [
				request({ name: "log in", order: 0 }),
				request({ name: "who am I", order: 1 }),
				request({ name: "log out", order: 3 }),
			],
			children: [collection({ name: "folder", order: 2 })],
		});
		expect(listing(parent)).toEqual([
			"request:log in",
			"request:who am I",
			"folder:folder",
			"request:log out",
		]);
	});

	it("closes gaps and lets a folder win a tie", () => {
		const parent = collection({
			requests: [request({ name: "request", order: 4 })],
			children: [
				collection({ name: "folder", order: 4 }),
				collection({ name: "early", order: 1 }),
			],
		});
		expect(listing(parent)).toEqual(["folder:early", "folder:folder", "request:request"]);
		expect(siblingPositions(parent)).toEqual({ folders: [1, 0], requests: [2] });
	});
});
