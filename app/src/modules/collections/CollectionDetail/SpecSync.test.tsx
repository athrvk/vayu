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
 * writes nothing, the up-to-date short-circuit is the engine's byte comparison
 * rather than a second opinion formed here, every count is stated including the
 * zeros, and a binding with no origin says what to do about it instead of
 * failing quietly.
 *
 * The write half (#655) adds the two rules a user has to be able to rely on:
 * applying sends **one** call - so it is one transaction - and what it sends is
 * exactly what was ticked. The defaults are pinned here rather than only in
 * `spec-apply.test.ts` because the default *is* the interface: a removal that
 * arrived pre-ticked, or an edited field that did, would be a silent
 * destruction nobody had to agree to.
 *
 * **The comparison is stubbed, not computed** (issue #854): it is
 * `POST /specs/diff`'s, pinned against real documents in
 * `engine/tests/spec_diff_test.cpp`. What this file drives is the section that
 * renders the answer and turns ticks into a payload, so each case states the
 * diff the engine returned - which is also what the section would break on if
 * the wire shape moved.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
	Collection,
	SpecDiffChanged,
	SpecDiffResponse,
	SpecDocumentMeta,
	SpecDraftRequest,
	SpecField,
	SpecFieldDiff,
	SpecOperation,
	SpecSyncRequest,
} from "@/types";

const importFetch = vi.fn();
const updateRequest = vi.fn();
const updateCollection = vi.fn();
const createRequest = vi.fn();
const deleteRequest = vi.fn();
const createSpec = vi.fn();
const syncSpec = vi.fn();
const diffSpec = vi.fn();
const getSpecMeta = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		importFetch: (url: string, maxBytes?: number) => importFetch(url, maxBytes),
		updateRequest,
		updateCollection,
		createRequest,
		deleteRequest,
		createSpec,
		syncSpec: (payload: SpecSyncRequest) => syncSpec(payload),
		diffSpec: (payload: unknown) => diffSpec(payload),
		// Where the bound document came from - all the check needs of it, since
		// the engine compares its own stored bytes (issues #712, #854).
		getSpecMeta: (id: string) => getSpecMeta(id),
	},
}));

vi.mock("@/hooks/useSpecDocumentLimit", () => ({
	useSpecDocumentLimit: () => ({ maxBytes: 10 * 1024 * 1024 }),
}));

const { default: SpecSync } = await import("./SpecSync");

const LIST_PETS: SpecOperation = { operationId: "listPets", method: "GET", path: "/pets" };
const LIST_OWNERS: SpecOperation = { operationId: "listOwners", method: "GET", path: "/owners" };

const NEXT_DOC = '{"openapi":"3.0.0","info":{"title":"Pets API"}}';

const meta = (
	sourceUrl: string | null = "https://api.example.com/spec.json"
): SpecDocumentMeta => ({
	id: "spec_1",
	sourceUrl,
	fetchedAt: 1_700_000_000_000,
	hash: "abc123",
	contentBytes: 128,
});

function draft(overrides: Partial<SpecDraftRequest> = {}): SpecDraftRequest {
	return {
		name: "List all the pets",
		description: "",
		method: "GET",
		url: "{{baseUrl}}/pets",
		params: [],
		headers: [],
		body: { mode: "none" },
		examples: [],
		...overrides,
	};
}

function field(name: SpecField, userTouched = false): SpecFieldDiff {
	return { field: name, current: "List pets", next: "List all the pets", userTouched };
}

function changed(overrides: Partial<SpecDiffChanged> = {}): SpecDiffChanged {
	return {
		requestId: "req_1",
		name: "List pets",
		boundOperation: LIST_PETS,
		operation: LIST_PETS,
		matchedBy: "operationId",
		renamed: false,
		previousUnknown: false,
		fields: [field("name")],
		draft: draft(),
		...overrides,
	};
}

function diffResponse(parts: Partial<SpecDiffResponse> = {}): SpecDiffResponse {
	return {
		identical: false,
		added: [],
		removed: [],
		changed: [],
		unchanged: 0,
		unmapped: 0,
		...parts,
	};
}

/** The answer the engine gives for the ordinary case: one reworded summary. */
const RENAMED_SUMMARY = diffResponse({ changed: [changed()] });

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
function renderSync(props: { collections?: Collection[] } = {}) {
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
			specId="spec_1"
			specFile={undefined}
		/>,
		{ wrapper }
	);
}

const check = () => fireEvent.click(screen.getByRole("button", { name: /check for changes/i }));
const apply = () => fireEvent.click(screen.getByRole("button", { name: /apply selected/i }));

beforeEach(() => {
	vi.clearAllMocks();
	getSpecMeta.mockResolvedValue(meta());
	importFetch.mockResolvedValue({ content: NEXT_DOC });
	diffSpec.mockResolvedValue(RENAMED_SUMMARY);
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
	it("reports up to date when the engine says the document is the stored one", async () => {
		// The byte comparison is the engine's, over the bytes it hashes - a second
		// one here would be the copy this move exists to remove.
		diffSpec.mockResolvedValue(diffResponse({ identical: true, unchanged: 1 }));
		renderSync();

		check();

		expect(await screen.findByText(/up to date/i)).toBeTruthy();
		expect(screen.queryByText(/the document has changed/i)).toBeNull();
		// The re-fetch is spec-only, so it states the document's own live cap as
		// the fetch's byte bound (issue #784) rather than leaving the engine to
		// buffer whatever the URL now serves.
		expect(importFetch).toHaveBeenCalledWith(expect.any(String), 10 * 1024 * 1024);
	});

	it("sends the collection and the re-fetched bytes, and nothing else", async () => {
		renderSync();

		check();

		await screen.findByText(/the document has changed/i);
		// Neither the requests nor the bound document: the engine walks the
		// subtree and reads its own stored bytes, which is what makes the
		// user-touched flag three-way at all.
		expect(diffSpec).toHaveBeenCalledWith({
			collectionId: "col_1",
			spec: { content: NEXT_DOC },
		});
	});

	it("states every count, zeros included, when the document has changed", async () => {
		renderSync();

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
		diffSpec.mockResolvedValue(
			diffResponse({
				changed: [
					changed({
						name: "My pets call",
						fields: [field("name", /* userTouched */ true), field("url")],
					}),
				],
			})
		);
		renderSync();

		check();

		expect(await screen.findByText(/the document has changed/i)).toBeTruthy();
		const flags = screen.getAllByText(/edited here/i);
		expect(flags).toHaveLength(1);
		expect(screen.getByText("url")).toBeTruthy();
	});

	it("writes nothing at all while checking", async () => {
		renderSync();

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
		getSpecMeta.mockResolvedValue(meta(null));
		renderSync();

		check();

		expect(await screen.findByText(/Bind it again/i)).toBeTruthy();
		expect(importFetch).not.toHaveBeenCalled();
		expect(diffSpec).not.toHaveBeenCalled();
	});

	it("surfaces the engine's message when the re-fetch fails", async () => {
		importFetch.mockRejectedValue(new Error("Fetch failed: 404 Not Found"));
		renderSync();

		check();

		expect(await screen.findByText(/404 Not Found/)).toBeTruthy();
	});

	it("surfaces the engine's message when the comparison itself is refused", async () => {
		// A collection whose binding names a document the store no longer holds,
		// which the route answers rather than comparing against nothing.
		diffSpec.mockRejectedValue(
			new Error("Collection is bound to spec 'spec_1', which is not stored")
		);
		renderSync();

		check();

		expect(await screen.findByText(/couldn't check this document/i)).toBeTruthy();
		expect(screen.getByText(/which is not stored/i)).toBeTruthy();
	});

	it("declares a surface everywhere it draws a rule", async () => {
		// The declaration half of the `--rule` contract: `border-rule` under no
		// declared surface falls back to the `:root` default, which inside a card
		// is invisible in dark. Rendered rather than scanned, and the count is
		// asserted so this cannot pass by finding nothing.
		const { container } = renderSync();

		check();
		await screen.findByText(/the document has changed/i);

		const ruled = container.querySelectorAll(".border-rule");
		expect(ruled.length).toBeGreaterThan(1);
		for (const element of ruled) {
			expect(element.className).toMatch(/surface-(card|sunken)/);
		}
	});

	/*
	 * Issues #712 and #854. The section used to be gated on a document the tab
	 * preloaded - so Check was unpressable until a transfer of up to
	 * `maxSpecDocumentBytes` had finished, for a comparison the user had not
	 * asked for yet. Then it read the stored bytes on the click. Now it reads
	 * only the *description* of the document, because the comparison against the
	 * stored bytes is the engine's.
	 */
	it("is pressable before anything is read, and reads only the description on the click", async () => {
		let answer: (meta: SpecDocumentMeta) => void = () => {};
		getSpecMeta.mockReturnValue(
			new Promise<SpecDocumentMeta>((resolve) => {
				answer = resolve;
			})
		);
		diffSpec.mockResolvedValue(diffResponse({ identical: true, unchanged: 1 }));
		renderSync();

		const button = screen.getByRole("button", { name: /check for changes/i });
		expect(button.hasAttribute("disabled")).toBe(false);
		// Nothing is transferred until it is asked for: rendering the section
		// reads nothing at all.
		expect(getSpecMeta).not.toHaveBeenCalled();

		check();

		await waitFor(() => expect(getSpecMeta).toHaveBeenCalledWith("spec_1"));
		answer(meta());
		expect(await screen.findByText(/up to date/i)).toBeTruthy();
	});

	it("says the check failed when the binding cannot be described", async () => {
		getSpecMeta.mockRejectedValue(new Error("Spec not found"));
		renderSync();

		check();

		expect(await screen.findByText(/couldn't check this document/i)).toBeTruthy();
		expect(screen.getByText(/spec not found/i)).toBeTruthy();
		// The comparison never started, so nothing was re-fetched either.
		expect(importFetch).not.toHaveBeenCalled();
	});

	it("applies the whole selection in one call, and stores the bytes it diffed", async () => {
		renderSync();

		check();
		await screen.findByText(/the document has changed/i);
		apply();

		await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(1));
		const payload = syncSpec.mock.calls[0][0] as SpecSyncRequest;
		expect(payload.collectionId).toBe("col_1");
		// The document that was compared, not a second re-fetch: a sync that
		// stored different bytes from the ones it diffed would apply a diff
		// nobody computed.
		expect(payload.spec.content).toBe(NEXT_DOC);
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
		diffSpec.mockResolvedValue(
			diffResponse({
				changed: [changed({ name: "My pets call", fields: [field("name", true)] })],
			})
		);
		renderSync();

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
		diffSpec.mockResolvedValue(
			diffResponse({
				added: [
					{
						operation: LIST_OWNERS,
						folder: "owners",
						draft: draft({ name: "List owners", url: "{{baseUrl}}/owners" }),
					},
				],
				removed: [{ requestId: "req_1", name: "List pets", operation: LIST_PETS }],
			})
		);
		renderSync();

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
	 * The comparison covers request-shaped fields, so a document that tightens a
	 * response schema or documents a new status produces three empty buckets -
	 * and Apply used to be disabled on exactly those, permanently, while the
	 * summary truthfully said the document had changed. The stored document, the
	 * response-schema index and the coverage index then stayed stale forever.
	 * These pin the tier that replaces the dead end.
	 */
	describe("a change no request row can carry", () => {
		/** What the engine answers for a document whose only change is a schema. */
		const DOCUMENT_LEVEL = diffResponse({ unchanged: 1 });

		it("says the change is document-level instead of dead-ending on three zeros", async () => {
			diffSpec.mockResolvedValue(DOCUMENT_LEVEL);
			renderSync();

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

		it("applies it - the new bytes, with no request row touched", async () => {
			// Mutation check: restore `isEmptySelection(...)` to the Apply button's
			// `disabled` and this reddens at the click - `syncSpec` is never called,
			// which is the dead end this issue is.
			diffSpec.mockResolvedValue(DOCUMENT_LEVEL);
			syncSpec.mockResolvedValue({
				idMap: {},
				specId: "spec_2",
				specHash: "def456",
				syncedAt: 1_700_000_100_000,
				created: 0,
				updated: 0,
				deleted: 0,
			});
			renderSync();

			check();
			await screen.findByText(/the document has changed/i);

			fireEvent.click(screen.getByRole("button", { name: /update the stored document/i }));

			await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(1));
			const payload = syncSpec.mock.calls[0][0] as SpecSyncRequest;
			// The document moves, so the binding the engine writes moves with it.
			expect(payload.spec.content).toBe(NEXT_DOC);
			// Not one request row is named - the whole point of the tier.
			expect(payload.create).toEqual([]);
			expect(payload.update).toEqual([]);
			expect(payload.delete).toEqual([]);
			expect(payload.collections).toEqual([]);
			// Neither index rides along: the engine derives both from the document
			// this payload stores (issues #853 and #860), which is what makes
			// validation read the *new* contract rather than one a client
			// re-sent - or forgot to.
			expect(Object.keys(payload.spec).sort()).toEqual(["content", "sourceUrl"]);
			expect(
				await screen.findByText(/no request changed.*now bound to the document/i)
			).toBeTruthy();
		});

		it("stays applyable when every offered row is unticked", async () => {
			// The same dead end one step over: a diff that *does* have rows, all of
			// which the user declines, must still let them onto the new document.
			diffSpec.mockResolvedValue(
				diffResponse({
					changed: [changed({ name: "My pets call", fields: [field("name", true)] })],
				})
			);
			renderSync();

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
		// reddens.
		diffSpec.mockResolvedValue(
			diffResponse({
				changed: [
					changed({
						fields: [
							field("name"),
							{
								field: "method",
								current: "HEAD",
								next: "GET",
								userTouched: true,
							},
						],
					}),
				],
			})
		);
		renderSync();

		check();
		await screen.findByText(/the document has changed/i);
		apply();

		await waitFor(() => expect(syncSpec).toHaveBeenCalledTimes(1));
		const patch = (syncSpec.mock.calls[0][0] as SpecSyncRequest).update[0];
		expect(patch.method).toBeUndefined();
		// The identity still travels, and still records what the operation is.
		expect(patch.specOperation).toEqual(LIST_PETS);

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
		syncSpec.mockRejectedValue(new Error("Request 'req_1' no longer exists"));
		renderSync();

		check();
		await screen.findByText(/the document has changed/i);
		apply();

		expect(await screen.findByText(/no longer exists/i)).toBeTruthy();
		// Still the diff, still ticked: nothing was written, so there is nothing
		// to re-check before trying again.
		expect(screen.getByRole("button", { name: /apply selected/i })).toBeTruthy();
	});
});
