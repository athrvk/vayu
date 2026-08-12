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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
	},
	{
		name: "run_request",
		description: "Send one request.",
		category: "execute",
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

/**
 * The endpoint is the main process's to know: it is built there from
 * `MCP_HOST` / `MCP_PORT` / `MCP_PATH` and reported over `mcp:status`. This
 * panel used to keep its own `http://127.0.0.1:9877/mcp` literal as a fallback -
 * a third copy of the URL, shown as fact whenever the status could not be read,
 * and one port change away from telling the user to point an agent at nothing.
 */
describe("McpSettingsPanel endpoint", () => {
	it("shows the URL the main process reports, whatever it is", async () => {
		getMcpStatus.mockResolvedValue({ ...STATUS, url: "http://127.0.0.1:9999/mcp" });

		await renderPanel();

		expect(screen.getAllByText("http://127.0.0.1:9999/mcp").length).toBeGreaterThan(0);
	});

	it("shows no URL at all, and nothing to copy, when the status never arrives", async () => {
		getMcpStatus.mockRejectedValue(new Error("no answer"));

		await renderPanel();

		// Scoped to the Connection card: that is where a URL is shown as fact and
		// copied into an agent's config. Elsewhere on the panel a URL is sample
		// copy (the allowlist card shows one being reduced to a host), which this
		// guard is not about and used to fail on.
		const connectionCard = screen.getByText("Connection").closest("[data-slot=card]");
		expect(connectionCard).not.toBeNull();
		expect(within(connectionCard as HTMLElement).queryByText(/^https?:\/\//)).toBeNull();
		// The placeholder stands in wherever the URL would have been - the
		// endpoint line and every connect snippet.
		expect(screen.getAllByText(/unavailable - mcp status not loaded/i).length).toBeGreaterThan(
			0
		);
		const copyButtons = screen.getAllByRole("button", { name: /^copy$/i });
		expect(copyButtons.length).toBeGreaterThan(0);
		for (const button of copyButtons) expect(button).toBeDisabled();
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

/**
 * This is the one panel where wrong copy is a safety problem: a user lowering a
 * cap against an agent is entitled to text that matches the mechanism. Max RPS
 * read as covering "a load run" while `targetRps` exists only in Constant RPS,
 * and Max concurrency claimed to cap "in-flight requests", which is not what it
 * bounds. Both are asserted by what they must *not* say as well, since the
 * defect was an over-broad sentence rather than a missing one.
 */
describe("McpSettingsPanel cap copy", () => {
	/**
	 * The description paragraph rendered beside a cap's input. Reached from the
	 * input rather than by text, so an assertion cannot pass by matching some
	 * other row's copy.
	 */
	function capDescription(label: string): string {
		// `data-setting-row` is the shared NumberSettingRow's own container, so
		// this reaches the description of *this* cap and no other.
		const row = screen.getByLabelText(label).closest("[data-setting-row]");
		const text = row?.querySelector("p")?.textContent ?? "";
		expect(text.length).toBeGreaterThan(0);
		return text;
	}

	it("scopes Max RPS to the mode that carries a rate", async () => {
		await renderPanel();

		const text = capDescription("Max RPS");
		expect(text).toMatch(/only a constant rps run carries a rate/i);
		expect(text).toMatch(/max concurrency/i);
	});

	it("says what Max concurrency bounds, and that in-flight is not it", async () => {
		await renderPanel();

		const text = capDescription("Max concurrency");
		expect(text).toMatch(/closed-loop/i);
		// The old text said this cap ceilings "in-flight requests for a load
		// run". It may only appear now as the thing the cap does *not* bound.
		expect(text).toMatch(/does not bound its in-flight requests/i);
	});

	it("advertises each cap's ceiling on the input the user types into", async () => {
		await renderPanel();

		// The main process holds each cap here on save, so an input that offered
		// more would be an input whose value silently comes back lower.
		expect(screen.getByLabelText("Max RPS")).toHaveAttribute("max", "1000000");
		expect(screen.getByLabelText("Max concurrency")).toHaveAttribute("max", "10000");
		// The unit moved out of the label and into the input's suffix, so the
		// label is now "Max duration" - one place per unit, per the settings
		// voice conventions.
		expect(screen.getByLabelText("Max duration")).toHaveAttribute("max", "86400");
		expect(screen.getByLabelText("Max iterations")).toHaveAttribute("max", "100000000");
	});

	it("says a cap above that maximum is lowered rather than stored", async () => {
		await renderPanel();

		expect(
			screen.getByText(/a cap above the most vayu itself will run is lowered/i)
		).toBeInTheDocument();
	});
});

/**
 * Two switches govern the write tools - the Tools card's Write group
 * (`disabledTools`) and the Write access toggle (`allowWrites`) - and a user who
 * flips one and sees no effect from the other has only these two sentences to go
 * on. Each card must name the other.
 */
describe("McpSettingsPanel copy that described only half its mechanism", () => {
	it("says what the server switch gives when it is on, and that on is the default", async () => {
		await renderPanel();

		// It described only the OFF state, on a switch that ships on.
		expect(screen.getByText(/on by default/i)).toBeInTheDocument();
	});

	it("states the allowlist rule the normalizer actually has", async () => {
		await renderPanel();

		// "no scheme or port" was a rule `normalizeHost` does not enforce - it
		// accepts a full URL and reduces it - so a user pasting one had no way to
		// know the entry they got was the right one.
		expect(screen.getByText(/paste a url or type a host/i)).toBeInTheDocument();
		expect(screen.queryByText(/no scheme or port/i)).not.toBeInTheDocument();
	});
});

describe("McpSettingsPanel write-switch cross-references", () => {
	it("tells the Tools card that Write access is a second switch", async () => {
		await renderPanel();

		expect(screen.getByText(/write access, below/i)).toBeInTheDocument();
	});

	it("tells the Write access card that a tool switched off in Tools stays off", async () => {
		await renderPanel();

		expect(
			screen.getByText(/turning it on grants no tool you switched off in tools/i)
		).toBeInTheDocument();
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
			} as unknown as McpToolInfo,
		]);

		await renderPanel();
		await act(async () => {
			fireEvent.click(screen.getByRole("switch", { name: /enable tool analyze_run/i }));
		});

		expect(updateMcpSafety).toHaveBeenCalledWith({ disabledTools: ["analyze_run"] });
	});
});
