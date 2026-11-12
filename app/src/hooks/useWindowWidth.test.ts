/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWindowWidth } from "./useWindowWidth";

function resizeTo(width: number) {
	vi.stubGlobal("innerWidth", width);
	window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useWindowWidth", () => {
	it("reads the window's width on mount", () => {
		vi.stubGlobal("innerWidth", 1337);
		const { result } = renderHook(() => useWindowWidth());
		expect(result.current).toBe(1337);
	});

	it("follows a resize", () => {
		vi.stubGlobal("innerWidth", 1280);
		const { result } = renderHook(() => useWindowWidth());
		act(() => resizeTo(512));
		expect(result.current).toBe(512);
	});

	it("stops listening once unmounted", () => {
		const remove = vi.spyOn(window, "removeEventListener");
		const { unmount } = renderHook(() => useWindowWidth());
		unmount();
		expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
		remove.mockRestore();
	});
});
