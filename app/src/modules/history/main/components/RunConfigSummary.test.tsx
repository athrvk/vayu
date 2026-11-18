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
 * The report's "Test config" line: the mode in the run's own words, by the kind
 * of run it is (#3570).
 *
 * Mutation check: drop the kind from the `loadTestTypeToLabel` call and the
 * collection mode case reads "Fixed request count".
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import RunConfigSummary from "./RunConfigSummary";

const CONFIG = { mode: "iterations", concurrency: 10, iterations: 400 };

function lineOf(isCollectionRun: boolean) {
	return render(
		<TooltipProvider>
			<RunConfigSummary
				config={CONFIG}
				downgradedRequests={0}
				isCollectionRun={isCollectionRun}
			/>
		</TooltipProvider>
	).container.textContent;
}

describe("RunConfigSummary mode", () => {
	it("reads Fixed passes for a collection run", () => {
		const text = lineOf(true);
		expect(text).toContain("Mode:Fixed passes");
		expect(text).not.toContain("Fixed request count");
	});

	it("keeps Fixed request count for a single-request run", () => {
		const text = lineOf(false);
		expect(text).toContain("Mode:Fixed request count");
		expect(text).not.toContain("Fixed passes");
	});
});
