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
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { emptyDrafts } from "../../utils/body-drafts";
import { TooltipProvider } from "@/components/ui";
import { formatChord } from "@/lib/platform";
import { SEND_CHORD, LOAD_TEST_CHORD } from "@/constants/shortcuts";
import UrlBar from "./index";

vi.mock("./MethodSelector", () => ({ default: () => null }));
vi.mock("./UrlInput", () => ({ default: () => null }));

interface CtxOverrides {
	isStreaming?: boolean;
	stopStream?: () => Promise<void>;
}

function ctx(canStartLoadTest: boolean, overrides: CtxOverrides = {}): RequestBuilderContextValue {
	return {
		request: { ...createDefaultRequestState(), url: "https://example.test/x" },
		setRequest: vi.fn(),
		updateField: vi.fn(),
		restoreStoredName: vi.fn(),
		// Body drafts belong to the Body panel; the URL bar never reads them. This
		// is the one context in the suite built without a cast, so it has to be
		// complete.
		getBodyDrafts: () => emptyDrafts(null),
		setBodyDrafts: vi.fn(),
		getVariablesDraft: () => null,
		setVariablesDraft: vi.fn(),
		// Likewise the Content-Type row a body mode added: the Body panel's record.
		getAutoContentType: () => null,
		setAutoContentType: vi.fn(),
		// Likewise the Accept row the Event stream toggle added: the Settings
		// panel's record (issue #574).
		getAutoAccept: () => null,
		setAutoAccept: vi.fn(),
		response: null,
		setResponse: vi.fn(),
		activeTab: "params",
		setActiveTab: vi.fn(),
		isExecuting: false,
		isStreaming: overrides.isStreaming ?? false,
		stopStream: overrides.stopStream ?? vi.fn(async () => {}),
		isSaving: false,
		hasUnsavedChanges: false,
		saveStatus: "idle",
		resolveString: (s: string) => s,
		resolveVariables: (s: string) => s,
		resolvedAuth: null,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: vi.fn(),
		writableScopes: [],
		// Send-with-row's row cap. The bar reads it off the context rather than
		// the config query precisely so this file can render without a
		// `QueryClientProvider`; no case here declares a contract, so nothing
		// measures anything against it.
		dataFileMaxRows: 1000,
		executeRequest: vi.fn(async () => {}),
		saveRequest: vi.fn(async () => {}),
		startLoadTest: vi.fn(),
		canStartLoadTest,
	};
}

function renderBar(canStartLoadTest: boolean, overrides: CtxOverrides = {}) {
	return render(
		// Both buttons carry their shortcut in a tooltip, and Radix throws
		// without a provider ancestor. The app mounts one at its root.
		<TooltipProvider>
			<RequestBuilderContext.Provider value={ctx(canStartLoadTest, overrides)}>
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

/**
 * The URL field is a `--rule` surface, and the separator depends on it.
 *
 * The hairline between the method and the URL was `bg-border`. That reads 1.30
 * on the field in light and **1.01 in dark** - `--border` is the same colour as
 * `--card` there - so the separation existed in one theme and not the other.
 * It is the defect the surface/rule contract was built to remove, walked into
 * again by writing a border token instead of `border-rule`.
 *
 * Per that contract only one half is checkable here: **the declaration**. A
 * `border-rule` under no declared surface silently falls back to `--border`,
 * which is the original bug, so asserting `border-rule` alone proves nothing.
 * The colour it resolves to is a computed-style question jsdom cannot answer.
 */
describe("the method / URL separator", () => {
	it("declares the surface its rule reads from", () => {
		const { container } = renderBar(true);
		const field = container.querySelector(".surface-card");
		expect(field, "the URL field must declare surface-card").not.toBeNull();
	});

	it("keeps bg-card beside it, or the surface loses the cascade", () => {
		// `surface-card` sets a background too, but a `bg-*` utility on the same
		// element wins - so the pair is written. Dropping either is a silent
		// revert of half the contract.
		const { container } = renderBar(true);
		expect(container.querySelector(".surface-card")?.className).toContain("bg-card");
	});

	it("draws the separator with border-rule, not a border token", () => {
		const { container } = renderBar(true);
		const rule = container.querySelector(".border-rule");
		expect(rule, "the separator must consume --rule").not.toBeNull();
		// The token it replaced. `bg-border` here is the invisible-in-dark bug.
		expect(rule?.className).not.toContain("bg-border");
	});

	it("puts the separator inside the surface that declares the rule", () => {
		// Inheritance is the whole mechanism: outside it, `--rule` falls back to
		// the `:root` default and the dark case goes straight back to 1.01.
		const { container } = renderBar(true);
		const surface = container.querySelector(".surface-card");
		expect(surface?.querySelector(".border-rule")).not.toBeNull();
	});
});

/**
 * Every button in the pair responds to the pointer.
 *
 * All three shipped with `transition-opacity` and no `hover:` rule at all - a
 * transition for a change that never happened. `Button`'s `default` variant is
 * `hover:bg-primary-fill/90`; these are hand-rolled so the pair can share an
 * edge, which means they carry that convention rather than inherit it.
 */
describe("button hover states", () => {
	it("darkens the Send fill, matching the Button primitive", () => {
		renderBar(true);
		const send = screen.getByRole("button", { name: /send/i });
		expect(send.className).toContain("hover:bg-primary-fill/90");
		// The border has to move with the fill or a lighter ring is left behind.
		expect(send.className).toContain("hover:border-primary-fill/90");
	});

	it("steps the Load Test tint up rather than down", () => {
		renderBar(true);
		expect(screen.getByRole("button", { name: /load test/i }).className).toContain(
			"hover:bg-primary/20"
		);
	});

	it("transitions colour, since colour is what changes", () => {
		renderBar(true);
		for (const name of [/send/i, /load test/i]) {
			expect(screen.getByRole("button", { name }).className).toContain("transition-colors");
		}
	});

	it("does not offer a hover on a button that cannot be clicked", () => {
		renderBar(true);
		expect(screen.getByRole("button", { name: /load test/i }).className).toContain(
			"disabled:hover:bg-primary/10"
		);
	});
});

/**
 * The row's controls sit on the app's own height step.
 *
 * They were `h-[34px]`, a value used in exactly four places - all of them this
 * file - wedged between the two heights everything else uses (`h-8` in 43
 * places, `h-9` in 16). It read as a considered number and was not one; it is
 * the same drift `type-scale.test.ts` exists to catch for font sizes, in a
 * dimension that has no equivalent guard.
 *
 * Pinned here rather than repo-wide: two other arbitrary heights exist and may
 * be deliberate, and a guard that fails on things nobody has looked at gets
 * switched off.
 */
describe("control heights", () => {
	it("uses the shared step, not a one-off pixel value", () => {
		const { container } = renderBar(true);
		expect(container.innerHTML).not.toContain("h-[34px]");
		for (const el of [
			screen.getByRole("button", { name: /send/i }),
			screen.getByRole("button", { name: /load test/i }),
		]) {
			expect(el.className).toContain("h-8");
		}
	});

	it("gives the URL field the same height as the buttons beside it", () => {
		// They are one visual row; a field a pixel off its neighbours is the kind
		// of thing nobody can name but everybody sees.
		const { container } = renderBar(true);
		expect(container.querySelector(".surface-card")?.className).toContain("h-8");
	});
});

/**
 * While a stream is open, Send is Stop (issue #574).
 *
 * A stream ends by being stopped or by hitting one of the engine's bounds, and
 * sending again while one is open is not something this surface offers - the
 * run you would be replacing is the one you would be stopping. So the control
 * has to *become* the available action rather than sit next to it, and the
 * failure mode worth guarding is the quiet one: a Send button still on screen
 * during a stream, doing something the user did not mean.
 */
describe("the Send button while a stream is open", () => {
	it("becomes Stop", () => {
		renderBar(true, { isStreaming: true });

		expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
	});

	it("stops the stream at the engine when clicked", () => {
		const stopStream = vi.fn(async () => {});
		renderBar(true, { isStreaming: true, stopStream });

		fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));

		expect(stopStream).toHaveBeenCalledTimes(1);
	});

	it("keeps the attached group's shared edge", () => {
		// Same three-state geometry as Send: the member that owns the left half
		// squares its right edge wherever Load Test joins it.
		renderBar(true, { isStreaming: true });
		expect(screen.getByRole("button", { name: /^stop$/i }).className).toContain("rounded-l-md");

		cleanup();
		renderBar(false, { isStreaming: true });
		expect(screen.getByRole("button", { name: /^stop$/i }).className).toContain("rounded-md");
	});

	it("goes back to Send once the stream has ended", () => {
		renderBar(true, { isStreaming: false });
		expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
	});
});
