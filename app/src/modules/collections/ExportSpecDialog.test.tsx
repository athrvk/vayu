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
 * Exporting a collection as an OpenAPI document, from the dialog (issue #630,
 * assembled engine-side since #855).
 *
 * What the engine's own suite cannot check is what the *user* is told before a
 * file lands in their downloads folder: which of the two directions ran, what
 * the export could not carry, and that a document the engine refused stops the
 * export instead of silently downgrading it to a skeleton. Those are what this
 * file locks, plus the one thing that is still the renderer's decision - that
 * each format is asked for once, so toggling back is free.
 *
 * The assembly itself is no longer here to test: the subtree walk, its boundary
 * at a nested binding (#721) and every rule about what is written are
 * `engine/tests/spec_export_route_test.cpp` and `openapi_export_test.cpp`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { withQueryClient } from "@/test/query-wrapper";
import type { Collection, ExportNotes, SpecExportRequest, SpecExportResponse } from "@/types";

const exportSpec = vi.hoisted(() =>
	vi.fn<(payload: SpecExportRequest) => Promise<SpecExportResponse>>()
);

vi.mock("@/services/api", () => ({ apiService: { exportSpec } }));

const { default: ExportSpecDialog } = await import("./ExportSpecDialog");

function notes(overrides: Partial<ExportNotes> = {}): ExportNotes {
	return {
		direction: "document",
		dialect: "OpenAPI 3.0.3",
		requestsExported: 1,
		requestsWithoutOperation: 1,
		operationsNotInDocument: 0,
		operationsRemoved: 1,
		requestsWithoutPath: 0,
		duplicateOperations: 0,
		examplesWritten: 0,
		examplesWithoutMediaType: 0,
		examplesTruncated: 0,
		sharedParametersLeft: 0,
		vocabularyNotWritten: false,
		...overrides,
	};
}

function answer(overrides: Partial<SpecExportResponse> = {}): SpecExportResponse {
	return {
		text: '{\n  "openapi": "3.0.3"\n}\n',
		fileName: "petstore.openapi.json",
		notes: notes(),
		...overrides,
	};
}

function collection(): Collection {
	return {
		id: "col_1",
		name: "Petstore",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

/** The Blob a Download click hands the browser, as text. */
function captureDownload() {
	const captured = { fileName: "", type: "" };
	const blobs = new Map<string, Blob>();
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
		const url = `blob:${blobs.size}`;
		blobs.set(url, blob as Blob);
		return url;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	// `click` lives on HTMLElement, not on the anchor subclass - spying on the
	// subclass silently intercepts nothing.
	vi.spyOn(HTMLElement.prototype, "click").mockImplementation(function (this: HTMLElement) {
		if (!(this instanceof HTMLAnchorElement)) return;
		captured.fileName = this.download;
		captured.type = blobs.get(this.href)?.type ?? "";
	});
	return {
		async read(): Promise<{ fileName: string; type: string; text: string }> {
			const all = [...blobs.values()];
			const blob = all[all.length - 1];
			return { ...captured, text: blob ? await blob.text() : "" };
		},
	};
}

function open() {
	render(withQueryClient(<ExportSpecDialog collection={collection()} onOpenChange={vi.fn()} />));
}

beforeEach(() => {
	vi.restoreAllMocks();
	exportSpec.mockReset();
	exportSpec.mockResolvedValue(answer());
});

describe("ExportSpecDialog", () => {
	it("says it is updating the collection's own document, and names what it left out", async () => {
		open();

		expect(await screen.findByText(/own document, updated/)).toBeTruthy();
		expect(screen.getByText(/OpenAPI 3.0.3/)).toBeTruthy();
		// The counts are one list item each, and each item mixes an element with
		// text - so they are read as text content rather than matched node by node.
		const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(lines).toContain("1 operation removed - nothing here claims it");
		expect(lines).toContain(
			"1 request with no operation identity - not written, bind the collection to give them one"
		);
		expect(lines).toContain("1 request exported as an operation");
	});

	it("downloads the document under the name the engine gave it, in the chosen format", async () => {
		const download = captureDownload();
		open();

		// The summary appearing is what says the read is in - Download is disabled
		// until then, and a click on a disabled button is not a download.
		await screen.findByText(/own document, updated/);
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		const json = await download.read();
		expect(json.fileName).toBe("petstore.openapi.json");
		expect(json.type).toBe("application/json");
		expect(JSON.parse(json.text).openapi).toBe("3.0.3");

		exportSpec.mockResolvedValue(
			answer({ text: "openapi: 3.0.3\n", fileName: "petstore.openapi.yaml" })
		);
		fireEvent.click(screen.getByRole("radio", { name: "YAML" }));
		await waitFor(() => expect(exportSpec).toHaveBeenCalledTimes(2));
		expect(exportSpec.mock.calls[1][0]).toEqual({ collectionId: "col_1", format: "yaml" });
		// The other format is a second read, not a re-render: the pending line
		// going away is what says its answer is the one Download now holds.
		await waitFor(() => expect(screen.queryByText(/Assembling the document/)).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		const asYaml = await download.read();
		expect(asYaml.fileName).toBe("petstore.openapi.yaml");
		expect(asYaml.type).toBe("application/yaml");
		expect(asYaml.text.startsWith("openapi: 3.0.3")).toBe(true);
	});

	it("calls a free-form collection's export a starting point, not a contract", async () => {
		exportSpec.mockResolvedValue(
			answer({
				notes: notes({
					direction: "skeleton",
					dialect: "OpenAPI 3.1.0",
					operationsRemoved: 0,
					requestsWithoutOperation: 0,
				}),
			})
		);
		open();

		expect(await screen.findByText(/A skeleton document/)).toBeTruthy();
		expect(screen.getByText(/starting point, not a contract/)).toBeTruthy();
		expect(screen.getByText(/OpenAPI 3.1.0/)).toBeTruthy();
	});

	it("shows the engine's own sentence when there is no document, and downloads nothing", async () => {
		// Not a skeleton behind the user's back: a skeleton in place of the
		// document the user believes they are updating would drop every member of
		// their spec Vayu does not model. With nothing to update there is nothing
		// to download.
		exportSpec.mockRejectedValue(
			new Error("The stored document could not be read: line 1: unexpected end of document")
		);
		open();

		expect(await screen.findByText("The document could not be assembled")).toBeTruthy();
		expect(screen.getByText(/unexpected end of document/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
			true
		);
	});

	it("asks for each format once, so toggling back is free", async () => {
		open();

		await screen.findByText(/own document, updated/);
		fireEvent.click(screen.getByRole("radio", { name: "YAML" }));
		await waitFor(() => expect(exportSpec).toHaveBeenCalledTimes(2));
		fireEvent.click(screen.getByRole("radio", { name: "JSON" }));

		// The JSON answer is still the one that was fetched first: a toggle back
		// reads the cache rather than assembling the document again.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
				false
			)
		);
		expect(exportSpec.mock.calls.map((call) => call[0].format)).toEqual(["json", "yaml"]);
	});
});
