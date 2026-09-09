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
 * Settings, General's "Open logs folder" button (#1558) - the one row in
 * Storage paths a user can act on rather than only read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useToastStore } from "@/stores";
import GeneralPanel from "./GeneralPanel";

vi.mock("@/queries/runs", () => ({
	useAllRunsQuery: () => ({ data: [] }),
	useInvalidateRuns: () => vi.fn(),
}));

vi.mock("@/services", () => ({
	apiService: { deleteRun: vi.fn() },
}));

vi.mock("./UpdatesCard", () => ({ UpdatesCard: () => null }));
vi.mock("./CookiesCard", () => ({ CookiesCard: () => null }));

const getAppPaths = vi.fn();
const openLogsFolder = vi.fn();

beforeEach(() => {
	getAppPaths.mockReset().mockResolvedValue({
		appDir: "/app",
		dataDir: "/data",
		dbPath: "/data/db",
		logsPath: "/data/logs",
	});
	openLogsFolder.mockReset().mockResolvedValue("");
	(window as unknown as { electronAPI: unknown }).electronAPI = { getAppPaths, openLogsFolder };
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	useToastStore.setState({ toasts: [] });
});

describe("GeneralPanel - Open logs folder", () => {
	it("shows an Open button beside the Logs path, and no other row", async () => {
		render(<GeneralPanel />);
		await screen.findByText("/data/logs");

		expect(screen.getByRole("button", { name: /open/i })).toBeInTheDocument();
		// One button for one row - Database, App directory and Data directory get
		// no affordance, only the path.
		expect(screen.getAllByRole("button", { name: /open/i })).toHaveLength(1);
	});

	it("calls electronAPI.openLogsFolder when clicked", async () => {
		render(<GeneralPanel />);
		await screen.findByText("/data/logs");

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /open/i }));
		});

		expect(openLogsFolder).toHaveBeenCalledTimes(1);
	});

	it("toasts the failure reason when the main process could not open it", async () => {
		openLogsFolder.mockResolvedValue("No file manager is configured");
		render(<GeneralPanel />);
		await screen.findByText("/data/logs");

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /open/i }));
		});

		await waitFor(() => {
			expect(useToastStore.getState().toasts).toHaveLength(1);
		});
		const [toast] = useToastStore.getState().toasts;
		expect(toast.message).toContain("No file manager is configured");
		expect(toast.variant).toBe("error");
	});

	it("shows no button when there is no electronAPI (the sweep/probe harness)", () => {
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		render(<GeneralPanel />);

		expect(
			screen.getByText(/Storage paths are available in the desktop app/i)
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /open/i })).not.toBeInTheDocument();
	});
});
