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
import { useToastStore } from "@/stores";
import type { Collection, Request, RequestSummary } from "@/types";

const createRequest = vi.fn();
const getRequest = vi.fn<(id: string) => Promise<Request>>();

vi.mock("@/queries", () => ({
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: createRequest, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
	useStopMockServerMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	requestDetailOptions: (id: string) => ({
		queryKey: ["requests", "detail", id],
		queryFn: () => getRequest(id),
		retry: false,
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
	return renderHook(
		() =>
			useTreeCrud({
				collections,
				requestsByCollection,
				getRequestsByCollection: (id: string) => requestsByCollection.get(id) ?? [],
			}),
		{ wrapper }
	);
}

beforeEach(() => {
	createRequest.mockReset();
	createRequest.mockResolvedValue({ id: "r-1-copy", collectionId: "c-1" });
	getRequest.mockReset();
	getRequest.mockResolvedValue(source);
	useToastStore.setState({ toasts: [] });
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
