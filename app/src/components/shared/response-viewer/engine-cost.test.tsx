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
 * Vayu's own cost shows beside the response time, and only when the engine
 * reported one (issue #2132).
 *
 * A stream, an auth-failure reply and a row stored before the key existed carry
 * no figure, and an invented `0 ms in Vayu` would be a claim nothing measured.
 * So the absent case is asserted as hard as the present one, plus the values a
 * bad payload could carry (NaN, negative).
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResponseStatusBar } from "./ResponseStatusBar";
import { ENGINE_COST_TIP } from "./utils";

const bar = (engineMs?: number, time: number | null = 120) =>
	render(
		<ResponseStatusBar
			status={200}
			statusText="OK"
			time={time ?? undefined}
			size={11}
			engineMs={engineMs}
		/>
	);

describe("the status bar's Vayu figure", () => {
	it("is drawn beside the time with the scope sentence on hover", () => {
		bar(3.4);

		const figure = screen.getByText(/in Vayu/);
		expect(figure).toHaveTextContent("- 3 ms in Vayu");
		expect(figure).toHaveAttribute("title", ENGINE_COST_TIP);
		// Inside the time block, right after the time itself.
		expect(figure.previousElementSibling).toHaveTextContent("120 ms");
	});

	it("keeps two decimals under a millisecond", () => {
		bar(0.4);
		expect(screen.getByText(/in Vayu/)).toHaveTextContent("- 0.40 ms in Vayu");
	});

	it("shows a zero, which is a measurement", () => {
		bar(0);
		expect(screen.getByText(/in Vayu/)).toHaveTextContent("- 0.00 ms in Vayu");
	});

	it("is absent when the engine reported none", () => {
		bar(undefined);
		expect(screen.queryByText(/in Vayu/)).toBeNull();
		expect(screen.getByText("120 ms")).toBeInTheDocument();
	});

	it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("is absent for %s", (bad) => {
		bar(bad);
		expect(screen.queryByText(/in Vayu/)).toBeNull();
	});

	it("is absent when the bar has no time to put it beside", () => {
		bar(3.4, null);
		expect(screen.queryByText(/in Vayu/)).toBeNull();
	});

	it("paints no background, so it is not a Badge that owes a chip variant", () => {
		bar(3.4);
		expect(screen.getByText(/in Vayu/).className).not.toMatch(/\bbg-/);
	});
});

describe("the hover sentence", () => {
	it("states a scope, not a comparison or a bare 'the engine'", () => {
		expect(ENGINE_COST_TIP).toMatch(/^Time Vayu's engine /);
		expect(ENGINE_COST_TIP).toMatch(/\.$/);
		expect(ENGINE_COST_TIP).not.toMatch(/\u2014/);
		expect(ENGINE_COST_TIP).not.toMatch(/\d/);
	});

	// A first-use OAuth 2.0 token fetch is the identity provider's wait and the
	// engine leaves it out (#2185); the tip must not claim it as Vayu's.
	it("does not claim a token fetch as Vayu's cost", () => {
		expect(ENGINE_COST_TIP).not.toMatch(/token/i);
	});
});
