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
import { TransactionsSummary } from "./TransactionsSummary";
import type { RunTransactionSummary } from "@/types/domain";

describe("TransactionsSummary", () => {
	it("renders nothing when the run closed no transaction", () => {
		// Absent - a collection with no control.transaction element, or a
		// report from an engine that predates #1515 - has to read as no
		// card, not an empty one.
		const { container } = render(<TransactionsSummary transactions={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing for an empty array", () => {
		const { container } = render(<TransactionsSummary transactions={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows a transaction's name, count and percentiles", () => {
		const transactions: RunTransactionSummary[] = [
			{
				name: "checkout",
				count: 480,
				errors: 0,
				latency: { min: 8.1, p50: 14.2, p90: 22.0, p95: 26.5, p99: 33.0, max: 55.4 },
			},
		];
		render(<TransactionsSummary transactions={transactions} />);
		expect(screen.getByText("checkout")).toBeInTheDocument();
		expect(screen.getByText("(480 runs)")).toBeInTheDocument();
		expect(screen.getByText("p50 14.2ms / p95 26.5ms / max 55.4ms")).toBeInTheDocument();
	});

	it("names the error count when a transaction failed at least once", () => {
		const transactions: RunTransactionSummary[] = [
			{
				name: "checkout",
				count: 10,
				errors: 2,
				latency: { min: 1, p50: 1, p90: 1, p95: 1, p99: 1, max: 1 },
			},
		];
		render(<TransactionsSummary transactions={transactions} />);
		expect(screen.getByText("(10 runs, 2 errors)")).toBeInTheDocument();
	});

	it("renders one row per declared name", () => {
		const transactions: RunTransactionSummary[] = [
			{
				name: "checkout",
				count: 1,
				errors: 0,
				latency: { min: 1, p50: 1, p90: 1, p95: 1, p99: 1, max: 1 },
			},
			{
				name: "login",
				count: 1,
				errors: 0,
				latency: { min: 1, p50: 1, p90: 1, p95: 1, p99: 1, max: 1 },
			},
		];
		render(<TransactionsSummary transactions={transactions} />);
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
	});

	it("titles the card 'Transactions'", () => {
		const transactions: RunTransactionSummary[] = [
			{
				name: "checkout",
				count: 1,
				errors: 0,
				latency: { min: 1, p50: 1, p90: 1, p95: 1, p99: 1, max: 1 },
			},
		];
		render(<TransactionsSummary transactions={transactions} />);
		expect(screen.getByText("Transactions")).toBeInTheDocument();
	});
});
