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
 * The post-run dashboard header's Export menu (#2139).
 *
 * The dashboard hands the header `exportRunId` only once the finished run's
 * report is on screen (`dashboard.report.test.tsx`), so a streaming run never
 * mounts the menu; the report's URL and method come along as primitives for
 * the baseline lookup of a run whose row names no saved request. The memo half
 * is `DashboardHeader.render-count.test.tsx`.
 *
 * Mutation check: render the menu without the `exportRunId` guard and the live
 * case reds; drop `exportRequestUrl` from the menu's props and the baseline
 * lookup case reds.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import type { Run } from "@/types";
import type { DashboardHeaderProps } from "../types";
import DashboardHeader from "./DashboardHeader";

const baselineTargets = vi.hoisted(() => [] as unknown[]);

// A run of an unsaved request: its row names no request and its snapshot no URL.
vi.mock("@/queries", () => ({
	useRunQuery: () => ({
		data: { id: "run_1", type: "load", status: "completed", requestId: null } as Run,
	}),
	useBaselineRunQuery: (target: unknown) => {
		baselineTargets.push(target);
		return { data: null };
	},
}));
vi.mock("@/services/api", () => ({ apiService: { exportRunReport: vi.fn() } }));
vi.mock("@/lib/download-text-file", () => ({ downloadTextFile: vi.fn() }));

function mount(patch: Partial<DashboardHeaderProps>) {
	return render(
		withQueryClient(
			<DashboardHeader
				mode="completed"
				isStreaming={false}
				isStopping={false}
				onStop={async () => {}}
				{...patch}
			/>
		)
	);
}

const exportButton = () => screen.queryByRole("button", { name: "Export" });

beforeEach(() => {
	baselineTargets.length = 0;
	vi.mocked(apiService.exportRunReport)
		.mockReset()
		.mockResolvedValue({
			text: "{}",
			fileName: "Orders.run.json",
			mimeType: "application/json",
			notes: { urlCredentialsOmitted: 0 },
		});
});

describe("Export in the dashboard header", () => {
	it("is offered for the finished run it is handed, and exports that run", async () => {
		mount({ exportRunId: "run_1" });

		const trigger = exportButton()!;
		expect(trigger).toBeInTheDocument();
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
		fireEvent.click(trigger, { detail: 1 });
		fireEvent.click(await screen.findByRole("menuitem", { name: "Save as JSON" }));

		await waitFor(() =>
			expect(apiService.exportRunReport).toHaveBeenCalledWith({
				runId: "run_1",
				format: "json",
			})
		);
	});

	it("is absent while the run streams", () => {
		mount({ mode: "running", isStreaming: true, requestUrl: "https://api.test/orders" });

		expect(exportButton()).toBeNull();
		expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
	});

	it("finds the baseline by the report's URL and method when the run row has neither", () => {
		mount({
			exportRunId: "run_1",
			exportRequestUrl: "https://api.test/orders",
			exportRequestMethod: "POST",
		});

		expect(baselineTargets[baselineTargets.length - 1]).toEqual({
			requestId: null,
			url: "https://api.test/orders",
			method: "POST",
		});
	});
});
