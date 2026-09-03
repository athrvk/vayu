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
	// `request` for its id alone - the pane selects a live event stream against
	// the request on screen (issue #574), and these responses have none.
	useRequestBuilderContext: () => ({ response, isExecuting: false, request: { id: null } }),
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
		expect(
			screen.getByText(/Re-send the request to view the full response/i)
		).toBeInTheDocument();
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

/**
 * The second, separate disclosure (issue #1157): the engine stopped *reading*
 * at `maxDesignResponseBodyBytes`, so the rest was never received.
 *
 * It is not the notice above and must not be worded like it. Storage truncation
 * shortened a body that arrived whole, so "re-send" recovers it; a capped read
 * is reproduced exactly by a re-send, and the only thing that changes it is the
 * setting. Telling a user to re-send here is advice that cannot work.
 */
describe("response body cap notice", () => {
	function renderWith(state: Partial<ResponseState>) {
		response = baseResponse(state);
		render(
			<TooltipProvider>
				<ResponseViewer />
			</TooltipProvider>
		);
	}

	it("shows the notice when the engine capped the read", () => {
		renderWith({ body: "PREFIX", bodyCapped: true, size: 33_554_432 });

		expect(screen.getByText(/Body capped while reading/i)).toBeInTheDocument();
		// The actionable half - and the half that differs from the notice above.
		expect(screen.getByText(/Raise Max Design Response Body in Settings/i)).toBeInTheDocument();
	});

	it("shows no notice for an uncapped response", () => {
		renderWith({});

		expect(screen.queryByText(/Body capped while reading/i)).toBeNull();
	});

	it("says something different from the storage-truncation notice", () => {
		// Both facts at once, which is a real state: the engine read a prefix and
		// storage then shortened even that. Two notices, two remedies - and the
		// re-send instruction must belong to exactly one of them.
		renderWith({
			body: "PREFIX",
			bodyCapped: true,
			bodyTruncated: true,
			bodyBytes: 33_554_432,
			size: 33_554_432,
		});

		const truncated = screen.getByText(/Body truncated for storage/i);
		const capped = screen.getByText(/Body capped while reading/i);
		expect(truncated).toBeInTheDocument();
		expect(capped).toBeInTheDocument();

		const truncatedText = truncated.parentElement!.textContent ?? "";
		const cappedText = capped.parentElement!.textContent ?? "";
		expect(cappedText).not.toBe(truncatedText);

		// Only the storage notice tells the user to re-send; only the cap notice
		// names the setting. Swapping either sentence between them would be the
		// conflation this pair exists to prevent.
		expect(truncatedText).toMatch(/Re-send the request/i);
		expect(truncatedText).not.toMatch(/Max Design Response Body/i);
		expect(cappedText).toMatch(/Max Design Response Body/i);
		expect(cappedText).toMatch(/re-sending reads the same amount/i);
	});
});
