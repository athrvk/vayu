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
 * The Settings tab and its redirect controls.
 *
 * Three things are worth holding still. The tab has to be a real member of the
 * tab strip - Radix gives arrow-key roving focus to whatever sits in the
 * `tablist`, so a tab rendered anywhere else would look identical and navigate
 * nothing. The badge has to track the *engine* defaults rather than "the user
 * touched it", or every request would badge forever after a stray keystroke.
 * And the max-redirects field has to disable when following is off, because a
 * hop count with nothing to count is a control that lies.
 *
 * Rendering rather than scanning source: the badge arrives through `tab.badge`
 * from a `.map()`, so no static scan can see whether it was computed.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { RequestBuilderContext } from "../../context/RequestBuilderContext";
import type { RequestBuilderContextValue, RequestState } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { DEFAULT_MAX_REDIRECTS, MAX_MAX_REDIRECTS } from "@/constants/request";
import RequestTabs from "./index";

function renderTabs(overrides: Partial<RequestState> = {}, updateField = vi.fn()) {
	const request: RequestState = { ...createDefaultRequestState(), ...overrides };
	const value = {
		request,
		updateField,
		setRequest: vi.fn(),
		activeTab: "settings",
		setActiveTab: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	render(
		<RequestBuilderContext.Provider value={value}>
			<RequestTabs />
		</RequestBuilderContext.Provider>
	);
	return updateField;
}

const settingsTab = () => screen.getByRole("tab", { name: /settings/i });
const followToggle = () => screen.getByRole("switch", { name: /follow redirects/i });
const hopLimit = () => screen.getByLabelText(/maximum redirects/i);

describe("Settings tab", () => {
	it("is a member of the tab strip, so it joins arrow-key navigation", () => {
		renderTabs();
		const strip = screen.getByRole("tablist");
		expect(within(strip).getByRole("tab", { name: /settings/i })).toBeTruthy();
	});

	it("renders its panel, so the trigger's aria-controls resolves", () => {
		renderTabs();
		expect(settingsTab().getAttribute("aria-controls")).toBeTruthy();
		expect(screen.getByRole("tabpanel")).toBeTruthy();
	});

	it("does not badge while the request matches the engine defaults", () => {
		renderTabs();
		expect(settingsTab().textContent).toBe("Settings");
	});

	it("badges when following is turned off", () => {
		renderTabs({ followRedirects: false });
		expect(settingsTab().textContent).toContain("1");
	});

	it("badges when the hop limit differs from the default", () => {
		renderTabs({ maxRedirects: DEFAULT_MAX_REDIRECTS + 5 });
		expect(settingsTab().textContent).toContain("1");
	});
});

describe("Settings panel controls", () => {
	it("writes the toggle through to the request", () => {
		const updateField = renderTabs();
		fireEvent.click(followToggle());
		expect(updateField).toHaveBeenCalledWith("followRedirects", false);
	});

	it("turns following back on from the off state", () => {
		const updateField = renderTabs({ followRedirects: false });
		fireEvent.click(followToggle());
		expect(updateField).toHaveBeenCalledWith("followRedirects", true);
	});

	it("keeps both controls in the keyboard tab order", () => {
		renderTabs();
		// Radix renders the switch as a <button>; a stray tabIndex={-1} on
		// either control would leave the panel mouse-only.
		for (const control of [followToggle(), hopLimit()]) {
			expect(control.getAttribute("tabindex")).not.toBe("-1");
			control.focus();
			expect(document.activeElement).toBe(control);
		}
	});

	it("disables the hop limit while following is off", () => {
		renderTabs({ followRedirects: false });
		expect(hopLimit()).toBeDisabled();
	});

	it("leaves the hop limit editable while following is on", () => {
		renderTabs({ followRedirects: true });
		expect(hopLimit()).not.toBeDisabled();
	});

	it("clamps a hop limit above the accepted range", () => {
		const updateField = renderTabs();
		fireEvent.change(hopLimit(), { target: { value: "999" } });
		expect(updateField).toHaveBeenCalledWith("maxRedirects", MAX_MAX_REDIRECTS);
	});

	it("falls back to the default when the field is cleared", () => {
		const updateField = renderTabs();
		fireEvent.change(hopLimit(), { target: { value: "" } });
		expect(updateField).toHaveBeenCalledWith("maxRedirects", DEFAULT_MAX_REDIRECTS);
	});
});
