/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { buttonVariants } from "./button-variants";
import { cn } from "@/lib/utils";

describe("buttonVariants listRow", () => {
	// cva concatenates `size`'s classes after `variant`'s, so a height set on
	// `variant.listRow` itself loses to `size`'s default `h-9` in the same
	// `cn()` merge Button.tsx applies - the override has to live in
	// `compoundVariants`, which cva appends after `size`. Mutation-checked:
	// dropping the `compoundVariants` entry lets this fail while every other
	// test in the suite stays green, since jsdom renders no layout for a
	// height class to visibly break.
	it("overrides the default size's fixed height with h-auto", () => {
		const classes = cn(buttonVariants({ variant: "listRow" }));
		expect(classes).toContain("h-auto");
		expect(classes).not.toMatch(/(^|\s)h-9(\s|$)/);
	});

	it("left-aligns instead of the base's centered justify-content", () => {
		const classes = cn(buttonVariants({ variant: "listRow" }));
		expect(classes).toContain("justify-start");
		expect(classes).not.toMatch(/(^|\s)justify-center(\s|$)/);
	});

	it("lets a caller's className win a conflicting utility, e.g. justify-between", () => {
		const classes = cn(buttonVariants({ variant: "listRow", className: "justify-between" }));
		expect(classes).toContain("justify-between");
		expect(classes).not.toMatch(/(^|\s)justify-start(\s|$)/);
	});
});
