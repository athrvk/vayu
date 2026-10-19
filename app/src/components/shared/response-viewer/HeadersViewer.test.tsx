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

import { describe, it, expect, vi } from "vitest";
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

describe("HeadersViewer: header lines as received (issue #2460)", () => {
	const LINES = [
		{ name: "X-Dup", value: "one" },
		{ name: "x-dup", value: "two" },
		{ name: "Set-Cookie", value: "a=1; Path=/" },
		{ name: "Set-Cookie", value: "b=2" },
	];
	const FOLDED = { "x-dup": "one, two", "set-cookie": "a=1; Path=/, b=2" };

	const rowTexts = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
			Array.from(tr.querySelectorAll("td")).map((td) => td.textContent)
		);

	it("renders one row per line in the case received, repeats kept", () => {
		const { container } = render(<HeadersViewer headers={FOLDED} headerLines={LINES} />);

		expect(rowTexts(container)).toEqual([
			["X-Dup", "one"],
			["x-dup", "two"],
			["Set-Cookie", "a=1; Path=/"],
			["Set-Cookie", "b=2"],
		]);
		expect(screen.getByText("4")).toBeInTheDocument();
	});

	it("builds the table from the folded map when there are no lines", () => {
		const { container } = render(<HeadersViewer headers={FOLDED} />);

		expect(rowTexts(container)).toEqual([
			["x-dup", "one, two"],
			["set-cookie", "a=1; Path=/, b=2"],
		]);
	});

	it("gives the compact variant the same rows", () => {
		const { container } = render(<CompactHeadersViewer headers={FOLDED} headerLines={LINES} />);

		const names = Array.from(container.querySelectorAll("span.font-medium")).map(
			(n) => n.textContent
		);
		expect(names).toEqual(["X-Dup:", "x-dup:", "Set-Cookie:", "Set-Cookie:"]);
	});

	it.each([
		["table", HeadersViewer],
		["compact", CompactHeadersViewer],
	] as const)("keeps the %s rows of a repeated name under distinct keys", (_name, Viewer) => {
		// Two rows keyed by name alone share a key, which React reports.
		const errors: unknown[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
		render(<Viewer headers={FOLDED} headerLines={LINES} />);
		spy.mockRestore();

		expect(errors).toEqual([]);
	});
});
