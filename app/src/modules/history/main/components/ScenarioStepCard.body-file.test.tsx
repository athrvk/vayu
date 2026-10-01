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
 * A scenario step that sent a binary body names the file, as its stored
 * request node recorded it - the same line the design-run copy shows.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";
import type { RunResultSample } from "@/modules/request-builder/utils/restore-response";

afterEach(cleanup);

function row(bodyFile?: unknown): ScenarioStepRow {
	return {
		iteration: 0,
		stepIndex: 0,
		name: "Upload",
		outcome: "passed",
		statusCode: 201,
		latencyMs: 12,
		result: {
			timestamp: 1_750_000_000_000,
			statusCode: 201,
			latencyMs: 12,
			trace: {
				request: { method: "PUT", url: "https://x.test/blob", bodyFile },
				response: { headers: {}, body: "" },
			},
		} as RunResultSample,
	};
}

function renderExpanded(step: ScenarioStepRow) {
	return render(
		<ScenarioStepCard
			step={step}
			showIteration={false}
			isExpanded={true}
			onToggle={() => {}}
			runId="run_1"
		/>
	);
}

describe("ScenarioStepCard sent file", () => {
	it("names the file, its size and its hash", () => {
		renderExpanded(row({ fileName: "blob.bin", size: 10, sha256: "feedfacecafebeef00" }));

		expect(screen.getByText(/Sent file blob\.bin · 10 B · sha256/)).toBeTruthy();
		expect(screen.getByText("feedfacecafe")).toBeTruthy();
	});

	it("says nothing for a step whose request recorded no file", () => {
		renderExpanded(row());
		expect(screen.queryByText(/Sent file/)).toBeNull();
	});
});
