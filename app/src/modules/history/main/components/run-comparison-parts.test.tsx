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
 * `DeltaCell` is where a null side of a `MetricDelta` becomes text (#2904):
 * either side the run did not record reads as unrecorded, never as a value and
 * never as a delta against a 0.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MetricDelta } from "@/lib/run-compare";
import { DeltaCell } from "./run-comparison-parts";

function metric(base: number | null, target: number | null): MetricDelta {
	const both = base !== null && target !== null;
	return {
		metric: "latency.p99",
		base,
		target,
		delta: both ? target - base : null,
		pctChange: both && base !== 0 ? ((target - base) / base) * 100 : null,
		direction: "lower-is-better",
	};
}

describe("DeltaCell", () => {
	it("reads an unrecorded target as not recorded, with no figure or change", () => {
		render(<DeltaCell metric={metric(40, null)} />);

		expect(screen.getByText("not recorded")).toBeInTheDocument();
		expect(screen.queryByText(/ms|%|baseline/)).not.toBeInTheDocument();
	});

	it("keeps a real target and says the baseline was not recorded", () => {
		render(<DeltaCell metric={metric(null, 40)} />);

		expect(screen.getByText("40ms")).toBeInTheDocument();
		expect(screen.getByText("baseline not recorded")).toBeInTheDocument();
		expect(screen.queryByText(/%/)).not.toBeInTheDocument();
	});

	it("draws the change when both sides were recorded", () => {
		render(<DeltaCell metric={metric(20, 40)} />);

		expect(screen.getByText("+100.0%")).toBeInTheDocument();
		expect(screen.queryByText(/not recorded/)).not.toBeInTheDocument();
	});
});
