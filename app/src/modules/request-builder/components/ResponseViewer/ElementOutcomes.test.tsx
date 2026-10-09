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
 * list used to drop.
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
		expect(screen.getByText(/250 ms/)).toBeTruthy();
	});

	it("prints a zero wait, the silenced timer", () => {
		render(<ElementOutcomes outcomes={[row({ waitedMs: 0 })]} />);
		expect(screen.getByText(/0 ms/)).toBeTruthy();
	});

	it("prints a passing transaction's name inline", () => {
		render(
			<ElementOutcomes
				outcomes={[row({ kind: "control.transaction", message: "checkout", waitedMs: 80 })]}
			/>
		);
		expect(screen.getByText("checkout")).toBeTruthy();
		expect(screen.getByText(/80 ms/)).toBeTruthy();
	});

	it("prints neither for a row that carries neither", () => {
		const { container } = render(
			<ElementOutcomes outcomes={[row({ kind: "extract.json" })]} />
		);
		expect(container.textContent).not.toMatch(/ms/);
		expect(container.textContent).toBe("Elementsextract.jsonok");
	});

	it("keeps a failure's message on hover rather than inline", () => {
		const { container } = render(
			<ElementOutcomes
				outcomes={[
					row({ kind: "assert.status", outcome: "failed", message: "expected 200" }),
				]}
			/>
		);
		expect(screen.queryByText("expected 200")).toBeNull();
		expect(container.querySelector('[title="expected 200"]')).not.toBeNull();
	});
});
