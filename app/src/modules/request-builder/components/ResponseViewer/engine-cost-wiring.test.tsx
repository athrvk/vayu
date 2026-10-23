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
 * `timing.engineMs` has to reach the status bar through the pane (issue #2132).
 *
 * The bar's own tests hand it the prop directly, so they cannot see the
 * pass-through from `ResponseState` being dropped. This renders the real pane
 * with a response whose timing carries the figure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// Monaco does not run under jsdom; same stub as resend-keeps-response.test.tsx.
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

const response = (engineMs?: number): ResponseState => ({
	status: 200,
	statusText: "OK",
	headers: {},
	body: "{}",
	bodyRaw: "{}",
	bodyType: "json",
	size: 2,
	time: 120,
	timing: {
		totalMs: 120,
		dnsMs: 1,
		connectMs: 2,
		tlsMs: 3,
		firstByteMs: 100,
		downloadMs: 1,
		...(engineMs === undefined ? {} : { engineMs }),
	},
});

const renderViewer = () =>
	render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);

describe("the response pane's Vayu figure", () => {
	beforeEach(() => {
		state.isExecuting = false;
	});

	it("shows the engineMs the response carries", () => {
		state.response = response(0.4);
		renderViewer();

		expect(screen.getByText("- 0.4 ms in Vayu")).toBeInTheDocument();
	});

	it("shows nothing for a response without one", () => {
		state.response = response();
		renderViewer();

		expect(screen.queryByText(/in Vayu/)).toBeNull();
	});
});
