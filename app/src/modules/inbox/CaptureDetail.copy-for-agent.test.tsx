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
 * "Copy for agent" on a capture's detail header (#2047).
 *
 * An icon button: a landed copy swaps the glyph and raises no toast. The line
 * names the capture by id, method and path; the headers, body and query the
 * detail displays stay off the clipboard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useToastStore } from "@/stores";
import type { InboxCapture } from "@/types";
import { CaptureDetail } from "./CaptureDetail";

const SENTINEL = "s3cr3t-sentinel";

const CAPTURE: InboxCapture = {
	id: 7,
	inboxId: "inbox_a",
	receivedAt: 1700000000000,
	method: "POST",
	path: "/hook/orders",
	query: `token=${SENTINEL}`,
	headers: { Authorization: `Bearer ${SENTINEL}` },
	body: JSON.stringify({ password: SENTINEL }),
	bodyBytes: 30,
	bodyTruncated: false,
	remoteAddr: "127.0.0.1",
};

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

function renderDetail(capture: InboxCapture | null = CAPTURE) {
	render(
		<TooltipProvider>
			<CaptureDetail capture={capture} inboxUrl="http://127.0.0.1:41234/" />
		</TooltipProvider>
	);
}

const copyButton = () => screen.getByRole("button", { name: "Copy capture for agent" });

/** The glyph a button shows now; `IconSwap` keeps the other one invisible beside it. */
function liveGlyph(button: HTMLElement): string {
	return button.querySelector(".enter-fade svg")?.getAttribute("class") ?? "";
}

describe("Copy for agent on a capture", () => {
	it("copies the formatter's line", async () => {
		renderDetail();
		fireEvent.click(copyButton());

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(
			'Vayu capture "POST /hook/orders" (7) in inbox (inbox_a)'
		);
	});

	it("swaps the glyph to a check and raises no toast", async () => {
		renderDetail();
		expect(liveGlyph(copyButton())).toContain("lucide-copy");

		fireEvent.click(copyButton());

		await waitFor(() => expect(liveGlyph(copyButton())).toContain("lucide-check"));
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("is the shared icon button, not a hand-rolled copy of it", () => {
		renderDetail();

		// `CopyForAgentButton` is the one place the rowAction variant and its
		// compact hit area are written for this control.
		expect(copyButton().className).toContain("hover:bg-accent-active");
		expect(copyButton().className).toContain("size-control-sm");
	});

	it("keeps the query, headers and body off the clipboard", async () => {
		renderDetail();
		fireEvent.click(copyButton());

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const copied = writeText.mock.calls[0][0] as string;
		expect(copied).not.toContain(SENTINEL);
		expect(copied).not.toContain("127.0.0.1");
	});

	it("offers no control while no capture is selected", () => {
		renderDetail(null);

		expect(screen.queryByRole("button", { name: "Copy capture for agent" })).toBeNull();
	});
});
