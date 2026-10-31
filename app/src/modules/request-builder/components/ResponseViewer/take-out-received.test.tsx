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
 * Copy and Download in the response pane take the body as received (issue
 * #2459).
 *
 * `ResponseActions` copies whatever string it is handed, so the defect lived in
 * what `ResponseViewer` hands it: the pane's indented `body`, in which key
 * order, repeated keys and large integers had already been rewritten.
 * `ResponseActions.test.tsx` covers the component; this is the wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";

// Monaco does not run in jsdom, and the editor is not what this asserts.
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: () => <div data-testid="code-editor" />,
}));

let response: ResponseState | null = null;
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => ({ response, isExecuting: false, request: { id: null } }),
}));

const { default: ResponseViewer } = await import("./index");

const RECEIVED = '{"z":1,"id":9007199254740993,"z":2}';
const PANE_COPY = '{\n  "z": 2,\n  "id": 9007199254740992\n}';

function respond(overrides: Partial<ResponseState> = {}): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: PANE_COPY,
		bodyRaw: RECEIVED,
		size: RECEIVED.length,
		time: 5,
		...overrides,
	};
}

let written: string[];
let blobs: Blob[];

beforeEach(() => {
	written = [];
	blobs = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: vi.fn(async (text: string) => void written.push(text)) },
	});
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
		blobs.push(blob as Blob);
		return "blob:test";
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function renderViewer() {
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

describe("Copy and Download in the response pane", () => {
	it("copy the body as received, not the indented pane copy", async () => {
		response = respond();
		expect(response.body).not.toBe(response.bodyRaw);
		renderViewer();

		fireEvent.click(screen.getByRole("button", { name: "Copy response" }));

		await waitFor(() => expect(written).toHaveLength(1));
		expect(written[0]).toBe(RECEIVED);
	});

	it("download the body as received, not the indented pane copy", async () => {
		response = respond();
		renderViewer();

		fireEvent.click(screen.getByRole("button", { name: "Download response" }));

		expect(blobs).toHaveLength(1);
		expect(await blobs[0].text()).toBe(RECEIVED);
	});

	it("use the full text above the display gate rather than a prefix", async () => {
		// `ResponseBody` shows a bounded prefix past `LARGE_BODY_BYTES`; the
		// take-out paths must still hand back every byte that was received.
		const big = `{"pad":"${"x".repeat(2 * 1024 * 1024 + 64)}"}`;
		response = respond({ body: big, bodyRaw: big });
		renderViewer();

		fireEvent.click(screen.getByRole("button", { name: "Copy response" }));

		await waitFor(() => expect(written).toHaveLength(1));
		expect(written[0].length).toBe(big.length);
	});

	it("fall back to the pane text for a response that recorded no bodyRaw", async () => {
		response = respond({ body: "only the pane copy", bodyRaw: undefined });
		renderViewer();

		fireEvent.click(screen.getByRole("button", { name: "Copy response" }));

		await waitFor(() => expect(written).toEqual(["only the pane copy"]));
	});
});
