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
	const widths = Array.from(bar.children).map((c) => parseFloat((c as HTMLElement).style.width));
	return { container, widths };
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
});
