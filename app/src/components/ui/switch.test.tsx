/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An off switch has to be visible.
 *
 * Measured against `--card` with transitions frozen, the unchecked track was
 * 1.55 in light and 1.28 in dark, and in light the thumb was only 1.41 against
 * its own track — so the control was very close to invisible until you knew
 * where to look. WCAG 1.4.11 asks for 3.0 on the visual information that
 * identifies a component and its state.
 *
 * The fix colours the already-reserved 2px border rather than darkening the
 * fill, so the off state stays quiet and nothing resizes. These tests assert the
 * class survives; the ratios themselves were measured in a browser, since jsdom
 * resolves no custom properties and would report every colour as empty.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Switch } from "./switch";

describe("Switch", () => {
	it("gives the unchecked state its own visible boundary", () => {
		render(<Switch aria-label="Reduced motion" />);
		const sw = screen.getByRole("switch", { name: "Reduced motion" });
		expect(sw).toHaveAttribute("data-state", "unchecked");
		expect(sw.className).toContain("data-[state=unchecked]:border-subtle-foreground");
	});

	it("reserves the border width in both states, so toggling does not resize", () => {
		// The boundary is painted into space the transparent border already
		// occupied. If the width became state-dependent the control would jump.
		render(<Switch aria-label="Reduced motion" />);
		const sw = screen.getByRole("switch", { name: "Reduced motion" });
		expect(sw.className).toContain("border-2");
		expect(sw.className).not.toMatch(/data-\[state=checked\]:border-\d/);
	});

	it("keeps the checked state on the accent fill", () => {
		render(<Switch aria-label="Reduced motion" checked onCheckedChange={() => {}} />);
		const sw = screen.getByRole("switch", { name: "Reduced motion" });
		expect(sw).toHaveAttribute("data-state", "checked");
		expect(sw.className).toContain("data-[state=checked]:bg-primary");
	});
});
