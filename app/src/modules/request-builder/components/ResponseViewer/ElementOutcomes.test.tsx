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
import { REQUIRED_MISS_HINT } from "@/components/shared";

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
			// Wraps in full (never `truncate`); the card's title repeats it.
			expect(screen.getByText("boom at the root")).toHaveClass("break-words");
			expect(screen.getByText("boom at the root")).not.toHaveClass("truncate");
			expect(container.querySelector('[title="boom at the root"]')).not.toBeNull();
		}
	);

	// A script whose only problem is a failed pm.test is `failed` with the
	// first failure as its message, and the row must say which test (issue
	// #2663); `error` stays for a script that threw.
	it("prints which assertion a failed script.post element broke", () => {
		const message = "2 tests failed - status is 201: expected 200 to equal 201";
		render(
			<ElementOutcomes
				outcomes={[row({ kind: "script.post", outcome: "failed", message })]}
			/>
		);
		expect(screen.getByText("script.post")).toBeTruthy();
		expect(screen.getByText("failed")).toBeTruthy();
		expect(screen.getByText(message)).toBeTruthy();
	});

	// A required extractor's miss failed the step, so it must not read as the
	// amber "missing" an optional miss is (issue #3051). Mutation check: drop
	// the `required` test in ElementOutcomes and the required row reads amber.
	it.each([
		{ required: true, word: "missing (required)", tint: "text-status-error-text" },
		{ required: undefined, word: "missing", tint: "text-status-warning-text" },
	] as const)("paints a miss with required $required as $word", ({ required, word, tint }) => {
		const { container } = render(
			<ElementOutcomes
				outcomes={[
					row({
						kind: "extract.json",
						name: "Session token",
						outcome: "missing",
						required,
						message: "no match for '$.token'",
					}),
				]}
			/>
		);
		const status = screen.getByText(word);
		expect(screen.getByText("Session token")).toHaveClass(tint);
		const card = container.querySelector("[title=\"no match for '$.token'\"]");
		expect(card?.className).toContain(required ? "bg-status-error/10" : "bg-status-warning/10");
		if (required) {
			expect(status).toHaveClass(tint);
			expect(status).toHaveAttribute("title", REQUIRED_MISS_HINT);
		} else {
			expect(status).toHaveClass("text-muted-foreground");
			expect(status).not.toHaveAttribute("title");
		}
	});

	// Two assertions of one kind were told apart only by a message the row cut
	// short (issue #3051): the name and the origin are what distinguish them.
	it("tells two outcomes of one kind apart by their names and origins", () => {
		render(
			<ElementOutcomes
				outcomes={[
					row({
						id: "a",
						kind: "extract.json",
						name: "Session token",
						outcome: "missing",
						origin: { kind: "collection", id: "col_1", name: "Billing" },
					}),
					row({
						id: "b",
						kind: "extract.json",
						name: "Order id",
						outcome: "ok",
						origin: { kind: "request", id: "req_1", name: "Log in" },
					}),
				]}
			/>
		);
		expect(screen.getByText("Session token")).toBeTruthy();
		expect(screen.getByText("Order id")).toBeTruthy();
		expect(screen.getAllByText("extract.json")).toHaveLength(2);
		expect(screen.getByText('from "Billing"')).toBeTruthy();
		// A request's own element names no origin.
		expect(screen.queryByText(/Log in/)).toBeNull();
	});

	it("prints the kind alone for an outcome with no name", () => {
		const { container } = render(
			<ElementOutcomes outcomes={[row({ kind: "extract.json", outcome: "ok" })]} />
		);
		expect(screen.getAllByText("extract.json")).toHaveLength(1);
		expect(container.textContent).toBe("Elementsextract.jsonok");
	});

	it("prints a long miss message in full, wrapping rather than cutting it", () => {
		const message =
			"no match for '$.data.items[0].attributes.session.token.value.that.keeps.going'";
		render(
			<ElementOutcomes
				outcomes={[row({ kind: "extract.json", outcome: "missing", message })]}
			/>
		);
		const text = screen.getByText(message);
		expect(text).toHaveClass("break-words");
		expect(text).not.toHaveClass("truncate");
	});
});
