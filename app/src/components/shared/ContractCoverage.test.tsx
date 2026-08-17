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
 * The coverage block exists so a reader can see what a run did *not* touch, so
 * the ways it could mislead are the cases worth pinning: showing anything at all
 * for a run that was never measured against a contract, burying the operation
 * nobody called below the ones that passed, or reading as though its numbers
 * came from the same sampled store the latency figures do.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ContractCoverage } from "./ContractCoverage";
import type { RunCoverage } from "@/types/domain";

afterEach(cleanup);

const coverage = (over: Partial<RunCoverage> = {}): RunCoverage => ({
	operationsTotal: 2,
	operationsCovered: 1,
	declaredResponsesTotal: 3,
	declaredResponsesHit: 1,
	declaredResponseCoveragePct: 33.3,
	undeclaredStatusesSeen: 0,
	operations: [
		{
			operationId: "deletePet",
			method: "DELETE",
			path: "/pets/{petId}",
			sent: 0,
			statusesSeen: [],
			declaredHit: [],
			declaredMissed: ["204"],
			undeclaredSeen: [],
		},
		{
			operationId: "listPets",
			method: "GET",
			path: "/pets",
			sent: 4,
			statusesSeen: [200],
			declaredHit: ["200"],
			declaredMissed: ["404"],
			undeclaredSeen: [],
		},
	],
	...over,
});

describe("ContractCoverage", () => {
	it("renders nothing for a run that was not measured against a contract", () => {
		// Absent and empty both mean "not measured". Neither may render a block
		// that reads as a contract this run covered none of.
		const { container } = render(<ContractCoverage coverage={undefined} />);
		expect(container).toBeEmptyDOMElement();

		cleanup();
		const empty = render(<ContractCoverage coverage={coverage({ operations: [] })} />);
		expect(empty.container).toBeEmptyDOMElement();
	});

	it("leads with the rollup a reader opens the block for", () => {
		render(<ContractCoverage coverage={coverage()} />);
		expect(screen.getByText("1 / 2 operations")).toBeTruthy();
		expect(screen.getByText(/1 of 3 declared responses seen \(33\.3%\)/)).toBeTruthy();
	});

	it("keeps the engine's uncovered-first order rather than re-sorting", () => {
		// Re-sorting here would be a second opinion about which operations are
		// the finding, and the two could disagree.
		render(<ContractCoverage coverage={coverage()} />);
		const rows = screen.getAllByRole("listitem");
		expect(rows[0].textContent).toContain("/pets/{petId}");
		expect(rows[0].textContent).toContain("never called");
		expect(rows[1].textContent).toContain("/pets");
	});

	it("names the declared responses a covered operation never produced", () => {
		render(<ContractCoverage coverage={coverage()} />);
		// The operation was called and answered 200; its declared 404 never came
		// back, which is the half of coverage a green run still hides.
		expect(screen.getByText(/404 not seen/)).toBeTruthy();
	});

	it("says the numbers are exact, because it sits among sampled ones", () => {
		render(<ContractCoverage coverage={coverage()} />);
		expect(screen.getByText(/Counted on every send, not from the stored sample/)).toBeTruthy();
	});

	it("reports undeclared statuses and off-contract requests as findings", () => {
		render(
			<ContractCoverage
				coverage={coverage({
					undeclaredStatusesSeen: 2,
					undeclaredOperationRequests: 5,
				})}
			/>
		);
		expect(screen.getByText(/2 undeclared statuses observed/)).toBeTruthy();
		expect(
			screen.getByText(/5 requests went to operations this document does not declare/)
		).toBeTruthy();
	});

	it("says whose contract it is when the binding came from a parent collection", () => {
		// A tag sub-collection of an imported spec is measured against the whole
		// document, so most of it is honestly uncovered - without this line the
		// same numbers read as a catastrophe (issue #716).
		render(<ContractCoverage coverage={coverage()} inheritedBinding />);
		expect(screen.getByText(/contract is bound on a parent collection/)).toBeTruthy();
	});

	it("stays silent about the binding when the collection that ran carries it", () => {
		// Absent is the engine's spelling of "nothing to disclose", and a line
		// about parent collections on a whole-collection run would be noise.
		render(<ContractCoverage coverage={coverage()} />);
		expect(screen.queryByText(/parent collection/)).toBeNull();
	});

	it("reads as complete only when nothing is uncovered and nothing undeclared", () => {
		render(
			<ContractCoverage
				coverage={coverage({
					operationsCovered: 2,
					operations: [coverage().operations[1]],
				})}
			/>
		);
		expect(screen.getByText("2 / 2 operations").className).toContain("status-success");
	});
});
