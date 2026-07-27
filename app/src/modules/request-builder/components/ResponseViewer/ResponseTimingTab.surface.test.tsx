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
 * The timing tab's two rules, and the tooltip provider above them.
 *
 * **The rules.** Both were `border-border`, inside a pane whose root declares
 * `surface-card` (`ResponseViewer/index.tsx`). On a card `--border` measures
 * ~1.00 in dark - it is the same colour as `--card` - so the dashed summary
 * separator and the info dot's outline were simply absent in one theme. The
 * sibling `ResponseCookies` in this same pane was migrated to `border-rule`
 * with those measurements written into its comment; this tab was missed, which
 * is what "migrate as you touch" leaves behind.
 *
 * Only the *declaration* is checkable here: `border-rule` resolves through a
 * CSS custom property, and jsdom computes no colours. The surface it reads from
 * is declared by the pane, not by this tab, so what this file can prove is that
 * the tab stopped naming a token the pane cannot make visible.
 *
 * **The provider is no longer this tab's business.** `InfoTip` used to mount its
 * own `TooltipProvider` - five for a five-phase tab - and this file grew tests
 * for that. Since the app root now sets the delay once and nothing nests a
 * provider anywhere, those tests moved to `components/ui/tooltip-delay.test.tsx`,
 * which guards the rule for the whole app rather than for one tab. What is left
 * here is the harness supplying a provider, as the app does.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { ResponseTiming } from "../../types";

import { TooltipProvider } from "@/components/ui";
import ResponseTimingTab from "./ResponseTimingTab";

const timing: ResponseTiming = {
	totalMs: 1011,
	wireMs: 1008,
	queueWaitMs: 0.2,
	dnsMs: 64,
	connectMs: 214,
	tlsMs: 517,
	firstByteMs: 213,
	downloadMs: 0,
};

function rendered() {
	// The tab brings no provider of its own, so the harness supplies one - the
	// same thing `main.tsx` does for the running app.
	return render(
		<TooltipProvider>
			<ResponseTimingTab timing={timing} />
		</TooltipProvider>
	);
}

describe("the rules inside the response card", () => {
	it("names no border token the card cannot show", () => {
		const { container } = rendered();
		const offenders = Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
			/\bborder-(border|border-strong|input)\b/.test(el.className)
		);
		expect(offenders.map((el) => el.className)).toEqual([]);
	});

	it("draws the summary separator with a rule that reads on a card", () => {
		const { container } = rendered();
		const separator = container.querySelector(".border-dashed");
		expect(separator, "the summary row's separator").not.toBeNull();
		expect(separator!.className).toContain("border-rule");
	});

	it("outlines the info dots the same way", () => {
		const { container } = rendered();
		const dots = Array.from(
			container.querySelectorAll<HTMLElement>('button[aria-label="More information"]')
		);
		// One per phase plus the summary stats - the point is that there are
		// several and none of them is checked by hand.
		expect(dots.length).toBeGreaterThan(1);
		for (const dot of dots) {
			expect(dot.className).toContain("border-rule");
		}
	});
});
