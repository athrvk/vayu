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
 * The capture header's method chip (#2317).
 *
 * It is the shared `MethodBadge`, so it reads as the same chip the History
 * sidebar draws: coloured, five characters wide, and `DEL` with the full name
 * on hover rather than an outline `Badge` spelling `DELETE` out.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { InboxCapture } from "@/types";
import { CaptureDetail } from "./CaptureDetail";

const CAPTURE: InboxCapture = {
	id: 7,
	inboxId: "inbox_a",
	receivedAt: 1700000000000,
	method: "DELETE",
	path: "/hook/orders",
	query: "",
	headers: {},
	body: "",
	bodyEncoding: "utf8",
	bodyBytes: 0,
	bodyTruncated: false,
	remoteAddr: "127.0.0.1",
};

describe("the capture header method", () => {
	it("is the coloured, abbreviated MethodBadge with the full method on hover", () => {
		render(
			<TooltipProvider>
				<CaptureDetail capture={CAPTURE} inboxUrl="http://127.0.0.1:41234/" />
			</TooltipProvider>
		);

		const header = screen.getByText("http://127.0.0.1:41234/hook/orders").parentElement!;
		const badge = header.querySelector<HTMLElement>("[title='DELETE']")!;
		expect(badge.textContent).toBe("DEL");
		expect(badge.style.color).toContain("--method-delete");
	});
});
