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
 * collection mode case reads "Fixed request count"; drop the `iterations` entry
 * from `headlineEntries` and the count cases fail.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import RunConfigSummary from "./RunConfigSummary";

const CONFIG = { mode: "iterations", concurrency: 10, iterations: 400 };

function lineOf(isCollectionRun: boolean, config: object = CONFIG) {
	return render(
		<TooltipProvider>
			<RunConfigSummary
				config={config}
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

describe("RunConfigSummary configured count (#3570)", () => {
	it("says Passes for a collection run", () => {
		expect(lineOf(true)).toContain("Passes:400");
	});

	it("says Requests for a single-request run", () => {
		const text = lineOf(false);
		expect(text).toContain("Requests:400");
		expect(text).not.toContain("Passes");
	});

	it("groups a large count", () => {
		expect(lineOf(false, { ...CONFIG, iterations: 12000 })).toContain("Requests:12,000");
	});

	it.each([
		["absent", { mode: "constant_rps", duration: "30s" }],
		["zero", { mode: "constant_rps", duration: "30s", iterations: 0 }],
	])("draws no count where the run has %s", (_name, config) => {
		const text = lineOf(false, config);
		expect(text).not.toContain("Requests:");
		expect(text).not.toContain("Passes:");
	});
});
