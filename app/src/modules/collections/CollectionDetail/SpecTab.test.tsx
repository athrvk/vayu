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
 * Binding a collection to an OpenAPI document (issue #638).
 *
 * Four things have to hold, and each is one a later phase builds on rather than
 * a detail of this tab:
 *
 *  - **The match result is disclosed before anything is written.** Sync (#627)
 *    acts on operation identity, so a user agreeing to a bind has to see how much
 *    of their collection it actually covers.
 *  - **Only matched requests are stamped**, and nothing is created or deleted -
 *    the leftovers on both sides are reported and left alone.
 *  - **Unbind sends `null`, not `{}`.** The engine reads absent as "keep"; an
 *    unbind is only expressible as an explicit null that survives to the wire.
 *  - **The path is remembered and the document is not.** The store holds where
 *    the file is; its contents live on the engine, hashed there.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useSpecFileStore } from "@/stores";
import type { Collection, Request } from "@/types";

const updateCollection = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

const bindSpec = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
	data: undefined as { failedStamps: string[] } | undefined,
};

const specQuery = {
	data: undefined as { sourceUrl: string | null; fetchedAt: number } | undefined,
	isLoading: false,
	isError: false,
};

let requests: Request[] = [];

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: [{ id: "col_1", name: "Pets", parentId: undefined }] }),
	useMultipleCollectionRequests: () => ({
		requestsByCollection: new Map([["col_1", requests]]),
		isLoading: false,
	}),
	useUpdateCollectionMutation: () => updateCollection,
}));

vi.mock("@/queries/specs", () => ({
	useSpecQuery: () => specQuery,
	useBindSpecMutation: () => bindSpec,
}));

const importFetch = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: { importFetch: (url: string) => importFetch(url) },
}));

// The bound half of the tab renders the Sync section (issue #654), which reads
// the engine's document cap. Stubbed here for the same reason the queries above
// are: this file renders the tab without a QueryClient, and the cap is asserted
// where it is used (`SpecSync.test.tsx`).
vi.mock("@/hooks/useSpecDocumentLimit", () => ({
	useSpecDocumentLimit: () => ({ maxBytes: 10 * 1024 * 1024 }),
}));

const { default: SpecTab } = await import("./SpecTab");

const OPENAPI = JSON.stringify({
	openapi: "3.0.0",
	info: { title: "Pets API" },
	servers: [{ url: "https://api.example.com" }],
	paths: {
		"/pets": { get: { operationId: "listPets" } },
		"/pets/{petId}": { get: { operationId: "getPet" } },
	},
});

const POSTMAN = JSON.stringify({
	info: { name: "Team", schema: "https://schema.getpostman.com/json/collection/v2.1.0/" },
	item: [],
});

const collection = (openapi?: Collection["openapi"]): Collection =>
	({
		id: "col_1",
		name: "Pets",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		openapi,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	}) as Collection;

const request = (id: string, url: string, specOperation?: Request["specOperation"]): Request =>
	({
		id,
		collectionId: "col_1",
		name: id,
		description: "",
		method: "GET",
		url,
		params: [],
		headers: [],
		body: { mode: "none" },
		bodyType: "none",
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		stream: false,
		specOperation,
		order: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	}) as Request;

/** Drive the hidden <input type="file"> the way the browser would. */
async function pickFile(name: string, text: string) {
	const input = document.querySelector('input[type="file"]') as HTMLInputElement;
	expect(input).toBeTruthy();
	fireEvent.change(input, { target: { files: [new File([text], name)] } });
	await waitFor(() => expect(screen.getByText(/Matched|Not an OpenAPI/)).toBeTruthy());
}

/** Resolve the bind the way TanStack would, running the caller's onSuccess. */
function bindSucceeds() {
	const [, options] = bindSpec.mutate.mock.calls[bindSpec.mutate.mock.calls.length - 1];
	options?.onSuccess?.({ stamped: 0, failedStamps: [] });
}

beforeEach(() => {
	updateCollection.mutate.mockClear();
	updateCollection.isPending = false;
	updateCollection.isError = false;
	bindSpec.mutate.mockClear();
	bindSpec.isPending = false;
	bindSpec.isError = false;
	bindSpec.data = undefined;
	specQuery.data = undefined;
	specQuery.isError = false;
	importFetch.mockReset();
	requests = [];
	useSpecFileStore.setState({ locations: {} });
	vi.stubGlobal("electronAPI", { getFilePath: () => "/home/u/petstore.json" });
});

describe("binding a collection that already has requests", () => {
	it("discloses matched and unmatched counts on both sides before binding", async () => {
		requests = [
			request("r1", "{{baseUrl}}/pets"),
			request("r2", "{{baseUrl}}/health"), // no operation
		];
		render(<SpecTab collection={collection()} />);

		await pickFile("petstore.json", OPENAPI);

		// One matched, one request left over, and one operation with no request -
		// all three, including the ones the user might rather not read.
		const summary = screen.getByText(/Matched 1 request/);
		expect(summary.textContent).toContain("1 request with no operation");
		expect(summary.textContent).toContain("1 operation with no request");
	});

	it("stamps only the matched requests, and remembers where the file is", async () => {
		requests = [request("r1", "{{baseUrl}}/pets"), request("r2", "{{baseUrl}}/health")];
		render(<SpecTab collection={collection()} />);
		await pickFile("petstore.json", OPENAPI);

		fireEvent.click(screen.getByRole("button", { name: /bind this spec/i }));

		const [payload] = bindSpec.mutate.mock.calls[0];
		expect(payload.collectionId).toBe("col_1");
		expect(payload.content).toBe(OPENAPI);
		// A file has no URL to re-fetch from, and the engine stores `null` rather
		// than an empty string for that.
		expect(payload.sourceUrl).toBeNull();
		expect(payload.stamps).toEqual([
			{
				requestId: "r1",
				specOperation: { operationId: "listPets", method: "GET", path: "/pets" },
			},
		]);

		bindSucceeds();
		expect(useSpecFileStore.getState().locations.col_1).toEqual({
			path: "/home/u/petstore.json",
			fileName: "petstore.json",
		});
	});

	it("sends the fetched URL as the document's origin, and remembers no path", async () => {
		importFetch.mockResolvedValue({ content: OPENAPI });
		render(<SpecTab collection={collection()} />);

		fireEvent.change(screen.getByPlaceholderText(/openapi.json/i), {
			target: { value: "https://api.example.com/openapi.json" },
		});
		fireEvent.click(screen.getByRole("button", { name: /fetch/i }));
		await waitFor(() => expect(screen.getByText(/Matched/)).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: /bind this spec/i }));
		expect(bindSpec.mutate.mock.calls[0][0].sourceUrl).toBe(
			"https://api.example.com/openapi.json"
		);

		bindSucceeds();
		// A URL-sourced document records its origin portably, engine-side; there
		// is no machine-local path to keep.
		expect(useSpecFileStore.getState().locations.col_1).toBeUndefined();
	});

	it("refuses a document that is not a spec, by name, and offers no bind", async () => {
		render(<SpecTab collection={collection()} />);

		await pickFile("team.postman.json", POSTMAN);

		// The parser that claimed it, named - "unrecognised format" would be a lie
		// about a file the app imports happily.
		expect(
			screen.getByText(/This is Postman Collection v2.1, not an OpenAPI document/i)
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /bind this spec/i })).toBeNull();
	});
});

describe("a bound collection", () => {
	const bound = () =>
		collection({ specId: "spec_1", specHash: "9f86d081884c7d659a2feaa0c55ad015", syncedAt: 0 });

	it("shows where the document came from, its hash and how much of the tree it covers", () => {
		specQuery.data = { sourceUrl: "https://api.example.com/openapi.json", fetchedAt: 0 };
		requests = [
			request("r1", "{{baseUrl}}/pets", {
				operationId: "listPets",
				method: "GET",
				path: "/pets",
			}),
			request("r2", "{{baseUrl}}/health"),
		];

		render(<SpecTab collection={bound()} />);

		expect(screen.getByText("https://api.example.com/openapi.json")).toBeTruthy();
		// Short enough to compare by eye, and it is the hash the run stamp uses.
		expect(screen.getByText("9f86d081884c")).toBeTruthy();
		expect(screen.getByText("1 of 2 requests")).toBeTruthy();
	});

	it("names the picked file when the document has no URL", () => {
		specQuery.data = { sourceUrl: null, fetchedAt: 0 };
		useSpecFileStore.setState({
			locations: { col_1: { path: "/home/u/petstore.json", fileName: "petstore.json" } },
		});

		render(<SpecTab collection={bound()} />);

		expect(screen.getByText("petstore.json")).toBeTruthy();
	});

	it("unbinds with an explicit null and forgets the remembered file", () => {
		useSpecFileStore.setState({
			locations: { col_1: { path: "/home/u/petstore.json", fileName: "petstore.json" } },
		});
		render(<SpecTab collection={bound()} />);

		fireEvent.click(screen.getByRole("button", { name: /unbind/i }));

		const [payload, options] = updateCollection.mutate.mock.calls[0];
		// `{}` would read as "keep" to the engine's merge-patch.
		expect(payload).toEqual({ id: "col_1", openapi: null });
		options?.onSuccess?.({});
		expect(useSpecFileStore.getState().locations.col_1).toBeUndefined();
	});

	it("offers no picker while a spec is bound - re-binding is sync's job", () => {
		render(<SpecTab collection={bound()} />);
		expect(screen.queryByRole("button", { name: /choose file/i })).toBeNull();
	});

	it("says which requests kept no identity when some stamps failed", async () => {
		bindSpec.data = { failedStamps: ["req_9"] };
		render(<SpecTab collection={bound()} />);
		expect(screen.getByText(/1 request kept no operation identity/i)).toBeTruthy();
	});
});
