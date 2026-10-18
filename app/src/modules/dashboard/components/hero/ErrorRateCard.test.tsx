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
 * The Error rate card shows the engine's one error definition (issue #2124):
 * a response outside 2xx/3xx, or no response. The card does not recount - the
 * percentage and the HTTP errors / No response split arrive as props - but the
 * bar and its legend bucket the status map, and that is where a 3xx used to be
 * drawn as an error.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { ErrorRateCard } from "./ErrorRateCard";

type CardProps = React.ComponentProps<typeof ErrorRateCard>;

function renderCard(props: CardProps) {
	const { container } = render(
		<TooltipProvider>
			<ErrorRateCard {...props} />
		</TooltipProvider>
	);
	const bar = container.querySelector<HTMLElement>(".h-2")!;
	const segments = Array.from(bar.children) as HTMLElement[];
	const widths = segments.map((c) => parseFloat(c.style.width));
	return { container, widths, segments };
}

/** The bar's four segments in order: 2xx/3xx, 4xx, 5xx, no response. */
const [OK, S4, S5, NONE] = [0, 1, 2, 3];

describe("ErrorRateCard", () => {
	it("shows HTTP errors as a red rate with a filled bar, while the run is live", () => {
		const { container, widths } = renderCard({
			totalRequests: 100,
			failedRequests: 15,
			httpErrors: 15,
			noResponse: 0,
			statusCodes: { "200": 85, "500": 15 },
		});

		const value = screen.getByText("15.0");
		expect(value.getAttribute("style")).toContain("destructive-text");
		expect(widths[OK]).toBeCloseTo(85);
		expect(widths[S5]).toBeCloseTo(15);
		expect(widths[S4]).toBe(0);
		expect(widths[NONE]).toBe(0);
		expect(container.textContent).toContain("15 / 100");
	});

	it("labels the breakdown HTTP errors and No response", () => {
		renderCard({
			totalRequests: 100,
			failedRequests: 12,
			httpErrors: 10,
			noResponse: 2,
			statusCodes: { "200": 88, "429": 4, "503": 6, "0": 2 },
		});

		expect(screen.getByText("HTTP errors 10")).toBeTruthy();
		expect(screen.getByText(/^No response 2/)).toBeTruthy();
		expect(screen.getByText(/^4xx 4/)).toBeTruthy();
		expect(screen.getByText(/^5xx 6/)).toBeTruthy();
	});

	it("counts a 3xx with the success bucket, not as an error", () => {
		const { widths } = renderCard({
			totalRequests: 100,
			failedRequests: 0,
			httpErrors: 0,
			noResponse: 0,
			statusCodes: { "200": 70, "301": 20, "304": 10 },
		});

		expect(screen.getByText("0.0").getAttribute("style")).toContain("success-text");
		expect(screen.getByText(/^2xx\/3xx 100/)).toBeTruthy();
		expect(widths[OK]).toBeCloseTo(100);
		expect(widths[NONE]).toBe(0);
		expect(widths[S4]).toBe(0);
		expect(widths[S5]).toBe(0);
	});

	it("shows a run with no responses as No response, with zero HTTP errors", () => {
		const { widths } = renderCard({
			totalRequests: 50,
			failedRequests: 50,
			httpErrors: 0,
			noResponse: 50,
			statusCodes: { "0": 50 },
		});

		expect(screen.getByText("100.0")).toBeTruthy();
		expect(screen.getByText("HTTP errors 0")).toBeTruthy();
		expect(screen.getByText(/^No response 50/)).toBeTruthy();
		expect(widths[NONE]).toBeCloseTo(100);
		expect(widths[OK]).toBe(0);
	});

	it("never prints 0.0 in red: a rate under 0.1% takes a second decimal", () => {
		renderCard({
			totalRequests: 70_000,
			failedRequests: 10,
			httpErrors: 10,
			noResponse: 0,
			statusCodes: { "200": 69_990, "500": 10 },
		});

		expect(screen.queryByText("0.0")).toBeNull();
		const value = screen.getByText("0.01");
		expect(value.getAttribute("style")).toContain("destructive-text");
	});

	it("reads <0.01 in red for a rate that rounds to nothing at two decimals", () => {
		renderCard({
			totalRequests: 1_000_000,
			failedRequests: 1,
			httpErrors: 1,
			noResponse: 0,
			statusCodes: { "200": 999_999, "500": 1 },
		});

		expect(screen.getByText("<0.01").getAttribute("style")).toContain("destructive-text");
	});

	it("draws a zero rate in success, so colour and digits agree at both ends", () => {
		renderCard({
			totalRequests: 70_000,
			failedRequests: 0,
			httpErrors: 0,
			noResponse: 0,
			statusCodes: { "200": 70_000 },
		});

		expect(screen.getByText("0.0").getAttribute("style")).toContain("success-text");
	});

	it("keeps an empty bar and a zero rate before the first response", () => {
		const { widths } = renderCard({
			totalRequests: 0,
			failedRequests: 0,
			httpErrors: 0,
			noResponse: 0,
			statusCodes: {},
		});

		expect(screen.getByText("0.0")).toBeTruthy();
		expect(widths).toEqual([0, 0, 0, 0]);
	});

	it("draws a 1xx and a code of 600 or more with 5xx, as the engine tallies them", () => {
		// `httpStatusClass` groups 1xx with redirect and 600+ with no-response, but
		// the engine counts both as HTTP errors, so the bar must not drop them
		// into a quieter bucket than the rate above it.
		const { widths } = renderCard({
			totalRequests: 100,
			failedRequests: 10,
			httpErrors: 10,
			noResponse: 0,
			statusCodes: { "200": 90, "101": 4, "600": 6 },
		});

		expect(widths[S5]).toBeCloseTo(10);
		expect(widths[OK]).toBeCloseTo(90);
		expect(widths[S4]).toBe(0);
		expect(widths[NONE]).toBe(0);
	});

	it("paints the four segments and their swatches from the status tokens", () => {
		const { container, segments } = renderCard({
			totalRequests: 4,
			failedRequests: 3,
			httpErrors: 2,
			noResponse: 1,
			statusCodes: { "200": 1, "404": 1, "503": 1, "0": 1 },
		});

		expect(segments.map((c) => c.className)).toEqual([
			expect.stringContaining("bg-status-success-fill"),
			expect.stringContaining("bg-status-warning-fill"),
			expect.stringContaining("bg-status-error-fill"),
			expect.stringContaining("bg-status-no-response-fill"),
		]);

		const swatches = Array.from(
			container.querySelectorAll<HTMLElement>("span.inline-block")
		).map((c) => c.style.background);
		expect(swatches).toEqual([
			"hsl(var(--status-success))",
			"hsl(var(--status-warning))",
			"hsl(var(--status-error))",
			"hsl(var(--status-no-response))",
		]);
	});
});
