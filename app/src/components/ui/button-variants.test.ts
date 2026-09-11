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

	// The baseline press-feedback shrink (index.css's `[data-slot="button"]:active`)
	// is 2% of the element's own box - fine on a compact, content-fit CTA, a
	// visible glitch on a full-width row (measured: a 1290px row shrinks 13px per
	// side). Mutation-checked: dropping `active:scale-100` from the
	// `compoundVariants` entry lets this fail while every other test stays green,
	// since jsdom never renders `:active` and so never visibly breaks.
	it("suppresses the baseline's active:scale press feedback", () => {
		const classes = cn(buttonVariants({ variant: "listRow" }));
		expect(classes).toContain("active:scale-100");
	});
});
