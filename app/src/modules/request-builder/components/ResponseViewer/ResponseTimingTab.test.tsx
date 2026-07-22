/**
 * Tests for ResponseTimingTab - the per-request timing breakdown.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ResponseTimingTab from "./ResponseTimingTab";
import type { ResponseTiming } from "../../types";

const sample: ResponseTiming = {
	total: 1011,
	wire: 1008,
	queueWait: 0.2,
	dns: 64,
	connect: 214,
	tls: 517,
	firstByte: 213,
	download: 0,
};

describe("ResponseTimingTab", () => {
	it("renders all five phases with their millisecond values", () => {
		render(<ResponseTimingTab timing={sample} />);
		for (const label of ["DNS", "Connect", "TLS", "TTFB", "Download"]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
		// Phase values (>=100 render with no decimals).
		expect(screen.getByText("64.0")).toBeInTheDocument(); // dns (10..100 → 1 dp)
		expect(screen.getByText("214")).toBeInTheDocument(); // connect
		expect(screen.getByText("517")).toBeInTheDocument(); // tls
	});

	it("computes each phase as a percentage of the summed network phases", () => {
		render(<ResponseTimingTab timing={sample} />);
		// phaseSum = 64+214+517+213+0 = 1008. TLS = 517/1008 ≈ 51%.
		expect(screen.getByText("51%")).toBeInTheDocument();
		// Download = 0 → 0%.
		expect(screen.getByText("0%")).toBeInTheDocument();
	});

	it("shows Wire, Queue and Total in the summary", () => {
		render(<ResponseTimingTab timing={sample} />);
		expect(screen.getByText("Wire")).toBeInTheDocument();
		expect(screen.getByText("Queue")).toBeInTheDocument();
		expect(screen.getByText("Total")).toBeInTheDocument();
		expect(screen.getByText("1008")).toBeInTheDocument(); // wire
		expect(screen.getByText("1011")).toBeInTheDocument(); // total
		expect(screen.getByText("0.20")).toBeInTheDocument(); // queueWait (<10 → 2 dp)
	});

	it("omits Wire and Queue when those fields are absent (restored responses)", () => {
		const minimal: ResponseTiming = {
			total: 42,
			dns: 5,
			connect: 10,
			tls: 20,
			firstByte: 7,
			download: 0,
		};
		render(<ResponseTimingTab timing={minimal} />);
		expect(screen.queryByText("Wire")).not.toBeInTheDocument();
		expect(screen.queryByText("Queue")).not.toBeInTheDocument();
		expect(screen.getByText("Total")).toBeInTheDocument();
	});

	it("handles all-zero phases without dividing by zero", () => {
		const zero: ResponseTiming = {
			total: 0,
			wire: 0,
			queueWait: 0,
			dns: 0,
			connect: 0,
			tls: 0,
			firstByte: 0,
			download: 0,
		};
		render(<ResponseTimingTab timing={zero} />);
		// Every phase share is 0% - at least the five legend rows render it.
		expect(screen.getAllByText("0%").length).toBeGreaterThanOrEqual(5);
	});
});
