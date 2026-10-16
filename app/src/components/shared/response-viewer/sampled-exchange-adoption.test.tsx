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
 * Issue #76 guard: the sampled-exchange view renders through the shared shell.
 *
 * The dashboard's sample list and the history detail's stored one showed the
 * same thing - a sampled HTTP exchange, expandable - and were two components
 * that drifted in their summary rows, expansion chrome and section order. The
 * dashboard's went with #2220, when the dashboard began rendering History's
 * report; the shell stays the one place a sample row is drawn.
 *
 * `SampledExchange` is replaced with a sentinel here, so a view that goes back
 * to a hand-rolled row fails - which asserting on rendered markup would not,
 * since a hand-rolled row can render the same status chip and latency. The
 * props the view passes are echoed into the DOM, because "renders the shell"
 * is only half of it: the stored-row specifics have to stay in the caller.
 */

import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";

vi.mock("@/components/shared/response-viewer/SampledExchange", () => ({
	SampledExchange: (props: Record<string, unknown>) => (
		<div
			data-testid="sampled-exchange"
			data-status={String(props.statusCode)}
			data-label={String(props.label)}
			data-phases={String((props.phases as unknown[] | undefined)?.length ?? 0)}
		>
			{props.timestamp as ReactNode}
		</div>
	),
}));

// The history card's response path mounts Monaco via CodeEditor.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const trace = { dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 4, downloadMs: 5 };

describe("the sampled view renders through SampledExchange (#76)", () => {
	it("the history detail's stored sample card", async () => {
		const SampleRequestCard = (
			await import("@/modules/history/main/components/SampleRequestCard")
		).default;

		render(
			<SampleRequestCard
				sample={
					{
						timestamp: Date.UTC(2024, 0, 1, 10, 11, 12, 345),
						statusCode: 200,
						latencyMs: 5,
						trace,
					} as unknown as import("@/modules/history/types").SampleResult
				}
				index={6}
				isExpanded
				onToggle={() => {}}
			/>
		);

		const row = screen.getByTestId("sampled-exchange");
		expect(row).toHaveAttribute("data-status", "200");
		// One-based, and the history side has no engine request number to use.
		expect(row).toHaveAttribute("data-label", "7");
		expect(row).toHaveAttribute("data-phases", "5");
		// A stored row dates a run rather than placing a moment inside one.
		expect(row.textContent).not.toMatch(/\.345/);
	});
});
