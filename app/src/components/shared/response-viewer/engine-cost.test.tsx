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
import { ENGINE_COST_TIP, SCRIPT_TIME_TIP } from "./utils";

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
		expect(figure).toHaveTextContent("- 3.4 ms in Vayu");
		expect(figure).toHaveAttribute("title", ENGINE_COST_TIP);
		// Inside the time block, right after the time itself.
		expect(figure.previousElementSibling).toHaveTextContent("120 ms");
	});

	it("keeps its decimals below 10 ms, as the load surfaces do", () => {
		bar(0.4);
		expect(screen.getByText(/in Vayu/)).toHaveTextContent("- 0.4 ms in Vayu");
	});

	it("shows a zero, which is a measurement", () => {
		bar(0);
		expect(screen.getByText(/in Vayu/)).toHaveTextContent("- 0 ms in Vayu");
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

const scriptsBar = (scriptMs?: number, wireMs?: number, time: number | null = 4000) =>
	render(
		<ResponseStatusBar
			status={200}
			statusText="OK"
			time={time ?? undefined}
			size={11}
			scriptMs={scriptMs}
			wireMs={wireMs}
		/>
	);

// Scripts are not in `time`, so the bar draws them only when they outweigh the
// wire: the case where the send felt slow because of the user's code (#3676).
describe("the status bar's scripts figure", () => {
	it("is drawn beside the time, with its hover, when scripts exceed the wire", () => {
		scriptsBar(3070, 120);

		const figure = screen.getByText(/in scripts/);
		expect(figure).toHaveTextContent("- 3.07 s in scripts");
		expect(figure).toHaveAttribute("title", SCRIPT_TIME_TIP);
		expect(figure.previousElementSibling).toHaveTextContent("4.00 s");
	});

	it("sits after the Vayu figure when both show", () => {
		render(
			<ResponseStatusBar
				status={200}
				time={4000}
				engineMs={3.4}
				scriptMs={3070}
				wireMs={120}
			/>
		);

		expect(screen.getByText(/in Vayu/).nextElementSibling).toBe(screen.getByText(/in scripts/));
	});

	it("is absent when scripts equal the wire", () => {
		scriptsBar(120, 120);
		expect(screen.queryByText(/in scripts/)).toBeNull();
	});

	it("is absent when scripts are below the wire", () => {
		scriptsBar(40, 120);
		expect(screen.queryByText(/in scripts/)).toBeNull();
	});

	it("is absent when no scripts figure was reported", () => {
		scriptsBar(undefined, 120);
		expect(screen.queryByText(/in scripts/)).toBeNull();
	});

	it("is absent when there is no wire figure to compare against", () => {
		scriptsBar(3070, undefined);
		expect(screen.queryByText(/in scripts/)).toBeNull();
	});

	it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("is absent for scriptMs %s", (bad) => {
		scriptsBar(bad, 120);
		expect(screen.queryByText(/in scripts/)).toBeNull();
	});

	it.each([Number.NaN, -1])("is absent for wireMs %s", (bad) => {
		scriptsBar(3070, bad);
		expect(screen.queryByText(/in scripts/)).toBeNull();
	});

	it("is absent when the bar has no time to put it beside", () => {
		scriptsBar(3070, 120, null);
		expect(screen.queryByText(/in scripts/)).toBeNull();
	});

	it("paints no background, so it is not a Badge that owes a chip variant", () => {
		scriptsBar(3070, 120);
		expect(screen.getByText(/in scripts/).className).not.toMatch(/\bbg-/);
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

	// Both tips draw the same boundary: scripts are counted in one and left out
	// of the other, and neither claims the other's figure.
	it("keeps the scripts tip a statement of scope that agrees with the Vayu tip", () => {
		expect(SCRIPT_TIME_TIP).toMatch(/^Time your /);
		expect(SCRIPT_TIME_TIP).toMatch(/\.$/);
		expect(SCRIPT_TIME_TIP).not.toMatch(/\u2014/);
		expect(SCRIPT_TIME_TIP).not.toMatch(/\d/);
		expect(ENGINE_COST_TIP).toMatch(/leaves out .*your scripts/);
		expect(SCRIPT_TIME_TIP).toMatch(/apart from .*Vayu's own time/);
	});
});
