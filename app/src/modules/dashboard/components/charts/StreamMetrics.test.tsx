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
 * The stream card (issue #576).
 *
 * The load-bearing case is the first one: the section is absent for every run
 * that did not stream, and rendering zeros there would tell a user their
 * ordinary load test measured an event rate and found none.
 */

import { describe, it, expect } from "vitest";
import { render as rtlRender, screen, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui";
import type { RunReport } from "@/types";
import { StreamMetrics } from "./StreamMetrics";

// The card carries an InfoChip, which is a Radix tooltip and needs its
// provider - the dashboard supplies one at the shell.
const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

function report(stream?: RunReport["stream"]): RunReport {
	return { stream } as unknown as RunReport;
}

const events = { min: 1, max: 60, p50: 40, p90: 55, p95: 58, p99: 60, count: 3 };

describe("StreamMetrics", () => {
	it("renders nothing for a run that did not stream", () => {
		const { container } = render(<StreamMetrics report={report(undefined)} />);
		expect(container).toBeEmptyDOMElement();
		cleanup();

		// And nothing at all for a report the dashboard has not loaded yet.
		const empty = render(<StreamMetrics report={null} />);
		expect(empty.container).toBeEmptyDOMElement();
	});

	it("shows the rate, the totals and the per-stream distribution", () => {
		render(
			<StreamMetrics
				report={report({
					completions: 3,
					totalEvents: 120,
					capped: 1,
					eventsPerSecond: 12.5,
					events,
				})}
			/>
		);
		expect(screen.getByText("12.5")).toBeInTheDocument();
		expect(screen.getByText("120")).toBeInTheDocument();
		expect(screen.getByText("events/sec")).toBeInTheDocument();
		// The per-stream p50, which is the number that separates "one long
		// stream" from "many short ones" at the same rate.
		expect(screen.getByText("40")).toBeInTheDocument();
	});

	it("warns when every stream was ended by a cap", () => {
		// The honest reading of a run whose totals are its own bounds: without
		// this the event count looks like a property of the target.
		render(
			<StreamMetrics
				report={report({
					completions: 4,
					totalEvents: 40,
					capped: 4,
					eventsPerSecond: 4,
					events,
				})}
			/>
		);
		expect(screen.getByText(/measure the caps, not the target/i)).toBeInTheDocument();
	});

	it("says so plainly when the server closed every stream", () => {
		render(
			<StreamMetrics
				report={report({
					completions: 4,
					totalEvents: 40,
					capped: 0,
					eventsPerSecond: 4,
					events,
				})}
			/>
		);
		expect(screen.getByText(/closed by the server - no cap was reached/i)).toBeInTheDocument();
		expect(screen.queryByText(/measure the caps/i)).not.toBeInTheDocument();
	});

	it("counts a mixed run without claiming either extreme", () => {
		render(
			<StreamMetrics
				report={report({
					completions: 10,
					totalEvents: 100,
					capped: 3,
					eventsPerSecond: 10,
					events,
				})}
			/>
		);
		expect(screen.getByText(/3 of 10 streams were ended by a cap/i)).toBeInTheDocument();
	});
});
