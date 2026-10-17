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
 * The finished run's Export menu (#2139): what it asks the engine, what it
 * does with the answer, and the palette slot it fills.
 *
 * The engine names the file and picks its type, so a save hands both through
 * untouched and only once the answer is here; a failure downloads nothing. The
 * mounts' gating (a finished load run only) is held by
 * `HistoryDetail.export.test.tsx` and the dashboard's suites.
 *
 * Mutation checks: drop `baseRunId` from the payload and the comparison case
 * reds; download before the export resolves, or with the registry's MIME type
 * rather than the engine's, and the save case reds; register the slot while an
 * export is in flight and the withdrawal case reds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import { downloadTextFile } from "@/lib/download-text-file";
import { useLiveCommandSurfaceStore } from "@/lib/commands";
import { runExportActions, type RunExportFormatEntry } from "@/lib/run-export-formats";
import { useToastStore } from "@/stores";
import type { Run, RunReportExportResponse } from "@/types";
import RunExportMenu from "./RunExportMenu";

const queries = vi.hoisted(() => ({
	run: undefined as unknown,
	baseline: null as unknown,
}));

vi.mock("@/queries", () => ({
	useRunQuery: () => ({ data: queries.run }),
	useBaselineRunQuery: () => ({ data: queries.baseline }),
}));
vi.mock("@/services/api", () => ({ apiService: { exportRunReport: vi.fn() } }));
vi.mock("@/lib/download-text-file", () => ({ downloadTextFile: vi.fn() }));

// No format is copyable yet; the copy case adds one to the table the menu reads.
const extraFormats = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/run-export-formats", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/run-export-formats")>();
	return {
		...actual,
		runExportActions: () =>
			actual.runExportActions([
				...actual.RUN_EXPORT_FORMATS,
				...(extraFormats.rows as RunExportFormatEntry[]),
			]),
	};
});

const MARKDOWN = {
	id: "markdown",
	name: "Markdown",
	mimeType: "text/markdown",
	extension: ".run.md",
	copyable: true,
	mcp: true,
} as unknown as RunExportFormatEntry;

function loadRun(id: string): Run {
	return {
		id,
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		requestId: "req_1",
		configSnapshot: { url: "https://api.test/orders", method: "GET" },
	} as unknown as Run;
}

/** The engine's answer: a name and a type the registry would not have picked. */
function envelope(urlCredentialsOmitted = 0): RunReportExportResponse {
	return {
		text: '{"schema":"vayu.run-report"}',
		fileName: "Orders 2026-10-17 0841.run.json",
		mimeType: "application/json; charset=utf-8",
		notes: { urlCredentialsOmitted },
	};
}

const exportRunReport = vi.mocked(apiService.exportRunReport);
const download = vi.mocked(downloadTextFile);
const writeText = vi.fn();

beforeEach(() => {
	queries.run = loadRun("run_1");
	queries.baseline = null;
	extraFormats.rows = [];
	exportRunReport.mockReset().mockResolvedValue(envelope());
	download.mockReset();
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
	useLiveCommandSurfaceStore.setState({ exportRun: null });
});
afterEach(cleanup);

function renderMenu() {
	return render(withQueryClient(<RunExportMenu runId="run_1" />));
}

async function openMenu() {
	const trigger = screen.getByRole("button", { name: "Export" });
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
	fireEvent.click(trigger, { detail: 1 });
	return screen.findByRole("menu");
}

const toasts = () => useToastStore.getState().toasts;

describe("the Export menu's items", () => {
	it("lists every action the format registry offers, and the note", async () => {
		renderMenu();
		const menu = await openMenu();

		const labels = runExportActions().map((action) => action.label);
		expect(labels).toEqual(["Save as JSON"]);
		const items = within(menu)
			.getAllByRole("menuitem")
			.map((item) => item.textContent);
		expect(items).toEqual(labels);
		expect(menu).toHaveTextContent("Includes the target URL, names, and comments you wrote.");
		expect(menu).toHaveTextContent("Leaves out request and response data.");
	});

	it("declares the surface its note's divider reads on", async () => {
		renderMenu();
		const menu = await openMenu();

		const note = within(menu).getByText(/Includes the target URL/).parentElement!;
		expect(note.className).toContain("border-rule");
		expect(menu.className).toContain("surface-card");
		expect(menu.getAttribute("aria-describedby")).toBe(note.id);
	});

	it("offers a copy for a copyable format, and copies the engine's text", async () => {
		extraFormats.rows = [MARKDOWN];
		renderMenu();
		const menu = await openMenu();

		fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy as Markdown" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(envelope().text));
		expect(exportRunReport).toHaveBeenCalledWith({ runId: "run_1", format: "markdown" });
		expect(download).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(toasts().map((t) => t.message)).toEqual(["Markdown report copied"])
		);
	});
});

describe("saving", () => {
	it("downloads the engine's file, by the engine's name and type, once it has answered", async () => {
		let answer!: (value: RunReportExportResponse) => void;
		exportRunReport.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		renderMenu();
		const menu = await openMenu();

		fireEvent.click(within(menu).getByRole("menuitem", { name: "Save as JSON" }));

		await waitFor(() =>
			expect(exportRunReport).toHaveBeenCalledWith({ runId: "run_1", format: "json" })
		);
		expect(download).not.toHaveBeenCalled();

		await act(async () => answer(envelope()));

		await waitFor(() =>
			expect(download).toHaveBeenCalledWith(
				envelope().text,
				"Orders 2026-10-17 0841.run.json",
				"application/json; charset=utf-8"
			)
		);
		expect(download).toHaveBeenCalledTimes(1);
		expect(toasts().map((t) => [t.message, t.variant])).toEqual([
			["Exported Orders 2026-10-17 0841.run.json", "success"],
		]);
	});

	it("says what the URL lost on the way out", async () => {
		exportRunReport.mockResolvedValue(envelope(2));
		renderMenu();
		fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Save as JSON" }));

		await waitFor(() =>
			expect(toasts().map((t) => t.message)).toEqual([
				"Exported Orders 2026-10-17 0841.run.json - 2 URL credentials left out",
			])
		);
	});

	it("says why in the engine's words, and downloads nothing, when the export fails", async () => {
		exportRunReport.mockRejectedValue(
			new Error("Run is still running; export it once it has finished")
		);
		renderMenu();
		fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Save as JSON" }));

		await waitFor(() => expect(toasts()).toHaveLength(1));
		expect(toasts()[0].variant).toBe("error");
		expect(toasts()[0].message).toContain(
			"Run is still running; export it once it has finished"
		);
		expect(download).not.toHaveBeenCalled();
	});
});

describe("the comparison with the baseline", () => {
	it("is not offered without a pinned baseline, nor when this run is the baseline", async () => {
		renderMenu();
		expect(within(await openMenu()).queryByRole("menuitemcheckbox")).toBeNull();
		cleanup();

		queries.baseline = loadRun("run_1");
		renderMenu();
		expect(within(await openMenu()).queryByRole("menuitemcheckbox")).toBeNull();
	});

	it("is ticked by default and sends the baseline, and unticking it drops it", async () => {
		queries.baseline = loadRun("run_0");
		renderMenu();
		let menu = await openMenu();

		const toggle = within(menu).getByRole("menuitemcheckbox", {
			name: "Include comparison with baseline",
		});
		expect(toggle).toHaveAttribute("aria-checked", "true");
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Save as JSON" }));
		await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
		expect(exportRunReport).toHaveBeenLastCalledWith({
			runId: "run_1",
			format: "json",
			baseRunId: "run_0",
		});

		menu = await openMenu();
		fireEvent.click(within(menu).getByRole("menuitemcheckbox"));
		// A toggle keeps the menu open for the export it qualifies.
		expect(within(menu).getByRole("menuitemcheckbox")).toHaveAttribute("aria-checked", "false");
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Save as JSON" }));
		await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
		expect(exportRunReport).toHaveBeenLastCalledWith({ runId: "run_1", format: "json" });
	});
});

/*
 * The palette's half: the menu is what fills the `exportRun` slot, in the
 * manner `send-request-command-surface.test.tsx` holds for Send.
 */
describe("the exportRun command surface", () => {
	const registered = () => useLiveCommandSurfaceStore.getState().exportRun;
	const [saveJson] = runExportActions();

	it("is filled while the menu is mounted and cleared when it unmounts", () => {
		expect(registered()).toBeNull();
		const { unmount } = renderMenu();
		expect(registered()).not.toBeNull();

		unmount();

		expect(registered()).toBeNull();
	});

	it("exports through the menu's own handler, comparison included", async () => {
		queries.baseline = loadRun("run_0");
		renderMenu();

		act(() => registered()!(saveJson));

		await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
		expect(exportRunReport).toHaveBeenCalledWith({
			runId: "run_1",
			format: "json",
			baseRunId: "run_0",
		});
	});

	it("is withdrawn while an export is in flight, and offered again once it lands", async () => {
		let answer!: (value: RunReportExportResponse) => void;
		exportRunReport.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		renderMenu();

		act(() => registered()!(saveJson));
		await waitFor(() => expect(registered()).toBeNull());

		await act(async () => answer(envelope()));
		await waitFor(() => expect(registered()).not.toBeNull());
	});

	it("leaves the clear to the current holder", () => {
		renderMenu();
		const current = registered();

		act(() => useLiveCommandSurfaceStore.getState().clearSurface("exportRun", () => {}));

		expect(registered()).toBe(current);
	});
});
