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
 * Issue #731: a collection run stores each step's exchange verbatim, bound data
 * cells included, while the Data tab promised rows are "never saved anywhere".
 * The notice is the mitigation for storing what was sent, so a silent version
 * of it is the same as not having disclosed it at all.
 *
 * Mutation check: drop the `steps <= 0` guard and the "says nothing" case
 * fails; drop the `dataBound` branch and the data-file case fails.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StoredExchangeWarning } from "./StoredExchangeWarning";

describe("StoredExchangeWarning", () => {
	it("says the steps hold the exchange as sent, and names the expiry", () => {
		render(<StoredExchangeWarning steps={4} dataBound={false} />);
		expect(screen.getByText("Stored step data")).toBeTruthy();
		expect(screen.getByText(/as sent and received/)).toBeTruthy();
		// The expiry is the actionable half - without it the notice is a worry
		// with no answer, the same rule CapturedDataWarning follows.
		expect(screen.getByText("maxRunsRetained")).toBeTruthy();
	});

	it("says nothing when the surface lists no steps", () => {
		const { container } = render(<StoredExchangeWarning steps={0} dataBound={false} />);
		expect(container.firstChild).toBeNull();
	});

	it("names the bound cells when the run had a data file", () => {
		render(<StoredExchangeWarning steps={2} dataBound />);
		expect(screen.getByText(/those cells are stored in these steps/)).toBeTruthy();
	});

	it("does not mention data cells for a run that bound none", () => {
		const { container } = render(<StoredExchangeWarning steps={2} dataBound={false} />);
		// A run with no data file must not be told about cells it never bound -
		// a warning that applies to everyone is read by no one.
		expect(container.textContent).not.toMatch(/data file/i);
	});
});
