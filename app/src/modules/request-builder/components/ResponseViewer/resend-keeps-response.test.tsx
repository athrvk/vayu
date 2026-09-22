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
 * Re-sending must not blank the pane.
 *
 * The loading branch used to be `isExecuting || (isStreaming && !shown)`, so
 * *every* send - the first one and every re-send after it - replaced the whole
 * pane with a centred spinner. Press Send on a request you already had a
 * response for and the status, the headers and the body you were reading were
 * gone from the moment of the press: a blank flash for a fast request, and for
 * a slow one nothing left to compare the new answer against.
 *
 * The two states are different and get different treatments, which is what
 * these cases pin:
 *
 * - **Nothing on screen yet** (the first send for a request) keeps the centred
 *   spinner - there is no context to preserve.
 * - **Something on screen already** (a re-send) keeps the previous exchange,
 *   marks the pane `aria-busy` and dims it, and does not move a pixel.
 *
 * A source scan cannot see either half: both live in a branch chosen from
 * props, so these render the component in each state and read the tree.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// Monaco does not run under jsdom. Render the body text plainly so "is the
// previous body still on screen" is a real assertion rather than a check for an
// empty editor shell. Same stub as tab-strand.test.tsx.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="body-content">{value}</div>,
}));

// The context is mutated between renders to model a send starting and landing.
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

const BODY = "the-previous-response-body";

function previousResponse(): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: BODY,
		bodyRaw: BODY,
		bodyType: "json",
		size: BODY.length,
		time: 34,
	};
}

// `ResponseActions` uses a Tooltip and relies on the app-level provider.
function renderViewer() {
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

describe("a send in flight over a response that is already on screen", () => {
	it("keeps the previous exchange instead of replacing it with a spinner", () => {
		state.response = previousResponse();
		state.isExecuting = true;
		const { container } = renderViewer();

		// The thing the user was reading is still there.
		expect(screen.getByTestId("body-content")).toHaveTextContent(BODY);
		expect(screen.getByText("200 OK")).toBeInTheDocument();
		// And the full-pane loading screen is not.
		expect(screen.queryByText(/Sending request/)).not.toBeInTheDocument();

		// Marked mid-update rather than silently stale: `aria-busy` on the pane
		// root, and the dim on what it is holding.
		const pane = container.querySelector('[aria-busy="true"]');
		expect(pane).not.toBeNull();
		expect(pane?.querySelectorAll(".opacity-60").length).toBeGreaterThan(0);

		// The one deliberate exception to "nothing moves" - `SendingWave`, faint
		// enough (`via-foreground/[0.08]`) to leave the dimmed body still
		// legible, and never a click target of its own.
		const wave = pane?.querySelector(".response-wave");
		expect(wave).not.toBeNull();
		expect(wave?.className).toContain("via-foreground/[0.08]");
		expect(wave?.parentElement?.getAttribute("aria-hidden")).toBe("true");
		expect(wave?.parentElement?.className).toContain("pointer-events-none");
	});

	it("lifts the dim when the new response lands", () => {
		state.response = previousResponse();
		state.isExecuting = false;
		const { container } = renderViewer();

		expect(screen.getByTestId("body-content")).toHaveTextContent(BODY);
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		expect(container.querySelectorAll(".opacity-60")).toHaveLength(0);
		// The wave is scoped to the busy window - it does not linger once the
		// dim itself has lifted.
		expect(container.querySelectorAll(".response-wave")).toHaveLength(0);
	});

	it("still shows the loading screen when there is nothing to keep", () => {
		// The first send for a request: no previous exchange, so a spinner is
		// the right answer and this branch stays.
		state.response = null;
		state.isExecuting = true;
		renderViewer();

		expect(screen.getByText(/Sending request/)).toBeInTheDocument();
		expect(screen.queryByTestId("body-content")).not.toBeInTheDocument();
	});
});
