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
 * The MCP result view where the request builder mounts it (#3841): the Body
 * tab shows it above the raw reply for an `mcp` request and for no other mode,
 * and the raw reply stays in its own pane beneath it. The reading and the
 * drawing are `mcp-result.test.ts` and `McpResultView.test.tsx`.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ResponseState } from "../../types";

vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: () => <div data-testid="code-editor" />,
}));

let response: ResponseState | null = null;
let bodyMode = "mcp";
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => ({
		response,
		isExecuting: false,
		request: { id: null, bodyMode },
	}),
}));

const { default: ResponseViewer } = await import("./index");

const BODY = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	result: { isError: true, content: [{ type: "text", text: "City not found" }] },
});

function show(mode: string, overrides: Partial<ResponseState> = {}) {
	bodyMode = mode;
	response = {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: BODY,
		size: BODY.length,
		time: 12,
		...overrides,
	};
	render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

describe("MCP result view in the response Body tab", () => {
	it("draws the result above the raw reply for an mcp request", () => {
		show("mcp");

		const view = screen.getByLabelText("MCP result");
		expect(view).toHaveTextContent("Tool reported an error");
		expect(view).toHaveTextContent("City not found");
		// The raw reply keeps its own pane after the view.
		const raw = screen.getByTestId("code-editor");
		expect(view.compareDocumentPosition(raw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(view.contains(raw)).toBe(false);
	});

	it.each(["none", "json", "raw", "graphql"])("draws no result view for a %s request", (mode) => {
		show(mode);

		expect(screen.queryByLabelText("MCP result")).toBeNull();
		expect(screen.getByTestId("code-editor")).toBeInTheDocument();
	});

	it("draws no result view for an mcp reply the engine capped", () => {
		show("mcp", { bodyCapped: true });

		expect(screen.queryByLabelText("MCP result")).toBeNull();
		expect(screen.getByTestId("code-editor")).toBeInTheDocument();
	});
});
