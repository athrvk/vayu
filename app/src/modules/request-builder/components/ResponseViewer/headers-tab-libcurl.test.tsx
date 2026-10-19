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
 * The Headers tab hands `ResponseState.libcurlHeaders` to the panel (issue
 * #2464). The field is set by both funnels; this is the reader that keeps it
 * from being written and never shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="code-editor">{value}</div>,
}));

const state: {
	response: ResponseState | null;
	isExecuting: boolean;
	request: { id: string | null };
} = { response: null, isExecuting: false, request: { id: "req-1" } };
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

const response = (overrides: Partial<ResponseState> = {}): ResponseState => ({
	status: 200,
	statusText: "OK",
	headers: { server: "nginx" },
	requestHeaders: { "User-Agent": "vayu/1" },
	body: "",
	bodyType: "text",
	size: 0,
	time: 1,
	...overrides,
});

function openHeadersTab() {
	render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
	const trigger = screen.getByRole("tab", { name: /headers/i });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

beforeEach(() => {
	state.isExecuting = false;
	state.request = { id: "req-1" };
});

afterEach(cleanup);

describe("the Headers tab", () => {
	it("lists the lines libcurl added, read-only", () => {
		state.response = response({ libcurlHeaders: { Host: "api.example.com" } });
		openHeadersTab();

		fireEvent.click(screen.getByRole("button", { name: /added by libcurl/i }));
		expect(screen.getByText("Host")).toBeTruthy();
		expect(screen.getByText("api.example.com")).toBeTruthy();
		expect(screen.queryAllByRole("textbox")).toHaveLength(0);
	});

	it("has no such group when the response carries none", () => {
		state.response = response();
		openHeadersTab();

		expect(screen.queryByText("Added by libcurl")).toBeNull();
	});
});
