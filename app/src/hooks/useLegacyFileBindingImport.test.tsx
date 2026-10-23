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
 * The root hook runs the one-time import against the real `localStorage` and
 * the first collections list (#2765): an existing `vayu.spec-files` entry
 * migrates to the engine once, reaches the store that mirrors the list, and
 * the key is cleared. Which entries move is `legacy-file-bindings.test.ts`'s.
 *
 * Mutation check: return early from the hook's effect (skip the import) and
 * the first case fails; drop the `started` guard and the second writes twice.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LEGACY_FILE_BINDING_KEYS } from "@/constants/storage-keys";
import { installFileBindingMirror } from "@/queries/file-bindings";
import { queryKeys } from "@/queries/keys";
import { useSpecFileStore } from "@/stores/spec-file-store";
import type { Collection, UpdateCollectionRequest } from "@/types";
import { useLegacyFileBindingImport } from "./useLegacyFileBindingImport";

const listCollections = vi.fn();
const updateCollection = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: {
		listCollections: () => listCollections(),
		updateCollection: (update: UpdateCollectionRequest) => updateCollection(update),
	},
}));

const PETS = { path: "/home/u/pets.yaml", fileName: "pets.yaml" };
const row = (id: string, extra: Partial<Collection> = {}) =>
	({ id, name: id, order: 0, ...extra }) as Collection;

let client: QueryClient;
let uninstall: () => void;

function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(
		LEGACY_FILE_BINDING_KEYS.SPEC_FILES,
		JSON.stringify({ state: { locations: { col_1: PETS } }, version: 1 })
	);
	listCollections.mockResolvedValue([row("col_1")]);
	updateCollection.mockImplementation(async (update: UpdateCollectionRequest) =>
		row(update.id, { specFile: update.specFile ?? undefined })
	);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	useSpecFileStore.setState({ locations: {} });
	uninstall = installFileBindingMirror(client);
});

afterEach(() => {
	uninstall();
	vi.clearAllMocks();
});

describe("useLegacyFileBindingImport", () => {
	it("migrates an existing vayu.spec-files entry once the list arrives, and clears the key", async () => {
		renderHook(() => useLegacyFileBindingImport(), { wrapper });

		await waitFor(() =>
			expect(localStorage.getItem(LEGACY_FILE_BINDING_KEYS.SPEC_FILES)).toBeNull()
		);
		expect(updateCollection).toHaveBeenCalledWith({ id: "col_1", specFile: PETS });
		// The engine's answer lands in the list, so the binding is on screen
		// without a refetch.
		expect(useSpecFileStore.getState().locations.col_1).toEqual(PETS);
	});

	it("runs once, however often the list changes afterwards", async () => {
		const { rerender } = renderHook(() => useLegacyFileBindingImport(), { wrapper });
		await waitFor(() => expect(updateCollection).toHaveBeenCalledTimes(1));

		// A later list, and the key back as if another writer had put it there:
		// the import is a launch's first-list step, not a watcher.
		localStorage.setItem(
			LEGACY_FILE_BINDING_KEYS.SPEC_FILES,
			JSON.stringify({ state: { locations: { col_2: PETS } }, version: 1 })
		);
		client.setQueryData<Collection[]>(queryKeys.collections.list(), [
			row("col_1"),
			row("col_2"),
		]);
		rerender();

		expect(updateCollection).toHaveBeenCalledTimes(1);
	});
});
