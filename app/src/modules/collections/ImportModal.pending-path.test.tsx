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
 * A file the OS handed Vayu to import (#1364): dropped on the Dock or taskbar
 * icon, or a path on the command line. `useOpenIntent` queues the path on
 * `useImportModalStore`; this is the dialog's half, which reads it back once
 * and imports it like any other File-tab pick.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function stubReadSpecFile(
	impl: (specPath: string, refPath: string) => Promise<{ bytes: Uint8Array; fileName: string }>
) {
	const readSpecFile = vi.fn(impl);
	(window as unknown as { electronAPI: unknown }).electronAPI = { readSpecFile };
	return readSpecFile;
}

describe("ImportModal - a pending path from the OS", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	});

	it("reads the path back through readSpecFile and imports it", async () => {
		stubParse(() =>
			result({
				collections: [collection({ name: "From disk", requests: [request()] })],
			})
		);
		const readSpecFile = stubReadSpecFile(async () => ({
			bytes: new TextEncoder().encode('{"any":"document"}'),
			fileName: "spec.json",
		}));
		useImportModalStore.setState({ isOpen: true, pendingPath: "/Users/me/specs/spec.json" });

		renderModal();

		await waitFor(() => expect(screen.getByText(/From disk/)).toBeInTheDocument());
		// The channel reads a `$ref` target by resolving it against the spec's
		// own directory, so the file's own base name reads exactly that file -
		// see the comment on `importPendingFile`.
		expect(readSpecFile).toHaveBeenCalledWith("/Users/me/specs/spec.json", "spec.json");
	});

	/*
	 * Mutation check: read `pendingPath` without clearing it (drop
	 * `takePendingPath`'s `set` call), and the store still names this path the
	 * next time anything asks - which is what would import it a second time.
	 */
	it("clears the pending path once it has been read", async () => {
		stubParse(() => result({ collections: [collection({ requests: [request()] })] }));
		stubReadSpecFile(async () => ({
			bytes: new TextEncoder().encode("{}"),
			fileName: "spec.json",
		}));
		useImportModalStore.setState({ isOpen: true, pendingPath: "/tmp/spec.json" });

		renderModal();

		await waitFor(() => expect(useImportModalStore.getState().pendingPath).toBeNull());
	});

	it("reports an error when there is no gated channel to read through", async () => {
		// Outside Electron: no `readSpecFile` on the bridge at all.
		useImportModalStore.setState({ isOpen: true, pendingPath: "/tmp/spec.json" });

		renderModal();

		await waitFor(() =>
			expect(
				screen.getByText(/Could not read this file outside the desktop app/i)
			).toBeInTheDocument()
		);
	});

	it("reports the read's own failure as a sentence the user can act on", async () => {
		stubReadSpecFile(async () => {
			throw new Error("spec.json is larger than the 10 MB import limit.");
		});
		useImportModalStore.setState({ isOpen: true, pendingPath: "/tmp/spec.json" });

		renderModal();

		await waitFor(() =>
			expect(
				screen.getByText(/spec\.json is larger than the 10 MB import limit\./i)
			).toBeInTheDocument()
		);
	});
});
