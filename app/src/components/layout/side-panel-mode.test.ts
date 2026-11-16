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
 * Push or overlay, over the measured window width (#3494).
 *
 * Driven through `useWindowWidth` with a stubbed `innerWidth` and a real
 * `resize` event, so each case is the path `Shell` takes, not just the
 * comparison on its own.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWindowWidth } from "@/hooks/useWindowWidth";
import {
	CONTEXT_BAR_PUSH_MIN_WIDTH,
	DRAWER_PUSH_MIN_WIDTH,
	sidePanelMode,
} from "@/constants/layout";

function renderMode(pushMinWidth: number, initialWidth: number) {
	vi.stubGlobal("innerWidth", initialWidth);
	return renderHook(() => sidePanelMode(useWindowWidth(), pushMinWidth));
}

function resizeTo(width: number) {
	vi.stubGlobal("innerWidth", width);
	window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each([
	["drawer", DRAWER_PUSH_MIN_WIDTH],
	["context bar", CONTEXT_BAR_PUSH_MIN_WIDTH],
])("the %s's mode", (_panel, threshold) => {
	it("pushes at the threshold", () => {
		const { result } = renderMode(threshold, threshold);
		expect(result.current).toBe("push");
	});

	it("overlays one pixel below it", () => {
		const { result } = renderMode(threshold, threshold - 1);
		expect(result.current).toBe("overlay");
	});

	it("follows the window across the threshold both ways", () => {
		const { result } = renderMode(threshold, threshold + 200);
		expect(result.current).toBe("push");
		act(() => resizeTo(threshold - 200));
		expect(result.current).toBe("overlay");
		act(() => resizeTo(threshold));
		expect(result.current).toBe("push");
	});
});

describe("the drawer's threshold", () => {
	it("pushes in a 1024px window and overlays at 200% of it", () => {
		// 1024 is the window minimum at 100%; 512 is the same screen at 200%,
		// where a pushing drawer at its 480px maximum would leave the content
		// nothing (the acceptance case of #3494).
		expect(sidePanelMode(1024, DRAWER_PUSH_MIN_WIDTH)).toBe("push");
		expect(sidePanelMode(512, DRAWER_PUSH_MIN_WIDTH)).toBe("overlay");
	});

	it("sits below the context bar's, which keeps its 1200px", () => {
		expect(CONTEXT_BAR_PUSH_MIN_WIDTH).toBe(1200);
		expect(DRAWER_PUSH_MIN_WIDTH).toBeLessThan(CONTEXT_BAR_PUSH_MIN_WIDTH);
	});
});
