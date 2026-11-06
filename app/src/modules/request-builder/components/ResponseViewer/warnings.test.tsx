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
 * The engine's warnings about a send in the response pane (issue #3307).
 *
 * A jar cookie left off the `Cookie` line, or a `Set-Cookie` libcurl discarded
 * unread, changes what the server did without changing what the response
 * shows. Like the auth notice, the band explains the outcome, so it must show
 * on every tab and on a `status: 0` failure, whose Body tab is
 * `ClientErrorView`.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ResponseState } from "../../types";

// Monaco does not run in jsdom - the body editor is not what this test is about.
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: () => <div data-testid="code-editor" />,
}));

let response: ResponseState | null = null;
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => ({ response, isExecuting: false, request: { id: null } }),
}));

const { default: ResponseViewer } = await import("./index");

const NOT_SENT = {
	code: "cookie_not_sent",
	message: "The cookie 'session' did not fit in the Cookie header and was left out.",
};
const DROPPED = {
	code: "cookie_dropped_too_many",
	message: "12 Set-Cookie headers past the first 50 were ignored.",
};

function renderWith(overrides: Partial<ResponseState> = {}) {
	response = {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: "{}",
		size: 2,
		time: 12,
		...overrides,
	};
	render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

describe("response exchange warnings", () => {
	it("draws one line per warning, each under the title for its code", () => {
		renderWith({ warnings: [NOT_SENT, DROPPED] });

		expect(screen.getByText("A cookie did not fit the Cookie header")).toBeInTheDocument();
		expect(screen.getByText(/The cookie 'session' did not fit/)).toBeInTheDocument();
		expect(screen.getByText("Response cookies were dropped as too many")).toBeInTheDocument();
		expect(screen.getByText(/12 Set-Cookie headers past the first 50/)).toBeInTheDocument();
	});

	it("titles a code the app does not know neutrally", () => {
		renderWith({ warnings: [{ code: "from_a_newer_engine", message: "Something happened." }] });

		expect(screen.getByText("Note on this send")).toBeInTheDocument();
		expect(screen.getByText(/Something happened\./)).toBeInTheDocument();
	});

	it("shows them on a failed send, whose Body tab is the client-error view", () => {
		renderWith({
			status: 0,
			statusText: "",
			body: "",
			size: 0,
			errorCode: "CONNECTION_ERROR",
			errorMessage: "refused",
			warnings: [NOT_SENT],
		});

		expect(screen.getByText(/The cookie 'session' did not fit/)).toBeInTheDocument();
	});

	it("stays on screen when another tab is selected", () => {
		renderWith({ warnings: [NOT_SENT] });

		fireEvent.mouseDown(screen.getByRole("tab", { name: /Headers/ }), { button: 0 });
		fireEvent.click(screen.getByRole("tab", { name: /Headers/ }));

		expect(screen.getByRole("tab", { name: /Headers/ })).toHaveAttribute(
			"data-state",
			"active"
		);
		expect(screen.getByText(/The cookie 'session' did not fit/)).toBeInTheDocument();
	});

	it.each([{ warnings: undefined }, { warnings: [] }])(
		"shows nothing when the response carries $warnings",
		({ warnings }) => {
			renderWith({ warnings });

			expect(screen.queryByText("A cookie did not fit the Cookie header")).toBeNull();
			expect(screen.queryByText("Note on this send")).toBeNull();
		}
	);
});
