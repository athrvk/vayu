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
 * Before the first tick arrives the dashboard says so through the shared
 * `EmptyState` (#2314), not a hand-rolled block that misses its fixes.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import MetricsView from "./MetricsView";

describe("MetricsView before the first metrics", () => {
	it("draws the waiting line as an EmptyState with no action", () => {
		render(
			<TooltipProvider>
				<MetricsView
					metrics={null}
					historicalMetrics={[]}
					mode="constant_concurrency"
					concurrency={10}
				/>
			</TooltipProvider>
		);

		const state = document.querySelector('[data-slot="empty-state"]');
		expect(state).not.toBeNull();
		expect(state?.textContent).toBe("Waiting for metrics…");
		expect(state?.querySelector("button")).toBeNull();
		expect(screen.getByText("Waiting for metrics…")).toBeTruthy();
	});
});
