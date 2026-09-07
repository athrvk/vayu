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
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useTreeCrud } from "./useTreeCrud";
import { useToastStore } from "@/stores";
import type { Collection, Request } from "@/types";

const createRequest = vi.fn();

vi.mock("@/queries", () => ({
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: createRequest, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
	preRequestScript: "pm.variables.set('x', 1);",
	postRequestScript: "pm.test('ok', () => {});",
	followRedirects: false,
	maxRedirects: 3,
	httpVersion: "http1.1",
	verifySSL: false,
	stream: true,
	specOperation: { operationId: "getPet", method: "GET", path: "/pets/{id}" },
	order: 1,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
};

const requestsByCollection = new Map([["c-1", [source]]]);

function renderCrud() {
	return renderHook(() =>
		useTreeCrud({
			collections,
			rootCollections: collections,
			selectedCollectionId: null,
			requestsByCollection,
			getRequestsByCollection: (id: string) => requestsByCollection.get(id) ?? [],
		})
	);
}

beforeEach(() => {
	createRequest.mockReset();
	createRequest.mockResolvedValue({ id: "r-1-copy", collectionId: "c-1" });
	useToastStore.setState({ toasts: [] });
});

describe("duplicating a request", () => {
	it("sends every field of the source except id and timestamps", async () => {
		const { result } = renderCrud();

		await act(async () => {
			await result.current.rows.onDuplicateRequest(source);
		});

		expect(createRequest).toHaveBeenCalledTimes(1);
		const sent = createRequest.mock.calls[0][0];
		const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...expected } = source;
		expect(sent).toEqual({ ...expected, name: "Get pet (Copy)" });
	});

	// Issue #1485: a list row can carry `truncatedFields` when the engine
	// substituted a default for a column over its size cap. Copying it would
	// silently persist the substitution as if it were the real value.
	it("refuses to copy a row whose engine substituted a default for an oversized field", async () => {
		const truncated: Request = { ...source, truncatedFields: ["body", "auth"] };
		const { result } = renderCrud();

		await act(async () => {
			await result.current.rows.onDuplicateRequest(truncated);
		});

		expect(createRequest).not.toHaveBeenCalled();
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].variant).toBe("error");
		expect(toasts[0].message).toContain("body, auth");
	});
});
