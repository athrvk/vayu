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
 * Files dropped on the window outside the dialog (#2252). `useWindowFileDrop`
 * queues them on `useImportModalStore`; this is the dialog's half, which takes
 * them once and imports them through the File tab's own `handleFiles`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";
import { collection, request, result, stubParse } from "./import-preview.testkit";

function renderModal() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<ImportModal />
		</QueryClientProvider>
	);
}

describe("ImportModal - files pending from a window drop", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		useImportModalStore.setState({ isOpen: false, pendingPath: null, pendingFiles: [] });
	});

	it("imports the dropped files and clears the queue", async () => {
		stubParse(() =>
			result({ collections: [collection({ name: "From a drop", requests: [request()] })] })
		);
		useImportModalStore
			.getState()
			.openWithFiles([new File(["{}"], "export.json", { type: "application/json" })]);

		renderModal();

		await waitFor(() => expect(screen.getByText(/From a drop/)).toBeInTheDocument());
		expect(useImportModalStore.getState().pendingFiles).toEqual([]);
	});

	it("imports files dropped while the dialog is already open", async () => {
		// `isOpen` does not change here, only the queue does - an effect keyed on
		// `isOpen` alone would leave the files sitting in the store.
		stubParse(() =>
			result({ collections: [collection({ name: "Dropped late", requests: [request()] })] })
		);
		useImportModalStore.getState().open();
		renderModal();

		act(() => {
			useImportModalStore.getState().openWithFiles([new File(["{}"], "late.json")]);
		});

		await waitFor(() => expect(screen.getByText(/Dropped late/)).toBeInTheDocument());
	});
});
