/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

	it("forwards arbitrary button props such as aria-pressed", () => {
		renderButton(<TooltipIconButton label="Reveal" icon={<svg />} aria-pressed={true} />);
		expect(screen.getByRole("button", { name: "Reveal" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
	});
});
