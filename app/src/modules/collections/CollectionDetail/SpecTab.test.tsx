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
	data: undefined as { failedStamps: string[]; failedClears: string[] } | undefined,
};

const syncSpec = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

const specMetaQuery = {
	data: undefined as
		| { sourceUrl: string | null; fetchedAt: number; contentBytes: number }
		| undefined,
	isLoading: false,
	isError: false,
};

let requests: Request[] = [];
/** Whether the subtree's request lists have answered - the mapped count's input. */
let requestsLoading = false;

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: [{ id: "col_1", name: "Pets", parentId: undefined }] }),
	useMultipleCollectionRequests: () => ({
		requestsByCollection: new Map([["col_1", requests]]),
		isLoading: requestsLoading,
	}),
	useUpdateCollectionMutation: () => updateCollection,
}));

vi.mock("@/queries/specs", () => ({
	// The card describes the document rather than reading it (issue #712).
	useSpecMetaQuery: () => specMetaQuery,
	useBindSpecMutation: () => bindSpec,
	// The Sync section reads the stored bytes when Check is pressed. Stubbed
	// like the queries above - what a check does with them is asserted in
	// SpecSync.test.tsx.
	useSpecContentReader: () => () => new Promise(() => {}),
	// The Sync section's apply half (issue #655). Stubbed like the two above:
	// this file renders the tab without a QueryClient, and what a sync writes is
	// asserted in SpecSync.test.tsx.
	useSyncSpecMutation: () => syncSpec,
}));

// The bound half also carries the last run's contract coverage (issue #629).
// Stubbed for the same reason the queries above are - this file renders the tab
// without a QueryClient - and what the line says is asserted in
// SpecCoverageLine.test.tsx.
vi.mock("@/queries/runs", () => ({
	useLastCollectionRunQuery: () => ({ data: undefined }),
	useRunReportQuery: () => ({ data: undefined }),
}));

const importFetch = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: { importFetch: (url: string, maxBytes?: number) => importFetch(url, maxBytes) },
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
		verifySSL: true,
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
	options?.onSuccess?.({ stamped: 0, failedStamps: [], failedClears: [] });
}

beforeEach(() => {
	updateCollection.mutate.mockClear();
	updateCollection.isPending = false;
	updateCollection.isError = false;
	bindSpec.mutate.mockClear();
	bindSpec.isPending = false;
	bindSpec.isError = false;
	bindSpec.data = undefined;
	syncSpec.mutate.mockClear();
	syncSpec.isPending = false;
	syncSpec.isError = false;
	specMetaQuery.data = undefined;
	specMetaQuery.isLoading = false;
	specMetaQuery.isError = false;
	requestsLoading = false;
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

	// Issue #784. This tab only ever fetches a document it is about to bind, so
	// the fetch carries the cap the engine will store it under - the refusal
	// then happens while the bytes arrive, rather than after a document the
	// engine was never going to accept has been buffered whole.
	it("fetches under the engine's live document cap", async () => {
		importFetch.mockResolvedValue({ content: OPENAPI });
		render(<SpecTab collection={collection()} />);

		fireEvent.change(screen.getByPlaceholderText(/openapi.json/i), {
			target: { value: "https://api.example.com/openapi.json" },
		});
		fireEvent.click(screen.getByRole("button", { name: /fetch/i }));

		await waitFor(() =>
			expect(importFetch).toHaveBeenCalledWith(
				"https://api.example.com/openapi.json",
				10 * 1024 * 1024
			)
		);
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

	/*
	 * Re-binding to a different document (issue #718). Nothing writes null to a
	 * request's `specOperation` anywhere else in the app, so a stamp the new
	 * document does not account for would otherwise be permanent - and coverage
	 * resolves stamps by `operationId` first, so it would claim whichever
	 * operation of the new document shares the id rather than simply going
	 * unread.
	 */
	it("clears identity recorded against a document this one is not", async () => {
		requests = [
			request("r1", "{{baseUrl}}/pets"),
			// Matched the *old* document, matches nothing here: its URL is not a
			// path this spec declares.
			request("r2", "{{baseUrl}}/v1/legacy", {
				operationId: "legacyPing",
				method: "GET",
				path: "/v1/legacy",
			}),
			// No stamp to clear - an unmatched request that never had identity is
			// left exactly as it was.
			request("r3", "{{baseUrl}}/health"),
		];
		render(<SpecTab collection={collection()} />);
		await pickFile("petstore.json", OPENAPI);

		fireEvent.click(screen.getByRole("button", { name: /bind this spec/i }));

		const [payload] = bindSpec.mutate.mock.calls[0];
		expect(payload.clearStamps).toEqual(["r2"]);
		// The matched request is stamped, not cleared - the two lists are disjoint,
		// which is what lets the mutation write both at once.
		expect(payload.stamps.map((s: { requestId: string }) => s.requestId)).toEqual(["r1"]);
	});

	it("discloses the clearing before it happens, and stays silent when there is none", async () => {
		requests = [
			request("r1", "{{baseUrl}}/pets"),
			request("r2", "{{baseUrl}}/v1/legacy", {
				operationId: "legacyPing",
				method: "GET",
				path: "/v1/legacy",
			}),
		];
		const { unmount } = render(<SpecTab collection={collection()} />);
		await pickFile("petstore.json", OPENAPI);

		// The one line on this screen that describes a write to something already
		// there, so the user reads it before pressing Bind.
		expect(
			screen.getByText(/1 request records an operation this document does not have/i)
		).toBeTruthy();
		unmount();

		// A collection with nothing stale says nothing - a zero here would read as
		// a warning about a bind that rewrites nothing.
		requests = [request("r1", "{{baseUrl}}/pets"), request("r3", "{{baseUrl}}/health")];
		render(<SpecTab collection={collection()} />);
		await pickFile("petstore.json", OPENAPI);
		expect(screen.queryByText(/does not have/i)).toBeNull();
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
		specMetaQuery.data = {
			sourceUrl: "https://api.example.com/openapi.json",
			fetchedAt: 0,
			contentBytes: 2048,
		};
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
		specMetaQuery.data = { sourceUrl: null, fetchedAt: 0, contentBytes: 2048 };
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

	/*
	 * Issue #712. The card used to render blanks while the whole document
	 * downloaded: the source line printed the "stored with this collection"
	 * fallback - which is a *claim*, not a blank - and the mapped count flashed
	 * 0 of 0 before the request lists answered. Both are now skeletons, and the
	 * mutation check is that the fallback markup is unreachable while pending.
	 */
	it("renders a skeleton card while the document is being described, never a fallback source", () => {
		specMetaQuery.isLoading = true;
		specMetaQuery.data = undefined;
		requests = [request("r1", "{{baseUrl}}/pets")];

		render(<SpecTab collection={bound()} />);

		expect(screen.getByTestId("spec-source-skeleton")).toBeTruthy();
		expect(screen.getByTestId("spec-fetched-skeleton")).toBeTruthy();
		expect(screen.getByTestId("spec-size-skeleton")).toBeTruthy();
		// The false statement this replaced: a URL-imported spec claiming to have
		// come from nowhere in particular, right up until the read landed.
		expect(screen.queryByText(/a document stored with this collection/i)).toBeNull();
		// And the pending treatment the card used to have for its one covered
		// cell, which said nothing about the rest of it.
		expect(screen.queryByText("…")).toBeNull();

		// The binding's own facts are known before any read - hiding them would be
		// a second way of describing the document wrongly.
		expect(screen.getByText("9f86d081884c")).toBeTruthy();
	});

	it("skeletons the mapped count until the request lists answer, so it cannot flash 0 of 0", () => {
		requestsLoading = true;
		requests = [];
		specMetaQuery.data = { sourceUrl: null, fetchedAt: 0, contentBytes: 2048 };

		render(<SpecTab collection={bound()} />);

		expect(screen.getByTestId("spec-mapped-skeleton")).toBeTruthy();
		expect(screen.queryByText(/0 of 0 requests/i)).toBeNull();
	});

	it("shows the document's size once it is described", () => {
		specMetaQuery.data = { sourceUrl: null, fetchedAt: 0, contentBytes: 12 * 1024 * 1024 };

		render(<SpecTab collection={bound()} />);

		// Through the settings formatter, so the size beside a document and the
		// limit it is stored under read in the same unit.
		expect(screen.getByText("12.0 MB")).toBeTruthy();
	});

	it("offers no picker while a spec is bound - re-binding is sync's job", () => {
		render(<SpecTab collection={bound()} />);
		expect(screen.queryByRole("button", { name: /choose file/i })).toBeNull();
	});

	it("says which requests kept no identity when some stamps failed", async () => {
		bindSpec.data = { failedStamps: ["req_9"], failedClears: [] };
		render(<SpecTab collection={bound()} />);
		expect(screen.getByText(/1 request kept no operation identity/i)).toBeTruthy();
	});

	// The other half of the same report, and the worse state of the two: a stamp
	// that survived still reads as identity, in a document nothing is bound to.
	it("says which requests still record another document's operation", async () => {
		bindSpec.data = { failedStamps: [], failedClears: ["req_9"] };
		render(<SpecTab collection={bound()} />);
		expect(
			screen.getByText(/1 request still records an operation of another document/i)
		).toBeTruthy();
	});
});
