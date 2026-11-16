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
 * The viewer given a request and no response (an inbox capture, #3492) is the
 * body's home: the tab says "Body", the panels fill the card their caller sizes,
 * and the empty state does not blame a response that never existed. With a
 * response it is the sampled-run viewer it always was, panels fixed at 500px.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}));

import UnifiedResponseViewer from "./UnifiedResponseViewer";

const JSON_HEADERS = { "content-type": "application/json" };

describe("UnifiedResponseViewer without a response", () => {
	it("labels the first tab Body and shows the request body", () => {
		render(<UnifiedResponseViewer request={{ headers: JSON_HEADERS, body: '{"a":1}' }} />);

		expect(screen.getByRole("tab", { name: "Body" })).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: "Response" })).not.toBeInTheDocument();
		expect(JSON.parse(screen.getByTestId("code-editor").textContent ?? "")).toEqual({ a: 1 });
	});

	it("says No body for an empty request body", () => {
		render(<UnifiedResponseViewer request={{ headers: JSON_HEADERS, body: "" }} />);

		expect(screen.getByText("No body")).toBeInTheDocument();
		expect(screen.queryByText("No response body")).not.toBeInTheDocument();
	});

	it("sizes the panel to the card rather than a fixed height", () => {
		render(<UnifiedResponseViewer request={{ headers: JSON_HEADERS, body: '{"a":1}' }} />);

		const panel = screen.getByRole("tabpanel");
		expect(panel.className).toContain("flex-1");
		expect(panel.className).toContain("min-h-0");
		expect(panel.className).not.toContain("h-[500px]");
	});
});

describe("UnifiedResponseViewer with a response", () => {
	it("keeps the Response tab and its fixed 500px panel, whatever the request carries", () => {
		render(
			<UnifiedResponseViewer
				response={{ body: '{"ok":true}', headers: JSON_HEADERS }}
				request={{ headers: JSON_HEADERS, body: '{"sent":true}' }}
			/>
		);

		expect(screen.getByRole("tab", { name: "Response" })).toBeInTheDocument();
		expect(screen.getByRole("tabpanel").className).toContain("h-[500px]");
		expect(JSON.parse(screen.getByTestId("code-editor").textContent ?? "")).toEqual({
			ok: true,
		});
	});

	it("says No response body for a response with none", () => {
		render(
			<UnifiedResponseViewer
				response={{ body: "", headers: JSON_HEADERS }}
				request={{ headers: JSON_HEADERS, body: '{"sent":true}' }}
			/>
		);

		expect(screen.getByText("No response body")).toBeInTheDocument();
	});
});
