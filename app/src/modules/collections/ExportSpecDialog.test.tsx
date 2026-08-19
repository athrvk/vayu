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
 *
 * It also owns the two questions that live between the hook and the exporter
 * (issue #721): which collections the subtree walk reaches, since a nested
 * binding answers to a document of its own, and that assembly happens off the
 * render pass, since neither the hook nor the exporter can see when it ran.
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
/** Collections beyond the root, for the nested-binding cases. */
let extraCollections: Array<Partial<Collection> & { id: string; parentId?: string }> = [];
/** Requests filed under a collection other than the root. */
let requestsByOtherCollection = new Map<string, Request[]>();
let requestsMemo: {
	key: string;
	rows: Request[];
	value: { requestsByCollection: Map<string, Request[]>; isLoading: boolean };
} = { key: "", rows: [], value: { requestsByCollection: new Map(), isLoading: false } };

/** How many times the exporter actually assembled a document. */
const assembled = vi.hoisted(() => vi.fn<(format: string) => void>());
/**
 * Whether the pending line was on screen at the moment each assembly ran.
 *
 * Read inside the exporter rather than polled from the test, because the pending
 * state is transient: a `findBy*` can miss it and report a freeze as a pass. An
 * assembly that runs from render cannot see its own pending line, so a `false`
 * here is exactly the defect.
 */
const pendingWhenAssembled = vi.hoisted(() => [] as boolean[]);

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({
		data: [{ id: "col_1", name: "Petstore", parentId: undefined }, ...extraCollections],
	}),
	// Pinned to its contents, the way the real hook pins the map `combine`
	// builds: it hands back the same object until the ids or the rows change,
	// and a mock rebuilding it every render would model a hook this app does
	// not have.
	useMultipleCollectionRequests: (ids: string[]) => {
		const key = ids.join(",");
		if (requestsMemo.key !== key || requestsMemo.rows !== requests) {
			requestsMemo = {
				key,
				rows: requests,
				value: {
					requestsByCollection: new Map([
						["col_1", requests],
						...[...requestsByOtherCollection].filter(([id]) => ids.includes(id)),
					]),
					isLoading: false,
				},
			};
		}
		return requestsMemo.value;
	},
}));

vi.mock("@/queries/specs", () => ({ useSpecQuery: () => specQuery }));

vi.mock("@/services/api", () => ({
	apiService: { listRequestExamples: () => Promise.resolve(examples) },
}));

// The real exporter, counted. Assembly cost is the point of the deferral, and
// only the number of times it ran says whether a format toggle re-paid it.
vi.mock("@/services/exporters/openapi", async (importActual) => {
	const actual = await importActual<typeof import("@/services/exporters/openapi")>();
	return {
		...actual,
		exportOpenApi: (input: Parameters<typeof actual.exportOpenApi>[0]) => {
			assembled(input.format);
			pendingWhenAssembled.push(
				document.body.textContent?.includes("Assembling the document") ?? false
			);
			return actual.exportOpenApi(input);
		},
	};
});

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
	assembled.mockClear();
	pendingWhenAssembled.length = 0;
	requests = [];
	examples = [];
	extraCollections = [];
	requestsByOtherCollection = new Map();
	requestsMemo = {
		key: "",
		rows: [],
		value: { requestsByCollection: new Map(), isLoading: false },
	};
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
		// The other format is assembled, not re-rendered: the click starts work
		// that finishes after a paint, so the button it enables is the signal.
		await waitFor(() => expect(assembled).toHaveBeenCalledTimes(2));
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

	it("leaves a nested collection bound to another document out of this one", async () => {
		// Collections re-parent freely, so spec B's collection can end up under
		// spec A's. Its request names `listOwners` - a name this document happens
		// to declare too, which is the whole hazard.
		extraCollections = [
			{
				id: "col_2",
				name: "Owners (another spec)",
				parentId: "col_1",
				openapi: { specId: "spec_2", specHash: "def456", syncedAt: 1 },
			},
		];
		requests = [
			request({ specOperation: { operationId: "listPets", method: "GET", path: "/pets" } }),
		];
		requestsByOtherCollection = new Map([
			[
				"col_2",
				[
					request({
						id: "req_foreign",
						collectionId: "col_2",
						name: "List owners of the other spec",
						specOperation: {
							operationId: "listOwners",
							method: "GET",
							path: "/owners",
						},
					}),
				],
			],
		]);
		const download = captureDownload();
		render(
			withQueryClient(
				<ExportSpecDialog collection={collection(true)} onOpenChange={vi.fn()} />
			)
		);

		await screen.findByText(/own document, updated/);
		const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(lines).toContain("1 request exported as an operation");
		// `/owners` is removed because nothing in *this* collection claims it -
		// the honest outcome. Without the boundary the foreign request claims it
		// and rewrites it instead.
		expect(lines).toContain("1 operation removed - nothing here claims it");
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		const json = JSON.parse((await download.read()).text);
		expect(Object.keys(json.paths)).toEqual(["/pets"]);
	});

	it("keeps a nested collection bound to the same document, which describes it too", async () => {
		extraCollections = [
			{
				id: "col_2",
				name: "Owners",
				parentId: "col_1",
				openapi: { specId: "spec_1", specHash: "abc123", syncedAt: 1 },
			},
		];
		requests = [
			request({ specOperation: { operationId: "listPets", method: "GET", path: "/pets" } }),
		];
		requestsByOtherCollection = new Map([
			[
				"col_2",
				[
					request({
						id: "req_owners",
						collectionId: "col_2",
						name: "List owners",
						specOperation: {
							operationId: "listOwners",
							method: "GET",
							path: "/owners",
						},
					}),
				],
			],
		]);
		const download = captureDownload();
		render(
			withQueryClient(
				<ExportSpecDialog collection={collection(true)} onOpenChange={vi.fn()} />
			)
		);

		await screen.findByText(/own document, updated/);
		const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
		// A descendant bound to the *same* document describes the operations being
		// patched. Stopping there would remove them as unclaimed - a deletion in
		// place of a rewrite, which is not an improvement.
		expect(lines).toContain("2 requests exported as an operation");
		expect(lines).toContain("0 operations removed - nothing here claims it");
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		const json = JSON.parse((await download.read()).text);
		expect(Object.keys(json.paths).sort()).toEqual(["/owners", "/pets"]);
	});

	it("assembles the document off the render pass, behind a line that says so", async () => {
		requests = [
			request({ specOperation: { operationId: "listPets", method: "GET", path: "/pets" } }),
		];
		render(
			withQueryClient(
				<ExportSpecDialog collection={collection(true)} onOpenChange={vi.fn()} />
			)
		);

		await screen.findByText(/own document, updated/);
		// Assembly happened while the pending line was on screen - which it cannot
		// be if the work runs during render.
		expect(pendingWhenAssembled).toEqual([true]);
	});

	it("assembles each format once, so toggling back is free", async () => {
		requests = [
			request({ specOperation: { operationId: "listPets", method: "GET", path: "/pets" } }),
		];
		render(
			withQueryClient(
				<ExportSpecDialog collection={collection(true)} onOpenChange={vi.fn()} />
			)
		);

		await screen.findByText(/own document, updated/);
		fireEvent.click(screen.getByRole("radio", { name: "YAML" }));
		await waitFor(() => expect(assembled).toHaveBeenCalledTimes(2));
		fireEvent.click(screen.getByRole("radio", { name: "JSON" }));

		// The JSON document is still the one that was assembled first: a toggle
		// back reads the cache rather than re-parsing the stored spec.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(
				false
			)
		);
		expect(assembled.mock.calls.map((call) => call[0])).toEqual(["json", "yaml"]);
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
