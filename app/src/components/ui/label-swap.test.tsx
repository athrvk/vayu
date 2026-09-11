/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LabelSwap } from "./label-swap";

describe("LabelSwap", () => {
	it("renders the live label as visible text", () => {
		const { container } = render(<LabelSwap label="Send" states={["Send", "Sending"]} />);
		expect(container.querySelector(".enter-fade")).toHaveTextContent("Send");
	});

	it("hides every reserved state from assistive tech, not just the ones not shown", () => {
		// Both "Send" and "Sending" render as DOM nodes (one is the live label,
		// one is a width-reservation twin) - a screen reader must hear only one.
		const { container } = render(<LabelSwap label="Send" states={["Send", "Sending"]} />);
		const hidden = container.querySelectorAll('[aria-hidden="true"]');
		expect(hidden).toHaveLength(2);
		for (const node of hidden) {
			expect(node).toHaveClass("invisible");
		}
	});

	it("re-keys the live span when the label changes, so .enter-fade fires again", () => {
		const { container, rerender } = render(
			<LabelSwap label="Send" states={["Send", "Sending"]} />
		);
		const before = container.querySelector(".enter-fade");
		rerender(<LabelSwap label="Sending" states={["Send", "Sending"]} />);
		const after = container.querySelector(".enter-fade");
		expect(after).not.toBeNull();
		expect(after).not.toBe(before);
		expect(after).toHaveTextContent("Sending");
	});

	it("re-keys the live span on the way back too - a round trip fades both ways", () => {
		// A bare `key={label}` on the live span shares its value with whichever
		// reserve twin currently equals it (both would be `key="Send"` at rest).
		// React scopes a mapped array as its own keyspace, separate from a
		// sibling's, so this never actually collides - checked directly, no
		// duplicate-key warning either direction - but a single Send -> Sending
		// check alone would not have caught it if it had. A full round trip,
		// checked at every step, is the guard against a reconciler regression
		// here, not evidence a collision bug ever existed.
		const states = ["Send", "Sending"];
		const { container, rerender } = render(<LabelSwap label="Send" states={states} />);
		const seen = new Set<Element>();
		const steps = ["Sending", "Send", "Sending", "Send"];
		let previous = container.querySelector(".enter-fade");
		expect(previous).not.toBeNull();
		seen.add(previous!);
		for (const label of steps) {
			rerender(<LabelSwap label={label} states={states} />);
			const current = container.querySelector(".enter-fade");
			expect(current, `live span missing after switching to "${label}"`).not.toBeNull();
			expect(current, `label "${label}" reused a node from an earlier step`).not.toBe(
				previous
			);
			expect(
				seen.has(current!),
				`label "${label}" reused a node seen at an earlier step`
			).toBe(false);
			expect(current).toHaveTextContent(label);
			seen.add(current!);
			previous = current;
		}
	});

	it("never remounts a reserve twin, even when the live span's key matches its text", () => {
		// The other half of the same guarantee: if the key collision above were
		// resolved the wrong way, a reserve twin's own node could get stolen and
		// replaced instead of the live span's. The twins must stay exactly the
		// stable, `aria-hidden` nodes they started as, at every step.
		const states = ["Send", "Sending"];
		const { container, rerender } = render(<LabelSwap label="Send" states={states} />);
		const initialTwins = [...container.querySelectorAll('[aria-hidden="true"]')];
		expect(initialTwins).toHaveLength(2);
		for (const label of ["Sending", "Send", "Sending"]) {
			rerender(<LabelSwap label={label} states={states} />);
			const twins = [...container.querySelectorAll('[aria-hidden="true"]')];
			expect(twins, `wrong twin count after switching to "${label}"`).toHaveLength(2);
			// Element-wise `toBe` - `toEqual` on DOM nodes compares structurally
			// (and can pass even across different nodes), which would make this
			// assertion pass even after a twin got silently replaced.
			twins.forEach((twin, i) => {
				expect(twin, `twin ${i} was replaced after switching to "${label}"`).toBe(
					initialTwins[i]
				);
			});
		}
	});

	it("reserves height-zero twins so only the widest state sets the box width", () => {
		const { container } = render(<LabelSwap label="Send" states={["Send", "Sending"]} />);
		const reserved = container.querySelectorAll('[aria-hidden="true"]');
		for (const node of reserved) {
			expect(node).toHaveClass("h-0");
		}
	});
});
