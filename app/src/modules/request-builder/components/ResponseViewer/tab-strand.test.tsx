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
 * The response pane must not go blank when the tab you are standing on stops
 * existing in the next response (issue #59).
 *
 * `ResponseViewer` keeps the active tab in local state that survives a response
 * change. Four of the seven tabs are conditional - `timing`, `console`, `tests`
 * and `raw-request` - and each trigger unmounts with its panel. The `Tabs` root
 * is controlled, so once `value` names a tab that no longer renders, Radix has
 * nothing to select and nothing to show: no tab highlighted, empty body.
 *
 * A source scan cannot see this - the defect lives in state that outlives a prop
 * change - so these render the component, shrink the tab set between renders and
 * assert a tab is still selected and the body still renders. Revert the
 * `effectiveTab` clamp in index.tsx and both cases fail: zero tabs active, no
 * body panel in the tree.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// Monaco does not run under jsdom. Render the body text plainly so "is the body
// panel on screen" is a real assertion, not a check for an empty editor shell.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="body-content">{value}</div>,
}));

// The context is mutated between renders to model a second response arriving.
// `request` is read for its id alone - the pane selects the live event stream
// against the request on screen (issue #574), and these responses have none.
const state: { response: ResponseState | null; isExecuting: boolean; request: { id: null } } = {
	response: null,
	isExecuting: false,
	request: { id: null },
};
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

const BODY = "the-response-body";

/** A response carrying every conditional tab. */
function fullResponse(): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		requestHeaders: { host: "example.com" },
		rawRequest: "GET / HTTP/1.1",
		body: BODY,
		bodyRaw: BODY,
		bodyType: "json",
		size: BODY.length,
		time: 34,
		timing: { totalMs: 34, dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 20, downloadMs: 8 },
		consoleLogs: ["hello from a script"],
		testResults: [{ name: "status is 200", passed: true }],
	};
}

// `ResponseActions` uses a Tooltip and relies on the app-level provider (main.tsx).
function renderViewer() {
	const result = render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
	return {
		...result,
		rerender: () =>
			result.rerender(
				<TooltipProvider>
					<ResponseViewer />
				</TooltipProvider>
			),
	};
}

// Radix selects a trigger on `mousedown`/focus, not on a bare `click` - and
// `user-event` is not a dependency here, so drive it the way Radix listens.
function selectTab(name: RegExp) {
	const trigger = screen.getByRole("tab", { name });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

/** The active trigger, or null if the strip has nothing selected. */
function activeTabName(): string | null {
	const active = screen
		.getAllByRole("tab")
		.filter((t) => t.getAttribute("data-state") === "active");
	expect(active.length, "exactly one tab must be selected").toBe(1);
	return active[0]?.textContent?.trim() ?? null;
}

/*
 * Issue #59 is now unrepresentable rather than handled.
 *
 * It happened because four tabs rendered only when the response carried their
 * data, so the set shrank as you switched responses: a tab clicked on one
 * response could name a trigger the next one no longer drew, leaving the
 * controlled Tabs root with nothing to select and a blank pane. The fix was a
 * clamp back to `body`.
 *
 * Every tab renders now, so nothing can vanish underneath the selection and the
 * clamp is gone. These no longer test the clamp; they test the property that
 * replaced it - **the tab set does not depend on the response** - which is
 * strictly stronger, because a clamp only rescues you after the set has changed.
 */
describe("the response tab set", () => {
	const ALL = [/body/i, /headers/i, /cookies/i, /timing/i, /console/i, /tests/i, /raw/i];

	it("renders all seven tabs for a response that carries everything", () => {
		state.response = fullResponse();
		renderViewer();
		for (const name of ALL) {
			expect(screen.queryByRole("tab", { name })).toBeTruthy();
		}
	});

	it("renders all seven for a response that carries none of the optional data", () => {
		// The case that used to shrink the strip to three.
		state.response = {
			...fullResponse(),
			timing: undefined,
			consoleLogs: undefined,
			testResults: undefined,
			rawRequest: undefined,
			preScriptError: undefined,
			postScriptError: undefined,
		};
		renderViewer();
		for (const name of ALL) {
			expect(screen.queryByRole("tab", { name })).toBeTruthy();
		}
	});

	it("keeps the selected tab when the next response drops that tab's data", () => {
		/*
		 * The #59 repro, inverted. Standing on Tests and re-sending without a
		 * test script used to unmount the trigger under you; now the tab stays
		 * selected and says it has nothing, which is an answer rather than a
		 * disappearance.
		 */
		state.response = fullResponse();
		const { rerender } = renderViewer();

		selectTab(/tests/i);
		expect(activeTabName()).toMatch(/tests/i);

		state.response = { ...fullResponse(), testResults: undefined };
		rerender();

		expect(screen.queryByRole("tab", { name: /tests/i })).toBeTruthy();
		expect(activeTabName()).toMatch(/tests/i);
		expect(screen.getByText(/no tests ran/i)).toBeTruthy();
	});

	it("keeps Timing selected across restored traces with and without timing", () => {
		// Sequence #65 makes this routine by routing design-run history here.
		state.response = fullResponse();
		const { rerender } = renderViewer();

		selectTab(/timing/i);
		expect(activeTabName()).toMatch(/timing/i);

		state.response = { ...fullResponse(), timing: undefined };
		rerender();

		expect(activeTabName()).toMatch(/timing/i);
		expect(screen.getByText(/no timing recorded/i)).toBeTruthy();
	});
});

/**
 * No tab trigger carries an icon.
 *
 * Console had one - the only icon across the fifteen triggers in the two strips,
 * this pane's seven and the request builder's eight. One decorated tab out of
 * fifteen reads as that tab being a different *kind* of thing rather than as an
 * aid to finding it, and it sat directly beside the error dot that actually
 * distinguishes Console when it matters.
 *
 * Asserted by rendering rather than scanning: an icon arrives as a component, and
 * a source scan for `lucide` would flag the tab *panels*, which use icons
 * legitimately.
 */
describe("icons in the tab strip", () => {
	it("has none, so no tab reads as a different kind of thing", () => {
		state.response = fullResponse();
		const { container } = renderViewer();

		const triggers = Array.from(
			container.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]')
		);
		expect(triggers.length).toBeGreaterThan(5);

		const decorated = triggers
			.filter((t) => t.querySelector("svg"))
			.map((t) => t.textContent?.trim());
		expect(decorated).toEqual([]);
	});
});

/**
 * A tab count of zero renders nothing.
 *
 * Removing the conditional gating made the Console tab always render, and its
 * count came with it - so a response with no console output showed `Console⁰`,
 * a superscript whose only message is that there is nothing to read, above a
 * panel that says "No console output" at more length.
 *
 * `TabCount` drops a zero itself rather than each call site guarding: they were
 * already guarding by hand (`RequestTabs` passes `badge: undefined` and tests
 * `!== undefined`), which is the same remembering problem one level up.
 */
describe("a tab count of zero", () => {
	it("shows no superscript on Console when nothing was logged", () => {
		state.response = {
			...fullResponse(),
			consoleLogs: undefined,
			preScriptError: undefined,
			postScriptError: undefined,
		};
		renderViewer();

		/*
		 * The absence of a `sup`, not an equality on the text. `TabLabel` renders
		 * its label twice - once `invisible font-semibold` to reserve the width
		 * the active state will need - so `textContent` is "ConsoleConsole" and
		 * always will be.
		 */
		const trigger = screen.getByRole("tab", { name: /console/i });
		expect(trigger.querySelector("sup")).toBeNull();
		expect(trigger.textContent).not.toMatch(/\d/);
	});

	it("still shows a real count when there is one", () => {
		// The guard has to fail for the right reason - a count that vanished
		// entirely would pass the assertion above.
		state.response = { ...fullResponse(), consoleLogs: ["one", "two"] };
		renderViewer();

		const trigger = screen.getByRole("tab", { name: /console/i });
		expect(trigger.querySelector("sup")?.textContent).toBe("2");
	});
});
