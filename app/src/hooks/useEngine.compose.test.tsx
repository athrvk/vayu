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

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEngine } from "./useEngine";

const composeRequest = vi.fn();

vi.mock("@/services", () => ({
	ApiError: class ApiError extends Error {},
	apiService: { composeRequest: (...args: unknown[]) => composeRequest(...args) },
}));

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

	it("passes an answer that has none through unchanged", async () => {
		composeRequest.mockResolvedValue({ method: "GET", url: "https://a.test/" });
		const { result } = renderHook(() => useEngine());

		expect(await result.current.composeRequest({ requestId: "req_1" })).toEqual({
			method: "GET",
			url: "https://a.test/",
		});
	});
});
