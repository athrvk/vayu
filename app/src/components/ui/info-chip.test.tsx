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
 * The chip's dot is 12px and its hit box is the 24px target floor (#1867).
 * jsdom does no layout, so the hit box is asserted as the classes that state
 * it: the button is `relative`, the dot stays `size-icon-sm`, and an `after:`
 * square at `size-target` centred on it is the clickable area.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { InfoChip } from "./info-chip";
import { TooltipProvider } from "./tooltip";

function chipClasses(className?: string): string[] {
	render(
		<TooltipProvider>
			<InfoChip tip="x" className={className} />
		</TooltipProvider>
	);
	return screen.getByRole("button", { name: "More information" }).className.split(/\s+/);
}

describe("InfoChip", () => {
	it("keeps the 12px dot and grows the hit box to the target floor", () => {
		const classes = chipClasses();
		expect(classes).toContain("size-icon-sm");
		expect(classes).toContain("relative");
		expect(classes).toContain("after:absolute");
		expect(classes).toContain("after:size-target");
	});

	it("centres the hit box on the dot", () => {
		const classes = chipClasses();
		for (const c of [
			"after:left-1/2",
			"after:top-1/2",
			"after:-translate-x-1/2",
			"after:-translate-y-1/2",
		]) {
			expect(classes).toContain(c);
		}
	});

	it("keeps the hit box when the caller passes a class", () => {
		const classes = chipClasses("border-rule");
		expect(classes).toContain("border-rule");
		expect(classes).toContain("after:size-target");
	});
});
