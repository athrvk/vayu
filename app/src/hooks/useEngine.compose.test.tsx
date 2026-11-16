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
 * The send sites spread `useEngine().composeRequest`'s answer into the
 * `/execute` and `/runs` bodies, so the answer's `deferredVariables` (#2521, a
 * note about the composition for the Code section) must not be in it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useClientSettingsStore } from "@/stores/client-settings-store";
import { useEngine } from "./useEngine";

const composeRequest = vi.fn();

vi.mock("@/services", () => ({
	ApiError: class ApiError extends Error {},
	apiService: { composeRequest: (...args: unknown[]) => composeRequest(...args) },
}));

beforeEach(() => useClientSettingsStore.setState({ approvedEndpoints: [] }));

describe("useEngine().composeRequest", () => {
	it("hands on the composed request without deferredVariables", async () => {
		composeRequest.mockResolvedValue({
			method: "GET",
			url: "https://{{host}}/",
			deferredVariables: ["host"],
		});
		const { result } = renderHook(() => useEngine());

		const composed = await result.current.composeRequest({ requestId: "req_1" });

		expect(composeRequest).toHaveBeenCalledWith({ requestId: "req_1" });
		expect(composed).toEqual({ method: "GET", url: "https://{{host}}/" });
		// What a send site then builds its bodies from.
		expect({ ...composed, stream: false }).not.toHaveProperty("deferredVariables");
	});

	// The scope composition read is part of the send (#3461): `/execute` reads
	// the scripts' collection from it when no saved row is linked. Mutation
	// check: strip `collectionId` beside `deferredVariables` and this fails.
	it("keeps the collectionId composition answered with", async () => {
		composeRequest.mockResolvedValue({
			method: "GET",
			url: "https://{{host}}/",
			collectionId: "col_1",
			deferredVariables: ["host"],
		});
		const { result } = renderHook(() => useEngine());

		const composed = await result.current.composeRequest({
			request: { method: "GET", url: "https://{{host}}/" },
			collectionId: "col_1",
		});

		expect(composed).toEqual({
			method: "GET",
			url: "https://{{host}}/",
			collectionId: "col_1",
		});
	});

	it("passes an answer that has none through unchanged", async () => {
		composeRequest.mockResolvedValue({ method: "GET", url: "https://a.test/" });
		const { result } = renderHook(() => useEngine());

		expect(await result.current.composeRequest({ requestId: "req_1" })).toEqual({
			method: "GET",
			url: "https://a.test/",
		});
	});
});

/*
 * Composing here is composing to send (Send, Load test, a History re-run), so
 * it is the user choosing to contact the origin: the GraphQL body may then
 * introspect it on its own (`lib/graphql/approved-endpoints.ts`).
 */
describe("useEngine().composeRequest and approved endpoints", () => {
	it("approves the origin the composed request goes to, not the typed text", async () => {
		composeRequest.mockResolvedValue({ method: "POST", url: "https://api.test/gql?q=1" });
		const { result } = renderHook(() => useEngine());

		await result.current.composeRequest({
			request: { method: "POST", url: "{{base}}/gql?q=1" },
		});

		expect(useClientSettingsStore.getState().approvedEndpoints).toEqual(["https://api.test"]);
	});

	it("approves nothing for a composition that names no origin", async () => {
		composeRequest.mockResolvedValue({ method: "POST", url: "https://{{host}}/gql" });
		const { result } = renderHook(() => useEngine());

		await result.current.composeRequest({ requestId: "req_1" });

		expect(useClientSettingsStore.getState().approvedEndpoints).toEqual([]);
	});

	it("approves nothing when composing fails", async () => {
		composeRequest.mockRejectedValue(new Error("collection not found"));
		const { result } = renderHook(() => useEngine());

		await expect(result.current.composeRequest({ requestId: "req_1" })).rejects.toThrow();

		expect(useClientSettingsStore.getState().approvedEndpoints).toEqual([]);
	});
});
