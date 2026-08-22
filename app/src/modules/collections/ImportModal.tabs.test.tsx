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
 * Each import tab owns its own state (issue #893).
 *
 * The dialog kept one `phase`, one `entries`, one `error` and one `progress` for
 * all three tabs, and switching tab called `reset()` on them - which cleared the
 * display and did nothing whatever to the work. So a URL fetch started on the URL
 * tab went on running, and when it landed it wrote its preview into the shared
 * state: the document appeared on whichever tab the user had switched to, under a
 * dropzone or a paste box that had nothing to do with it, and the URL they typed
 * was gone.
 *
 * The property every case here holds down: **a tab shows its own work and
 * nobody else's.** The two that are easiest to get wrong are the ones about
 * *concurrency* - sibling keys of one record written from two async flows at
 * once - and the ones about *staleness*, where work outlives the state it was
 * started for.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = () => res();
	});
	return { promise, resolve };
}

type Gate = ReturnType<typeof deferred>;

/** The signal handed to the most recent `importFetch`. */
function lastSignal(): AbortSignal | undefined {
	return gate.signals[gate.signals.length - 1];
}

const gate = vi.hoisted(() => ({
	/** Held per document text, so one tab's parse can land while another waits. */
	parse: null as Gate | null,
	fetchHold: null as Gate | null,
	fetchTicks: [] as { received: number; total: number | null }[],
	/** Signals `importFetch` was handed, newest last. */
	signals: [] as (AbortSignal | undefined)[],
	/** Every `importEnvironments` value the parse was asked for. */
	parseOptions: [] as boolean[],
}));

vi.mock("@/queries/import", () => ({
	useImportMutation: () => ({
		mutateAsync: vi.fn().mockResolvedValue(undefined),
		isPending: false,
	}),
}));

vi.mock("@/services/api", async () => {
	const { ApiError } = await import("@/services/http-client");
	return {
		apiService: {
			importFetch: vi
				.fn()
				.mockImplementation(
					async (
						_url: string,
						_maxBytes: number | undefined,
						onProgress?: (p: { received: number; total: number | null }) => void,
						signal?: AbortSignal
					) => {
						gate.signals.push(signal);
						for (const tick of gate.fetchTicks) onProgress?.(tick);
						if (gate.fetchHold) await gate.fetchHold.promise;
						return { content: urlSpec, contentType: "application/json" };
					}
				),
			readDocument: async (text: string) => JSON.parse(text),
			parseImport: async (payload: {
				content: string;
				fileName?: string;
				importEnvironments?: boolean;
			}) => {
				gate.parseOptions.push(payload.importEnvironments !== false);
				if (gate.parse) await gate.parse.promise;
				const document = JSON.parse(payload.content) as Record<string, unknown>;
				const title =
					(document.info as { title?: string } | undefined)?.title ?? "Imported";
				if (title === "Broken") {
					throw new ApiError(400, "BAD_REQUEST", "Unrecognised format");
				}
				return {
					collections: [
						{
							// The collection's name, distinct from `meta.format` below:
							// the preview prints both, so a fixture that made them equal
							// would match twice and every assertion here would be
							// ambiguous rather than wrong.
							name: title,
							description: "",
							variables: {},
							auth: { mode: "none" as const },
							preRequestScript: "",
							postRequestScript: "",
							children: [],
							requests: [],
						},
					],
					environments: [],
					globals: {},
					meta: {
						format: "OpenAPI 3.0",
						...(payload.fileName ? { fileName: payload.fileName } : {}),
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
	};
});

import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";

/** A minimal OpenAPI document whose `info.title` is the name a preview shows. */
function spec(title: string): string {
	return JSON.stringify({ openapi: "3.0.0", info: { title, version: "1" }, paths: {} });
}
const urlSpec = spec("From URL");
const fileSpec = spec("From File");

function renderModal() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ImportModal />
		</QueryClientProvider>
	);
}

/** Radix tabs activate on mouseDown; a click alone does not switch the panel. */
function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

function dropFiles(...files: { name: string; text: string }[]) {
	fireEvent.drop(screen.getByText(/Drop files here/i).closest("button")!, {
		dataTransfer: {
			files: files.map((f) => new File([f.text], f.name, { type: "application/json" })),
		},
	});
}

function startUrlFetch(url = "https://example.com/spec.json") {
	selectTab(/URL/i);
	fireEvent.change(screen.getByPlaceholderText(/petstore/i), { target: { value: url } });
	fireEvent.click(screen.getByRole("button", { name: /^Fetch$/i }));
}

beforeEach(() => {
	gate.parse = null;
	gate.fetchHold = null;
	gate.fetchTicks = [];
	gate.signals = [];
	gate.parseOptions = [];
	useImportModalStore.setState({ isOpen: true });
});

describe("a tab shows its own work", () => {
	it("keeps a running fetch on the URL tab when the user looks at File", async () => {
		gate.fetchTicks = [{ received: 1024, total: 8192 }];
		gate.fetchHold = deferred();
		renderModal();
		startUrlFetch();
		await waitFor(() => expect(screen.getByRole("progressbar")).toBeInTheDocument());

		selectTab(/File/i);

		// The File tab is idle - it has done nothing - and the URL tab's download
		// is not on screen because it is not this tab's.
		expect(screen.getByText(/Drop files here/i)).toBeInTheDocument();
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

		selectTab(/URL/i);

		// And switching back shows exactly what was left running, the typed URL
		// included. `reset()` on tab change used to wipe both.
		expect(screen.getByRole("progressbar")).toBeInTheDocument();
		expect(screen.getByPlaceholderText(/petstore/i)).toHaveValue(
			"https://example.com/spec.json"
		);
	});

	it("lands a finished fetch on the URL tab, not on whichever tab is showing", async () => {
		// The bug, exactly: the preview appeared under the File tab's dropzone.
		gate.fetchHold = deferred();
		renderModal();
		startUrlFetch();
		await waitFor(() => expect(screen.getByRole("progressbar")).toBeInTheDocument());
		selectTab(/File/i);

		gate.fetchHold.resolve();
		// Nothing about the fetch may appear here, now or after it settles.
		await waitFor(() => expect(screen.getByText(/Drop files here/i)).toBeInTheDocument());
		expect(screen.queryByText("From URL")).not.toBeInTheDocument();

		selectTab(/URL/i);
		await waitFor(() => expect(screen.getByText("From URL")).toBeInTheDocument());
	});

	it("holds two tabs' results at the same time", async () => {
		renderModal();
		dropFiles({ name: "a.json", text: fileSpec });
		await waitFor(() => expect(screen.getByText("From File")).toBeInTheDocument());

		startUrlFetch();
		await waitFor(() => expect(screen.getByText("From URL")).toBeInTheDocument());
		// The File tab's preview is not this tab's and must not be here.
		expect(screen.queryByText("From File")).not.toBeInTheDocument();

		selectTab(/File/i);
		expect(screen.getByText("From File")).toBeInTheDocument();
	});

	it("keeps one tab's failure off the others", async () => {
		renderModal();
		dropFiles({ name: "bad.json", text: spec("Broken") });
		await waitFor(() => expect(screen.getByText(/Unrecognised format/i)).toBeInTheDocument());

		selectTab(/Paste JSON/i);

		expect(screen.queryByText(/Unrecognised format/i)).not.toBeInTheDocument();
	});

	it("survives a progress tick landing while another tab's detect is in flight", async () => {
		// Sibling keys of one record, written from two async flows at once. A
		// `setTabs({ ...tabs, url: ... })` over a stale snapshot silently clobbers
		// whichever landed first, and no sequential test can see it.
		gate.fetchHold = deferred();
		gate.fetchTicks = [{ received: 1024, total: 8192 }];
		renderModal();

		gate.parse = deferred();
		dropFiles({ name: "a.json", text: fileSpec });
		await waitFor(() => expect(screen.getByRole("progressbar")).toBeInTheDocument());

		startUrlFetch(); // Ticks progress into the URL slice while File is parsing.
		gate.parse.resolve();
		gate.fetchHold.resolve();

		await waitFor(() => expect(screen.getByText("From URL")).toBeInTheDocument());
		selectTab(/File/i);
		await waitFor(() => expect(screen.getByText("From File")).toBeInTheDocument());
	});
});

describe("an option toggle reaches every tab that holds a parse", () => {
	it("re-parses both tabs, not just the one on screen", async () => {
		renderModal();
		dropFiles({ name: "a.json", text: fileSpec });
		await waitFor(() => expect(screen.getByText("From File")).toBeInTheDocument());
		startUrlFetch();
		await waitFor(() => expect(screen.getByText("From URL")).toBeInTheDocument());

		gate.parseOptions = [];
		fireEvent.click(screen.getByText(/Import environments & variables/i));

		// Both tabs' entries were parsed under the old options; leaving one behind
		// means importing it later with a setting the checkbox says is off.
		await waitFor(() => expect(gate.parseOptions.length).toBe(2));
		expect(gate.parseOptions).toEqual([false, false]);
	});
});

describe("closing the dialog", () => {
	it("cancels a running fetch", async () => {
		gate.fetchHold = deferred();
		renderModal();
		startUrlFetch();
		await waitFor(() => expect(screen.getByRole("progressbar")).toBeInTheDocument());

		// The engine is reading megabytes; nobody is going to look at them.
		expect(lastSignal()?.aborted).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: /^Close$/i }));

		expect(lastSignal()?.aborted).toBe(true);
	});

	it("leaves nothing behind for the next time it opens", async () => {
		// `handleClose` never blocked on `detecting`, so this is reachable: the
		// detect finishes after the dialog is gone and writes a preview into the
		// state it reopens with.
		gate.parse = deferred();
		renderModal();
		dropFiles({ name: "a.json", text: fileSpec });
		await waitFor(() => expect(screen.getByRole("progressbar")).toBeInTheDocument());

		fireEvent.click(screen.getByRole("button", { name: /^Close$/i }));
		gate.parse.resolve();
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

		useImportModalStore.setState({ isOpen: true });
		await waitFor(() => expect(screen.getByText(/Drop files here/i)).toBeInTheDocument());
		expect(screen.queryByText("From File")).not.toBeInTheDocument();
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
	});
});
