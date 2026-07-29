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
 * The truncation notice in the response body pane.
 *
 * The engine caps a stored trace body at `maxTraceBodyBytes`, so a response
 * restored from a run (a cold-start tab, or a design run opened from History)
 * can hold only the stored slice. `restore-response.ts` carries the
 * `bodyTruncated` / `bodyBytes` flags into `ResponseState`; this pane is where
 * the user is told, and how to get the whole body back.
 *
 * Both restored responses and design-run views render through this same viewer,
 * so one notice here covers both readers.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ResponseState } from "../../types";

// Monaco does not run in jsdom - the body editor is not what this test is about.
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: () => <div data-testid="code-editor" />,
}));

// The viewer reads its response from context; feed it a fixed one per render.
let response: ResponseState | null = null;
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => ({ response, isExecuting: false }),
}));

// Imported after the mocks above are registered.
const { default: ResponseViewer } = await import("./index");

function baseResponse(overrides: Partial<ResponseState> = {}): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: '{"ok":true}',
		bodyType: "json",
		size: 11,
		time: 12,
		...overrides,
	};
}

describe("response body truncation notice", () => {
	it("shows the notice when the restored response body was truncated", () => {
		response = baseResponse({
			body: "STORED_SLICE",
			bodyTruncated: true,
			bodyBytes: 5_242_880,
			restoredFrom: { at: new Date(1_750_000_000_000).toISOString() },
		});

		render(
			<TooltipProvider>
				<ResponseViewer />
			</TooltipProvider>
		);

		expect(screen.getByText(/Body truncated for storage/i)).toBeInTheDocument();
		// The "how to recover" instruction is the actionable half of the notice.
		expect(screen.getByText(/Re-send the request to view the full response/i)).toBeInTheDocument();
	});

	it("shows no notice for an untruncated response", () => {
		response = baseResponse();

		render(
			<TooltipProvider>
				<ResponseViewer />
			</TooltipProvider>
		);

		expect(screen.queryByText(/Body truncated for storage/i)).toBeNull();
	});
});
