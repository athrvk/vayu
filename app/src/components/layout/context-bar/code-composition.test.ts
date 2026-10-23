/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `POST /compose` answers which names a pre-request script runs before as
 * `deferredVariables` (#2521), and the Code section can only name them if the
 * composition it reads carries them - on both of its paths, the editor's inline
 * compose and the saved row's compose by id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { composeForCode } from "./code-composition";
import { useLiveCommandSurfaceStore, type EditorDraft } from "@/lib/commands/live-surfaces";
import type { RequestState } from "@/modules/request-builder/types";

const composeRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: { composeRequest: (...args: unknown[]) => composeRequest(...args) },
}));

const SCRIPTED = { method: "GET", url: "https://{{host}}/", deferredVariables: ["host"] };
const PLAIN = { method: "GET", url: "https://api.example.com/" };

/** Only what `editorComposeBody` and `composeForCode` read of a draft. */
const DRAFT = {
	id: "req_1",
	collectionId: "col_1",
	method: "GET",
	url: "https://{{host}}/",
	params: [],
	headers: [],
	disabledDefaultHeaders: [],
	bodyMode: "none",
	body: "",
	formData: [],
	urlEncoded: [],
	binaryFile: { src: "", unresolved: true },
	auth: { mode: "inherit" },
	elements: [],
	stream: false,
	disableCookies: false,
} as unknown as RequestState;

function holdDraft() {
	const draft: EditorDraft = { request: DRAFT, ancestors: [] };
	useLiveCommandSurfaceStore
		.getState()
		.registerSurface("editorDraft", { requestId: DRAFT.id, read: () => draft });
}

beforeEach(() => {
	useLiveCommandSurfaceStore.setState({ editorDraft: null });
	composeRequest.mockReset();
});

describe("composeForCode carries the deferred names", () => {
	it("from the saved row's compose", async () => {
		composeRequest.mockResolvedValue(SCRIPTED);

		const composition = await composeForCode("req_1", null);

		expect(composition.deferredVariables).toEqual(["host"]);
		expect(composition.editorSettings).toBeNull();
	});

	it("from the editor's compose", async () => {
		holdDraft();
		composeRequest.mockResolvedValue(SCRIPTED);

		const composition = await composeForCode("req_1", null);

		expect(composition.deferredVariables).toEqual(["host"]);
		expect(composition.editorSettings).not.toBeNull();
	});

	it("as an empty list when the answer has none", async () => {
		composeRequest.mockResolvedValue(PLAIN);

		expect((await composeForCode("req_1", null)).deferredVariables).toEqual([]);
	});
});
