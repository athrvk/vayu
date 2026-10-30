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
import { queryKeys } from "@/queries/keys";
import { compositionOptions, composeForCode } from "./code-composition";
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
	const draft: EditorDraft = { request: DRAFT, ancestors: [], elementKinds: [] };
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

describe("compositionOptions", () => {
	// The Code section, the Sends line and the tab title read one cache entry
	// because they build their key here; a reader spelling it again is how the
	// entry would stop being shared.
	it.each([
		[true, "editor"],
		[false, "saved"],
	] as const)("keys a request the builder holds=%s under %s", (held, source) => {
		expect(compositionOptions("req_1", "env_1", held).queryKey).toEqual(
			queryKeys.compose.forRequest("req_1", "env_1", source)
		);
	});

	it("never refetches on its own", () => {
		expect(compositionOptions("req_1", null, false).staleTime).toBe(Infinity);
	});
});
