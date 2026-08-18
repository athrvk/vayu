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
 * The Spec tab's Sync section (issues #654 and #655).
 *
 * The read half has to prove mostly what it does *not* do: checking a document
 * writes nothing, the up-to-date short-circuit is byte equality against the
 * stored document, every count is stated including the zeros, and a binding
 * with no origin says what to do about it instead of failing quietly.
 *
 * The write half (#655) adds the two rules a user has to be able to rely on:
 * applying sends **one** call - so it is one transaction - and what it sends is
 * exactly what was ticked. The defaults are pinned here rather than only in
 * `spec-apply.test.ts` because the default *is* the interface: a removal that
 * arrived pre-ticked, or an edited field that did, would be a silent
 * destruction nobody had to agree to.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Collection, Request, SpecDocument, SpecSyncRequest } from "@/types";

const importFetch = vi.fn();
const updateRequest = vi.fn();
const updateCollection = vi.fn();
const createRequest = vi.fn();
const deleteRequest = vi.fn();
const createSpec = vi.fn();
const syncSpec = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		importFetch: (url: string, maxBytes?: number) => importFetch(url, maxBytes),
		updateRequest,
		updateCollection,
		createRequest,
		deleteRequest,
		createSpec,
		syncSpec: (payload: SpecSyncRequest) => syncSpec(payload),
	},
}));

vi.mock("@/hooks/useSpecDocumentLimit", () => ({
	useSpecDocumentLimit: () => ({ maxBytes: 10 * 1024 * 1024 }),
}));

const { default: SpecSync } = await import("./SpecSync");

const doc = (summary: string, extra: Record<string, unknown> = {}): string =>
	JSON.stringify({
		openapi: "3.0.0",
		info: { title: "Pets API" },
		servers: [{ url: "https://api.example.com" }],
		paths: { "/pets": { get: { operationId: "listPets", summary, ...extra } } },
	});

const BOUND = doc("List pets");

const spec = (
	content: string,
	sourceUrl: string | null = "https://api.example.com/spec.json"
): SpecDocument => ({
	id: "spec_1",
	content,
	sourceUrl,
	fetchedAt: 1_700_000_000_000,
	hash: "abc123",
	operations: null,
	responseSchemas: null,
});

const request = (overrides: Partial<Request> = {}): Request =>
	({
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
		specOperation: { operationId: "listPets", method: "GET", path: "/pets" },
		order: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}) as Request;

const collection = (id = "col_1"): Collection =>
	({
		id,
		name: "Pets API",
		order: 0,
		openapi: { specId: "spec_1", specHash: "abc123" },
	}) as Collection;

/**
 * Renders inside a real query client - the apply path is a mutation, and a
 * stubbed one could not prove that a failed sync leaves the selection alone.
 */
function renderSync(props: {
	spec?: SpecDocument;
	requests?: Request[];
	collections?: Collection[];
}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<SpecSync
			collection={collection()}
			collections={props.collections ?? [collection()]}
			spec={props.spec}
			specFile={undefined}
			requests={props.requests ?? [request()]}
		/>,
		{ wrapper }
	);
}

const check = () => fireEvent.click(screen.getByRole("button", { name: /check for changes/i }));
const apply = () => fireEvent.click(screen.getByRole("button", { name: /apply selected/i }));

beforeEach(() => {
	vi.clearAllMocks();
	syncSpec.mockResolvedValue({
		idMap: {},
		specId: "spec_2",
		specHash: "def456",
		syncedAt: 1_700_000_100_000,
		created: 0,
		updated: 1,
		deleted: 0,
	});
});

describe("SpecSync", () => {
	it("reports up to date when the document comes back byte for byte", async () => {
		importFetch.mockResolvedValue({ content: BOUND });
		renderSync({ spec: spec(BOUND) });

		check();

		expect(await screen.findByText(/up to date/i)).toBeTruthy();
		expect(screen.queryByText(/the document has changed/i)).toBeNull();
		// The re-fetch is spec-only, so it states the document's own live cap as
		// the fetch's byte bound (issue #784) rather than leaving the engine to
		// buffer whatever the URL now serves.
		expect(importFetch).toHaveBeenCalledWith(expect.any(String), 10 * 1024 * 1024);
	});

	it("states every count, zeros included, when the document has changed", async () => {
		importFetch.mockResolvedValue({ content: doc("List all the pets") });
		renderSync({ spec: spec(BOUND) });

		check();

		expect(await screen.findByText(/the document has changed/i)).toBeTruthy();
		expect(
			screen.getByText(
				/0 new operations · 0 requests whose operation is gone · 1 changed · 0 unchanged/i
			)
		).toBeTruthy();
		expect(screen.getByText("name")).toBeTruthy();
	});

	it("marks a field the user edited, and leaves one only the document moved unmarked", async () => {
		importFetch.mockResolvedValue({
			content: doc("List pets", {
				parameters: [{ name: "limit", in: "query", required: true, example: "50" }],
			}),
		});
		renderSync({ spec: spec(BOUND), requests: [request({ name: "My pets call" })] });

		check();

		expect(await screen.findByText(/the document has changed/i)).toBeTruthy();
		// The name is the user's (the document still says "List pets"); the URL is
		// the document's, and neither is described as the other.
		const flags = screen.getAllByText(/edited here/i);
		expect(flags).toHaveLength(1);
		expect(screen.getByText("url")).toBeTruthy();
	});

	it("writes nothing at all while checking", async () => {
		importFetch.mockResolvedValue({ content: doc("List all the pets") });
		renderSync({ spec: spec(BOUND) });

		check();

		await screen.findByText(/the document has changed/i);
		for (const write of [
			updateRequest,
			updateCollection,
			createRequest,
			deleteRequest,
			createSpec,
			syncSpec,
		]) {
			expect(write).not.toHaveBeenCalled();
		}
	});

	it("says what to do when the binding records no origin to read from", async () => {
		renderSync({ spec: spec(BOUND, null) });

		check();

		expect(await screen.findByText(/Bind it again/i)).toBeTruthy();
		expect(importFetch).not.toHaveBeenCalled();
	});

	it("surfaces the engine's message when the re-fetch fails", async () => {
		importFetch.mockRejectedValue(new Error("Fetch failed: 404 Not Found"));
		renderSync({ spec: spec(BOUND) });

		check();

		expect(await screen.findByText(/404 Not Found/)).toBeTruthy();
	});

	it("declares a surface everywhere it draws a rule", async () => {
		// The declaration half of the `--rule` contract: `border-rule` under no
		// declared surface falls back to the `:root` default, which inside a card
		// is invisible in dark. Rendered rather than scanned, and the count is
		// asserted so this cannot pass by finding nothing.
		importFetch.mockResolvedValue({ content: doc("List all the pets") });
		const { container } = renderSync({ spec: spec(BOUND) });

		check();
		await screen.findByText(/the document has changed/i);

		const ruled = container.querySelectorAll(".border-rule");
		expect(ruled.length).toBeGreaterThan(1);
		for (const element of ruled) {
			expect(element.className).toMatch(/surface-(card|sunken)/);
		}
	});

	it("cannot be checked until the stored document has loaded", async () => {
		renderSync({ spec: undefined });

		const button = screen.getByRole("button", { name: /check for changes/i });
		expect(button.hasAttribute("disabled")).toBe(true);
		await waitFor(() => {
			expect(screen.getByText(/has to load before it can be compared/i)).toBeTruthy();
		});
	});
	it("applies the whole selection in one call, and stores the bytes it diffed", async () => {
		const next = doc("List all the pets");
		importFetch.mockResolvedValue({ content: next });
		renderSync({ spec: spec(BOUND) });

		check();
		await screen.findByText(/the document has changed/i);
		apply();

		await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(1));
		const payload = syncSpec.mock.calls[0][0] as SpecSyncRequest;
		expect(payload.collectionId).toBe("col_1");
		// The document that was compared, not a second re-fetch: a sync that
		// stored different bytes from the ones it diffed would apply a diff
		// nobody computed.
		expect(payload.spec.content).toBe(next);
		expect(payload.update).toHaveLength(1);
		expect(payload.update[0].id).toBe("req_1");
		expect(payload.update[0].name).toBe("List all the pets");
		expect(payload.delete).toEqual([]);
		expect(await screen.findByText(/applied - 0 requests created, 1 updated/i)).toBeTruthy();
	});

	it("leaves a field the user edited out of the payload until it is ticked", async () => {
		// The document moved `summary` and the user renamed the request, so the
		// name is theirs: nothing about this request is ticked for them, and even
		// applying the request writes every field except that one. Mutation check:
		// drop the `userTouched` filter in `defaultSelection` and both halves
		// redden - the first because the name arrives pre-ticked, the second
		// because it is then in the payload before anybody agreed.
		importFetch.mockResolvedValue({ content: doc("List all the pets") });
		renderSync({ spec: spec(BOUND), requests: [request({ name: "My pets call" })] });

		check();
		await screen.findByText(/the document has changed/i);
		// Nothing is ticked, so the apply on offer is the document-level one and
		// says so - it is no longer a disabled button, because a document that
		// moved must always be applyable (#717); what it must not do is carry the
		// user's field. Both halves are asserted below.
		expect(screen.queryByRole("button", { name: /apply selected/i })).toBeNull();
		expect(screen.getByRole("button", { name: /update the stored document/i })).toBeTruthy();

		fireEvent.click(screen.getByRole("checkbox", { name: /apply changes to my pets call/i }));
		apply();

		await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(1));
		expect((syncSpec.mock.calls[0][0] as SpecSyncRequest).update[0].name).toBeUndefined();

		check();
		await screen.findByText(/the document has changed/i);
		fireEvent.click(screen.getByRole("checkbox", { name: /apply changes to my pets call/i }));
		fireEvent.click(screen.getByRole("checkbox", { name: /apply name to my pets call/i }));
		apply();

		await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(2));
		expect((syncSpec.mock.calls[1][0] as SpecSyncRequest).update[0].name).toBe(
			"List all the pets"
		);
	});

	it("never deletes without a confirm that names the count", async () => {
		// The new document declares a different operation, so the bound request's
		// operation is gone and a second one is added.
		importFetch.mockResolvedValue({
			content: JSON.stringify({
				openapi: "3.0.0",
				info: { title: "Pets API" },
				servers: [{ url: "https://api.example.com" }],
				paths: {
					"/owners": { get: { operationId: "listOwners", summary: "List owners" } },
				},
			}),
		});
		renderSync({ spec: spec(BOUND) });

		check();
		await screen.findByText(/the document has changed/i);

		// Unticked by default - applying now must not name the request at all.
		apply();
		await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(1));
		expect((syncSpec.mock.calls[0][0] as SpecSyncRequest).delete).toEqual([]);

		check();
		await screen.findByText(/the document has changed/i);
		fireEvent.click(screen.getByRole("checkbox", { name: /list pets \(GET \/pets\)/i }));
		apply();

		// The confirm stands between the tick and the call.
		expect(syncSpec).toHaveBeenCalledTimes(1);
		expect(await screen.findByText(/1 request will be deleted/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /apply and delete/i }));

		await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(2));
		expect((syncSpec.mock.calls[1][0] as SpecSyncRequest).delete).toEqual(["req_1"]);
	});

	/**
	 * The document-level tier (issue #717).
	 *
	 * `spec-diff` compares request-shaped fields, so a document that tightens a
	 * response schema or documents a new status produces three empty buckets -
	 * and Apply used to be disabled on exactly those, permanently, while the
	 * summary truthfully said the document had changed. The stored document, the
	 * response-schema index and the coverage index then stayed stale forever.
	 * These pin the tier that replaces the dead end.
	 */
	describe("a change no request row can carry", () => {
		const withResponses = (
			properties: Record<string, unknown>,
			extraStatuses: Record<string, unknown> = {}
		): string =>
			doc("List pets", {
				responses: {
					"200": {
						description: "OK",
						content: {
							"application/json": { schema: { type: "object", properties } },
						},
					},
					...extraStatuses,
				},
			});

		/** The contract as bound, and the same contract with a tighter 200 and a new 429. */
		const BOUND_SCHEMA = withResponses({ id: { type: "string" } });
		const TIGHTENED = withResponses(
			{ id: { type: "string" }, name: { type: "string" } },
			{ "429": { description: "Too many requests" } }
		);

		it("says the change is document-level instead of dead-ending on three zeros", async () => {
			importFetch.mockResolvedValue({ content: TIGHTENED });
			renderSync({ spec: spec(BOUND_SCHEMA) });

			check();

			expect(await screen.findByText(/the document has changed/i)).toBeTruthy();
			// The counts are still stated in full, and now they are explained.
			expect(
				screen.getByText(
					/0 new operations · 0 requests whose operation is gone · 0 changed · 1 unchanged/i
				)
			).toBeTruthy();
			expect(screen.getByText(/document-level changes only/i)).toBeTruthy();
		});

		it("applies it - the new bytes and both indexes, with no request row touched", async () => {
			// Mutation check: restore `isEmptySelection(...)` to the Apply button's
			// `disabled` and this reddens at the click - `syncSpec` is never called,
			// which is the dead end this issue is.
			importFetch.mockResolvedValue({ content: TIGHTENED });
			syncSpec.mockResolvedValue({
				idMap: {},
				specId: "spec_2",
				specHash: "def456",
				syncedAt: 1_700_000_100_000,
				created: 0,
				updated: 0,
				deleted: 0,
			});
			renderSync({ spec: spec(BOUND_SCHEMA) });

			check();
			await screen.findByText(/the document has changed/i);

			fireEvent.click(screen.getByRole("button", { name: /update the stored document/i }));

			await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(1));
			const payload = syncSpec.mock.calls[0][0] as SpecSyncRequest;
			// The document moves, so the binding the engine writes moves with it.
			expect(payload.spec.content).toBe(TIGHTENED);
			// Not one request row is named - the whole point of the tier.
			expect(payload.create).toEqual([]);
			expect(payload.update).toEqual([]);
			expect(payload.delete).toEqual([]);
			expect(payload.collections).toEqual([]);
			// The indexes ride along, which is what makes validation and coverage
			// read the *new* contract rather than the one they were stale against.
			expect(JSON.stringify(payload.spec.responseSchemas)).toContain("name");
			expect(payload.spec.operations?.length).toBeGreaterThan(0);
			expect(
				await screen.findByText(/no request changed.*now bound to the document/i)
			).toBeTruthy();
		});

		it("stays applyable when every offered row is unticked", async () => {
			// The same dead end one step over: a diff that *does* have rows, all of
			// which the user declines, must still let them onto the new document.
			importFetch.mockResolvedValue({ content: doc("List all the pets") });
			renderSync({ spec: spec(BOUND), requests: [request({ name: "My pets call" })] });

			check();
			await screen.findByText(/the document has changed/i);
			// Nothing is ticked (the one changed field is the user's own name).
			expect(
				screen.getByRole("button", { name: /update the stored document/i })
			).toBeTruthy();
			expect(screen.getByText(/no request rows change/i)).toBeTruthy();
		});
	});

	it("never takes back a method the user edited, and offers it as its own row", async () => {
		// Issue #717's problem B, end to end: the document only rewords a summary,
		// but the apply used to write `method` unconditionally - reverting a HEAD
		// to GET with no row, no flag and nothing ticked. Mutation check: restore
		// `patch.method = draft.method` in `updateItem` and the first assertion
		// reddens; drop "method" from `SpecField` and the second does.
		importFetch.mockResolvedValue({ content: doc("List all the pets") });
		renderSync({ spec: spec(BOUND), requests: [request({ method: "HEAD" })] });

		check();
		await screen.findByText(/the document has changed/i);
		apply();

		await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(1));
		const patch = (syncSpec.mock.calls[0][0] as SpecSyncRequest).update[0];
		expect(patch.method).toBeUndefined();
		// The identity still travels, and still records what the operation is.
		expect(patch.specOperation).toEqual({
			operationId: "listPets",
			method: "GET",
			path: "/pets",
		});

		// It is a row the user can see and take, flagged as theirs - the treatment
		// `url` always had and `method` never did.
		check();
		await screen.findByText(/the document has changed/i);
		expect(screen.getByText("method")).toBeTruthy();
		expect(screen.getAllByText(/edited here/i)).toHaveLength(1);
		fireEvent.click(screen.getByRole("checkbox", { name: /apply method to list pets/i }));
		apply();

		await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(2));
		expect((syncSpec.mock.calls[1][0] as SpecSyncRequest).update[0].method).toBe("GET");
	});

	it("surfaces a failed apply and keeps the selection", async () => {
		importFetch.mockResolvedValue({ content: doc("List all the pets") });
		syncSpec.mockRejectedValue(new Error("Request 'req_1' no longer exists"));
		renderSync({ spec: spec(BOUND) });

		check();
		await screen.findByText(/the document has changed/i);
		apply();

		expect(await screen.findByText(/no longer exists/i)).toBeTruthy();
		// Still the diff, still ticked: nothing was written, so there is nothing
		// to re-check before trying again.
		expect(screen.getByRole("button", { name: /apply selected/i })).toBeTruthy();
	});
});
