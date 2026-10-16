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
 * The count line under a parsed file reads the same wherever the file appears
 * (#2248): the single-file preview and a batch ledger row both go through
 * `describeCounts`, so neither can drift back to "1 requests" or to a
 * "collections" count that is really folders.
 *
 * The single-file preview adds a second line for what came along - variables,
 * auth, scripts (#2249) - and none when there is nothing to say.
 *
 * Mutation check: restore an inline template in either site and the
 * matching case fails.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

const POSTMAN_FILE_LINE = "1 request · 3 folders · 0 examples";

function stubPostmanFile() {
	stubParse(() =>
		result({
			collections: [collection({ name: "Pets", requests: [request({ name: "List pets" })] })],
			meta: { folderCount: 3 },
		})
	);
}

function previewPastedFile() {
	renderModal();
	const tab = screen.getByRole("tab", { name: /Paste JSON/i });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), {
		target: { value: JSON.stringify({ any: "document" }) },
	});
	fireEvent.click(screen.getByRole("button", { name: /Detect and preview/i }));
}

describe("the import preview's count line", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		useImportModalStore.setState({ isOpen: true });
	});

	it("describes a single file with plurals and no environment segments", async () => {
		stubPostmanFile();
		previewPastedFile();

		await waitFor(() => expect(screen.getByText(POSTMAN_FILE_LINE)).toBeInTheDocument());
		expect(screen.queryByText(/·.*(environment|global)/i)).not.toBeInTheDocument();
	});

	it("describes a batch row the same way", async () => {
		stubPostmanFile();
		renderModal();
		const files = ["one.json", "two.json"].map(
			(name) => new File(["{}"], name, { type: "application/json" })
		);
		fireEvent.drop(screen.getByText(/Drop files here/i).closest("button")!, {
			dataTransfer: { files },
		});

		await waitFor(() => expect(screen.getByText("2 files")).toBeInTheDocument());
		for (const name of ["one.json", "two.json"]) {
			const row = screen.getByLabelText(name).closest("label")!;
			expect(within(row).getByText(POSTMAN_FILE_LINE)).toBeInTheDocument();
		}
	});

	it("says what came along under the counts, and nothing when nothing did", async () => {
		stubParse(() =>
			result({
				collections: [
					collection({
						name: "Pets",
						variables: { baseUrl: { value: "https://x.test", enabled: true } },
						children: [
							collection({
								requests: [
									request({ auth: { mode: "bearer", token: "t" } }),
									request({
										elements: [
											{
												kind: "script.pre",
												enabled: true,
												config: { script: "a()" },
											},
										],
									}),
								],
							}),
						],
					}),
				],
			})
		);
		previewPastedFile();

		await waitFor(() =>
			expect(
				screen.getByText(
					"Carried over: 1 variable · auth on 1 request · scripts on 1 request"
				)
			).toBeInTheDocument()
		);
	});

	it("renders no second line for a file with nothing to carry over", async () => {
		stubPostmanFile();
		previewPastedFile();

		const counts = await screen.findByText(POSTMAN_FILE_LINE);
		expect(screen.queryByText(/Carried over/)).not.toBeInTheDocument();
		const lines = [...counts.parentElement!.querySelectorAll("p")];
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => line.textContent !== "")).toBe(true);
	});
});
