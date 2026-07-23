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
import { render, screen, fireEvent, within } from "@testing-library/react";
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
const state: { response: ResponseState | null; isExecuting: boolean } = {
	response: null,
	isExecuting: false,
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
		timing: { total: 34, dns: 1, connect: 2, tls: 3, firstByte: 20, download: 8 },
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

function bodyIsVisible(): boolean {
	const panel = screen.queryByTestId("body-content");
	return !!panel && within(panel).queryByText(BODY) !== null;
}

describe("ResponseViewer active-tab clamping", () => {
	it("renders the conditional tab this test relies on (guards the fixture)", () => {
		state.response = fullResponse();
		const { unmount } = renderViewer();

		// If the fixture stopped producing a Tests tab, the strand test below
		// would pass vacuously - so prove the tab is really there first.
		expect(screen.getByRole("tab", { name: /tests/i })).toBeTruthy();
		unmount();
	});

	it("falls back to Body when the selected tab disappears from the next response", () => {
		state.response = fullResponse();
		const { rerender } = renderViewer();

		// Stand on Tests, the way the app's repro does.
		selectTab(/tests/i);
		expect(activeTabName()).toMatch(/tests/i);

		// A scriptless re-send: same response, no test results. The Tests tab and
		// its panel unmount together.
		state.response = { ...fullResponse(), testResults: undefined };
		rerender();

		expect(screen.queryByRole("tab", { name: /tests/i })).toBeNull();
		expect(activeTabName()).toMatch(/body/i);
		expect(bodyIsVisible()).toBe(true);
	});

	it("survives switching between restored responses with differing tab sets", () => {
		// One restored trace has timing, the next has none - the sequence #65
		// makes routine by routing design-run history through this viewer.
		state.response = fullResponse();
		const { rerender } = renderViewer();

		selectTab(/timing/i);
		expect(activeTabName()).toMatch(/timing/i);

		state.response = { ...fullResponse(), timing: undefined };
		rerender();

		expect(screen.queryByRole("tab", { name: /timing/i })).toBeNull();
		expect(activeTabName()).toMatch(/body/i);
		expect(bodyIsVisible()).toBe(true);
	});
});
