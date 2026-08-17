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
 * Exporting a collection as an OpenAPI document, from the dialog (issue #630).
 *
 * What the exporter's own suite cannot check is what the *user* is told before a
 * file lands in their downloads folder: which of the two directions is about to
 * run, what the export could not carry, and that a document the engine would not
 * give up stops the export instead of silently downgrading it to a skeleton.
 * Those four are what this file locks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { withQueryClient } from "@/test/query-wrapper";
import type { Collection, Request, RequestExample } from "@/types";

const specQuery = {
	data: undefined as { content: string } | undefined,
	isLoading: false,
	isError: false,
};

let requests: Request[] = [];
let examples: RequestExample[] = [];

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: [{ id: "col_1", name: "Petstore", parentId: undefined }] }),
	useMultipleCollectionRequests: () => ({
		requestsByCollection: new Map([["col_1", requests]]),
		isLoading: false,
	}),
}));

vi.mock("@/queries/specs", () => ({ useSpecQuery: () => specQuery }));

vi.mock("@/services/api", () => ({
	apiService: { listRequestExamples: () => Promise.resolve(examples) },
}));

const { default: ExportSpecDialog } = await import("./ExportSpecDialog");

const SPEC = JSON.stringify({
	openapi: "3.0.3",
	info: { title: "Petstore", version: "1.0.0" },
	paths: {
		"/pets": { get: { operationId: "listPets", responses: { "200": { description: "ok" } } } },
		"/owners": {
			get: { operationId: "listOwners", responses: { "200": { description: "ok" } } },
		},
	},
});

function collection(bound: boolean): Collection {
	return {
		id: "col_1",
		name: "Petstore",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		...(bound ? { openapi: { specId: "spec_1", specHash: "abc123", syncedAt: 1 } } : {}),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function request(overrides: Partial<Request> = {}): Request {
	return {
		id: "req_1",
		collectionId: "col_1",
		name: "List pets",
		description: "",
		method: "GET",
		url: "{{baseUrl}}/pets",
		params: [],
		headers: [],
		body: { mode: "none" },
		bodyType: "none",
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		followRedirects: true,
		maxRedirects: 10,
		verifySSL: true,
		httpVersion: "auto",
		stream: false,
		order: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/** The Blob a Download click hands the browser, as text. */
function captureDownload() {
	const captured = { fileName: "", text: "", type: "" };
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
		const blob = blobs.get(this.href);
		captured.type = blob?.type ?? "";
	});
	return {
		async read(): Promise<{ fileName: string; type: string; text: string }> {
			const all = [...blobs.values()];
			const blob = all[all.length - 1];
			captured.text = blob ? await blob.text() : "";
			return captured;
		},
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	requests = [];
	examples = [];
	specQuery.data = { content: SPEC };
	specQuery.isLoading = false;
	specQuery.isError = false;
});

describe("ExportSpecDialog", () => {
	it("says it is updating the collection's own document, and names what it left out", async () => {
		requests = [
			request({ specOperation: { operationId: "listPets", method: "GET", path: "/pets" } }),
			request({ id: "req_2", name: "Health", url: "{{baseUrl}}/health" }),
		];
		render(
			withQueryClient(
				<ExportSpecDialog collection={collection(true)} onOpenChange={vi.fn()} />
			)
		);

		expect(await screen.findByText(/own document, updated/)).toBeTruthy();
		expect(screen.getByText(/OpenAPI 3.0.3/)).toBeTruthy();
		// `/owners` had no request; the second request has no identity. Both are
		// stated rather than quietly resolved either way.
		// The counts are one list item each, and each item mixes an element with
		// text - so they are read as text content rather than matched node by node.
		const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(lines).toContain("1 operation removed - nothing here claims it");
		expect(lines).toContain(
			"1 request with no operation identity - not written, bind the collection to give them one"
		);
		expect(lines).toContain("1 request exported as an operation");
	});

	it("downloads the updated document under the collection's name, in the chosen format", async () => {
		requests = [
			request({ specOperation: { operationId: "listPets", method: "GET", path: "/pets" } }),
		];
		const download = captureDownload();
		render(
			withQueryClient(
				<ExportSpecDialog collection={collection(true)} onOpenChange={vi.fn()} />
			)
		);

		// The summary appearing is what says the three reads are in - Download is
		// disabled until then, and a click on a disabled button is not a download.
		await screen.findByText(/own document, updated/);
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		const json = await download.read();
		expect(json.fileName).toBe("petstore.openapi.json");
		expect(json.type).toBe("application/json");
		const parsed = JSON.parse(json.text);
		expect(Object.keys(parsed.paths)).toEqual(["/pets"]);

		fireEvent.click(screen.getByRole("radio", { name: "YAML" }));
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		const asYaml = await download.read();
		expect(asYaml.fileName).toBe("petstore.openapi.yaml");
		expect(asYaml.text.startsWith("openapi: 3.0.3")).toBe(true);
	});

	it("calls a free-form collection's export a starting point, not a contract", async () => {
		requests = [request({ specOperation: undefined })];
		render(
			withQueryClient(
				<ExportSpecDialog collection={collection(false)} onOpenChange={vi.fn()} />
			)
		);

		expect(await screen.findByText(/A skeleton document/)).toBeTruthy();
		expect(screen.getByText(/starting point, not a contract/)).toBeTruthy();
		expect(screen.getByText(/OpenAPI 3.1.0/)).toBeTruthy();
	});

	it("refuses to export at all when the bound document cannot be read", async () => {
		specQuery.data = undefined;
		specQuery.isError = true;
		requests = [request()];
		render(
			withQueryClient(
				<ExportSpecDialog collection={collection(true)} onOpenChange={vi.fn()} />
			)
		);

		expect(await screen.findByText("The bound document could not be read")).toBeTruthy();
		// Not a skeleton behind the user's back: with nothing to update there is
		// nothing to download.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
				true
			)
		);
	});

	it("refuses to export a stored document it cannot parse", async () => {
		specQuery.data = { content: "openapi: [unclosed" };
		requests = [request()];
		render(
			withQueryClient(
				<ExportSpecDialog collection={collection(true)} onOpenChange={vi.fn()} />
			)
		);

		expect(await screen.findByText("The document could not be updated")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
			true
		);
	});
});
