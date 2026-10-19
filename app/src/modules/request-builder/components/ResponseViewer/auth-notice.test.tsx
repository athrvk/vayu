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
 * The auth notice in the response pane (issue #2474).
 *
 * An auth mode the engine stores but does not execute is sent without
 * authentication, and the usual consequence is a 401 or 403 from the target.
 * The engine says so in `authNotice`; this is where the user reads it. It must
 * not live in the Body tab's non-error branch like the two body notices do: a
 * target's 401 is a client-error status, and a `status: 0` failure has its own
 * Body tab content.
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

const NOTICE =
	"auth mode 'ntlm' is not executed by Vayu; the request was sent without authentication";

// The Callout puts the title in a span and the sentence after it as bare text in
// the same box, so the sentence is matched as a substring of that box.
const NOTICE_TEXT = /auth mode 'ntlm' is not executed by Vayu/;

function renderWith(overrides: Partial<ResponseState> = {}) {
	response = {
		status: 401,
		statusText: "Unauthorized",
		headers: { "content-type": "application/json" },
		body: '{"error":"unauthorized"}',
		bodyType: "json",
		size: 24,
		time: 12,
		...overrides,
	};
	render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

describe("response auth notice", () => {
	it("shows the engine's sentence beside a 401 from the target", () => {
		renderWith({ authNotice: NOTICE });

		expect(screen.getByText("Authentication not sent")).toBeInTheDocument();
		expect(screen.getByText(NOTICE_TEXT)).toBeInTheDocument();
	});

	it("shows it on a failed send, whose Body tab is the client-error view", () => {
		renderWith({
			status: 0,
			statusText: "",
			body: "",
			size: 0,
			errorCode: "CONNECTION_ERROR",
			errorMessage: "refused",
			authNotice: NOTICE,
		});

		expect(screen.getByText(NOTICE_TEXT)).toBeInTheDocument();
	});

	it("stays on screen when another tab is selected", () => {
		renderWith({ authNotice: NOTICE });

		fireEvent.mouseDown(screen.getByRole("tab", { name: /Headers/ }), { button: 0 });
		fireEvent.click(screen.getByRole("tab", { name: /Headers/ }));

		expect(screen.getByRole("tab", { name: /Headers/ })).toHaveAttribute(
			"data-state",
			"active"
		);
		expect(screen.getByText(NOTICE_TEXT)).toBeInTheDocument();
	});

	it("shows nothing when the response carries no notice", () => {
		renderWith();

		expect(screen.queryByText("Authentication not sent")).toBeNull();
	});
});
