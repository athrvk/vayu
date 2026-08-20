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
 * A restart the engine is waiting for has to be visible outside Settings.
 *
 * `pendingRestart` was raised by the settings save path and read by exactly one
 * screen - the one the user has already left by the time it matters. Every
 * other setting confirms itself; the restart-required ones cannot, so the Dock
 * says so and offers the restart from wherever the user is.
 *
 * Rendered, not source-scanned: the signal arrives through a store binding, and
 * both halves are asserted - present when pending, absent when not. A component
 * that rendered the line unconditionally would pass the first case alone.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { Dock } from "./Dock";
import { useEngineStore, useToastStore } from "@/stores";
import { TIMING } from "@/config/timing";

vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

const restartEngine = vi.fn();

const renderDock = () =>
	render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<Dock />
			</TooltipProvider>
		</QueryClientProvider>
	);

const signal = () => screen.queryByRole("button", { name: /Restart pending/i });

beforeEach(() => {
	cleanup();
	vi.clearAllMocks();
	useEngineStore.setState({
		isEngineConnected: true,
		engineError: null,
		pendingRestart: false,
		restartRequiredKeys: [],
	});
	useToastStore.setState({ toasts: [] });
	restartEngine.mockResolvedValue({ success: true });
	vi.stubGlobal("electronAPI", { restartEngine });
	// The renderer reads it off `window`, which is what the component sees.
	(window as unknown as { electronAPI: unknown }).electronAPI = { restartEngine };
});

describe("the Dock's pending-restart signal", () => {
	it("stays away while nothing is pending", () => {
		renderDock();
		expect(signal()).toBeNull();
	});

	it("appears once a restart-required setting has been saved", () => {
		// Any key would do - the store holds what the engine flagged and the Dock
		// never branches on which. `dbCacheSize` is one the engine really does
		// read once, at DB open; `workers` stood here until #873, where it stopped
		// being restart-gated because every run re-reads it.
		useEngineStore.getState().addRestartRequiredKey("dbCacheSize");
		renderDock();
		expect(signal()).not.toBeNull();
	});

	it("restarts the engine and lowers itself", async () => {
		useEngineStore.getState().addRestartRequiredKey("dbCacheSize");
		renderDock();

		fireEvent.click(signal()!);

		await waitFor(() => expect(restartEngine).toHaveBeenCalledTimes(1));
		// The hook waits for the daemon to come back before invalidating and
		// lowering the flag, so this outlasts that wait deliberately.
		await waitFor(() => expect(useEngineStore.getState().pendingRestart).toBe(false), {
			timeout: TIMING.ENGINE_RESTART_WAIT_MS + 2000,
		});
		expect(signal()).toBeNull();
	});

	it("keeps standing when the restart fails, and says why", async () => {
		restartEngine.mockResolvedValue({ success: false, error: "engine did not come back" });
		useEngineStore.getState().addRestartRequiredKey("dbCacheSize");
		renderDock();

		fireEvent.click(signal()!);

		await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
		const [toast] = useToastStore.getState().toasts;
		expect(toast?.variant).toBe("error");
		expect(toast?.message).toContain("engine did not come back");
		// The signal is the user's evidence that a saved value is not live yet;
		// a failed restart must not clear it.
		expect(useEngineStore.getState().pendingRestart).toBe(true);
		expect(signal()).not.toBeNull();
	});
});
