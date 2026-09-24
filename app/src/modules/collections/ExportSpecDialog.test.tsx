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
		examplesAlreadyDeclared: 0,
		examplesSampledAtImport: 0,
		sharedParametersLeft: 0,
		referencedResponsesLeft: 0,
		bodiesNotWritten: 0,
		rowsNotDeclared: 0,
		operationsEdited: 0,
		vocabularyNotWritten: false,
		secretsOmitted: 0,
		requestsOnlyInExtension: 0,
		operationsAdded: 0,
		boundMode: "contract",
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

function collection(overrides: Partial<Collection> = {}): Collection {
	return {
		id: "col_1",
		name: "Petstore",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
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

function open(overrides: Partial<Collection> = {}) {
	render(
		withQueryClient(
			<ExportSpecDialog collection={collection(overrides)} onOpenChange={vi.fn()} />
		)
	);
}

/** A collection bound to a stored document - the one kind asked how much to write. */
const BOUND: Partial<Collection> = { openapi: { specId: "spec_1", specHash: "h", syncedAt: 1 } };

/**
 * The one question both in-flight indicators answer (issue #1311): the
 * placeholder card on the first read, the spinner beside the toggle once there
 * is a summary to keep. Asking it by role rather than by sentence is what lets
 * the two forms share an assertion.
 */
function assembling() {
	return screen.queryByRole("status", { name: "Assembling the document" });
}

/** An export the test resolves by hand, to hold the dialog mid-read. */
function deferred() {
	let settle!: (answer: SpecExportResponse) => void;
	const promise = new Promise<SpecExportResponse>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

beforeEach(() => {
	vi.restoreAllMocks();
	exportSpec.mockReset();
	exportSpec.mockResolvedValue(answer());
});

describe("ExportSpecDialog", () => {
	it("says it is updating the collection's own document, and names what it left out", async () => {
		open();

		expect(await screen.findByText(/values updated/)).toBeTruthy();
		expect(screen.getByText(/OpenAPI 3.0.3/)).toBeTruthy();
		// The counts are one list item each, and each item mixes an element with
		// text - so they are read as text content rather than matched node by node.
		const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(lines).toEqual([
			"1 request exported",
			"1 new request not added - choose All edits",
			"1 unused operation removed",
		]);
	});

	it("lists only the counts that happened, but always the headline", async () => {
		exportSpec.mockResolvedValue(
			answer({
				notes: notes({
					requestsExported: 0,
					requestsWithoutOperation: 0,
					operationsRemoved: 0,
				}),
			})
		);
		open();

		await screen.findByText(/values updated/);
		const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(lines).toEqual(["0 requests exported"]);
	});

	it("names what a bound export could not write in, singular and plural alike", async () => {
		exportSpec.mockResolvedValue(
			answer({
				notes: notes({
					examplesAlreadyDeclared: 2,
					examplesSampledAtImport: 1,
					referencedResponsesLeft: 1,
					bodiesNotWritten: 3,
					rowsNotDeclared: 1,
					operationsEdited: 1,
					operationsNotInDocument: 1,
					examplesWithoutMediaType: 1,
					examplesTruncated: 1,
				}),
			})
		);
		open();

		expect(await screen.findByText(/values updated/)).toBeTruthy();
		const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(lines).toContain("2 examples already in the spec");
		expect(lines).toContain("3 request bodies not written");
		expect(lines).toContain("1 added parameter not written");
		expect(lines).toContain("1 request no longer in the spec - skipped");
		// Two reasons, one outcome for the reader: the status is there, the body is not.
		expect(lines).toContain("2 examples without a body");
		// $ref internals and import-time samples lose nothing the user made; the
		// engine's notes still carry them for MCP.
		expect(lines.some((line) => /\$ref|sampled|stamped/.test(line ?? ""))).toBe(false);
	});

	it("tells a Swagger 2.0 contract export that values need All edits", async () => {
		exportSpec.mockResolvedValue(
			answer({ notes: notes({ dialect: "Swagger 2.0", vocabularyNotWritten: true }) })
		);
		open(BOUND);

		expect(
			await screen.findByText(
				"Swagger 2.0: values are not updated in this mode. Choose All edits to write them."
			)
		).toBeTruthy();
	});

	it("downloads the document under the name the engine gave it, in the chosen format", async () => {
		const download = captureDownload();
		open();

		// The summary appearing is what says the read is in - Download is disabled
		// until then, and a click on a disabled button is not a download.
		await screen.findByText(/values updated/);
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
		expect(exportSpec.mock.calls[1][0]).toEqual({
			collectionId: "col_1",
			format: "yaml",
			mode: "contract",
		});
		// The other format is a second read, not a re-render: the in-flight
		// indicator going away is what says its answer is the one Download holds.
		await waitFor(() => expect(assembling()).toBeNull());
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

		expect(await screen.findByText(/New OpenAPI document/)).toBeTruthy();
		expect(screen.getByText(/A starting point/)).toBeTruthy();
		expect(screen.getByText(/OpenAPI 3.1.0/)).toBeTruthy();
	});

	it("names what a free-form export carries only as an extension, and the secrets it left out", async () => {
		exportSpec.mockResolvedValue(
			answer({
				notes: notes({
					direction: "skeleton",
					dialect: "OpenAPI 3.1.0",
					boundMode: "",
					operationsRemoved: 1,
					requestsWithoutOperation: 0,
					requestsOnlyInExtension: 1,
					secretsOmitted: 3,
				}),
			})
		);
		open();

		expect(await screen.findByText(/New OpenAPI document/)).toBeTruthy();
		expect(screen.getByText(/so Vayu can re-import it/)).toBeTruthy();
		const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(lines).toContain("1 request not visible to other tools");
		expect(lines).toContain("3 secrets exported empty");
		// A skeleton has no document of its own: nothing was removed from one,
		// even when the notes carry a stray count.
		expect(lines.some((line) => line?.includes("removed"))).toBe(false);
	});

	it("asks a bound collection how much to write, and keeps the contract by default", async () => {
		open(BOUND);
		await screen.findByText(/values updated/);
		expect(exportSpec.mock.calls[0][0].mode).toBe("contract");

		exportSpec.mockResolvedValue(
			answer({ notes: notes({ boundMode: "full", operationsAdded: 2, secretsOmitted: 1 }) })
		);
		// The hint under the toggle says what the chosen mode does.
		expect(screen.getByText(/The spec's structure stays as it is/)).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: "All edits" }));
		await waitFor(() => expect(exportSpec).toHaveBeenCalledTimes(2));
		expect(exportSpec.mock.calls[1][0]).toEqual({
			collectionId: "col_1",
			format: "json",
			mode: "full",
		});
		expect(await screen.findByText(/all edits applied/)).toBeTruthy();
		expect(screen.getByText(/new requests included/)).toBeTruthy();
		const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(lines).toContain("2 new requests added");
		expect(lines).toContain("1 secret exported empty");
		// The contract mode's "not added" line says nothing about this one.
		expect(lines.some((line) => line?.includes("not added"))).toBe(false);
	});

	it("does not ask a free-form collection how much to write", async () => {
		open();
		await screen.findByText(/values updated/);
		expect(screen.queryByRole("radio", { name: "All edits" })).toBeNull();
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

		expect(await screen.findByText("Couldn't assemble the document")).toBeTruthy();
		expect(screen.getByText(/unexpected end of document/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
			true
		);
	});

	it("keeps the summary on screen while the other format assembles", async () => {
		const download = captureDownload();
		open();
		await screen.findByText(/values updated/);

		const yaml = deferred();
		exportSpec.mockReturnValue(yaml.promise);
		fireEvent.click(screen.getByRole("radio", { name: "YAML" }));

		// The card is what used to be torn down for a one-line spinner, taking
		// ~200px of a self-centring dialog with it. It states properties of the
		// collection, which the serialisation does not change, so it stays - and
		// the read says so beside the toggle instead.
		await waitFor(() => expect(assembling()).not.toBeNull());
		expect(screen.getByText(/values updated/)).toBeTruthy();
		expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
		// What is held under it is still JSON's text, so neither button may act
		// on it: a Copy here would put JSON on the clipboard under a YAML toggle.
		expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
			true
		);
		expect(screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled")).toBe(true);

		yaml.settle(answer({ text: "openapi: 3.0.3\n", fileName: "petstore.openapi.yaml" }));
		await waitFor(() => expect(assembling()).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		expect((await download.read()).fileName).toBe("petstore.openapi.yaml");
	});

	it("opens at the summary's height instead of growing into it", async () => {
		const first = deferred();
		exportSpec.mockReturnValue(first.promise);
		open();

		// The first read has no previous answer to keep, so it holds the card's
		// footprint: the summary's own box with rows in it, not a line of text
		// the arriving card would push the dialog's edges away from.
		const placeholder = screen.getByRole("status", { name: "Assembling the document" });
		expect(placeholder.className).toContain("surface-sunken");
		// A heading bar, one for the sentence under it, and a typical answer's
		// rows. jsdom measures no heights, so the row count those heights come
		// from is what a test can hold.
		expect(placeholder.querySelectorAll('[data-slot="skeleton"]').length).toBe(6);

		first.settle(answer());
		expect(await screen.findByText(/values updated/)).toBeTruthy();
		expect(assembling()).toBeNull();
	});

	it("does not leave the previous format's summary under an error", async () => {
		open();
		await screen.findByText(/values updated/);

		exportSpec.mockRejectedValue(new Error("The stored document could not be read"));
		fireEvent.click(screen.getByRole("radio", { name: "YAML" }));

		// Keeping the previous answer is for a read that is still coming, not one
		// that failed: what is on screen has to be the format on the toggle, and
		// there is nothing to download for it.
		expect(await screen.findByText("Couldn't assemble the document")).toBeTruthy();
		expect(screen.queryByText(/values updated/)).toBeNull();
		expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
			true
		);
	});

	it("asks for each format once, so toggling back is free", async () => {
		open();

		await screen.findByText(/values updated/);
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
