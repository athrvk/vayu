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
 * A pre/post-request script error must be visible even when the script threw
 * before logging anything (issue #111). The engine still returns a normal 200
 * with `preScriptError`/`postScriptError` set but empty `consoleLogs`; gating
 * the Console tab on `consoleLogs.length > 0` hid the error entirely.
 *
 * These render the viewer and assert the Console tab (and its error card) show
 * up on a log-less error. Mutation-check: restore the `hasConsoleLogs`-only gate
 * in index.tsx and "renders the Console tab when a script errored without logs"
 * fails - no Console trigger, error nowhere on screen.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// Monaco does not run under jsdom; the body panel is not what we assert on.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="body-content">{value}</div>,
}));

const state: { response: ResponseState | null; isExecuting: boolean } = {
	response: null,
	isExecuting: false,
};
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

/** A 200 response whose pre-request script threw before logging anything. */
function errorNoLogsResponse(): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: '{"ok":true}',
		bodyRaw: '{"ok":true}',
		bodyType: "json",
		size: 11,
		time: 12,
		// No consoleLogs at all - the throw-before-log case.
		preScriptError: "ReferenceError: foo is not defined",
	};
}

function renderViewer() {
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

function selectTab(name: RegExp) {
	const trigger = screen.getByRole("tab", { name });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

describe("ResponseViewer surfaces script errors without console logs (#111)", () => {
	it("renders the Console tab when a script errored without logs", () => {
		state.response = errorNoLogsResponse();
		const { unmount } = renderViewer();

		// The tab exists despite `consoleLogs` being empty.
		expect(screen.getByRole("tab", { name: /console/i })).toBeTruthy();
		unmount();
	});

	it("shows the pre-request script error message inside the Console panel", () => {
		state.response = errorNoLogsResponse();
		renderViewer();

		selectTab(/console/i);

		expect(screen.getByText(/Pre-request Script Error/i)).toBeTruthy();
		expect(screen.getByText(/ReferenceError: foo is not defined/)).toBeTruthy();
	});

	it("does not render a Console tab when there is neither a log nor a script error", () => {
		state.response = { ...errorNoLogsResponse(), preScriptError: undefined };
		renderViewer();

		expect(screen.queryByRole("tab", { name: /console/i })).toBeNull();
	});
});
