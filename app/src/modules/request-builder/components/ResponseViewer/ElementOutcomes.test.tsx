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
 * What a row says beyond its kind and outcome (issue #1941): a timer's wait
 * and a passing transaction's name, both of which the engine reports and the
 * list used to drop; and, since #2522, the message of a row that did not pass.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ElementOutcomes from "./ElementOutcomes";
import type { ElementOutcome } from "@/types";

afterEach(cleanup);

function row(over: Partial<ElementOutcome>): ElementOutcome {
	return { id: "e1", kind: "timer.think", outcome: "ok", ...over };
}

describe("ElementOutcomes", () => {
	it("prints a timer's wait", () => {
		render(<ElementOutcomes outcomes={[row({ waitedMs: 250 })]} />);
		expect(screen.getByText("· 250ms")).toBeTruthy();
	});

	it("prints a zero wait, the silenced timer", () => {
		render(<ElementOutcomes outcomes={[row({ waitedMs: 0 })]} />);
		expect(screen.getByText("· 0ms")).toBeTruthy();
	});

	// The shared latency rule: sub-millisecond keeps its decimals and a wait of
	// a second or more reads in seconds, so no surface prints "1500 ms".
	it.each([
		[0.4, "· 0.4ms"],
		[1500, "· 1.50s"],
	])("formats a %s ms wait through formatLatency", (waitedMs, text) => {
		render(<ElementOutcomes outcomes={[row({ waitedMs })]} />);
		expect(screen.getByText(text)).toBeTruthy();
	});

	it("prints a passing transaction's name inline", () => {
		render(
			<ElementOutcomes
				outcomes={[row({ kind: "control.transaction", message: "checkout", waitedMs: 80 })]}
			/>
		);
		expect(screen.getByText("checkout")).toBeTruthy();
		expect(screen.getByText("· 80ms")).toBeTruthy();
	});

	it("prints neither for a row that carries neither", () => {
		const { container } = render(
			<ElementOutcomes outcomes={[row({ kind: "extract.json" })]} />
		);
		expect(container.textContent).not.toMatch(/ms/);
		expect(container.textContent).toBe("Elementsextract.jsonok");
	});

	it.each(["failed", "error", "missing"] as const)(
		"prints a %s element's message inline, not only on hover",
		(outcome) => {
			// An errored element used to be a bare chip with its one explanation in
			// a tooltip (issue #2522): the reason is the row's point.
			const { container } = render(
				<ElementOutcomes
					outcomes={[row({ kind: "script.pre", outcome, message: "boom at the root" })]}
				/>
			);
			expect(screen.getByText("boom at the root")).toBeTruthy();
			// Truncated on the row, so the whole text stays one hover away.
			expect(screen.getByText("boom at the root")).toHaveClass("truncate");
			expect(container.querySelector('[title="boom at the root"]')).not.toBeNull();
		}
	);
});
