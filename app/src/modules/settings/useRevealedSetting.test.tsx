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
 * What makes a search result worth clicking: the setting it named is the one
 * you are looking at when the panel opens. Both halves of Settings reveal
 * through this hook and the `data-setting-anchor` attribute - the engine cards
 * and the seven hand-written app panels - so the behaviour is pinned once,
 * here, rather than per panel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { useSettingsStore } from "./settings-store";
import { HIGHLIGHT_MS, useRevealedSetting } from "./useRevealedSetting";

function Panel({ anchors = ["theme-mode", "color-scheme"] }: { anchors?: string[] }) {
	useRevealedSetting();
	return (
		<div>
			{anchors.map((anchor) => (
				<div key={anchor} data-setting-anchor={anchor} data-testid={anchor}>
					{anchor}
				</div>
			))}
		</div>
	);
}

/** A panel shaped like `SettingsMain` / `ClientSettingsPanel`: a scroller ancestor. */
function PanelWithScroller({ anchors = ["theme-mode"] }: { anchors?: string[] }) {
	useRevealedSetting();
	return (
		<div data-testid="scroller" data-setting-scroller>
			{anchors.map((anchor) => (
				<div key={anchor} data-setting-anchor={anchor} data-testid={anchor}>
					{anchor}
				</div>
			))}
		</div>
	);
}

const isOutlined = (testId: string) =>
	screen.getByTestId(testId).className.includes("ring-primary");

beforeEach(() => {
	cleanup();
	useSettingsStore.setState({ highlightedKey: null });
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useRevealedSetting", () => {
	it("outlines the block that carries the key, and only that one", () => {
		render(<Panel />);
		act(() => useSettingsStore.getState().setSelectedCategory("appearance", "theme-mode"));

		expect(isOutlined("theme-mode")).toBe(true);
		expect(isOutlined("color-scheme")).toBe(false);
	});

	it("drops the outline and the key once the moment has passed", () => {
		// A key left in the store would re-outline the same block on every later
		// visit to the panel, for a search the user has long since forgotten.
		render(<Panel />);
		act(() => useSettingsStore.getState().setSelectedCategory("appearance", "theme-mode"));

		act(() => {
			vi.advanceTimersByTime(HIGHLIGHT_MS);
		});

		expect(isOutlined("theme-mode")).toBe(false);
		expect(useSettingsStore.getState().highlightedKey).toBeNull();
	});

	it("waits for a block that has not rendered yet", async () => {
		/*
		 * The key arrives with the category switch, so the panel holding the
		 * block usually mounts a commit later - and the engine catalogue arrives
		 * later still, from a query. A single lookup on mount would find nothing
		 * and silently give up.
		 */
		const { rerender } = render(<Panel anchors={[]} />);
		act(() => useSettingsStore.getState().setSelectedCategory("appearance", "theme-mode"));
		expect(screen.queryByTestId("theme-mode")).toBeNull();

		rerender(<Panel anchors={["theme-mode"]} />);
		// The MutationObserver callback is a microtask, not a timer.
		await act(async () => {});

		expect(isOutlined("theme-mode")).toBe(true);
	});

	it("gives up on a key nothing renders, rather than holding it forever", () => {
		render(<Panel />);
		act(() =>
			useSettingsStore.getState().setSelectedCategory("appearance", "gone-in-a-rename")
		);

		act(() => {
			vi.advanceTimersByTime(HIGHLIGHT_MS);
		});

		expect(useSettingsStore.getState().highlightedKey).toBeNull();
	});

	it("scrolls the ancestor scroller, not the anchor itself (#1612)", () => {
		render(<PanelWithScroller />);
		const scroller = screen.getByTestId("scroller");
		scroller.scrollTo = vi.fn();
		// jsdom has no layout, so both rects default to zero - which is already
		// a "centred" position and scrollWithin would (correctly) call nothing.
		// Stub a target below the scroller's viewport so there is an actual
		// scroll for the assertion to catch.
		scroller.getBoundingClientRect = () => ({ top: 0, height: 200 }) as DOMRect;
		screen.getByTestId("theme-mode").getBoundingClientRect = () =>
			({ top: 500, height: 40 }) as DOMRect;
		const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView");

		act(() => useSettingsStore.getState().setSelectedCategory("appearance", "theme-mode"));

		expect(scroller.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 420 });
		expect(scrollIntoViewSpy).not.toHaveBeenCalled();
		scrollIntoViewSpy.mockRestore();
	});

	it("does nothing when the anchor has no [data-setting-scroller] ancestor", () => {
		// A reveal target outside a scroller (none of today's panels, but the
		// fallback matters): no scroller to scroll, so nothing is called.
		render(<Panel />);
		const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView");

		act(() => useSettingsStore.getState().setSelectedCategory("appearance", "theme-mode"));

		expect(scrollIntoViewSpy).not.toHaveBeenCalled();
		expect(isOutlined("theme-mode")).toBe(true);
		scrollIntoViewSpy.mockRestore();
	});
});
