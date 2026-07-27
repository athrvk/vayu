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
 * **The provider.** `InfoTip` mounted its own `TooltipProvider`, so a five-phase
 * timing tab mounted five of them doing the same job. It is one at the tab root
 * now. It cannot be dropped: the app's root provider in `main.tsx` sets no
 * `delayDuration`, so these would fall back to Radix's 700ms default.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { ResponseTiming } from "../../types";

/** One entry per `TooltipProvider` mounted during a render. */
const providerRenders: number[] = [];

vi.mock("@/components/ui/tooltip", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/components/ui/tooltip")>();
	return {
		...actual,
		TooltipProvider: (props: React.ComponentProps<typeof actual.TooltipProvider>) => {
			providerRenders.push(props.delayDuration ?? -1);
			return <actual.TooltipProvider {...props} />;
		},
	};
});

const { default: ResponseTimingTab } = await import("./ResponseTimingTab");

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
	// No TooltipProvider wrapper on purpose - the tab must bring its own, and
	// Radix throws if a Tooltip finds no provider above it.
	return render(<ResponseTimingTab timing={timing} />);
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

describe("the tooltip provider", () => {
	it("sets a delay, since the app root sets none", () => {
		// `main.tsx` mounts a bare `TooltipProvider`, so without this the tips
		// inherit Radix's 700ms default - too slow for a row of phase labels.
		providerRenders.length = 0;
		rendered();
		expect(providerRenders[0]).toBeGreaterThan(0);
		expect(providerRenders[0]).toBeLessThan(700);
	});

	it("renders without one supplied, so the tab carries its own", () => {
		// Radix throws "Tooltip must be used within TooltipProvider" otherwise,
		// which is what removing the hoisted provider would do.
		expect(() => rendered()).not.toThrow();
	});

	it("mounts one, not one per tip", () => {
		/*
		 * Counted, not inferred from the DOM. A Radix provider renders no
		 * element of its own, so the obvious assertion - "no provider markup
		 * repeated" - holds whether there is one provider or five, and would
		 * have passed against the very code this replaced.
		 */
		providerRenders.length = 0;
		const { container } = rendered();
		const dots = container.querySelectorAll('button[aria-label="More information"]');

		expect(dots.length).toBeGreaterThan(1);
		expect(providerRenders).toHaveLength(1);
	});
});
