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
 * `logs-store.ts` and the bound cases in `logs-store.test.ts` red; widen the
 * window in `useLogWindow.ts` by every line appended below it, unbounded, and
 * the tail and Search newer window cases mount past the cap; drop `!hasBelow`
 * from `LogList.tsx`'s scroll handler and the tail window case follows from the
 * end of the window; export with `entryLine` in `LogsToolbar.tsx` and the cut
 * record case writes a line that is not JSON; set `more` false after a trim in
 * `logs-store.ts` and the case past the bound offers no Search older; draw
 * `OlderBar` regardless of `hasAbove` and the older bar cases show it above a
 * window that is not at the oldest line held; drop the `beforeGrowUp` call in
 * `useLogWindow.ts` and the reader's place case reads a `scrollTop` of 0; drop
 * the `scrollWithin` call in `LogList.tsx` and the jump cases that name the
 * scrolled element red; draw `JumpMarker` at the end of the list whatever
 * `jumpAt` says and the marker-between-lines case reds; drop `jumpTarget` from
 * `NOTHING_LOADED` and the case that reloads after a jump keeps its marker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { useTabsStore, useToastStore } from "@/stores";
import type { LogEntry, LogFileRecord, SaveFileReply } from "@/types/electron";
import { fakeLogsBridge, logCursor, logRecord, type FakeLogsBridge } from "./logs-bridge.testkit";
import { formatInstant } from "@/lib/time-value";
import { LogsTab } from "./LogsTab";
import { LOG_MAX_BYTES, useLogsStore } from "./logs-store";
import { makeScrollable, stubRowLayout } from "@/test/row-layout.testkit";
import { stubSentinelObserver } from "@/test/sentinel-observer.testkit";
import { scrollWithin } from "@/lib/scroll-within";
import { LOG_WINDOW_MAX_ROWS, LOG_WINDOW_STEP } from "./useLogWindow";

vi.mock("@/lib/scroll-within", () => ({ scrollWithin: vi.fn() }));

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

/** @p record's own fields: what a row opens to, Copy line copies and Export writes. */
function ownFields(record: LogFileRecord): LogFileRecord {
	const fields = { ...record };
	delete fields.$pos;
	return fields;
}

const request = logRecord(1, { status: 200, path: "/inbox", ms: 1.3 });
const unparsed: LogEntry = { unparsed: true, raw: "SEGFAULT at 0xdeadbeef" };

/** A record carrying the line the file holds, which `JSON.stringify` would not write back (`1.0`, a space). */
const FILE_LINE = `{"ts":"${logRecord(2).ts}","level":"info","src":"engine","cat":"http","msg":"line 2","pid":4242,"x":1.0, "path":"/raw"}`;
const withFileLine = logRecord(2, { x: 1, path: "/raw", $raw: FILE_LINE });

/** A record over the reader's 256 KiB bound: its message cut, and its raw line cut mid-value. */
const cutRecord = logRecord(3, { msg: `${"y".repeat(1024)}...[truncated]` });
const CUT_LINE = `{"ts":"${cutRecord.ts}","level":"info","src":"engine","cat":"http","msg":"yyyy`;
const withCutLine = { ...cutRecord, $raw: CUT_LINE };

beforeEach(() => {
	vi.mocked(scrollWithin).mockClear();
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

/** Lines @p from to @p to, exclusive, as `logRecord` numbers them. */
const lines = (from: number, to: number) =>
	Array.from({ length: to - from }, (_, n) => logRecord(from + n));

/** How many rows the list has mounted, not counting a jump's marker. */
const mountedRows = () =>
	screen.getByRole("list").querySelectorAll(":scope > li:not([role='separator'])").length;

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
		expect(document.querySelector("pre")?.textContent).toBe(
			JSON.stringify(ownFields(request), null, 2)
		);
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

		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith(JSON.stringify(ownFields(request)))
		);
		expect(toastTexts()).toEqual(["success:Line copied"]);
	});

	it("copies a line that is not a record as its raw text", async () => {
		await openTab([unparsed]);
		fireEvent.click(screen.getByRole("button", { expanded: false }));

		fireEvent.click(screen.getByRole("button", { name: "Copy line" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith("SEGFAULT at 0xdeadbeef"));
	});
});

describe("the raw line", () => {
	it("is what Copy line writes, not a re-serialisation of the record", async () => {
		await openTab([withFileLine]);
		fireEvent.click(screen.getByRole("button", { expanded: false }));

		fireEvent.click(screen.getByRole("button", { name: "Copy line" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(FILE_LINE));
		// The line the file holds parses to the fields the row shows, and no more.
		expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual(
			ownFields(logRecord(2, { x: 1, path: "/raw" }))
		);
	});

	it("is what Export writes", async () => {
		await openTab([withFileLine, unparsed]);

		fireEvent.click(screen.getByRole("button", { name: "Export" }));

		await waitFor(() =>
			expect(saveFile).toHaveBeenCalledWith(
				`${FILE_LINE}\nSEGFAULT at 0xdeadbeef\n`,
				"vayu-logs.jsonl"
			)
		);
	});

	it("is drawn neither as a field in the row nor in the opened row's JSON", async () => {
		await openTab([withFileLine]);
		const row = screen.getByRole("button", { expanded: false });

		expect(within(row).getByText("x=1 path=/raw")).toBeInTheDocument();
		fireEvent.click(row);

		expect(JSON.parse(document.querySelector("pre")?.textContent ?? "")).toEqual(
			ownFields(logRecord(2, { x: 1, path: "/raw" }))
		);
		expect(screen.queryByText(/\$raw/)).toBeNull();
	});

	it("is copied cut for a record over the bound, and exported as the cut record so the file stays JSON", async () => {
		await openTab([withCutLine]);
		fireEvent.click(screen.getByRole("button", { expanded: false }));

		fireEvent.click(screen.getByRole("button", { name: "Copy line" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(CUT_LINE));
		fireEvent.click(screen.getByRole("button", { name: "Export" }));

		await waitFor(() => expect(saveFile).toHaveBeenCalled());
		const [exported] = saveFile.mock.calls[0] as [string];
		expect(exported).toBe(`${JSON.stringify(ownFields(cutRecord))}\n`);
		expect(JSON.parse(exported)).toEqual(ownFields(cutRecord));
	});
});

describe("follow", () => {
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

	it("still offers Search older once the bound drops the oldest, from the oldest line held", async () => {
		await openTab([logRecord(10)], false);
		expect(screen.getByText("Reached the start of the logs.")).toBeInTheDocument();

		// One line that alone fills the byte budget drops line 10, the only older one.
		act(() => bridge.push([logRecord(11, { msg: "x".repeat(LOG_MAX_BYTES / 2) })]));

		expect(screen.queryByText("Reached the start of the logs.")).toBeNull();
		expect(screen.queryByText(/Searched back to/)).toBeNull();
		bridge.answer({ records: [logRecord(10)], more: false });
		fireEvent.click(screen.getByRole("button", { name: "Search older" }));

		expect(await screen.findByText("line 10")).toBeInTheDocument();
		expect(bridge.logs.read).toHaveBeenLastCalledWith({
			before: logCursor(11),
			filter: {},
			limit: 1000,
		});
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

	/** @p iso as the zone-less local value a `datetime-local` input holds, so no host zone shifts it. */
	function localInputValue(iso: string): string {
		const d = new Date(iso);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	}

	/** Jump to the instant of line 40 over a log holding lines 39 and 41 either side of it. */
	async function jumpBetween() {
		await openTab();
		bridge.answerReads({
			around: { records: [logRecord(39)], more: true, newer: logCursor(1) },
			after: { records: [logRecord(41)], more: true, cursor: logCursor(2) },
		});
		fireEvent.change(screen.getByLabelText("Jump to time"), {
			target: { value: localInputValue(logRecord(40).ts) },
		});
		fireEvent.click(screen.getByRole("button", { name: "Jump" }));
		await screen.findByText("line 41");
	}

	it("puts the line after the time in the table, beside the one before it", async () => {
		await jumpBetween();

		expect(screen.getByText("line 39")).toBeInTheDocument();
		expect(bridge.logs.read).toHaveBeenLastCalledWith({
			after: logCursor(1),
			filter: {},
			limit: 100,
		});
	});

	it("keeps the rows the reader had mounted, and no more than the cap, as Search newer adds pages below them", async () => {
		stubSentinelObserver();
		await openTab();
		bridge.answerReads({
			around: { records: lines(0, LOG_WINDOW_STEP + 1), more: true, newer: logCursor(1) },
			after: { records: [], more: true, cursor: logCursor(2) },
		});
		await act(() => useLogsStore.getState().jumpTo(logRecord(LOG_WINDOW_STEP).ts));
		expect(screen.queryByText("line 0")).toBeNull();
		expect(screen.getByText("line 1")).toBeInTheDocument();

		// Two pages below the window that together pass the cap.
		for (const [from, to] of [
			[201, 402],
			[402, 603],
		]) {
			bridge.answerReads({
				after: { records: lines(from, to), more: true, cursor: logCursor(to) },
			});
			fireEvent.click(screen.getByRole("button", { name: "Search newer" }));
			await waitFor(() => expect(useLogsStore.getState().records).toHaveLength(to));
			await screen.findByRole("button", { name: "Search newer" });
		}

		expect(mountedRows()).toBeLessThanOrEqual(LOG_WINDOW_MAX_ROWS);
		expect(screen.getByText("line 1")).toBeInTheDocument();
		expect(screen.queryByText("line 0")).toBeNull();
		// The pages wait below the window until the reader scrolls to them.
		expect(screen.queryByText("line 201")).toBeNull();
	});

	/** The text of the line either side of the jump's marker: "none" at an end of the list. */
	function besideMarker() {
		const marker = screen.getByRole("separator", { name: /^Jumped to / });
		const text = (row: Element | null) => row?.textContent ?? "none";
		return {
			marker,
			before: text(marker.previousElementSibling),
			after: text(marker.nextElementSibling),
		};
	}

	it("draws a rule naming the time between the last line before it and the first after it, and scrolls it into view", async () => {
		await jumpBetween();

		const { marker, before, after } = besideMarker();
		expect(before).toContain("line 39");
		expect(after).toContain("line 41");
		expect(marker).toHaveAccessibleName(`Jumped to ${formatInstant(logRecord(40).ts)}`);
		const scroller = screen.getByRole("list").parentElement;
		expect(scrollWithin).toHaveBeenCalledTimes(1);
		expect(scrollWithin).toHaveBeenCalledWith(scroller, marker, { block: "center" });
	});

	it("waits for the page after the time before it scrolls, so the place it scrolls to is the one that stays", async () => {
		await openTab();
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		bridge.logs.read.mockImplementation(async (request) => {
			if (request.after) await held;
			const records = request.after ? [logRecord(41)] : [logRecord(39)];
			return {
				records,
				cursor: logCursor(2),
				more: true,
				scannedTo: null,
				newer: logCursor(1),
			};
		});

		act(() => {
			void useLogsStore.getState().jumpTo(logRecord(40).ts);
		});
		expect(await screen.findByText("line 39")).toBeInTheDocument();
		expect(screen.queryByText("line 41")).toBeNull();
		expect(scrollWithin).not.toHaveBeenCalled();

		await act(async () => release());
		await screen.findByText("line 41");
		expect(scrollWithin).toHaveBeenCalledTimes(1);
	});

	it("scrolls once per jump: Search newer and the next jump are each their own", async () => {
		await jumpBetween();
		bridge.answerReads({
			after: { records: [logRecord(42)], more: true, cursor: logCursor(3) },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search newer" }));
		await screen.findByText("line 42");
		expect(scrollWithin).toHaveBeenCalledTimes(1);

		bridge.answerReads({
			around: { records: [logRecord(19)], more: true, newer: logCursor(1) },
			after: { records: [logRecord(21)], more: true, cursor: logCursor(2) },
		});
		await act(() => useLogsStore.getState().jumpTo(logRecord(20).ts));
		await screen.findByText("line 21");

		expect(scrollWithin).toHaveBeenCalledTimes(2);
	});

	it("draws the rule at the end when no line is at or after the time", async () => {
		await openTab();
		bridge.answerReads({ around: { records: [logRecord(39)], more: true } });

		await act(() => useLogsStore.getState().jumpTo(logRecord(45).ts));

		const { marker, before, after } = besideMarker();
		expect(before).toContain("line 39");
		expect(after).toBe("none");
		expect(scrollWithin).toHaveBeenCalledWith(expect.anything(), marker, { block: "center" });
	});

	it("draws the rule above every line when none is before the time", async () => {
		await openTab();
		bridge.answerReads({
			around: { records: [], more: false, newer: logCursor(1) },
			after: { records: [logRecord(41)], more: false },
		});

		await act(() => useLogsStore.getState().jumpTo(logRecord(40).ts));

		const { before, after } = besideMarker();
		expect(before).toBe("none");
		expect(after).toContain("line 41");
	});

	it("draws no rule once something else replaces the list", async () => {
		await jumpBetween();
		expect(screen.getByRole("separator", { name: /^Jumped to / })).toBeInTheDocument();

		bridge.answer({ records: [logRecord(50)] });
		await act(() => useLogsStore.getState().reload());

		expect(screen.queryByRole("separator")).toBeNull();
		expect(useLogsStore.getState().jumpTarget).toBeNull();
		expect(scrollWithin).toHaveBeenCalledTimes(1);
	});

	it("opens the window on the time, whatever is newer than it", async () => {
		stubSentinelObserver();
		await openTab();
		bridge.answerReads({
			around: { records: lines(0, 100), more: true, newer: logCursor(1) },
			after: {
				records: lines(100, 100 + LOG_WINDOW_STEP + 50),
				more: true,
				cursor: logCursor(2),
			},
		});

		await act(() => useLogsStore.getState().jumpTo(logRecord(100).ts));
		await screen.findByText("line 100");

		expect(screen.getByText("line 99")).toBeInTheDocument();
		const { before, after } = besideMarker();
		expect(before).toContain("line 99");
		expect(after).toContain("line 100");
	});

	it("pages newer from Search newer, and follows the tail again once it reaches the end", async () => {
		await jumpBetween();
		bridge.answerReads({ after: { records: [logRecord(42)], more: false } });

		fireEvent.click(screen.getByRole("button", { name: "Search newer" }));

		expect(await screen.findByText("line 42")).toBeInTheDocument();
		expect(bridge.logs.read).toHaveBeenLastCalledWith({
			after: logCursor(2),
			filter: {},
			limit: 1000,
		});
		expect(screen.queryByRole("button", { name: "Search newer" })).toBeNull();
		act(() => bridge.push([logRecord(43)]));
		expect(await screen.findByText("line 43")).toBeInTheDocument();
	});
});

describe("the window", () => {
	it("mounts no more than the cap as the tail appends below a reader who is not following", async () => {
		stubSentinelObserver();
		await openTab(lines(0, LOG_WINDOW_STEP));
		act(() => useLogsStore.getState().setFollow(false));

		// Two batches that together pass the cap.
		act(() => bridge.push(lines(200, 400)));
		act(() => bridge.push(lines(400, 601)));

		expect(useLogsStore.getState().records).toHaveLength(601);
		expect(mountedRows()).toBeLessThanOrEqual(LOG_WINDOW_MAX_ROWS);
		expect(screen.getByText("line 0")).toBeInTheDocument();
		expect(screen.queryByText("line 600")).toBeNull();
		// The end of the window is not the newest line, so reaching it does not follow.
		scrollTo(800);
		expect(screen.getByRole("switch", { name: "Follow" })).not.toBeChecked();
	});

	it("grows older at the top sentinel, gives up the newest past the cap, and mounts them again at the bottom one", async () => {
		const observer = stubSentinelObserver();
		await openTab(lines(0, LOG_WINDOW_MAX_ROWS + LOG_WINDOW_STEP + 1));
		act(() => useLogsStore.getState().setFollow(false));
		const list = screen.getByRole("list");
		expect(screen.getByText("line 601")).toBeInTheDocument();
		expect(screen.queryByText("line 600")).toBeNull();

		for (let step = 0; step < 3; step++) {
			act(() => observer.reach(list.previousElementSibling as Element));
		}

		expect(mountedRows()).toBe(LOG_WINDOW_MAX_ROWS);
		expect(screen.getByText("line 1")).toBeInTheDocument();
		expect(screen.getByText("line 600")).toBeInTheDocument();
		expect(screen.queryByText("line 601")).toBeNull();

		act(() => observer.reach(list.nextElementSibling as Element));

		expect(mountedRows()).toBe(LOG_WINDOW_MAX_ROWS);
		expect(screen.getByText("line 800")).toBeInTheDocument();
		expect(screen.getByText("line 201")).toBeInTheDocument();
		expect(screen.queryByText("line 200")).toBeNull();
	});

	it("draws the older bar only above the oldest line held, not above the window", async () => {
		const observer = stubSentinelObserver();
		await openTab(lines(0, LOG_WINDOW_STEP + 50), true);
		act(() => useLogsStore.getState().setFollow(false));
		const list = screen.getByRole("list");
		// Lines 0 to 49 are held and not mounted: the bar speaks of what is above all of them.
		expect(screen.queryByRole("button", { name: "Search older" })).toBeNull();
		expect(screen.queryByText(/Searched back to/)).toBeNull();

		act(() => observer.reach(list.previousElementSibling as Element));

		expect(screen.getByText("line 0")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Search older" })).toBeInTheDocument();
		expect(screen.getByText(/Searched back to/)).toBeInTheDocument();
	});

	it("says it reached the start only once the window does", async () => {
		const observer = stubSentinelObserver();
		await openTab(lines(0, LOG_WINDOW_STEP + 50), false);
		act(() => useLogsStore.getState().setFollow(false));
		expect(screen.queryByText("Reached the start of the logs.")).toBeNull();

		act(() => observer.reach(screen.getByRole("list").previousElementSibling as Element));

		expect(screen.getByText("Reached the start of the logs.")).toBeInTheDocument();
	});

	it("keeps the reader's place as the window grows above them, so the next scroll up grows it again", async () => {
		const observer = stubSentinelObserver();
		stubRowLayout(20);
		await openTab(lines(0, 1_000));
		act(() => useLogsStore.getState().setFollow(false));
		const list = screen.getByRole("list");
		const scroller = list.parentElement as HTMLElement;
		makeScrollable(scroller, 0);

		act(() => observer.reach(list.previousElementSibling as Element));
		expect(mountedRows()).toBe(2 * LOG_WINDOW_STEP);
		expect(scroller.scrollTop).toBe(LOG_WINDOW_STEP * 20);

		// The reader scrolls back to the top and reaches the sentinel again.
		scroller.scrollTop = 0;
		act(() => observer.reach(list.previousElementSibling as Element));
		expect(mountedRows()).toBe(LOG_WINDOW_MAX_ROWS);
		expect(scroller.scrollTop).toBe(LOG_WINDOW_STEP * 20);
	});
});

describe("export", () => {
	it("saves the held lines as JSON lines and says how many it wrote", async () => {
		await openTab([request, unparsed]);

		fireEvent.click(screen.getByRole("button", { name: "Export" }));

		await waitFor(() => expect(saveFile).toHaveBeenCalled());
		expect(saveFile).toHaveBeenCalledWith(
			`${JSON.stringify(ownFields(request))}\nSEGFAULT at 0xdeadbeef\n`,
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
