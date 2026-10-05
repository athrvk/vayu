/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TimeHoverCard } from "./TimeHoverCard";
import { TimeValue } from "./TimeValue";

const NOW = new Date("2026-10-05T14:00:00.000Z");

function renderValue(props: Partial<React.ComponentProps<typeof TimeValue>> = {}) {
	return render(
		<TooltipProvider delayDuration={0}>
			<TimeValue value="2026-10-05T12:00:00Z" locale="en-US" now={NOW} {...props} />
		</TooltipProvider>
	);
}

describe("TimeHoverCard", () => {
	it("renders one label and one value per row", () => {
		render(
			<TimeHoverCard
				rows={[
					{ label: "UTC", value: "noon" },
					{ label: "Relative", value: "now" },
				]}
			/>
		);
		expect(screen.getByText("UTC")).toBeTruthy();
		expect(screen.getByText("noon")).toBeTruthy();
		expect(screen.getByText("Relative")).toBeTruthy();
	});
});

describe("TimeValue", () => {
	it("shows the raw text and the card in Asia/Kolkata", async () => {
		renderValue({ style: "raw", timeZone: "Asia/Kolkata" });
		expect(screen.getByText("2026-10-05T12:00:00Z")).toBeTruthy();
		fireEvent.focus(screen.getByText("2026-10-05T12:00:00Z"));
		const card = await screen.findByTestId("time-hover-card");
		expect(card.textContent).toContain("Asia/Kolkata");
		expect(card.textContent).toContain("5:30:00 PM");
		expect(card.textContent).toContain("2 hours ago");
	});

	it("shows the same instant in America/New_York", async () => {
		renderValue({ style: "time", timeZone: "America/New_York" });
		fireEvent.focus(screen.getByText("8:00:00 AM"));
		const card = await screen.findByTestId("time-hover-card");
		expect(card.textContent).toContain("America/New_York");
		expect(card.textContent).toContain("EDT");
	});

	it("says a zoneless value is shown as written", async () => {
		renderValue({ value: "2026-10-05", style: "raw", timeZone: "UTC" });
		fireEvent.focus(screen.getByText("2026-10-05"));
		const card = await screen.findByTestId("time-hover-card");
		expect(card.textContent).toMatch(/no zone/);
	});

	it("renders text that is not a time as plain text with no card", async () => {
		renderValue({ value: "not a time", style: "raw" });
		fireEvent.focus(screen.getByText("not a time"));
		expect(screen.queryByTestId("time-hover-card")).toBeNull();
	});
});
