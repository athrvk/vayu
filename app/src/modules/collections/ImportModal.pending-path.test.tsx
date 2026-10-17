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
 * and imports it like any other File-tab pick - including when it arrives while
 * the dialog is already open (#2275), where `isOpen` does not change.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportModal } from "./ImportModal";
import { useImportModalStore, useToastStore } from "@/stores";
import { apiService } from "@/services/api";
import { fileBaseName } from "@/lib/file-path";
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

beforeEach(() => {
	vi.restoreAllMocks();
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	useImportModalStore.setState({ isOpen: false, pendingPath: null, pendingFiles: [] });
	useToastStore.setState({ toasts: [] });
});

describe("ImportModal - a pending path from the OS", () => {
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
				screen.getByText(/Couldn't read this file outside the desktop app/i)
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

describe("ImportModal - a path from the OS while the dialog is open", () => {
	/** Each path reads back as a document named for it, and parses to a collection named for it. */
	function stubTwoSpecs() {
		stubParse((payload) =>
			result({
				collections: [
					collection({ name: `Parsed ${payload.fileName}`, requests: [request()] }),
				],
			})
		);
		return stubReadSpecFile(async (specPath) => {
			const fileName = fileBaseName(specPath);
			return { bytes: new TextEncoder().encode("{}"), fileName };
		});
	}

	const toastMessages = () => useToastStore.getState().toasts.map((t) => t.message);

	it("imports a path that arrives with the dialog already open, with no close and reopen", async () => {
		const readSpecFile = stubTwoSpecs();
		useImportModalStore.setState({ isOpen: true });
		renderModal();
		expect(readSpecFile).not.toHaveBeenCalled();

		act(() => useImportModalStore.getState().openWithFile("/tmp/a.json"));

		await waitFor(() => expect(screen.getByText(/Parsed a\.json/)).toBeInTheDocument());
		expect(readSpecFile).toHaveBeenCalledWith("/tmp/a.json", "a.json");
		expect(useImportModalStore.getState().isOpen).toBe(true);
		expect(useImportModalStore.getState().pendingPath).toBeNull();
		// Nothing was under review, so there is nothing to apologise for.
		expect(toastMessages()).toEqual([]);
	});

	it("replaces a preview on screen and says so, rather than dropping either file", async () => {
		const readSpecFile = stubTwoSpecs();
		useImportModalStore.setState({ isOpen: true, pendingPath: "/tmp/a.json" });
		renderModal();
		await waitFor(() => expect(screen.getByText(/Parsed a\.json/)).toBeInTheDocument());

		act(() => useImportModalStore.getState().openWithFile("/tmp/b.json"));

		await waitFor(() => expect(screen.getByText(/Parsed b\.json/)).toBeInTheDocument());
		expect(screen.queryByText(/Parsed a\.json/)).not.toBeInTheDocument();
		expect(readSpecFile).toHaveBeenCalledTimes(2);
		expect(toastMessages()).toEqual([expect.stringContaining('"b.json"')]);
	});

	it("refuses a path while an apply is in flight, and says so", async () => {
		const readSpecFile = stubTwoSpecs();
		// An apply that never answers: the dialog stays in the middle of it.
		vi.spyOn(apiService, "applyImport").mockImplementation(() => new Promise(() => {}));
		useImportModalStore.setState({ isOpen: true, pendingPath: "/tmp/a.json" });
		renderModal();
		await waitFor(() => expect(screen.getByText(/Parsed a\.json/)).toBeInTheDocument());
		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));
		await waitFor(() => expect(apiService.applyImport).toHaveBeenCalled());

		act(() => useImportModalStore.getState().openWithFile("/tmp/b.json"));

		await waitFor(() => expect(toastMessages()).toEqual([expect.stringContaining('"b.json"')]));
		// The apply's own preview is untouched, and the new file was never read.
		expect(screen.getByText(/Parsed a\.json/)).toBeInTheDocument();
		expect(readSpecFile).toHaveBeenCalledTimes(1);
		expect(useImportModalStore.getState().pendingPath).toBeNull();
	});
});
