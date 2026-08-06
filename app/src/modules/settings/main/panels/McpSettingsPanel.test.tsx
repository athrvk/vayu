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
 * The panel must never invent the config it edits.
 *
 * Every control here commits a whole field computed from what is displayed -
 * adding a host persists `[...displayed, host]`, a tool switch persists the
 * whole disabled set. So a stand-in shown when the real config could not be
 * read is not a cosmetic default: it is one click away from being written over
 * the user's allowlist. The three IPC paths (load / persist / toggle) are
 * therefore tested on their failure branch, and the tool list is tested with a
 * category the panel's copy table does not know - a tool that renders nowhere
 * cannot be switched off at all, since this is the only UI that edits
 * `disabledTools`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import McpSettingsPanel from "./McpSettingsPanel";
import { useToastStore } from "@/stores";
import type { McpSafetyConfig, McpStatus, McpToolInfo } from "@/types";

const getMcpStatus = vi.fn();
const getMcpSafety = vi.fn();
const getMcpTools = vi.fn();
const updateMcpSafety = vi.fn();
const setMcpEnabled = vi.fn();
const connectMcpClient = vi.fn();

const STATUS: McpStatus = { running: true, url: "http://127.0.0.1:9877/mcp", enabled: true };

const SAVED: McpSafetyConfig = {
	allowlist: ["api.example.com", "internal.test"],
	allowAll: false,
	maxRps: 1000,
	maxConcurrency: 200,
	maxDurationSeconds: 300,
	maxIterations: 10000,
	allowWrites: false,
	disabledTools: [],
};

const TOOLS: McpToolInfo[] = [
	{
		name: "list_collections",
		description: "List collections.",
		category: "read",
		readOnly: true,
	},
	{
		name: "run_request",
		description: "Send one request.",
		category: "execute",
		readOnly: false,
	},
];

beforeEach(() => {
	cleanup();
	useToastStore.setState({ toasts: [] });
	for (const fn of [
		getMcpStatus,
		getMcpSafety,
		getMcpTools,
		updateMcpSafety,
		setMcpEnabled,
		connectMcpClient,
	]) {
		fn.mockReset();
	}
	getMcpStatus.mockResolvedValue(STATUS);
	getMcpSafety.mockResolvedValue(SAVED);
	getMcpTools.mockResolvedValue(TOOLS);
	updateMcpSafety.mockResolvedValue(SAVED);
	setMcpEnabled.mockResolvedValue(STATUS);
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		getMcpStatus,
		getMcpSafety,
		getMcpTools,
		updateMcpSafety,
		setMcpEnabled,
		connectMcpClient,
	};
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** Render and let the mount-time IPC settle before asserting. */
async function renderPanel() {
	await act(async () => {
		render(<McpSettingsPanel />);
	});
}

const toastMessages = () => useToastStore.getState().toasts.map((t) => t.message);

describe("McpSettingsPanel load failures", () => {
	it("surfaces a failed load instead of rendering an empty allowlist", async () => {
		getMcpSafety.mockRejectedValue(new Error("engine ipc down"));

		await renderPanel();

		expect(toastMessages().join(" ")).toMatch(/couldn't load mcp settings/i);
		expect(screen.getByText(/couldn't load mcp settings/i)).toBeInTheDocument();
		// The false-empty display the fix removes: with no config read, the panel
		// must not claim the user has no allowed hosts.
		expect(screen.queryByText(/no hosts allowed yet/i)).not.toBeInTheDocument();
		// Nor may an edit be possible against a config that was never read.
		expect(screen.getByRole("textbox", { name: /host to allow/i })).toBeDisabled();
		expect(screen.getByRole("switch", { name: /allow all hosts/i })).toBeDisabled();
	});

	it("does not report the server as disabled when the status read failed", async () => {
		getMcpStatus.mockRejectedValue(new Error("no answer"));

		await renderPanel();

		expect(screen.getByText(/unknown/i)).toBeInTheDocument();
		expect(screen.queryByText(/^disabled$/i)).not.toBeInTheDocument();
		expect(screen.getByRole("switch", { name: /enable mcp server/i })).toBeDisabled();
	});

	it("recovers the real config on Retry", async () => {
		getMcpSafety.mockRejectedValueOnce(new Error("engine ipc down"));

		await renderPanel();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		});

		// The chip's remove button, not the sample host in the card description.
		expect(
			await screen.findByRole("button", { name: /remove api\.example\.com/i })
		).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load mcp settings/i)).not.toBeInTheDocument();
	});
});

describe("McpSettingsPanel write failures", () => {
	it("reports a failed save and re-reads what the main process actually holds", async () => {
		await renderPanel();
		const live: McpSafetyConfig = { ...SAVED, allowWrites: true };
		updateMcpSafety.mockRejectedValue(new Error("disk full"));
		getMcpSafety.mockResolvedValue(live);

		await act(async () => {
			fireEvent.click(screen.getByRole("switch", { name: /allow write operations/i }));
		});

		expect(toastMessages().join(" ")).toMatch(/couldn't save mcp settings/i);
		// main applies the change live before persisting, so the re-read - not the
		// value we tried to set - is what the panel must end up showing.
		await waitFor(() =>
			expect(screen.getByRole("switch", { name: /allow write operations/i })).toBeChecked()
		);
	});

	it("reports a failed server toggle rather than leaving the switch lying", async () => {
		await renderPanel();
		setMcpEnabled.mockRejectedValue(new Error("port in use"));
		getMcpStatus.mockResolvedValue({ ...STATUS, running: false, enabled: false });

		await act(async () => {
			fireEvent.click(screen.getByRole("switch", { name: /enable mcp server/i }));
		});

		expect(toastMessages().join(" ")).toMatch(/couldn't stop the mcp server/i);
		await waitFor(() =>
			expect(screen.getByRole("switch", { name: /enable mcp server/i })).not.toBeChecked()
		);
	});
});

describe("McpSettingsPanel connect failures", () => {
	it("surfaces a rejected connect instead of only stopping the spinner", async () => {
		await renderPanel();
		connectMcpClient.mockRejectedValue(new Error("mcp server is off"));

		await act(async () => {
			fireEvent.click(screen.getAllByRole("button", { name: /^connect$/i })[0]);
		});

		expect(toastMessages().join(" ")).toMatch(/couldn't connect .*mcp server is off/i);
	});
});

describe("McpSettingsPanel tool list", () => {
	it("renders a tool whose category the copy table does not describe", async () => {
		getMcpTools.mockResolvedValue([
			...TOOLS,
			{
				name: "analyze_run",
				description: "A tool in a category added after this panel shipped.",
				// Deliberately outside McpToolCategory: the IPC boundary is untyped
				// at runtime, which is exactly how such a tool would arrive.
				category: "analyze",
				readOnly: true,
			} as unknown as McpToolInfo,
		]);

		await renderPanel();

		expect(screen.getByText("analyze_run")).toBeInTheDocument();
		expect(
			screen.getByRole("switch", { name: /enable tool analyze_run/i })
		).toBeInTheDocument();
	});

	it("keeps the known categories in their documented display order", async () => {
		await renderPanel();

		const labels = screen
			.getAllByText(/^(Read|Execute|Write|Load testing)$/)
			.map((el) => el.textContent);
		expect(labels).toEqual(["Read", "Execute"]);
	});

	it("still toggles a tool in an undescribed category through the same IPC path", async () => {
		getMcpTools.mockResolvedValue([
			{
				name: "analyze_run",
				description: "A tool in a category added after this panel shipped.",
				category: "analyze",
				readOnly: true,
			} as unknown as McpToolInfo,
		]);

		await renderPanel();
		await act(async () => {
			fireEvent.click(screen.getByRole("switch", { name: /enable tool analyze_run/i }));
		});

		expect(updateMcpSafety).toHaveBeenCalledWith({ disabledTools: ["analyze_run"] });
	});
});
