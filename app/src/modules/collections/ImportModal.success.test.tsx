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
 * After a successful apply (issue #2109).
 *
 * The dialog used to close on success and say nothing: the new root arrived
 * collapsed and unselected, and the list of things to finish by hand - which the
 * preview had just shown - was discarded with the dialog. Each case here is
 * written so that reverting `runImport`'s post-success block to a bare
 * `handleClose()` reddens it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const applied = vi.hoisted(() => ({ refuse: null as string | null }));

/** Answers like the real mutation: each root's temp id mapped to a real id. */
vi.mock("@/queries/import", () => ({
	useImportMutation: () => ({
		mutateAsync: vi.fn().mockImplementation(async ({ result }) => {
			if (applied.refuse && result.meta.fileName === applied.refuse) {
				throw new Error("engine said no");
			}
			const rootIds: Record<string, string> = {};
			result.collections.forEach((c: { name: string }, i: number) => {
				rootIds[`c${i + 1}`] = `col_${c.name}`;
			});
			return { idMap: { ...rootIds }, rootIds, environmentIds: {} };
		}),
		isPending: false,
	}),
}));

/** A document here is `{ name, requests, folders, unsignedAuth }`; the engine's parse is not under test. */
vi.mock("@/services/api", () => ({
	apiService: {
		importFetch: vi.fn(),
		readDocument: async (text: string) => JSON.parse(text),
		parseImport: async (payload: { content: string; fileName?: string }) => {
			const doc = JSON.parse(payload.content) as {
				name: string;
				requests: number;
				folders: number;
				unsignedAuth?: number;
			};
			return {
				collections: [
					{
						name: doc.name,
						description: "",
						variables: {},
						auth: { mode: "none" as const },
						elements: [],
						children: [],
						requests: [],
					},
				],
				environments: [],
				globals: {},
				meta: {
					format: "Postman Collection v2.1",
					...(payload.fileName ? { fileName: payload.fileName } : {}),
					requestCount: doc.requests,
					folderCount: doc.folders,
					environmentCount: 0,
					globalCount: 0,
					exampleCount: 0,
					skipped: [],
					nonExecutableAuth: doc.unsignedAuth ?? 0,
					unattachedFileParts: 0,
				},
			};
		},
	},
}));

import { ImportModal } from "./ImportModal";
import { useCollectionsStore } from "./collections-store";
import {
	useImportModalStore,
	useImportReportStore,
	useTabSelectionStore,
	useTabsStore,
	useToastStore,
} from "@/stores";

const petStore = JSON.stringify({ name: "Pet Store", requests: 60, folders: 4 });
const petStoreWithLoss = JSON.stringify({
	name: "Pet Store",
	requests: 60,
	folders: 4,
	unsignedAuth: 2,
});
const orders = JSON.stringify({ name: "Orders", requests: 1, folders: 0 });

function renderModal() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ImportModal />
		</QueryClientProvider>
	);
}

function file(name: string, text: string): File {
	return new File([text], name, { type: "application/json" });
}

async function importFiles(...files: File[]) {
	renderModal();
	fireEvent.drop(screen.getByText(/Drop files here/i).closest("button")!, {
		dataTransfer: { files },
	});
	// Only the preview has a single "Import" button; the picker offers "Import folder" too.
	const importButton = await waitFor(() => {
		const button = screen.getByRole("button", { name: /^Import/i });
		expect(button).toBeEnabled();
		return button;
	});
	fireEvent.click(importButton);
}

const toasts = () => useToastStore.getState().toasts;

beforeEach(() => {
	applied.refuse = null;
	useImportModalStore.setState({ isOpen: true });
	useToastStore.setState({ toasts: [] });
	useCollectionsStore.setState({ expandedCollectionIds: new Set() });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useTabSelectionStore.setState({ collectionTab: new Map() });
	useImportReportStore.setState({ reports: {} });
});

describe("after a successful import", () => {
	it("closes the dialog and names the collection and its request count in a toast", async () => {
		await importFiles(file("petstore.json", petStore));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(toasts()[0].message).toBe('Imported "Pet Store" - 60 requests, 4 folders.');
		expect(toasts()[0].variant).toBe("success");
		expect(useImportModalStore.getState().isOpen).toBe(false);
	});

	it("expands the new root and opens it as the active tab", async () => {
		await importFiles(file("petstore.json", petStore));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(useCollectionsStore.getState().expandedCollectionIds.has("col_Pet Store")).toBe(
			true
		);
		const { openTabs, activeTabId } = useTabsStore.getState();
		const active = openTabs.find((tab) => tab.id === activeTabId);
		expect(active).toMatchObject({ type: "collection", entityId: "col_Pet Store" });
	});

	it("offers no action when the import lost nothing", async () => {
		await importFiles(file("petstore.json", petStore));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(toasts()[0].action).toBeUndefined();
		expect(useImportReportStore.getState().reports).toEqual({});
	});

	it("counts what is left to finish, keeps the report, and offers one action that opens the collection", async () => {
		await importFiles(file("petstore.json", petStoreWithLoss));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(toasts()[0].message).toBe(
			'Imported "Pet Store" - 60 requests, 4 folders; 1 thing to finish.'
		);
		expect(
			useImportReportStore.getState().reports["col_Pet Store"]?.notices.map((n) => n.tier)
		).toEqual(["action"]);

		const action = toasts()[0].action;
		expect(action?.label.split(" ").length).toBeLessThanOrEqual(3);

		// The user has since moved on; the action brings the collection back on Info.
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		useTabSelectionStore.getState().setCollectionTab("col_Pet Store", "auth");
		action?.onClick();
		const { openTabs, activeTabId } = useTabsStore.getState();
		expect(openTabs.find((tab) => tab.id === activeTabId)).toMatchObject({
			type: "collection",
			entityId: "col_Pet Store",
		});
		expect(useTabSelectionStore.getState().getCollectionTab("col_Pet Store")).toBe("info");
	});

	it("raises one toast for a batch, and opens the first collection", async () => {
		await importFiles(file("petstore.json", petStore), file("orders.json", orders));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(toasts()[0].message).toBe("Imported 2 files.");
		const { expandedCollectionIds } = useCollectionsStore.getState();
		expect([...expandedCollectionIds].sort()).toEqual(["col_Orders", "col_Pet Store"]);
		const { openTabs, activeTabId } = useTabsStore.getState();
		expect(openTabs.find((tab) => tab.id === activeTabId)?.entityId).toBe("col_Pet Store");
	});
});

describe("a failed import", () => {
	it("keeps the dialog open and announces nothing", async () => {
		applied.refuse = "orders.json";
		await importFiles(file("petstore.json", petStore), file("orders.json", orders));

		await screen.findByText(/Couldn't import 1 of 2 files/i);
		expect(useImportModalStore.getState().isOpen).toBe(true);
		expect(toasts()).toEqual([]);
		expect(useTabsStore.getState().openTabs).toEqual([]);
		expect(useCollectionsStore.getState().expandedCollectionIds.size).toBe(0);
	});
});
