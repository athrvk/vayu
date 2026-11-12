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
 * Duplicate copied a request through a hand-written field list that predated
 * `verifySSL`, `stream` and `specOperation` (#1519): a copy of a request with
 * certificate verification off, redirects disabled, or a spec binding quietly
 * reset those to the engine's defaults and dropped the binding. The payload
 * must carry the whole source record instead, so a field added later is
 * copied without anyone updating this list.
 *
 * The tree's row is a summary (#2546), so the whole record is the detail read:
 * a copy made from the row it was invoked on would carry no body, headers,
 * auth or scripts at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useTreeCrud } from "./useTreeCrud";
import { useSaveStore, useTabsStore, useToastStore } from "@/stores";
import { queryKeys } from "@/queries/keys";
import { resetSaveStoreForTests, type SaveOutcome } from "@/stores/save-store";
import type { Collection, Request, RequestExample, RequestSummary } from "@/types";

const createRequest = vi.fn();
const updateRequest = vi.fn();
const listRequestExamples = vi.fn<(id: string) => Promise<RequestExample[]>>();
const createRequestExample = vi.fn();
const getRequest = vi.fn<(id: string) => Promise<Request>>();

vi.mock("@/services/api", () => ({
	apiService: {
		listRequestExamples: (id: string) => listRequestExamples(id),
		createRequestExample: (id: string, body: unknown) => createRequestExample(id, body),
	},
}));

vi.mock("@/queries", () => ({
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: createRequest, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: updateRequest, isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
	requestDetailOptions: (id: string) => ({
		queryKey: ["requests", "detail", id],
		queryFn: () => getRequest(id),
		retry: false,
		// The real options' policy: a cached detail is never refetched on its own.
		staleTime: Infinity,
	}),
}));

const collections = [{ id: "c-1", name: "Acme", order: 0 }] as Collection[];

const source: Request = {
	id: "r-1",
	collectionId: "c-1",
	name: "Get pet",
	description: "fetches one pet",
	method: "GET",
	url: "https://api.example.com/pets/{{petId}}",
	params: [{ key: "verbose", value: "true", enabled: true }],
	headers: [{ key: "X-Trace", value: "1", enabled: true }],
	body: { mode: "json", content: '{"a":1}' },
	bodyType: "json",
	auth: { mode: "bearer", token: "{{token}}" },
	elements: [
		{
			id: "el_1",
			kind: "script.pre",
			enabled: true,
			config: { script: "pm.variables.set('x', 1);" },
		},
		{
			id: "el_2",
			kind: "script.post",
			enabled: true,
			config: { script: "pm.test('ok', () => {});" },
		},
	],
	followRedirects: false,
	maxRedirects: 3,
	// Non-default, like the rest: a copy that dropped it would send the
	// request's timeout back to the setting (#2937).
	timeout: 1500,
	httpVersion: "http1.1",
	verifySSL: false,
	// Postman's protocol switches and their export carrier (#1765), at
	// non-default values, so a copy that reset them fails the whole-record check.
	disableCookies: true,
	disabledSystemHeaders: ["user-agent"],
	disableUrlEncoding: true,
	// The stored JSON text, in the source's member order: sent back as-is.
	postmanProtocolBehavior: '{"disabledSystemHeaders":{"user-agent":true},"disableCookies":true}',
	stream: true,
	mockResponseMode: "first",
	specOperation: { operationId: "getPet", method: "GET", path: "/pets/{id}" },
	order: 1,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
};

/** What the tree holds for `source`: `GET /requests?fields=summary`'s row. */
const listRow: RequestSummary = {
	id: source.id,
	collectionId: source.collectionId,
	name: source.name,
	method: source.method,
	url: source.url,
	order: source.order,
	createdAt: source.createdAt,
	specOperation: source.specOperation,
};

const requestsByCollection = new Map([["c-1", [listRow]]]);

function renderCrud() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		() =>
			useTreeCrud({
				collections,
				requestsByCollection,
				getRequestsByCollection: (id: string) => requestsByCollection.get(id) ?? [],
				revealEntity: vi.fn(),
			}),
		{ wrapper }
	);
	return { ...hook, client };
}

beforeEach(() => {
	createRequest.mockReset();
	createRequest.mockResolvedValue({ id: "r-1-copy", collectionId: "c-1" });
	updateRequest.mockReset();
	listRequestExamples.mockReset();
	listRequestExamples.mockResolvedValue([]);
	createRequestExample.mockReset();
	createRequestExample.mockImplementation(async (_id: string, body: { name: string }) => ({
		...body,
		id: `new-${body.name}`,
	}));
	getRequest.mockReset();
	getRequest.mockResolvedValue(source);
	useToastStore.setState({ toasts: [] });
	resetSaveStoreForTests();
});

describe("duplicating a request", () => {
	it("sends every field of the source except id and timestamps", async () => {
		const { result } = renderCrud();

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(getRequest).toHaveBeenCalledExactlyOnceWith("r-1");
		expect(createRequest).toHaveBeenCalledTimes(1);
		const sent = createRequest.mock.calls[0][0];
		const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...expected } = source;
		expect(sent).toEqual({ ...expected, name: "Get pet (Copy)" });
	});

	it("keeps a request with no timeout of its own on the setting, as null", async () => {
		getRequest.mockResolvedValue({ ...source, timeout: null });
		const { result } = renderCrud();

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(createRequest.mock.calls[0][0]).toHaveProperty("timeout", null);
	});

	// #2356: the read's `unresolved` is the engine's answer for the source, not
	// part of the record, so the copy's write carries none of it.
	it("copies a file reference without the engine's derived flag", async () => {
		const upload: Request = {
			...source,
			body: { mode: "binary", file: { src: "/data/a.bin", unresolved: true } },
			bodyType: "binary",
		};
		getRequest.mockResolvedValue(upload);
		const { result } = renderCrud();

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(createRequest.mock.calls[0][0].body).toEqual({
			mode: "binary",
			file: { src: "/data/a.bin" },
		});
	});

	// A request deleted elsewhere (an agent over MCP) since the tree drew it:
	// the detail read is a 404, and a copy of the summary is no copy at all.
	it("reports a request it could not read rather than copying the tree's row", async () => {
		getRequest.mockRejectedValue(new Error("Request r-1 no longer exists"));
		const { result } = renderCrud();

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(createRequest).not.toHaveBeenCalled();
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].variant).toBe("error");
		expect(toasts[0].message).toContain("Couldn't duplicate the request");
	});
});

/**
 * #3450: examples are a nested resource, so the request's create copied none
 * of them, and a fixed mock example was left naming the source's row.
 */
describe("duplicating a request that has saved examples", () => {
	const ok: RequestExample = {
		id: "ex-1",
		name: "200 - ok",
		status: 200,
		headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
		body: '{"ok":true}',
		contentType: "application/json",
		origin: "import",
	};
	const gone: RequestExample = {
		id: "ex-2",
		name: "404 - gone",
		status: 404,
		headers: [],
		body: "",
		contentType: "",
		origin: "user",
		bodyTruncated: true,
	};
	const fixedOnGone: Request = { ...source, mockResponseMode: "fixed", mockExampleId: "ex-2" };

	async function duplicate() {
		const hook = renderCrud();
		await act(async () => {
			await hook.result.current.handlers.onDuplicateRequest(listRow);
		});
		return hook;
	}

	it("posts every example to the copy in source order, as the user's own", async () => {
		listRequestExamples.mockResolvedValue([ok, gone]);

		await duplicate();

		expect(listRequestExamples).toHaveBeenCalledExactlyOnceWith("r-1");
		expect(createRequestExample.mock.calls).toEqual([
			[
				"r-1-copy",
				{
					name: "200 - ok",
					status: 200,
					headers: ok.headers,
					body: ok.body,
					contentType: "application/json",
					bodyTruncated: false,
					origin: "user",
				},
			],
			[
				"r-1-copy",
				{
					name: "404 - gone",
					status: 404,
					headers: [],
					body: "",
					contentType: "",
					bodyTruncated: true,
					origin: "user",
				},
			],
		]);
	});

	it("points a fixed mock example at the copy's own twin, never the source's", async () => {
		getRequest.mockResolvedValue(fixedOnGone);
		listRequestExamples.mockResolvedValue([ok, gone]);

		await duplicate();

		const sent = createRequest.mock.calls[0][0];
		expect(sent).not.toHaveProperty("mockExampleId");
		expect(sent.mockResponseMode).toBe("first");
		expect(updateRequest).toHaveBeenCalledExactlyOnceWith({
			id: "r-1-copy",
			mockResponseMode: "fixed",
			mockExampleId: "new-404 - gone",
		});
	});

	it("leaves the copy on first when the fixed example is no longer saved", async () => {
		getRequest.mockResolvedValue({ ...fixedOnGone, mockExampleId: "ex-deleted" });
		listRequestExamples.mockResolvedValue([ok]);

		await duplicate();

		expect(createRequest.mock.calls[0][0].mockResponseMode).toBe("first");
		expect(updateRequest).not.toHaveBeenCalled();
	});

	it("keeps a random mock mode as it was", async () => {
		getRequest.mockResolvedValue({ ...source, mockResponseMode: "random" });
		listRequestExamples.mockResolvedValue([ok]);

		await duplicate();

		expect(createRequest.mock.calls[0][0].mockResponseMode).toBe("random");
		expect(updateRequest).not.toHaveBeenCalled();
	});

	it("copies a request with no examples and posts nothing", async () => {
		await duplicate();

		expect(createRequest).toHaveBeenCalledTimes(1);
		expect(createRequestExample).not.toHaveBeenCalled();
		expect(updateRequest).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	it("reads the examples past a cached list", async () => {
		listRequestExamples.mockResolvedValue([ok]);
		const { result, client } = renderCrud();
		client.setQueryData(queryKeys.requests.examples("r-1"), []);

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(createRequestExample).toHaveBeenCalledTimes(1);
	});

	it("keeps the copy and says so when the examples cannot be listed", async () => {
		getRequest.mockResolvedValue(fixedOnGone);
		listRequestExamples.mockRejectedValue(new Error("engine unreachable"));

		await duplicate();

		expect(createRequest).toHaveBeenCalledTimes(1);
		expect(createRequestExample).not.toHaveBeenCalled();
		expect(updateRequest).not.toHaveBeenCalled();
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].variant).toBe("error");
		expect(toasts[0].message).toContain("couldn't copy all its examples");
		expect(useTabsStore.getState().openTabs.map((t) => t.entityId)).toContain("r-1-copy");
		expect(toasts[0].message).toContain("engine unreachable");
	});

	it("keeps the copy, stops there and leaves the mock on first when a post fails", async () => {
		getRequest.mockResolvedValue(fixedOnGone);
		listRequestExamples.mockResolvedValue([ok, gone]);
		createRequestExample.mockRejectedValueOnce(new Error("example cap reached"));

		await duplicate();

		expect(createRequestExample).toHaveBeenCalledTimes(1);
		expect(updateRequest).not.toHaveBeenCalled();
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].message).toContain("example cap reached");
	});

	it("refreshes the copy's examples even when copying them failed", async () => {
		listRequestExamples.mockRejectedValue(new Error("engine unreachable"));
		const { result, client } = renderCrud();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(invalidate).toHaveBeenCalledWith({
			queryKey: queryKeys.requests.examples("r-1-copy"),
		});
	});
});

/**
 * #3426: the open editor autosaves after a delay, so a Duplicate inside that
 * window used to copy the stored record without the edit.
 */
describe("duplicating a request whose editor has an unsaved edit", () => {
	const edited: Request = { ...source, url: "https://api.example.com/pets/edited" };

	function registerEditor(save: () => Promise<SaveOutcome | void>, hasPendingChanges = true) {
		useSaveStore
			.getState()
			.registerContext({ id: "request-r-1", name: "Request", save, hasPendingChanges });
	}

	it("saves first, then reads the request, then creates the copy from the saved record", async () => {
		const order: string[] = [];
		getRequest.mockImplementation(async () => {
			order.push("getRequest");
			return edited;
		});
		createRequest.mockImplementation(async () => {
			order.push("createRequest");
			return { id: "r-1-copy", collectionId: "c-1" };
		});
		registerEditor(async () => {
			order.push("save");
			return "saved";
		});
		const { result } = renderCrud();

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(order).toEqual(["save", "getRequest", "createRequest"]);
		expect(createRequest.mock.calls[0][0]).toHaveProperty("url", edited.url);
	});

	// The detail cache is `staleTime: Infinity`: a tab that has the request open
	// holds the pre-edit record, and a plain fetchQuery would serve it.
	it("reads past a cached pre-edit record once the save has landed", async () => {
		getRequest.mockResolvedValue(edited);
		registerEditor(async () => "saved");
		const { result, client } = renderCrud();
		client.setQueryData(["requests", "detail", "r-1"], source);

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(getRequest).toHaveBeenCalledExactlyOnceWith("r-1");
		expect(createRequest.mock.calls[0][0]).toHaveProperty("url", edited.url);
	});

	it("does not save an editor with nothing pending, and keeps serving its cached record", async () => {
		const save = vi.fn(async (): Promise<SaveOutcome> => "saved");
		registerEditor(save, false);
		const { result, client } = renderCrud();
		client.setQueryData(["requests", "detail", "r-1"], source);

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(save).not.toHaveBeenCalled();
		expect(getRequest).not.toHaveBeenCalled();
		expect(createRequest).toHaveBeenCalledTimes(1);
	});

	it.each<SaveOutcome>(["failed", "final", "disk-full", "pending"])(
		"creates nothing when the save ends %s, and says why",
		async (outcome) => {
			registerEditor(async () => outcome);
			const { result } = renderCrud();

			await act(async () => {
				await result.current.handlers.onDuplicateRequest(listRow);
			});

			expect(getRequest).not.toHaveBeenCalled();
			expect(createRequest).not.toHaveBeenCalled();
			const toasts = useToastStore.getState().toasts;
			expect(toasts).toHaveLength(1);
			expect(toasts[0].variant).toBe("error");
			expect(toasts[0].message).toContain("Couldn't duplicate the request");
		}
	);

	it("creates nothing when the save rejects", async () => {
		registerEditor(async () => {
			throw new Error("engine unreachable");
		});
		const { result } = renderCrud();

		await act(async () => {
			await result.current.handlers.onDuplicateRequest(listRow);
		});

		expect(createRequest).not.toHaveBeenCalled();
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].message).toContain("engine unreachable");
	});
});
