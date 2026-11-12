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
 * The capture's body in the main pane (#3492).
 *
 * The pane was the response viewer reading a request: its tab said "Response"
 * and its body said "No response body" over a JSON POST whose body sat only in
 * the Raw block below. A base64 body must reach the pane as bytes, never as the
 * base64 text.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { InboxCapture } from "@/types";

// Monaco does not run in jsdom; the stand-in prints what the editor was given.
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}));

import { CaptureDetail } from "./CaptureDetail";

const JSON_BODY = '{"event":"order.paid","id":42}';
// "\x89PNG\r\n\x1a\n" and two more bytes: not valid UTF-8.
const BASE64_BODY = "iVBORw0KGgoA/w==";

function capture(overrides: Partial<InboxCapture> = {}): InboxCapture {
	return {
		id: 7,
		inboxId: "inbox_a",
		receivedAt: 1700000000000,
		method: "POST",
		path: "/hook/orders",
		query: "",
		headers: { "content-type": "application/json" },
		body: JSON_BODY,
		bodyEncoding: "utf8",
		bodyBytes: JSON_BODY.length,
		bodyTruncated: false,
		remoteAddr: "127.0.0.1",
		...overrides,
	};
}

function renderDetail(c: InboxCapture) {
	return render(
		<TooltipProvider>
			<CaptureDetail capture={c} inboxUrl="http://127.0.0.1:41234/" />
		</TooltipProvider>
	);
}

describe("the capture's main pane", () => {
	it("shows the body of a JSON capture under a Body tab", () => {
		renderDetail(capture());

		expect(screen.getByRole("tab", { name: "Body" })).toHaveAttribute("data-state", "active");
		expect(screen.queryByRole("tab", { name: "Response" })).not.toBeInTheDocument();

		const panel = screen.getByRole("tabpanel");
		const shown = within(panel).getByTestId("code-editor").textContent ?? "";
		expect(JSON.parse(shown)).toEqual({ event: "order.paid", id: 42 });
		expect(screen.queryByText("No response body")).not.toBeInTheDocument();
		expect(screen.queryByText("No body")).not.toBeInTheDocument();
	});

	it("says there is no body for a capture that sent none", () => {
		renderDetail(capture({ method: "GET", headers: {}, body: "", bodyBytes: 0 }));

		const panel = screen.getByRole("tabpanel");
		expect(within(panel).getByText("No body")).toBeInTheDocument();
		expect(screen.queryByText("No response body")).not.toBeInTheDocument();
	});

	it("shows a base64 body as the binary pane, not as base64 text", () => {
		renderDetail(
			capture({
				headers: { "content-type": "application/octet-stream" },
				body: BASE64_BODY,
				bodyEncoding: "base64",
				bodyBytes: 10,
			})
		);

		const panel = screen.getByRole("tabpanel");
		expect(within(panel).getByText("Binary data, 10 B")).toBeInTheDocument();
		expect(within(panel).queryByTestId("code-editor")).not.toBeInTheDocument();
		expect(screen.queryByText(BASE64_BODY, { exact: false })).not.toBeInTheDocument();
	});

	it("falls back to the Raw view's placeholder for base64 that does not decode", () => {
		const garbled = "!!! not base64 !!!";
		renderDetail(capture({ body: garbled, bodyEncoding: "base64", bodyBytes: 2048 }));

		const panel = screen.getByRole("tabpanel");
		const shown = within(panel).getByTestId("code-editor").textContent ?? "";
		expect(shown).toBe("[2.0 KB of binary data, not shown as text.]");
		expect(screen.queryByText(garbled, { exact: false })).not.toBeInTheDocument();
	});
});
