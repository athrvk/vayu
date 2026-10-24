/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { OAuth2Config } from "@/types";
import { useOAuth2DeferredNames } from "./useOAuth2DeferredNames";

let engineDeferred: readonly string[] = [];
const useDeferredVariables = vi.fn((_requestId: string, _enabled: boolean) => engineDeferred);
vi.mock("@/components/layout/context-bar/code-composition", () => ({
	useDeferredVariables: (requestId: string, enabled: boolean) =>
		useDeferredVariables(requestId, enabled),
}));

const withToken: OAuth2Config = {
	grantType: "client_credentials",
	accessTokenUrl: "https://idp.example/token",
	clientId: "{{clientId}}",
};
const literal: OAuth2Config = { ...withToken, clientId: "abc" };

beforeEach(() => {
	engineDeferred = [];
	useDeferredVariables.mockClear();
});

describe("useOAuth2DeferredNames", () => {
	it("answers the engine's names that the config as written uses", () => {
		engineDeferred = ["clientId", "unrelated"];

		const { result } = renderHook(() => useOAuth2DeferredNames("req_1", withToken));

		expect(result.current).toEqual(["clientId"]);
		expect(useDeferredVariables).toHaveBeenLastCalledWith("req_1", true);
	});

	it("does not ask the engine for a config with no token in it", () => {
		engineDeferred = ["clientId"];

		const { result } = renderHook(() => useOAuth2DeferredNames("req_1", literal));

		expect(useDeferredVariables).toHaveBeenLastCalledWith("req_1", false);
		expect(result.current).toEqual([]);
	});

	it("does not ask for a missing config", () => {
		renderHook(() => useOAuth2DeferredNames("req_1", null));

		expect(useDeferredVariables).toHaveBeenLastCalledWith("req_1", false);
	});

	it("does not ask while the caller has no use for the answer", () => {
		renderHook(() => useOAuth2DeferredNames("req_1", withToken, false));

		expect(useDeferredVariables).toHaveBeenLastCalledWith("req_1", false);
	});

	it("hands back the same array until an input changes", () => {
		engineDeferred = ["clientId"];
		const { result, rerender } = renderHook(() => useOAuth2DeferredNames("req_1", withToken));
		const first = result.current;

		rerender();

		expect(result.current).toBe(first);
	});
});
