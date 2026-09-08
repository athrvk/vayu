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
import { render, screen } from "@testing-library/react";
import { CustomMetricsSummary } from "./CustomMetricsSummary";
import type { RunReport } from "@/types/domain";

type CustomMetrics = NonNullable<RunReport["customMetrics"]>;

describe("CustomMetricsSummary", () => {
	it("renders nothing when the run recorded no custom metrics", () => {
		// Absent - a pre-#1500 report, or a run that never called pm.metrics -
		// has to read as no card, not an empty one.
		const { container } = render(<CustomMetricsSummary customMetrics={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing for an empty object", () => {
		const { container } = render(<CustomMetricsSummary customMetrics={{}} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows a trend's percentiles and sample count", () => {
		const metrics: CustomMetrics = {
			ttfb2: { type: "trend", count: 42, p50: 10, p95: 40, p99: 47.5, max: 50 },
		};
		render(<CustomMetricsSummary customMetrics={metrics} />);
		expect(screen.getByText("ttfb2")).toBeInTheDocument();
		expect(screen.getByText("(42 samples)")).toBeInTheDocument();
		expect(screen.getByText("p50 10 / p95 40 / p99 47.50")).toBeInTheDocument();
	});

	it("shows a counter's running total and recorded count", () => {
		const metrics: CustomMetrics = {
			bytesOut: { type: "counter", count: 4, value: 4096 },
		};
		render(<CustomMetricsSummary customMetrics={metrics} />);
		expect(screen.getByText("bytesOut")).toBeInTheDocument();
		expect(screen.getByText("(4 recorded)")).toBeInTheDocument();
		expect(screen.getByText("4096")).toBeInTheDocument();
	});

	it("shows a rate as a percentage", () => {
		const metrics: CustomMetrics = {
			cacheHit: { type: "rate", count: 10, value: 30 },
		};
		render(<CustomMetricsSummary customMetrics={metrics} />);
		expect(screen.getByText("cacheHit")).toBeInTheDocument();
		expect(screen.getByText("(10 recorded)")).toBeInTheDocument();
		expect(screen.getByText("30%")).toBeInTheDocument();
	});

	it("renders one row per metric, sorted by name", () => {
		const metrics: CustomMetrics = {
			zLast: { type: "counter", count: 1, value: 1 },
			aFirst: { type: "rate", count: 1, value: 50 },
		};
		render(<CustomMetricsSummary customMetrics={metrics} />);
		const items = screen.getAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("aFirst");
		expect(items[1]).toHaveTextContent("zLast");
	});

	it("titles the card 'Custom metrics'", () => {
		render(
			<CustomMetricsSummary
				customMetrics={{ ttfb2: { type: "trend", count: 1, p50: 1, p95: 1, p99: 1 } }}
			/>
		);
		expect(screen.getByText("Custom metrics")).toBeInTheDocument();
	});
});
