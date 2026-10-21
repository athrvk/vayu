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
 * `InfoBanner` is `Callout severity="info"` with the tab's bottom margin (#2317).
 *
 * It was a primary-tinted copy of the Callout, so a collection tab showed it
 * above neutral Callouts. Mutation check: restore the hand-written box
 * (`bg-primary/10 border-primary/30`) and the class comparison fails.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Callout } from "@/components/shared";
import { InfoBanner } from "./shared";

describe("InfoBanner", () => {
	it("renders the same box as an info Callout, plus the tab's margin", () => {
		const banner = render(<InfoBanner>Heads up</InfoBanner>).container.firstElementChild;
		const callout = render(<Callout severity="info">Heads up</Callout>).container
			.firstElementChild;

		expect(banner?.className.split(/\s+/)).toEqual(
			expect.arrayContaining(callout?.className.split(/\s+/) ?? [])
		);
		expect(banner).toHaveClass("mb-5");
		expect(banner?.className).not.toMatch(/primary/);
		expect(banner?.querySelector("svg")).not.toBeNull();
		expect(screen.getAllByText("Heads up")).toHaveLength(2);
	});
});
