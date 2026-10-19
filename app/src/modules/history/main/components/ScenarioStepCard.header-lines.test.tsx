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
 * A scenario step's Headers tab shows the response's header lines as the stored
 * trace recorded them (issue #2460), the same ones the design-run pane shows.
 * The card builds its viewer props by hand from the restored `ResponseState`,
 * so the field has to be forwarded there or the History pane would keep the
 * folded map while the builder shows the lines.
 *
 * Mutation check: drop `headerLines` from the projection in
 * `ScenarioStepCard.tsx` and the first case fails.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";
import type { RunResultSample } from "@/modules/request-builder/utils/restore-response";

afterEach(cleanup);

function row(headerLines?: Array<{ name: string; value: string }>): ScenarioStepRow {
	return {
		iteration: 0,
		stepIndex: 0,
		name: "Login",
		outcome: "passed",
		statusCode: 200,
		latencyMs: 12,
		result: {
			timestamp: 1_750_000_000_000,
			statusCode: 200,
			latencyMs: 12,
			trace: {
				request: { method: "POST", url: "https://x.test/login" },
				response: {
					headers: { "set-cookie": "a=1, b=2" },
					...(headerLines && { headerLines }),
					body: "ok",
				},
			},
		} as RunResultSample,
	};
}

function headerNames(step: ScenarioStepRow) {
	const { container } = render(
		<ScenarioStepCard
			step={step}
			showIteration={false}
			isExpanded={true}
			onToggle={() => {}}
			runId="run_1"
		/>
	);
	const trigger = screen.getByRole("tab", { name: /headers/i });
	trigger.focus();
	fireEvent.mouseDown(trigger);
	return Array.from(container.querySelectorAll("span.font-medium")).map((n) => n.textContent);
}

describe("ScenarioStepCard response headers", () => {
	it("shows one row per stored header line", () => {
		const names = headerNames(
			row([
				{ name: "Set-Cookie", value: "a=1" },
				{ name: "Set-Cookie", value: "b=2" },
			])
		);

		expect(names).toEqual(["Set-Cookie:", "Set-Cookie:"]);
	});

	it("shows the folded map for a row stored before the lines", () => {
		expect(headerNames(row())).toEqual(["set-cookie:"]);
	});
});
