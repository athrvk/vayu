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

const applied = vi.hoisted(() => ({
	refuse: null as string | null,
	/** The engine's environments as `GET /environments` would answer after the apply. */
	engineEnvironments: [] as { id: string; name: string; isActive: boolean }[],
	listEnvironments: vi.fn(),
	updateEnvironment: vi.fn(),
}));

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
			const environmentIds: Record<string, string> = {};
			result.environments.forEach((e: { name: string }, i: number) => {
				environmentIds[`e${i + 1}`] = `env_${e.name}`;
			});
			return { idMap: { ...rootIds, ...environmentIds }, rootIds, environmentIds };
		}),
		isPending: false,
	}),
}));

/** A document here is `{ name, requests, folders, environments, unsignedAuth }`; the engine's parse is not under test. */
vi.mock("@/services/api", () => ({
	apiService: {
		importFetch: vi.fn(),
		listEnvironments: applied.listEnvironments,
		updateEnvironment: applied.updateEnvironment,
		readDocument: async (text: string) => JSON.parse(text),
		parseImport: async (payload: { content: string; fileName?: string }) => {
			const doc = JSON.parse(payload.content) as {
				name: string;
				requests: number;
				folders: number;
				environments?: string[];
				unsignedAuth?: number;
			};
			const environments = (doc.environments ?? []).map((name) => ({
				name,
				description: "",
				variables: {},
			}));
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
				environments,
				globals: {},
				meta: {
					format: "Postman Collection v2.1",
					...(payload.fileName ? { fileName: payload.fileName } : {}),
					requestCount: doc.requests,
					folderCount: doc.folders,
					environmentCount: environments.length,
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
	useEnvSwitcherStore,
	useImportModalStore,
	useImportReportStore,
	useSessionStore,
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
const withEnvironments = (name: string, environments: string[], extra = {}) =>
	JSON.stringify({ name, requests: 1, folders: 0, environments, ...extra });

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
	applied.engineEnvironments = [];
	applied.listEnvironments.mockReset().mockImplementation(async () =>
		applied.engineEnvironments.map((e) => ({
			...e,
			description: "",
			variables: {},
			createdAt: "",
			updatedAt: "",
		}))
	);
	applied.updateEnvironment.mockReset().mockResolvedValue({});
	useSessionStore.setState({ activeEnvironmentId: null });
	useEnvSwitcherStore.setState({ isOpen: false });
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

/**
 * Which environment is live after an import (#2115). The rule: when the whole
 * import created exactly one environment and the engine reports none active,
 * that one becomes active; anything else changes nothing.
 */
describe("the active environment after an import", () => {
	const staging = { id: "env_Staging", name: "Staging", isActive: false };
	const production = { id: "env_Production", name: "Production", isActive: true };

	// Mutation check: drop the `activate` call in `activateImportedEnvironment`
	// and no PUT is sent.
	it("activates the one environment it created when none is active", async () => {
		applied.engineEnvironments = [staging];
		await importFiles(file("staging.json", withEnvironments("Staging API", ["Staging"])));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(applied.updateEnvironment).toHaveBeenCalledTimes(1);
		expect(applied.updateEnvironment).toHaveBeenCalledWith({
			id: "env_Staging",
			isActive: true,
		});
		expect(useSessionStore.getState().activeEnvironmentId).toBe("env_Staging");
		expect(toasts()[0].message).toContain('"Staging" is now the active environment');
		expect(toasts()[0].action).toBeUndefined();
		expect(useImportModalStore.getState().isOpen).toBe(false);
	});

	// Mutation check: drop the `active ?` guard in `planEnvironmentActivation`
	// and this overwrites the user's choice.
	it("leaves an environment the engine already has active, and offers the new one", async () => {
		applied.engineEnvironments = [production, staging];
		await importFiles(file("staging.json", withEnvironments("Staging API", ["Staging"])));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(applied.updateEnvironment).not.toHaveBeenCalled();
		expect(toasts()[0].message).toContain('"Production" is still the active environment');
		const action = toasts()[0].action;
		expect(action?.label).toBe('Use "Staging"');

		action?.onClick();

		await waitFor(() =>
			expect(applied.updateEnvironment).toHaveBeenCalledWith({
				id: "env_Staging",
				isActive: true,
			})
		);
		await waitFor(() =>
			expect(toasts()[toasts().length - 1]?.message).toBe("Environment: Staging")
		);
	});

	it("asks the engine, not the session store, whether one is active", async () => {
		// The store remembers an environment the engine no longer has active.
		useSessionStore.setState({ activeEnvironmentId: "env_Stale" });
		applied.engineEnvironments = [staging];
		await importFiles(file("staging.json", withEnvironments("Staging API", ["Staging"])));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(applied.updateEnvironment).toHaveBeenCalledWith({
			id: "env_Staging",
			isActive: true,
		});
	});

	it("activates nothing when the file made several, and offers the switcher", async () => {
		applied.engineEnvironments = ["A", "B", "C"].map((name) => ({
			id: `env_${name}`,
			name,
			isActive: false,
		}));
		await importFiles(file("many.json", withEnvironments("Many", ["A", "B", "C"])));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(applied.updateEnvironment).not.toHaveBeenCalled();
		expect(toasts()[0].message).toContain("no environment is active yet");
		const action = toasts()[0].action;
		expect(action?.label).toBe("Choose environment");

		action?.onClick();

		expect(useEnvSwitcherStore.getState().isOpen).toBe(true);
	});

	// Mutation check: collect only the last file's environment ids instead of
	// all of them and this batch reads as one environment and activates it.
	it("counts the whole batch, so one environment in each of two files is two", async () => {
		applied.engineEnvironments = [staging, { id: "env_Dev", name: "Dev", isActive: false }];
		await importFiles(
			file("staging.json", withEnvironments("Staging API", ["Staging"])),
			file("dev.json", withEnvironments("Dev API", ["Dev"]))
		);

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(applied.updateEnvironment).not.toHaveBeenCalled();
		expect(toasts()[0].message).toBe("Imported 2 files; no environment is active yet.");
	});

	it("reports a refused activation without calling the import failed", async () => {
		applied.engineEnvironments = [staging];
		applied.updateEnvironment.mockRejectedValue(new Error("engine said no"));
		await importFiles(file("staging.json", withEnvironments("Staging API", ["Staging"])));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(toasts()[0].message).toContain('couldn\'t make "Staging" the active environment');
		expect(toasts()[0].variant).toBe("success");
		expect(toasts()[0].action?.label).toBe("Choose environment");
		expect(useImportModalStore.getState().isOpen).toBe(false);
		expect(screen.queryByText(/Couldn't import/i)).toBeNull();
		expect(useSessionStore.getState().activeEnvironmentId).toBeNull();
	});

	it("keeps the notes action when the file also has notes, and the sentence in the message", async () => {
		applied.engineEnvironments = [production, staging];
		await importFiles(
			file("staging.json", withEnvironments("Staging API", ["Staging"], { unsignedAuth: 1 }))
		);

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(toasts()[0].action?.label).toBe("Review import notes");
		expect(toasts()[0].message).toContain('"Production" is still the active environment');
	});

	it("does not ask the engine about environments when the import created none", async () => {
		await importFiles(file("petstore.json", petStore));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(applied.listEnvironments).not.toHaveBeenCalled();
		expect(applied.updateEnvironment).not.toHaveBeenCalled();
	});
});
