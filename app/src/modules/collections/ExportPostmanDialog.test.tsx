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
 * Exporting a collection as a Postman Collection v2.1 document, from the dialog.
 *
 * The document itself is the engine's to test. What is left here is what the
 * user is told before the file lands: how much went out, how many secrets were
 * left empty, every kind of thing Postman had no place for - and that the
 * credentials switch asks the engine again rather than editing text here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import { withQueryClient } from "@/test/query-wrapper";
import type {
	Collection,
	PostmanExportNotes,
	PostmanExportRequest,
	PostmanExportResponse,
} from "@/types";

const exportPostman = vi.hoisted(() =>
	vi.fn<(payload: PostmanExportRequest) => Promise<PostmanExportResponse>>()
);

vi.mock("@/services/api", () => ({ apiService: { exportPostman } }));

const { default: ExportPostmanDialog } = await import("./ExportPostmanDialog");

function notes(overrides: Partial<PostmanExportNotes> = {}): PostmanExportNotes {
	return {
		requestsExported: 3,
		foldersExported: 1,
		secretsOmitted: 2,
		notCarried: [
			{ code: "load-test", count: 1, message: "Load-test settings" },
			{ code: "timer", count: 4, message: "Timers between steps" },
		],
		...overrides,
	};
}

function answer(overrides: Partial<PostmanExportResponse> = {}): PostmanExportResponse {
	return {
		text: '{\n  "info": { "name": "Petstore" }\n}\n',
		fileName: "Petstore.postman_collection.json",
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
	// `click` lives on HTMLElement, not on the anchor subclass.
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

function open(onOpenChange = vi.fn()) {
	render(
		withQueryClient(
			<ExportPostmanDialog collection={collection()} onOpenChange={onOpenChange} />
		)
	);
	return onOpenChange;
}

function assembling() {
	return screen.queryByRole("status", { name: "Assembling the collection" });
}

function deferred() {
	let settle!: (answer: PostmanExportResponse) => void;
	const promise = new Promise<PostmanExportResponse>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

function summaryLines() {
	return screen
		.getAllByRole("listitem")
		.filter((li) => !li.closest('[aria-labelledby="export-postman-not-carried"]'))
		.map((li) => li.textContent);
}

beforeEach(() => {
	vi.restoreAllMocks();
	exportPostman.mockReset();
	exportPostman.mockResolvedValue(answer());
});

describe("ExportPostmanDialog", () => {
	it("asks for the collection with credentials left out by default", async () => {
		open();
		await screen.findByText("Postman Collection");
		expect(exportPostman).toHaveBeenCalledTimes(1);
		expect(exportPostman.mock.calls[0][0]).toEqual({
			collectionId: "col_1",
			includeSecrets: false,
		});
		expect(
			screen.getByRole("switch", { name: /Include credentials/ }).getAttribute("aria-checked")
		).toBe("false");
	});

	it("states what went out, the secrets left empty, and every note not carried", async () => {
		open();
		await screen.findByText("Postman Collection");

		expect(summaryLines()).toEqual([
			"3 requests exported",
			"1 folder exported",
			"2 secrets written empty",
		]);
		const notCarried = screen.getByRole("list", { name: "Not carried" });
		expect(
			within(notCarried)
				.getAllByRole("listitem")
				.map((li) => li.textContent)
		).toEqual(["Load-test settings (1)", "Timers between steps (4)"]);
	});

	it("says nothing about notes or secrets when there are none", async () => {
		exportPostman.mockResolvedValue(
			answer({ notes: notes({ secretsOmitted: 0, notCarried: [] }) })
		);
		open();
		await screen.findByText("Postman Collection");

		expect(summaryLines()).toEqual(["3 requests exported", "1 folder exported"]);
		expect(screen.queryByRole("list", { name: "Not carried" })).toBeNull();
	});

	it("asks the engine again with includeSecrets when credentials are switched on", async () => {
		open();
		await screen.findByText("Postman Collection");

		const withSecrets = deferred();
		exportPostman.mockReturnValue(withSecrets.promise);
		fireEvent.click(screen.getByRole("switch", { name: /Include credentials/ }));

		await waitFor(() => expect(exportPostman).toHaveBeenCalledTimes(2));
		expect(exportPostman.mock.calls[1][0]).toEqual({
			collectionId: "col_1",
			includeSecrets: true,
		});
		expect(screen.getByText(/written as stored/)).toBeTruthy();

		// The previous answer stays on screen while the new one assembles (issue
		// #1311), but its secrets count belongs to the switch's old position,
		// and neither button may hand out the text that was read without them.
		await waitFor(() => expect(assembling()).not.toBeNull());
		expect(summaryLines()).toEqual(["3 requests exported", "1 folder exported"]);
		expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
			true
		);
		expect(screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled")).toBe(true);

		withSecrets.settle(
			answer({
				text: '{"auth":"s3cret"}',
				notes: notes({ secretsOmitted: 0 }),
			})
		);
		await waitFor(() => expect(assembling()).toBeNull());
		expect(summaryLines()).toEqual(["3 requests exported", "1 folder exported"]);
	});

	it("downloads the engine's text under the engine's file name, and closes", async () => {
		const download = captureDownload();
		const onOpenChange = open();
		await screen.findByText("Postman Collection");

		fireEvent.click(screen.getByRole("button", { name: "Download" }));

		const saved = await download.read();
		expect(saved).toEqual({
			fileName: "Petstore.postman_collection.json",
			type: "application/json",
			text: '{\n  "info": { "name": "Petstore" }\n}\n',
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("copies the engine's text", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		open();
		await screen.findByText("Postman Collection");

		fireEvent.click(screen.getByRole("button", { name: "Copy" }));

		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith('{\n  "info": { "name": "Petstore" }\n}\n')
		);
	});

	it("holds the summary's footprint on the first read", async () => {
		const first = deferred();
		exportPostman.mockReturnValue(first.promise);
		open();

		const placeholder = screen.getByRole("status", { name: "Assembling the collection" });
		expect(placeholder.className).toContain("surface-sunken");
		expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
			true
		);

		first.settle(answer());
		expect(await screen.findByText("Postman Collection")).toBeTruthy();
		expect(assembling()).toBeNull();
	});

	it("shows the engine's sentence when there is no collection, and downloads nothing", async () => {
		exportPostman.mockRejectedValue(new Error("Collection 'col_1' not found"));
		open();

		expect(await screen.findByText("Couldn't assemble the collection")).toBeTruthy();
		expect(screen.getByText(/not found/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
			true
		);
		expect(screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled")).toBe(true);
	});
});
