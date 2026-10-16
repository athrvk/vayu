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
 * The card is the one place a run's errors are itemised, so the cases worth
 * pinning are the ones a hand-built copy got wrong: a run whose errors are all
 * HTTP statuses (no transport types) must still list them, a type key must read
 * as its label, and the row buttons must exist only when a caller asked.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ErrorSummary, type ErrorSummaryProps } from "./ErrorSummary";

const props = (over: Partial<ErrorSummaryProps> = {}): ErrorSummaryProps => ({
	errors: { total: 0, withDetails: 0, types: {} },
	errorRate: 0,
	httpErrors: 0,
	noResponse: 0,
	...over,
});

describe("ErrorSummary", () => {
	it("lists an HTTP-500-only run's status code under the non-zero total", () => {
		render(
			<ErrorSummary
				{...props({
					errors: { total: 15, withDetails: 0, types: {}, byStatusCode: { "500": 15 } },
					errorRate: 15,
					httpErrors: 15,
				})}
			/>
		);

		const card = screen.getByText("Error summary").closest<HTMLElement>(".enter-fade")!;
		expect(card.textContent).toContain("15 (15.00%)");
		expect(screen.getByText("By status code")).toBeTruthy();
		expect(within(card).getByText("HTTP 500").nextSibling?.textContent).toBe("15");
		expect(screen.queryByText("By error type")).toBeNull();
	});

	it("lists transport types by label, not by raw key", () => {
		render(
			<ErrorSummary
				{...props({
					errors: { total: 5, withDetails: 5, types: { ssl_error: 3, dns_failed: 2 } },
					noResponse: 5,
				})}
			/>
		);

		expect(screen.getByText("SSL error").nextSibling?.textContent).toBe("3");
		expect(screen.getByText("DNS failed").nextSibling?.textContent).toBe("2");
		expect(screen.queryByText("ssl_error")).toBeNull();
		expect(screen.queryByText("By status code")).toBeNull();
	});

	it("falls back to a sentence-cased label for a type it has no entry for", () => {
		render(
			<ErrorSummary
				{...props({ errors: { total: 1, withDetails: 1, types: { future_failure: 1 } } })}
			/>
		);
		expect(screen.getByText("Future failure")).toBeTruthy();
	});

	it("shows both groups for a mixed run, with the split beside the total", () => {
		render(
			<ErrorSummary
				{...props({
					errors: {
						total: 17,
						withDetails: 2,
						types: { timeout: 2 },
						byStatusCode: { "500": 15, "0": 2 },
					},
					errorRate: 17,
					httpErrors: 15,
					noResponse: 2,
				})}
			/>
		);

		expect(screen.getByText("HTTP errors").nextSibling?.textContent).toBe("15");
		expect(screen.getByText("No response").nextSibling?.textContent).toBe("2");
		expect(screen.getByText("By error type")).toBeTruthy();
		expect(screen.getByText("Timeout")).toBeTruthy();
		expect(screen.getByText("By status code")).toBeTruthy();
		expect(screen.getByText("HTTP 500")).toBeTruthy();
	});

	it("names status 0 as no response", () => {
		render(
			<ErrorSummary
				{...props({
					errors: { total: 2, withDetails: 2, types: {}, byStatusCode: { "0": 2 } },
				})}
			/>
		);
		expect(screen.getByText("No response (status 0)").nextSibling?.textContent).toBe("2");
		expect(screen.queryByText("HTTP 0")).toBeNull();
	});

	it("does not print a nonzero rate as 0.00%", () => {
		render(
			<ErrorSummary
				{...props({
					errors: { total: 1, withDetails: 1, types: {} },
					errorRate: 0.0001,
				})}
			/>
		);
		expect(screen.getByText(/^1 \(/).textContent).toBe("1 (<0.01%)");
	});

	it.each([
		["a run with no errors", props()],
		["a report with no errors block", props({ errors: undefined })],
	])("draws nothing for %s", (_name, p) => {
		const { container } = render(<ErrorSummary {...p} />);
		expect(container.textContent).toBe("");
	});

	describe("onSelectStatus", () => {
		const withStatuses = props({
			errors: {
				total: 17,
				withDetails: 0,
				types: { timeout: 2 },
				byStatusCode: { "500": 15, "0": 2 },
			},
		});

		it("makes each status row a button that reports its code", () => {
			const onSelectStatus = vi.fn();
			render(<ErrorSummary {...withStatuses} onSelectStatus={onSelectStatus} />);

			const buttons = screen.getAllByRole("button");
			expect(buttons).toHaveLength(2);

			fireEvent.click(screen.getByRole("button", { name: /HTTP 500/ }));
			expect(onSelectStatus).toHaveBeenLastCalledWith("500");

			fireEvent.click(screen.getByRole("button", { name: /No response \(status 0\)/ }));
			expect(onSelectStatus).toHaveBeenLastCalledWith("0");
		});

		it("leaves the type rows as plain text", () => {
			render(<ErrorSummary {...withStatuses} onSelectStatus={vi.fn()} />);
			expect(screen.queryByRole("button", { name: /Timeout/ })).toBeNull();
		});

		it("draws no buttons when the caller gave no handler", () => {
			render(<ErrorSummary {...withStatuses} />);
			expect(screen.queryAllByRole("button")).toHaveLength(0);
			expect(screen.getByText("HTTP 500")).toBeTruthy();
		});
	});
});
