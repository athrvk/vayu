/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Re-importing a document a collection is already bound to (issue #680).
 *
 * The defect: it imported straight through and made a second collection, with
 * none of the bound one's operation identities, saved examples or coverage
 * history, and no line anywhere saying the first one existed.
 *
 * Every case here asserts what the *import* did, not what the dialog says:
 * remove the detection and the two bound cases send `mutateAsync` again, which
 * is exactly the silent second collection. A dialog-only assertion would keep
 * passing if the import fired behind it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportModal } from "./ImportModal";
import { useImportModalStore, useTabsStore } from "@/stores";
import type { Collection, SpecDocument } from "@/types";

const SPEC = JSON.stringify({
	openapi: "3.0.0",
	info: { title: "Petstore", version: "1.0.0" },
	paths: {
		"/pets": { get: { operationId: "listPets", responses: { "200": { description: "ok" } } } },
	},
});

/** The same document with an operation added - what a re-fetch of a moved spec reads. */
const SPEC_MOVED = JSON.stringify({
	openapi: "3.0.0",
	info: { title: "Petstore", version: "2.0.0" },
	paths: {
		"/pets": { get: { operationId: "listPets", responses: { "200": { description: "ok" } } } },
		"/pets/{petId}": {
			get: { operationId: "getPet", responses: { "200": { description: "ok" } } },
		},
	},
});

const state = {
	collections: [] as Collection[],
	documents: new Map<string, SpecDocument>(),
	imported: [] as unknown[],
};

vi.mock("@/queries/import", () => ({
	useImportMutation: () => ({
		mutateAsync: vi.fn().mockImplementation(async (payload: unknown) => {
			state.imported.push(payload);
		}),
		isPending: false,
	}),
}));

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: state.collections }),
}));

vi.mock("@/services/api", () => ({
	apiService: {
		getSpec: vi.fn().mockImplementation(async (id: string) => {
			const document = state.documents.get(id);
			if (!document) throw new Error(`no spec ${id}`);
			return document;
		}),
		importFetch: vi.fn(),
		readDocument: async (text: string) => JSON.parse(text),
		/**
		 * The parse is the engine's (issue #877). What these cases turn on is the
		 * one field it puts on an OpenAPI root - `spec.content`, the document
		 * verbatim - because that is what the bound-document detection hashes.
		 * Everything else about the parse is pinned engine-side.
		 */
		parseImport: async (payload: { content: string; sourceUrl?: string }) => {
			// Only an OpenAPI import carries a `spec`, which is the whole point of
			// the last case here: a Postman collection must not send the dialog
			// looking for a bound document.
			const spec = typeof JSON.parse(payload.content).openapi === "string";
			return {
				collections: [
					{
						name: "Petstore",
						description: "",
						variables: {},
						auth: { mode: "none" as const },
						preRequestScript: "",
						postRequestScript: "",
						children: [],
						requests: [],
						...(spec
							? {
									spec: {
										content: payload.content,
										...(payload.sourceUrl
											? { sourceUrl: payload.sourceUrl }
											: {}),
									},
								}
							: {}),
					},
				],
				environments: [],
				globals: {},
				meta: {
					format: spec ? "OpenAPI 3.0" : "Postman Collection v2.1",
					requestCount: 0,
					folderCount: 0,
					environmentCount: 0,
					globalCount: 0,
					exampleCount: 0,
					skipped: [],
					nonExecutableAuth: 0,
					unattachedFileParts: 0,
				},
			};
		},
	},
}));

function bind(collectionId: string, name: string, specId: string, document: Partial<SpecDocument>) {
	state.collections.push({
		id: collectionId,
		name,
		description: "",
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		order: 0,
		createdAt: "",
		updatedAt: "",
		openapi: { specId, specHash: "hash", syncedAt: 1 },
	});
	state.documents.set(specId, {
		id: specId,
		content: SPEC,
		sourceUrl: null,
		fetchedAt: 1,
		hash: "hash",
		operations: null,
		responseSchemas: null,
		...document,
	});
}

function renderModal() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ImportModal />
		</QueryClientProvider>
	);
}

/** See ImportModal.test.tsx - Radix tabs activate on mousedown, not a bare click. */
function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

async function previewPaste(text: string) {
	renderModal();
	selectTab(/Paste JSON/i);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: text } });
	fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
	// The Import button only exists in the preview phase, whatever format the
	// document turned out to be.
	await importButton();
}

/** Waits: while a dialog is open over it, the button is hidden from the a11y tree. */
function importButton() {
	return screen.findByRole("button", { name: /^Import →$/ });
}

async function pressImport() {
	fireEvent.click(await importButton());
}

/**
 * The fork, once it is actually on screen.
 *
 * By its title, not by the dialog role alone: the import dialog is a dialog too,
 * and until the fork mounts a bare role query resolves to that one - so the
 * assertion would read the preview and the buttons would be the preview's.
 */
function fork() {
	return screen.findByRole("dialog", { name: /already bound/i });
}

beforeEach(() => {
	state.collections = [];
	state.documents = new Map();
	state.imported = [];
	useImportModalStore.setState({ isOpen: true });
	useTabsStore.setState({ openTabs: [], activeTabId: null, specTabTarget: null });
});

describe("importing a document a collection is already bound to", () => {
	it("offers Sync instead of importing when the bytes are the ones already bound", async () => {
		bind("col_1", "Petstore", "spec_1", { content: SPEC });
		await previewPaste(SPEC);
		await pressImport();

		const dialog = await fork();
		expect(dialog).toHaveTextContent(/byte for byte/i);
		// Named, so the user knows which collection they already have.
		expect(dialog).toHaveTextContent("Petstore");
		// The whole point: nothing was written.
		expect(state.imported).toEqual([]);
	});

	/**
	 * The case Sync exists for. The document at the bound URL has changed, so the
	 * bytes cannot match - only the URL can - and this is precisely the import a
	 * user reaches for when they mean "pick up the new version".
	 */
	it("offers Sync when the same URL now serves a changed document", async () => {
		bind("col_1", "Petstore", "spec_1", {
			content: SPEC,
			sourceUrl: "https://acme.dev/openapi.json",
		});
		const { apiService } = await import("@/services/api");
		vi.mocked(apiService.importFetch).mockResolvedValue({
			content: SPEC_MOVED,
		} as Awaited<ReturnType<typeof apiService.importFetch>>);

		renderModal();
		selectTab(/URL/i);
		fireEvent.change(screen.getByPlaceholderText(/petstore/i), {
			target: { value: "https://acme.dev/openapi.json" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Fetch/i }));
		await screen.findByText(/OpenAPI 3.0/);
		await pressImport();

		expect(await fork()).toHaveTextContent(/newer version/i);
		expect(state.imported).toEqual([]);
	});

	it("imports straight through when nothing is bound to it", async () => {
		bind("col_1", "Petstore", "spec_1", { content: SPEC_MOVED });
		await previewPaste(SPEC);
		await pressImport();

		await waitFor(() => expect(state.imported).toHaveLength(1));
		expect(screen.queryByText(/already bound/i)).toBeNull();
	});

	it("still imports when the user chooses to - the dialog is a fork, not a block", async () => {
		bind("col_1", "Petstore", "spec_1", { content: SPEC });
		await previewPaste(SPEC);
		await pressImport();
		fireEvent.click(within(await fork()).getByRole("button", { name: /Import anyway/i }));

		await waitFor(() => expect(state.imported).toHaveLength(1));
	});

	it("routes to the bound collection's Spec tab on Sync, importing nothing", async () => {
		bind("col_1", "Petstore", "spec_1", { content: SPEC });
		await previewPaste(SPEC);
		await pressImport();
		fireEvent.click(within(await fork()).getByRole("button", { name: /Sync instead/i }));

		await waitFor(() => expect(useTabsStore.getState().specTabTarget).toBe("col_1"));
		expect(useTabsStore.getState().openTabs).toEqual([
			expect.objectContaining({ type: "collection", entityId: "col_1" }),
		]);
		expect(state.imported).toEqual([]);
		// The import dialog closes behind it - the user is being sent somewhere.
		expect(useImportModalStore.getState().isOpen).toBe(false);
	});

	it("goes back to the preview on Cancel, with nothing written", async () => {
		bind("col_1", "Petstore", "spec_1", { content: SPEC });
		await previewPaste(SPEC);
		await pressImport();
		fireEvent.click(within(await fork()).getByRole("button", { name: /^Cancel$/ }));

		await waitFor(() => expect(screen.queryByText(/already bound/i)).toBeNull());
		expect(state.imported).toEqual([]);
		expect(await importButton()).toBeInTheDocument();
	});

	/**
	 * A non-spec import must not pay for the lookup at all: there is no document
	 * to compare, and a Postman file has no binding to find.
	 */
	it("never reads a bound document for an import that carries no spec", async () => {
		bind("col_1", "Petstore", "spec_1", { content: SPEC });
		const { apiService } = await import("@/services/api");
		vi.mocked(apiService.getSpec).mockClear();

		await previewPaste(
			JSON.stringify({
				info: {
					name: "CB",
					schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
				},
				item: [{ name: "Ping", request: { method: "GET", url: "https://x/ping" } }],
			})
		);
		await pressImport();

		await waitFor(() => expect(state.imported).toHaveLength(1));
		expect(apiService.getSpec).not.toHaveBeenCalled();
	});
});
