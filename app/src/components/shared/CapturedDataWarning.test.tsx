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
 * Issue #174: capture stores response headers and bodies verbatim - the
 * decision was explicitly *not* to redact, on the grounds that design-mode
 * traces already store request headers as sent and a redaction guess is wrong
 * in both directions. The mitigation for that decision is this notice, so a
 * silent version of it is the same as not having made the decision.
 *
 * Mutation check: drop the `captured > 0` guard and the "says nothing" cases
 * fail; drop the component from SamplesTab and its own test fails.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CapturedDataWarning } from "./CapturedDataWarning";
import type { RunReport } from "@/types/domain";

function sampling(over: Partial<NonNullable<RunReport["sampling"]>> = {}) {
	return {
		errorsDropped: 0,
		successTracesDropped: 0,
		slowTracesDropped: 0,
		responseSamplesDropped: 0,
		...over,
	};
}

describe("CapturedDataWarning", () => {
	it("warns when the run stored captured responses", () => {
		render(<CapturedDataWarning sampling={sampling({ responseBodiesCaptured: 12 })} />);
		expect(screen.getByText("Captured response data")).toBeTruthy();
		expect(screen.getByText(/12 responses/)).toBeTruthy();
		// The expiry is the actionable half - without it the notice is a worry
		// with no answer.
		expect(screen.getByText("maxRunsRetained")).toBeTruthy();
	});

	it("says nothing when the run captured nothing", () => {
		const { container } = render(
			<CapturedDataWarning sampling={sampling({ responseBodiesCaptured: 0 })} />
		);
		expect(container.firstChild).toBeNull();
	});

	it("says nothing on a run recorded before capture existed", () => {
		// The field is absent, not zero - "we cannot tell" is worse as prose
		// than as absence, the same rule SampleRetentionNote follows.
		const { container } = render(<CapturedDataWarning sampling={sampling()} />);
		expect(container.firstChild).toBeNull();
	});

	it("says nothing when the report has no sampling section at all", () => {
		const { container } = render(<CapturedDataWarning sampling={undefined} />);
		expect(container.firstChild).toBeNull();
	});

	it("mentions bodies the run's budget could not keep", () => {
		render(
			<CapturedDataWarning
				sampling={sampling({ responseBodiesCaptured: 3, sampleBodiesDropped: 40 })}
			/>
		);
		expect(screen.getByText(/40 further bodies were not captured/)).toBeTruthy();
	});
});
