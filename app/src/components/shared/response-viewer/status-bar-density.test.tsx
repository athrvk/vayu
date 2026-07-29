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
 * The status band stays above the tabs, and stays dense.
 *
 * It was `px-4 py-3` with `text-sm` and 16px icons - a 40px band sitting
 * directly on a 24px tab row, and the loosest padding left in the builder after
 * everything around it had been taken to `py-1`/`py-1.5`. It is 32px now.
 *
 * Folding it *into* the tab row was tried and reverted. The status of a
 * response is the first thing you look at, and a row it shares with eight tab
 * triggers and the action buttons is not where a headline goes - so the band is
 * deliberate, and "why is this not merged" has an answer rather than being an
 * oversight someone tidies later.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ResponseStatusBar } from "./ResponseStatusBar";

const bar = () =>
	render(<ResponseStatusBar status={200} statusText="OK" time={120} size={2048} />).container
		.firstElementChild as HTMLElement;

describe("the response status band", () => {
	it("is padded like the rest of the builder, not three times it", () => {
		expect(bar().className).toContain("py-1.5");
		expect(bar().className).not.toContain("py-3");
	});

	it("sizes its metrics one step below body text", () => {
		// `text-sm` here was what forced the band to 40px.
		const el = bar();
		expect(el.className).not.toContain("text-sm");
		expect(el.querySelector(".text-xs")).not.toBeNull();
	});

	it("keeps its own rule and tint, because it is still a band", () => {
		// If these go, it has been merged into something - which was tried and is
		// not what we want.
		expect(bar().className).toContain("border-b");
		expect(bar().className).toContain("border-rule");
		expect(bar().className).toContain("bg-muted/30");
	});

	it("lines its numbers up, since they change on every send", () => {
		expect(bar().querySelectorAll(".tabular-nums")).toHaveLength(2);
	});

	it("still leads with the status chip", () => {
		// The one thing in the row carrying a fill, and the reason the row exists.
		expect(bar().firstElementChild?.textContent).toContain("200");
	});
});
