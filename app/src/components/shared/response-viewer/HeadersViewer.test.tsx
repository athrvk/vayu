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
 * A time in a header value carries the time card (#1786), and nothing else in
 * the value does. The assertions read labels and the value as received, never
 * the local row, so no case depends on the zone of the machine it runs on.
 *
 * Mutation check: render `{value}` in place of `<HeaderValue>` in the table
 * cell and the `Date` and `Set-Cookie` cases fail.
 */

import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import HeadersViewer, { CompactHeadersViewer } from "./HeadersViewer";

const DATE = "Sun, 05 Oct 2026 07:23:00 GMT";
const COOKIE_EXPIRES = "Wed, 21 Oct 2026 07:28:00 GMT";
const SET_COOKIE = `session=abc; Expires=${COOKIE_EXPIRES}; Path=/; HttpOnly`;

const HEADERS = {
	Date: DATE,
	"Content-Type": "application/json",
	"Set-Cookie": SET_COOKIE,
};

/** The value cell on the row named @p name. */
function valueCell(name: string): HTMLElement {
	const row = screen.getByText(name).closest("tr");
	expect(row).not.toBeNull();
	return row!.querySelectorAll<HTMLElement>("td")[1];
}

async function openCard(trigger: HTMLElement): Promise<HTMLElement> {
	fireEvent.focus(trigger);
	return screen.findByTestId("time-hover-card");
}

describe("HeadersViewer: times in header values", () => {
	it("gives a Date value the card, showing UTC and the value as received", async () => {
		render(<HeadersViewer headers={HEADERS} />);
		const time = within(valueCell("Date")).getByText(DATE);
		expect(time.tagName).toBe("TIME");
		const card = await openCard(time);
		expect(card.textContent).toContain("UTC");
		expect(card.textContent).not.toContain("Original");
	});

	it("gives a Content-Type value no card", () => {
		render(<HeadersViewer headers={HEADERS} />);
		const cell = valueCell("Content-Type");
		expect(cell.textContent).toBe("application/json");
		expect(cell.querySelector("time")).toBeNull();
		fireEvent.focus(within(cell).getByText("application/json"));
		expect(screen.queryByTestId("time-hover-card")).toBeNull();
	});

	it("wraps only the Expires date inside a Set-Cookie, the text unchanged", async () => {
		render(<HeadersViewer headers={HEADERS} />);
		const cell = valueCell("Set-Cookie");
		expect(cell.textContent).toBe(SET_COOKIE);
		const times = cell.querySelectorAll("time");
		expect(times).toHaveLength(1);
		expect(times[0].textContent).toBe(COOKIE_EXPIRES);
		const card = await openCard(times[0]);
		expect(card.textContent).toContain("UTC");
	});

	it("does the same in the compact variant", () => {
		const { container } = render(<CompactHeadersViewer headers={HEADERS} />);
		const times = Array.from(container.querySelectorAll("time")).map((t) => t.textContent);
		expect(times).toEqual([DATE, COOKIE_EXPIRES]);
	});
});
