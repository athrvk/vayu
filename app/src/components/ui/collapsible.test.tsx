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
 * The height animation is a class list, and a source scan cannot prove the
 * caller's own classes survive it - `cn()` is tailwind-merge, so a default that
 * collided with a caller's spacing would silently drop one of the two. Render
 * it and read `className`. Only the open state is testable here: a closed
 * `CollapsibleContent` is `hidden`, and jsdom has no layout or animations, so
 * the closing keyframe itself is out of reach of any test in this suite.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";

/**
 * Found by `data-testid`, not by `data-slot`: the slot attribute is part of
 * what this file guards, so keying the lookup on it would let a revert fail
 * at the query rather than at the class assertion it is actually about.
 */
function classesOf(container: HTMLElement): string {
	const content = container.querySelector('[data-testid="content"]');
	expect(content, "no collapsible content rendered").not.toBeNull();
	return (content as HTMLElement).className;
}

describe("CollapsibleContent", () => {
	it("carries the height animation and its clipping in both directions", () => {
		const { container } = render(
			<Collapsible open>
				<CollapsibleTrigger>Advanced</CollapsibleTrigger>
				<CollapsibleContent data-testid="content">body</CollapsibleContent>
			</Collapsible>
		);
		const classes = classesOf(container);

		expect(classes).toContain("data-[state=open]:animate-collapsible-down");
		expect(classes).toContain("data-[state=closed]:animate-collapsible-up");

		// Without it the box grows to full height on frame one and the keyframes
		// have nothing to reveal.
		expect(classes).toContain("overflow-hidden");

		// And not `.panel-clip` beside it: the controls inside a disclosure also
		// render outside one, so tucking their rings inward here would give one
		// control two looks. Clearance belongs to the consumer that needs it -
		// the rule `key-value-parity.test.tsx` guards for the checkbox.
		expect(classes).not.toContain("panel-clip");
	});

	it("runs the vocabulary's curve pair rather than tw-animate-css's ease-out", () => {
		const { container } = render(
			<Collapsible open>
				<CollapsibleContent data-testid="content">body</CollapsibleContent>
			</Collapsible>
		);
		const classes = classesOf(container);

		expect(classes).toContain("[--tw-ease:var(--ease-enter)]");
		expect(classes).toContain("data-[state=closed]:[--tw-ease:var(--ease-exit)]");
	});

	it("keeps a caller's own classes", () => {
		const { container } = render(
			<Collapsible open>
				<CollapsibleContent data-testid="content" className="mt-2 space-y-1">
					body
				</CollapsibleContent>
			</Collapsible>
		);
		const classes = classesOf(container);

		expect(classes).toContain("mt-2");
		expect(classes).toContain("space-y-1");
		expect(classes).toContain("data-[state=open]:animate-collapsible-down");
	});
});
