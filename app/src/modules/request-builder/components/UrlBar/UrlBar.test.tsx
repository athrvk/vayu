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
 * The Load Test button is hidden when the builder cannot start one.
 *
 * A detached copy of a past design run (History run view) is mounted without an
 * `onStartLoadTest` handler, so `canStartLoadTest` is false. The button used to
 * render anyway and do nothing on click. Dropping the `canStartLoadTest` gate in
 * the bar makes the second case below render the button again.
 *
 * The method selector and URL input are stubbed - they pull in the
 * variable-highlighting input and are not what this guards.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { TooltipProvider } from "@/components/ui";
import { formatChord } from "@/lib/platform";
import { SEND_CHORD, LOAD_TEST_CHORD } from "@/constants/shortcuts";
import UrlBar from "./index";

vi.mock("./MethodSelector", () => ({ default: () => null }));
vi.mock("./UrlInput", () => ({ default: () => null }));

function ctx(canStartLoadTest: boolean): RequestBuilderContextValue {
	return {
		request: { ...createDefaultRequestState(), url: "https://example.test/x" },
		setRequest: vi.fn(),
		updateField: vi.fn(),
		response: null,
		setResponse: vi.fn(),
		activeTab: "params",
		setActiveTab: vi.fn(),
		isExecuting: false,
		isSaving: false,
		hasUnsavedChanges: false,
		saveStatus: "idle",
		resolveString: (s: string) => s,
		resolveVariables: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: vi.fn(),
		writableScopes: [],
		executeRequest: vi.fn(async () => {}),
		saveRequest: vi.fn(async () => {}),
		startLoadTest: vi.fn(),
		canStartLoadTest,
	};
}

function renderBar(canStartLoadTest: boolean) {
	return render(
		// Both buttons carry their shortcut in a tooltip, and Radix throws
		// without a provider ancestor. The app mounts one at its root.
		<TooltipProvider>
			<RequestBuilderContext.Provider value={ctx(canStartLoadTest)}>
				<UrlBar />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

describe("UrlBar Load Test button visibility", () => {
	it("shows Load Test when the builder can start one", () => {
		renderBar(true);
		expect(screen.getByRole("button", { name: /load test/i })).toBeTruthy();
	});

	it("hides Load Test on a detached copy that cannot start one", () => {
		renderBar(false);
		expect(screen.queryByRole("button", { name: /load test/i })).toBeNull();
		// Send is still there - only the load-test affordance is gated.
		expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
	});
});

/**
 * Send and Load Test are one attached control, and it has three states.
 *
 * The pair used to be two separate buttons at two different type sizes (13px
 * and 12px) - the signature of two controls styled at different times rather
 * than a pair designed together. Attaching them makes the corner radii
 * state-dependent, and the state most likely to be missed is the one where the
 * second member is absent: a detached copy of a past design run has no
 * load-test handler, so Send is alone and must take back both corners or the
 * group looks broken rather than deliberate.
 */
describe("the Send / Load Test group", () => {
	const send = () => screen.getByRole("button", { name: /send/i });
	const loadTest = () => screen.getByRole("button", { name: /load test/i });

	it("squares Send's right edge where Load Test joins it", () => {
		renderBar(true);
		expect(send().className).toContain("rounded-l-md");
		expect(send().className).toContain("rounded-r-none");
	});

	it("gives Send both corners when it is alone", () => {
		// `canStartLoadTest` false - the detached-copy case.
		renderBar(false);
		expect(send().className).toContain("rounded-md");
		expect(send().className).not.toContain("rounded-r-none");
	});

	it("draws the shared edge once, not twice", () => {
		// Two adjacent 1px borders would render a 2px seam and make the pair a
		// pixel taller than Send on its own.
		renderBar(true);
		expect(loadTest().className).toContain("border-l-transparent");
	});

	it("sets both members at one type size", () => {
		renderBar(true);
		expect(send().className).toContain("text-xs");
		expect(loadTest().className).toContain("text-xs");
	});

	it("keeps the labels to just the words, so the row stays narrow", () => {
		// The chord was tried inside the buttons as a keycap and made them far
		// too wide - `Ctrl+Shift+↵` is eleven characters riding a nine-character
		// label, in the one row that has no width to spare. The icons went for
		// the same reason.
		renderBar(true);
		expect(send().textContent?.trim()).toBe("Send");
		expect(loadTest().textContent?.trim()).toBe("Load Test");
	});

	it("carries each shortcut in a tooltip instead", () => {
		// Zero width, and where a shortcut conventionally lives. Radix only sets
		// `aria-describedby` once the tooltip is *open*, and jsdom synthesises no
		// hover - so this asserts the trigger is wired at all, which is the part
		// that would silently vanish if the wrapper were dropped.
		renderBar(true);
		expect(send()).toHaveAttribute("data-state");
		expect(loadTest()).toHaveAttribute("data-state");
	});

	it("still defines both chords, which the tooltips render", () => {
		expect(formatChord(SEND_CHORD)).toMatch(/↵$/);
		expect(formatChord(LOAD_TEST_CHORD)).toMatch(/↵$/);
		expect(formatChord(LOAD_TEST_CHORD)).not.toBe(formatChord(SEND_CHORD));
	});
});
