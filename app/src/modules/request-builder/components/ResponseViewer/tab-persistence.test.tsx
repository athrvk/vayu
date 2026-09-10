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
 * The response pane's active sub-tab, kept per request id in
 * `tab-selection-store`.
 *
 * `Shell.tsx` mounts one workspace-tab's surface at a time, so switching away
 * from a request tab and back used to reset this pane to Body every time -
 * `activeTab` was a bare `useState` with no memory of which request it was
 * showing. It also has to survive the case that never unmounts at all: two
 * open request tabs are the same `ResponseViewer` instance (`RequestBuilder`
 * is not remounted when the user switches between them), so a plain
 * `useState` would carry request A's tab straight onto request B.
 *
 * Mutation check: drop the `setResponseTab` call from the wrapped
 * `setActiveTab` (or the `getResponseTab` read from either the mount
 * initializer or the `tabSyncedFor` sync) and the "survives" cases below fail
 * red; restoring either makes them green again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// Monaco does not run under jsdom - see tab-strand.test.tsx for the same stub.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="body-content">{value}</div>,
}));

const state: {
	response: ResponseState | null;
	isExecuting: boolean;
	request: { id: string | null };
} = {
	response: null,
	isExecuting: false,
	request: { id: null },
};
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

function aResponse(): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: "the-response-body",
		bodyType: "json",
		size: 18,
		time: 12,
	};
}

function renderViewer() {
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

// Radix selects a trigger on `mousedown`/focus, not on a bare `click` - see
// tab-strand.test.tsx.
function selectTab(name: RegExp) {
	const trigger = screen.getByRole("tab", { name });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

function activeTabName(): string | null {
	const active = screen
		.getAllByRole("tab")
		.filter((t) => t.getAttribute("data-state") === "active");
	expect(active.length, "exactly one tab must be selected").toBe(1);
	return active[0]?.textContent?.trim() ?? null;
}

beforeEach(() => {
	useTabSelectionStore.getState().clearAll();
	state.response = aResponse();
	state.isExecuting = false;
	state.request = { id: null };
});

describe("the response pane's active tab, kept per request id", () => {
	it("defaults to Body for a request seen for the first time", () => {
		state.request.id = "req_a";
		renderViewer();

		expect(activeTabName()).toMatch(/body/i);
	});

	it("survives Shell unmounting and remounting the pane for the same request", () => {
		state.request.id = "req_a";
		const { unmount } = renderViewer();
		selectTab(/headers/i);
		expect(activeTabName()).toMatch(/headers/i);

		unmount();

		// A different request, mounted fresh - shows its own default, not A's.
		state.request.id = "req_b";
		const { unmount: unmountB } = renderViewer();
		expect(activeTabName()).toMatch(/body/i);
		unmountB();

		// Back to A - its own selection is still there.
		state.request.id = "req_a";
		renderViewer();
		expect(activeTabName()).toMatch(/headers/i);
	});

	it("also keeps each request's tab separate when moving between two open request tabs without a remount", () => {
		// `RequestBuilder` is not remounted for a switch between two request
		// tabs of the same type - this pane's `request.id` changes underneath
		// the same component instance, which a mount-time initializer alone
		// cannot answer for.
		state.request.id = "req_a";
		const { rerender } = renderViewer();
		selectTab(/timing/i);
		expect(activeTabName()).toMatch(/timing/i);

		state.request.id = "req_b";
		rerender(
			<TooltipProvider>
				<ResponseViewer />
			</TooltipProvider>
		);
		expect(activeTabName()).toMatch(/body/i);

		state.request.id = "req_a";
		rerender(
			<TooltipProvider>
				<ResponseViewer />
			</TooltipProvider>
		);
		expect(activeTabName()).toMatch(/timing/i);
	});
});
