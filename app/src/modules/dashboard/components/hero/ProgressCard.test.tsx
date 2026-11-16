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
 * The Progress card counts requests sent against requests expected (#2914). Its
 * caption used to read "complete", which a user checks against the responses
 * and finds ahead of, and its tooltip promised the run stopped at 100%.
 *
 * Mutation-check: put "complete" back in the caption and the first case
 * reddens; put the "stops automatically" sentence back in `TOOLTIPS.progress`
 * and the second does.
 *
 * The bar is the `Progress` primitive (#3498), so a screen reader can ask how
 * far the run is. Mutation check: put the hand-drawn `MiniBar` back and the
 * progressbar case reddens.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TOOLTIPS } from "../tooltips";
import { ProgressCard } from "./ProgressCard";

function renderCard(requestsSent: number, requestsExpected: number) {
	render(
		<TooltipProvider>
			<ProgressCard
				requestsSent={requestsSent}
				requestsExpected={requestsExpected}
				currentRps={100}
			/>
		</TooltipProvider>
	);
}

describe("ProgressCard", () => {
	it("captions the count as sent, never complete", () => {
		renderCard(250, 1000);

		const caption = screen.getByText(/sent · ETA/);
		expect(caption.textContent).toContain("250 / 1,000 sent");
		expect(caption.textContent).not.toContain("complete");
		expect(screen.getByText("25.0")).toBeTruthy();
	});

	it("reads 100% once the sent count meets the expected count", () => {
		renderCard(1000, 1000);

		expect(screen.getByText("100.0")).toBeTruthy();
	});

	it("exposes the bar as a named progressbar with the sent fraction", () => {
		renderCard(250, 1000);

		const bar = screen.getByRole("progressbar", { name: "Run progress" });
		expect(bar).toHaveAttribute("aria-valuenow", "25");
		expect(bar).toHaveAttribute("aria-valuemax", "100");
	});

	it("explains a bar that fills on sends, and does not promise a stop at 100%", () => {
		const tip = String(TOOLTIPS.progress);

		expect(tip).toContain("sent");
		expect(tip).not.toContain("stops automatically");
	});
});
