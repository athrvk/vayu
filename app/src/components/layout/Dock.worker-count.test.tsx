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
 * The engine's worker-thread count (issue #1508) - written by every health
 * poll into `engine-store` and read nowhere before this. The version string
 * in the Dock's ambient-status strip is the affordance: hovering it now
 * offers the number the raw `/health` JSON has always carried.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { Dock } from "./Dock";
import { useEngineStore } from "@/stores";

vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

const renderDock = () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<Dock />
			</TooltipProvider>
		</QueryClientProvider>
	);
};

beforeEach(() => {
	cleanup();
	useEngineStore.setState({ workers: null });
});

describe("the version string's worker-count tooltip", () => {
	it("offers no affordance before any health poll has answered", () => {
		renderDock();
		const version = screen.getByText("v0.0.0-test");
		expect(version.closest("[tabindex='0']")).toBeNull();
	});

	it("shows the configured count on hover, plural", async () => {
		useEngineStore.setState({ workers: 8 });
		renderDock();

		const trigger = screen.getByText("v0.0.0-test").closest("[tabindex='0']");
		expect(trigger).toBeTruthy();

		fireEvent.focus(trigger!);
		await waitFor(() => {
			expect(screen.getAllByText("8 worker threads").length).toBeGreaterThan(0);
		});
	});

	it("keeps the singular for exactly one worker", async () => {
		useEngineStore.setState({ workers: 1 });
		renderDock();

		fireEvent.focus(screen.getByText("v0.0.0-test").closest("[tabindex='0']")!);
		await waitFor(() => {
			expect(screen.getAllByText("1 worker thread").length).toBeGreaterThan(0);
		});
	});
});
