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
 * What the import dialog says while it is working (issue #882).
 *
 * It said nothing. `phase === "detecting"` was set in three places and read by
 * nothing that renders, so the File tab kept showing the untouched dropzone for
 * the whole of a 13-file folder pick and the URL tab changed one word on a
 * button for the whole of an 8 MB download. "Written but never read", again.
 *
 * Every case here holds the work open and asserts on the dialog *mid-flight* -
 * which is the only moment any of this exists. A test that waited for the
 * preview would pass against a dialog that froze silently, which is the bug.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A promise the test releases when it wants the work to finish. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Held work, and the progress each stub should report before it lands. */
const gate = vi.hoisted(() => ({
	parse: null as { promise: Promise<void>; resolve: (v: void) => void } | null,
	apply: null as { promise: Promise<void>; resolve: (v: void) => void } | null,
	/** Ticks `importFetch` reports to its `onProgress` before resolving. */
	fetchTicks: [] as { received: number; total: number | null }[],
	fetchHold: null as { promise: Promise<void>; resolve: (v: void) => void } | null,
}));

vi.mock("@/queries/import", () => ({
	useImportMutation: () => ({
		mutateAsync: vi.fn().mockImplementation(async () => {
			if (gate.apply) await gate.apply.promise;
		}),
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
						onProgress?: (p: { received: number; total: number | null }) => void
					) => {
						for (const tick of gate.fetchTicks) onProgress?.(tick);
						if (gate.fetchHold) await gate.fetchHold.promise;
						return { content: postman, contentType: "application/json" };
					}
				),
			readDocument: async (text: string) => JSON.parse(text),
			parseImport: async (payload: { content: string; fileName?: string }) => {
				if (gate.parse) await gate.parse.promise;
				const document = JSON.parse(payload.content) as Record<string, unknown>;
				const info = document.info as { schema?: string } | undefined;
				if (!info?.schema?.includes("v2.1.0")) {
					throw new ApiError(400, "BAD_REQUEST", "Unrecognised format");
				}
				return {
					collections: [
						{
							name: "Imported",
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
						format: "Postman Collection v2.1",
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

const postman = readFileSync(
	join(__dirname, "../../services/importers/__fixtures__", "postman-v21.json"),
	"utf8"
);

function renderModal() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ImportModal />
		</QueryClientProvider>
	);
}

function file(name: string): File {
	return new File([postman], name, { type: "application/json" });
}

function drop(...files: File[]) {
	fireEvent.drop(screen.getByText(/Drop files here/i).closest("button")!, {
		dataTransfer: { files },
	});
}

/** Switch to the URL tab and fetch a document. */
function fetchUrl(url = "https://example.com/spec.json") {
	// Radix tabs activate on mouseDown; a click alone does not switch the panel.
	const tab = screen.getByRole("tab", { name: /URL/i });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
	fireEvent.change(screen.getByPlaceholderText(/petstore/i), { target: { value: url } });
	fireEvent.click(screen.getByRole("button", { name: /^Fetch$/i }));
}

beforeEach(() => {
	gate.parse = null;
	gate.apply = null;
	gate.fetchHold = null;
	gate.fetchTicks = [];
	useImportModalStore.setState({ isOpen: true });
});

describe("URL fetch progress", () => {
	it("draws the fraction of a download whose size the server declared", async () => {
		gate.fetchTicks = [{ received: 4_404_019, total: 8_808_038 }];
		gate.fetchHold = deferred<void>();
		renderModal();

		fetchUrl();

		const bar = await screen.findByRole("progressbar");
		expect(bar).toHaveAttribute("aria-valuenow", "50");
		// The figures, not just the bar: a bar alone cannot say whether a stalled
		// download has moved at all.
		expect(screen.getByText(/4\.2 MB of 8\.4 MB/)).toBeInTheDocument();

		gate.fetchHold.resolve();
	});

	it("draws bytes received when the server declared no size", async () => {
		gate.fetchTicks = [{ received: 2_411_724, total: null }];
		gate.fetchHold = deferred<void>();
		renderModal();

		fetchUrl();

		const bar = await screen.findByRole("progressbar");
		// Busy, not 0% - the download is somewhere in the middle of itself and the
		// upstream declared nothing to be a fraction of.
		expect(bar).toHaveAttribute("aria-busy", "true");
		expect(bar).not.toHaveAttribute("aria-valuenow");
		expect(screen.getByText(/2\.3 MB received/)).toBeInTheDocument();

		gate.fetchHold.resolve();
	});
});

describe("file and folder progress", () => {
	it("counts the documents it is reading", async () => {
		gate.parse = deferred<void>();
		renderModal();

		drop(file("a.json"), file("b.json"), file("c.json"));

		// The stages run in order - files off disk, then `$ref`s, then one engine
		// parse each - so this waits for the one the gate is holding rather than
		// asserting on whichever it caught. Both the name and the count: a count
		// with no stage behind it does not say what is taking the time.
		await waitFor(() => expect(screen.getByText("Reading documents")).toBeInTheDocument());
		expect(screen.getByText(/0 of 3 files/)).toBeInTheDocument();

		gate.parse.resolve();
		await waitFor(() => expect(screen.getByText("3 files")).toBeInTheDocument());
	});

	it("stops showing progress once the preview is up", async () => {
		renderModal();

		drop(file("a.json"));

		await waitFor(() =>
			expect(screen.getByText(/Postman Collection v2\.1/)).toBeInTheDocument()
		);
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
	});
});

describe("apply progress", () => {
	it("counts the files it is importing", async () => {
		renderModal();
		drop(file("a.json"), file("b.json"));
		await waitFor(() => expect(screen.getByText("2 files")).toBeInTheDocument());

		gate.apply = deferred<void>();
		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));

		// The apply is one transaction per file and always was; before this the
		// only sign of it was a button that read "Importing…" for all of them.
		await waitFor(() => expect(screen.getByRole("progressbar")).toBeInTheDocument());
		expect(screen.getByText(/0 of 2 files/)).toBeInTheDocument();

		gate.apply.resolve();
	});
});
