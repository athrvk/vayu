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
 * The Logs tab (#3635) over a fake `electronAPI.logs`: the table, the controls
 * and what each one asks main for.
 *
 * Mutation checks (revert, confirm red, restore): drop `stop()` from the mount
 * effect's cleanup and the unmount case reds; drop the `setControls` call in
 * `Filters`' debounce and the `cat:oauth` case reds; drop the `trimToBound` in
 * `logs-store.ts` and the bound cases in `logs-store.test.ts` red.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { useTabsStore, useToastStore } from "@/stores";
import type { LogEntry, SaveFileReply } from "@/types/electron";
import { fakeLogsBridge, logRecord, type FakeLogsBridge } from "./logs-bridge.testkit";
import { LogsTab } from "./LogsTab";
import { useLogsStore } from "./logs-store";

const config = vi.hoisted(() => ({ logLevel: "info" as string | undefined }));

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		data:
			config.logLevel === undefined
				? undefined
				: { entries: [{ key: "logLevel", value: config.logLevel }] },
	}),
}));

let bridge: FakeLogsBridge;
let openLogsFolder: ReturnType<typeof vi.fn>;
let saveFile: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

const request = logRecord(1, { status: 200, path: "/inbox", ms: 1.3 });
const unparsed: LogEntry = { unparsed: true, raw: "SEGFAULT at 0xdeadbeef" };

beforeEach(() => {
	bridge = fakeLogsBridge();
	openLogsFolder = vi.fn(async () => "");
	saveFile = vi.fn(async (): Promise<SaveFileReply> => ({
		outcome: "saved",
		fileName: "out.jsonl",
	}));
	writeText = vi.fn(async () => undefined);
	vi.stubGlobal("electronAPI", { logs: bridge.logs, openLogsFolder, saveFile });
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	config.logLevel = "info";
	useToastStore.setState({ toasts: [] });
	useLogsStore.setState({
		controls: { minLevel: "debug", source: null, category: null, search: "" },
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** Mount the tab over a read that answers @p records, and wait for them to be drawn. */
async function openTab(records: LogEntry[] = [request, unparsed], more = false) {
	bridge.answer({ records, more, scannedTo: logRecord(0).ts });
	const view = render(<LogsTab />);
	await waitFor(() => expect(useLogsStore.getState().status).toBe("ready"));
	await act(async () => undefined);
	return view;
}

const toastTexts = () => useToastStore.getState().toasts.map((t) => `${t.variant}:${t.message}`);

/** Pick an item of a Select by its trigger's accessible name. */
function choose(selectName: string, optionName: string) {
	fireEvent.click(screen.getByRole("combobox", { name: selectName }));
	fireEvent.click(screen.getByRole("option", { name: optionName }));
}

describe("outside Electron", () => {
	it("says the logs are in the desktop app and reaches for no bridge", () => {
		vi.stubGlobal("electronAPI", undefined);

		render(<LogsTab />);

		expect(screen.getByText("Logs are available in the desktop app.")).toBeInTheDocument();
		expect(bridge.logs.tailStart).not.toHaveBeenCalled();
		expect(screen.queryByRole("combobox")).toBeNull();
	});
});

describe("the table", () => {
	it("draws a record's time, level, source, component, message and remaining fields", async () => {
		await openTab([request]);

		const row = screen.getByRole("button", { expanded: false });
		expect(within(row).getByText("info")).toBeInTheDocument();
		expect(within(row).getByText("engine")).toBeInTheDocument();
		expect(within(row).getByText("http")).toBeInTheDocument();
		expect(within(row).getByText("line 1")).toBeInTheDocument();
		// The text renderer's shape, and nothing the table has a column for.
		expect(within(row).getByText("status=200 path=/inbox ms=1.3")).toBeInTheDocument();
		// The machine value is the record's own `ts`; the card on hover gives UTC.
		expect(row.querySelector("time")).toHaveAttribute("datetime", request.ts);
	});

	it("shows a line that is not a record raw, with a marker", async () => {
		await openTab([unparsed]);

		const row = screen.getByRole("button", { expanded: false });
		expect(within(row).getByText("SEGFAULT at 0xdeadbeef")).toBeInTheDocument();
		expect(within(row).getByText("unparsed")).toBeInTheDocument();
		expect(row.querySelector("time")).toBeNull();
	});

	it("opens a row to the whole record as formatted JSON", async () => {
		await openTab([request]);

		fireEvent.click(screen.getByRole("button", { expanded: false }));

		const row = screen.getByRole("button", { expanded: true });
		expect(row).toBeInTheDocument();
		expect(document.querySelector("pre")?.textContent).toBe(JSON.stringify(request, null, 2));
		// pid and tid have no column: the opened row is where they read.
		expect(document.querySelector("pre")?.textContent).toContain('"pid": 4242');

		fireEvent.click(row);
		expect(document.querySelector("pre")).toBeNull();
	});

	it("opens an unparsed line to its raw text", async () => {
		await openTab([unparsed]);

		fireEvent.click(screen.getByRole("button", { expanded: false }));

		expect(document.querySelector("pre")?.textContent).toBe("SEGFAULT at 0xdeadbeef");
	});

	it("says there is nothing to show, not an empty table", async () => {
		await openTab([]);

		expect(screen.getByText("No lines to show.")).toBeInTheDocument();
	});
});

describe("copy line", () => {
	it("copies the record as the one JSON line it is", async () => {
		await openTab([request]);
		fireEvent.click(screen.getByRole("button", { expanded: false }));

		fireEvent.click(screen.getByRole("button", { name: "Copy line" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(request)));
		expect(toastTexts()).toEqual(["success:Line copied"]);
	});

	it("copies a line that is not a record as its raw text", async () => {
		await openTab([unparsed]);
		fireEvent.click(screen.getByRole("button", { expanded: false }));

		fireEvent.click(screen.getByRole("button", { name: "Copy line" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith("SEGFAULT at 0xdeadbeef"));
	});
});

describe("follow", () => {
	/** The list's scroller, laid out as a 1000px list in a 200px box scrolled to @p top. */
	function scrollTo(top: number) {
		const scroller = screen.getByRole("list").parentElement as HTMLElement;
		Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
		Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
		Object.defineProperty(scroller, "scrollTop", {
			configurable: true,
			writable: true,
			value: top,
		});
		fireEvent.scroll(scroller);
	}

	const follow = () => screen.getByRole("switch", { name: "Follow" });

	it("is on by default", async () => {
		await openTab();

		expect(follow()).toBeChecked();
	});

	it("turns off when the reader scrolls up, and on when they reach the end again", async () => {
		await openTab();

		scrollTo(100);
		expect(follow()).not.toBeChecked();

		scrollTo(800);
		expect(follow()).toBeChecked();
	});

	it("is turned back on by its control", async () => {
		await openTab();
		scrollTo(100);

		fireEvent.click(follow());

		expect(follow()).toBeChecked();
	});

	it("is not resumed by reaching the end of lines that are not the newest", async () => {
		await openTab([request, unparsed], true);
		bridge.answer({ records: [logRecord(0)], more: true, scannedTo: logRecord(0).ts });
		fireEvent.click(screen.getByRole("button", { name: "Search older" }));
		await waitFor(() => expect(useLogsStore.getState().records).toHaveLength(3));
		// Detached by hand: the paged list is under the bound, so it is not by itself.
		act(() => useLogsStore.setState({ detached: true }));

		bridge.logs.tailStart.mockClear();
		scrollTo(800);
		// Resuming a detached list is a fresh read, which lands a moment later.
		await act(async () => undefined);

		expect(bridge.logs.tailStart).not.toHaveBeenCalled();
		expect(follow()).not.toBeChecked();
	});
});

describe("the filters", () => {
	it("re-issues the read and restarts the tail when the level changes", async () => {
		await openTab();
		bridge.logs.read.mockClear();
		bridge.logs.tailStart.mockClear();

		choose("Level", "Errors only");

		await waitFor(() =>
			expect(bridge.logs.tailStart).toHaveBeenCalledWith({ minLevel: "error" })
		);
		expect(bridge.logs.read).toHaveBeenCalledWith({
			filter: { minLevel: "error" },
			limit: 1000,
		});
	});

	it("re-issues with the source", async () => {
		await openTab();
		bridge.logs.tailStart.mockClear();

		choose("Source", "app");

		await waitFor(() =>
			expect(bridge.logs.tailStart).toHaveBeenCalledWith({ sources: ["app"] })
		);
	});

	it("offers the components it has seen and re-issues with the one chosen", async () => {
		await openTab([logRecord(1, { cat: "oauth" }), logRecord(2, { cat: "http" })]);
		bridge.logs.tailStart.mockClear();

		choose("Component", "oauth");

		await waitFor(() =>
			expect(bridge.logs.tailStart).toHaveBeenCalledWith({ categories: ["oauth"] })
		);
	});

	it("re-issues with cat:oauth typed in the search box, once typing stops", async () => {
		await openTab();
		bridge.logs.tailStart.mockClear();

		fireEvent.change(screen.getByRole("textbox", { name: "Search logs" }), {
			target: { value: "cat:oauth" },
		});

		await waitFor(() =>
			expect(bridge.logs.tailStart).toHaveBeenCalledWith({
				terms: [{ field: "cat", value: "oauth", exact: false }],
			})
		);
		expect(bridge.logs.read).toHaveBeenLastCalledWith({
			filter: { terms: [{ field: "cat", value: "oauth", exact: false }] },
			limit: 1000,
		});
		expect(bridge.logs.tailStart).toHaveBeenCalledTimes(1);
	});

	it("replaces the lines it holds with the filtered read", async () => {
		await openTab([request, unparsed]);
		bridge.answer({ records: [logRecord(9, { level: "error", msg: "boom" })] });

		choose("Level", "Errors only");

		expect(await screen.findByText("boom")).toBeInTheDocument();
		expect(screen.queryByText("line 1")).toBeNull();
	});
});

describe("search older", () => {
	it("pages back from the cursor, turns follow off and says how far it has searched", async () => {
		await openTab([logRecord(10)], true);
		const searched = logRecord(3);
		bridge.answer({ records: [logRecord(4)], more: true, scannedTo: searched.ts });

		fireEvent.click(screen.getByRole("button", { name: "Search older" }));

		await waitFor(() => expect(useLogsStore.getState().records).toHaveLength(2));
		expect(bridge.logs.read).toHaveBeenLastCalledWith({
			before: { files: [] },
			filter: {},
			limit: 1000,
		});
		expect(screen.getByRole("switch", { name: "Follow" })).not.toBeChecked();
		expect(screen.getByText(/Searched back to/)).toHaveTextContent(/Searched back to\s*\S/);
		const time = screen.getByText(/Searched back to/).querySelector("time");
		expect(time).toHaveAttribute("datetime", searched.ts);
	});

	it("says it has reached the start when nothing older remains", async () => {
		await openTab([logRecord(1)], false);

		expect(screen.getByText("Reached the start of the logs.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Search older" })).toBeNull();
	});
});

describe("jump to time", () => {
	it("reads around the instant the local time names", async () => {
		await openTab();
		bridge.answer({ records: [logRecord(40)], more: true });

		fireEvent.change(screen.getByLabelText("Jump to time"), {
			target: { value: "2026-11-18T10:30" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Jump" }));

		await waitFor(() =>
			expect(bridge.logs.read).toHaveBeenLastCalledWith({
				around: new Date("2026-11-18T10:30").toISOString(),
				filter: {},
				limit: 1000,
			})
		);
		expect(screen.getByRole("switch", { name: "Follow" })).not.toBeChecked();
	});

	it("waits for a time", async () => {
		await openTab();

		expect(screen.getByRole("button", { name: "Jump" })).toBeDisabled();
	});
});

describe("export", () => {
	it("saves the held lines as JSON lines and says how many it wrote", async () => {
		await openTab([request, unparsed]);

		fireEvent.click(screen.getByRole("button", { name: "Export" }));

		await waitFor(() => expect(saveFile).toHaveBeenCalled());
		expect(saveFile).toHaveBeenCalledWith(
			`${JSON.stringify(request)}\nSEGFAULT at 0xdeadbeef\n`,
			"vayu-logs.jsonl"
		);
		await waitFor(() =>
			expect(toastTexts()).toEqual(["success:Exported 2 lines to out.jsonl"])
		);
	});

	it("says nothing when the dialog is cancelled", async () => {
		saveFile.mockResolvedValue({ outcome: "cancelled" });
		await openTab([request]);

		fireEvent.click(screen.getByRole("button", { name: "Export" }));

		await waitFor(() => expect(saveFile).toHaveBeenCalled());
		expect(toastTexts()).toEqual([]);
	});

	it("reports a write that failed, with the system's reason", async () => {
		saveFile.mockResolvedValue({
			outcome: "failed",
			fileName: "out.jsonl",
			message: "disk full",
		});
		await openTab([request]);

		fireEvent.click(screen.getByRole("button", { name: "Export" }));

		await waitFor(() =>
			expect(toastTexts()).toEqual(["error:Couldn't save out.jsonl - disk full"])
		);
	});

	it("has nothing to export from an empty list", async () => {
		await openTab([]);

		expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
	});
});

describe("the logs folder", () => {
	it("opens it through the bridge", async () => {
		await openTab();

		fireEvent.click(screen.getByRole("button", { name: "Open logs folder" }));

		expect(openLogsFolder).toHaveBeenCalledTimes(1);
		expect(toastTexts()).toEqual([]);
	});

	it("reports why it could not", async () => {
		openLogsFolder.mockResolvedValue("no file manager");
		await openTab();

		fireEvent.click(screen.getByRole("button", { name: "Open logs folder" }));

		await waitFor(() =>
			expect(toastTexts()).toEqual(["error:Couldn't open the logs folder - no file manager"])
		);
	});
});

describe("the tail's lifetime", () => {
	it("starts on mount and stops on unmount, and ignores what main pushes after", async () => {
		const { unmount } = await openTab([request]);
		expect(bridge.logs.tailStart).toHaveBeenCalledTimes(1);
		expect(bridge.logs.tailStop).not.toHaveBeenCalled();

		act(() => bridge.push([logRecord(2, { msg: "while open" })]));
		expect(await screen.findByText("while open")).toBeInTheDocument();

		unmount();

		expect(bridge.logs.tailStop).toHaveBeenCalledTimes(1);
		expect(bridge.subscribers()).toBe(0);
		bridge.push([logRecord(3, { msg: "after unmount" })]);
		expect(useLogsStore.getState().records).toEqual([]);
	});
});

describe("the log level hint", () => {
	it("names the engine's level and says what is debug", async () => {
		await openTab();

		expect(screen.getByText(/Log level: info\./)).toBeInTheDocument();
		expect(
			screen.getByText(/Requests answered 2xx and database writes are logged at debug/)
		).toBeInTheDocument();
		expect(screen.getByText(/it applies after a restart/)).toBeInTheDocument();
	});

	it("leaves the level out until the config has answered, and keeps the rest", async () => {
		config.logLevel = undefined;
		await openTab();

		expect(screen.queryByText(/Log level:/)).toBeNull();
		expect(screen.getByText(/database writes are logged at debug/)).toBeInTheDocument();
	});

	it("opens Settings on Observability", async () => {
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		await openTab();

		fireEvent.click(screen.getByRole("button", { name: "Settings › Observability" }));

		expect(useSettingsStore.getState().selectedCategory).toBe("observability");
		expect(useTabsStore.getState().openTabs.map((tab) => tab.type)).toContain("settings");
	});
});

describe("a read that fails", () => {
	it("says what failed and reads again on Try again", async () => {
		bridge.logs.read.mockRejectedValueOnce(new Error("Refused: not the app window"));
		render(<LogsTab />);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Couldn't read the logs - Refused: not the app window");

		bridge.answer({ records: [request] });
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

		expect(await screen.findByText("line 1")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
