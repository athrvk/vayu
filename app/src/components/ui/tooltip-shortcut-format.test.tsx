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
 * Every shortcut tooltip has one shape: the label, then the chord in a
 * `TooltipHint`, in the same row.
 *
 * Three surfaces spelled it three ways - a `${label} ${shortcut}` template
 * (the rail, so the chord was plain foreground text), a flex row (icon
 * buttons) and a mono hint with its own gap (the URL bar). They now all render
 * `TooltipShortcutLabel`, and this renders each real surface and compares the
 * DOM, so a fourth hand-rolled spelling in one of them fails here.
 *
 * Nothing asserts a platform: the chord is whatever `formatChord` answers on the
 * host, and the shape under test is the same on every one.
 */

import { afterEach, describe, it, expect } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { TooltipProvider } from "./tooltip";
import { TooltipIconButton } from "./tooltip-icon-button";
import { RailButton } from "@/components/layout/RailButton";
import { Hint } from "@/modules/request-builder/components/UrlBar";
import { formatChord } from "@/lib/platform";
import { SEND_CHORD } from "@/constants/shortcuts";

const CHORD = formatChord(SEND_CHORD);

const SURFACES: { name: string; label: string; ui: React.ReactElement }[] = [
	{
		name: "TooltipIconButton",
		label: "Refresh schema",
		ui: <TooltipIconButton label="Refresh schema" tooltipHint={CHORD} icon={<svg />} />,
	},
	{
		name: "RailButton",
		label: "Collections",
		ui: (
			<RailButton
				active={false}
				onClick={() => {}}
				label="Collections"
				shortcut={CHORD}
				side="left"
				variant="indicator"
			>
				<svg />
			</RailButton>
		),
	},
	{
		name: "UrlBar Hint",
		label: "Send request",
		ui: (
			<Hint chord={SEND_CHORD} label="Send request">
				<button type="button">Send</button>
			</Hint>
		),
	},
];

afterEach(cleanup);

describe("shortcut tooltips", () => {
	it.each(SURFACES)("$name puts the chord in a TooltipHint beside the label", async (surface) => {
		render(<TooltipProvider>{surface.ui}</TooltipProvider>);
		// Radix opens on focus, which needs no pointer geometry in jsdom.
		await act(async () => {
			fireEvent.focus(screen.getByRole("button"));
		});

		const tooltip = await screen.findByRole("tooltip");
		const label = within(tooltip).getByText(surface.label);
		const hint = within(tooltip).getByText(CHORD);

		// Label and chord are siblings in one `flex items-center gap-1.5` row, and
		// the row holds nothing else: no parentheses, no separator text.
		expect(label.parentElement).toBe(hint.parentElement);
		expect(label.parentElement?.className).toContain("flex items-center gap-1.5");
		expect(label.parentElement?.textContent).toBe(`${surface.label}${CHORD}`);
		expect(hint.className).toContain("text-primary-foreground/");
		expect(label.className).not.toContain("text-primary-foreground/");
	});
});
