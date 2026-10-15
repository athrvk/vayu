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
 * The Tests tab with nothing to show (issue #2129).
 *
 * Postman users look for "Tests" and find it empty, with scripts and asserts
 * living under a request tab called "Elements". The empty state is the one
 * place on the response side that can say so, and it used to pass that
 * sentence as a `description` the inline variant never rendered.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// Monaco does not run under jsdom; the body panel is not what this asserts on.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="body-content">{value}</div>,
}));

const state: { response: ResponseState | null; isExecuting: boolean; request: { id: null } } = {
	response: null,
	isExecuting: false,
	request: { id: null },
};
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

const response = (overrides: Partial<ResponseState> = {}): ResponseState => ({
	status: 200,
	statusText: "OK",
	headers: { "content-type": "application/json" },
	body: "{}",
	bodyRaw: "{}",
	bodyType: "json",
	size: 2,
	time: 10,
	...overrides,
});

function openTestsTab() {
	render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
	// Radix selects on pointer-down, which a jsdom `click` never produces.
	const trigger = screen.getByRole("tab", { name: /tests/i });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

describe("the Tests tab empty state", () => {
	it("points at the Elements tab, where tests are written", () => {
		state.response = response({ testResults: [] });
		openTestsTab();

		expect(
			screen.getByText(
				"No tests ran. Add a post-request script or an assert in the Elements tab."
			)
		).toBeInTheDocument();
	});

	it("gives way to the results once a test ran", () => {
		state.response = response({ testResults: [{ name: "status is 200", passed: true }] });
		openTestsTab();

		expect(screen.queryByText(/No tests ran/)).toBeNull();
		expect(screen.getByText("status is 200")).toBeInTheDocument();
	});
});
