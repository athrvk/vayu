/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TooltipProvider } from "./tooltip";
import { TooltipIconButton } from "./tooltip-icon-button";

function renderButton(ui: React.ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("TooltipIconButton", () => {
	it("names the button from its label", () => {
		renderButton(<TooltipIconButton label="Refresh schema" icon={<svg data-testid="ic" />} />);
		// The whole point: an icon-only button that a screen reader can name.
		expect(screen.getByRole("button", { name: "Refresh schema" })).toBeInTheDocument();
		expect(screen.getByTestId("ic")).toBeInTheDocument();
	});

	it("forwards click and disabled to the underlying button", () => {
		const onClick = vi.fn();
		const { rerender } = renderButton(
			<TooltipIconButton label="Delete" icon={<svg />} onClick={onClick} />
		);
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(onClick).toHaveBeenCalledOnce();

		rerender(
			<TooltipProvider>
				<TooltipIconButton label="Delete" icon={<svg />} onClick={onClick} disabled />
			</TooltipProvider>
		);
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(onClick).toHaveBeenCalledOnce(); // still once - disabled swallowed it
	});

	/*
	 * The hint is secondary text on `bg-primary-fill`, so it has to be a tint of
	 * the foreground that reads there. It carried `text-muted-foreground` - a
	 * canvas token, ~1.0-2.3:1 on the accent fills - which made the mock-server
	 * row's URL unreadable inside its own tooltip. A source scan would not catch
	 * a regression that arrives through `cn()`, so the class is read off the
	 * rendered element; the ratios themselves are `tooltip-hint-contrast.test.ts`.
	 */
	it("paints the hint as a tint of the tooltip's own foreground", async () => {
		renderButton(
			<TooltipIconButton
				label="Copy mock server URL"
				tooltipHint="http://127.0.0.1:51056"
				icon={<svg />}
			/>
		);

		// Radix opens on focus, which needs no pointer geometry in jsdom.
		await act(async () => {
			fireEvent.focus(screen.getByRole("button", { name: "Copy mock server URL" }));
		});

		// Radix mirrors the content into a visually-hidden copy for the
		// `aria-describedby` announcement, so both spans are matched and both
		// are asserted rather than picking one and hoping it is the visible one.
		const hints = await screen.findAllByText("http://127.0.0.1:51056");
		expect(hints.length).toBeGreaterThan(0);
		for (const hint of hints) {
			expect(hint.className).toContain("text-primary-foreground/");
			expect(hint.className).not.toContain("text-muted-foreground");
		}
	});

	it("forwards arbitrary button props such as aria-pressed", () => {
		renderButton(<TooltipIconButton label="Reveal" icon={<svg />} aria-pressed={true} />);
		expect(screen.getByRole("button", { name: "Reveal" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
	});
});
