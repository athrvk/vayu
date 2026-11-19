/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Logs tab's lines (#3635): what the tail pushed, what a read paged in, and
 * the bound that keeps both from growing for as long as the tab is open.
 *
 * A store rather than component state because the work outlives a render and
 * has races of its own: a filter change replaces the list while a page is in
 * flight, and the tail pushes while a read is still answering. Every async step
 * checks `loadId` before it writes, and `stop()` bumps it, so nothing lands after
 * the tab is gone.
 *
 * **Filters are evaluated in main.** Changing one re-issues the read and
 * restarts the tail with the new filter (`logs:tail-start` replaces the running
 * one), and the lines already held are replaced by the fresh read. This store
 * never filters a line itself.
 *
 * **The bound** is `LOG_MAX_RECORDS` lines or `LOG_MAX_BYTES`, whichever comes
 * first. Following drops the oldest; paging older drops the newest, and having
 * dropped them the list is `detached` from the tail, since a batch appended
 * after a hole would be a lie about what happened between. Following again then
 * means reading afresh, never appending. Dropping the oldest moves the older
 * cursor up to the lines still held (`cursorAfterTrim`), so paging older reads
 * the dropped lines again; a page older a trim overtakes is read again from
 * there.
 *
 * **Jump to time** is detached too, and pages newer from the time it landed
 * on: one page at once, then one per "Search newer". Paging newer drops the
 * oldest, as following does; the page that reaches the end of the logs
 * attaches the tail again, which it restarted before reading so that nothing
 * written in between is lost.
 *
 * **A tail started before a read can repeat it.** The tail delivers what is
 * appended after it started and the read runs to the files' ends after that, so
 * the read's newest lines can arrive again in the tail's first batches. Lines
 * delivered while the read answers are checked against it in `buffered`; the
 * batches after it, against `overlapping`.
 */

import { create } from "zustand";
import { GROWING_WINDOW_STEP } from "@/hooks/useGrowingWindow";
import type {
	LogBatch,
	LogCursor,
	LogEntry,
	LogFileRecord,
	LogFilter,
	LogLinePosition,
	LogReadResult,
} from "@/types/electron";
import { POSITION_KEY, entryBytes, entryLine, isUnparsedEntry } from "./log-entry";
import { parseSearchInput } from "./parse-search";

/** The most lines the renderer holds. */
export const LOG_MAX_RECORDS = 10_000;
/** The most bytes of lines the renderer holds, by `entryBytes`' estimate. */
export const LOG_MAX_BYTES = 16 * 1024 * 1024;
/** Lines a read asks for; main clamps to 1000. */
const LOG_PAGE_SIZE = 1000;
/**
 * The page newer a jump reads at once: half the list's window, which renders
 * the newest lines held, so the window still reaches back past the time.
 */
const JUMP_NEWER_PAGE_SIZE = GROWING_WINDOW_STEP / 2;

export type LogLevelName = LogFileRecord["level"];

/** What the controls say; `buildLogFilter` turns it into what main evaluates. */
export interface LogControls {
	/** The lowest level shown; `debug` is every level. */
	minLevel: LogLevelName;
	source: string | null;
	category: string | null;
	/** The search box, as typed: free text and `field:value` terms. */
	search: string;
}

const DEFAULT_CONTROLS: LogControls = {
	minLevel: "debug",
	source: null,
	category: null,
	search: "",
};

/** The filter main evaluates for @p controls. Keys that constrain nothing are left out. */
export function buildLogFilter(controls: LogControls): LogFilter {
	const { text, terms } = parseSearchInput(controls.search);
	const filter: LogFilter = {};
	if (controls.minLevel !== "debug") filter.minLevel = controls.minLevel;
	if (controls.source !== null) filter.sources = [controls.source];
	if (controls.category !== null) filter.categories = [controls.category];
	if (text !== "") filter.text = text;
	if (terms.length > 0) filter.terms = terms;
	return filter;
}

interface Held {
	records: LogEntry[];
	bytes: number;
}

function totalBytes(records: readonly LogEntry[]): number {
	return records.reduce((sum, entry) => sum + entryBytes(entry), 0);
}

/**
 * @p held cut to the bound from one end, keeping at least one line: a single
 * line over the byte budget is still the one on screen, as a response over the
 * response cache's.
 */
function trimToBound(held: Held, drop: "oldest" | "newest"): Held & { dropped: LogEntry[] } {
	let start = 0;
	let end = held.records.length;
	let bytes = held.bytes;
	while (end - start > 1 && (end - start > LOG_MAX_RECORDS || bytes > LOG_MAX_BYTES)) {
		bytes -= entryBytes(drop === "oldest" ? held.records[start++] : held.records[--end]);
	}
	if (start === 0 && end === held.records.length) return { ...held, dropped: [] };
	return {
		records: held.records.slice(start, end),
		bytes,
		dropped: drop === "oldest" ? held.records.slice(0, start) : held.records.slice(end),
	};
}

/** Lines the tail delivered that @p read did not already return. */
function withoutRepeats(late: LogEntry[], read: LogEntry[]): LogEntry[] {
	if (late.length === 0 || read.length === 0) return late;
	const seen = new Set(read.map(entryLine));
	return late.filter((entry) => !seen.has(entryLine(entry)));
}

type CursorFile = LogCursor["files"][number];

const isLess = (a: number, b: number) => a < b;
const isGreater = (a: number, b: number) => a > b;

/** A cursor entry's file as the reader resolves it: by identity, or by name where there is none. */
function fileKey(file: Pick<CursorFile, "name" | "id">): string {
	return file.id === "" ? `name:${file.name}` : `id:${file.id}`;
}

/**
 * Per file of @p entries, the offset @p offsetOf reads off the line that
 * @p wins over every other line of that file; null when a line carries no
 * position (a fixture), since its file cannot be told.
 */
function offsetsByFile(
	entries: readonly LogEntry[],
	offsetOf: (position: LogLinePosition) => number,
	wins: (offset: number, current: number) => boolean
): Map<string, CursorFile> | null {
	const byFile = new Map<string, CursorFile>();
	for (const entry of entries) {
		const position = entry[POSITION_KEY];
		if (!position) return null;
		const key = fileKey(position);
		const offset = offsetOf(position);
		const current = byFile.get(key);
		if (!current || wins(offset, current.offset)) {
			byFile.set(key, { name: position.name, id: position.id, offset });
		}
	}
	return byFile;
}

/**
 * Where paging older continues once @p dropped, the oldest lines, are no longer
 * held: per file, the latest of the start of its oldest line still held, the
 * end of its newest line dropped and @p previous's entry, so the read takes the
 * dropped lines in again. Per file over every line, because the held order is
 * not time order across files (a poll's batch is sorted on its own, a lagging
 * file's lines arrive late), nor file order within one: the batch is sorted by
 * `ts`, which engine threads can write out of order, so a dropped line can lie
 * after a held one. @p previous sits above the held lines only for such a line,
 * dropped by an earlier trim and not yet read, so a later trim keeps it (a page
 * older, and the read before any trim, leave the cursor at or below every held
 * start). The page older then returns those held lines again, and `notHeld`
 * refuses them. Null, which ends
 * paging older, when a line has no position to place it by: a page from a
 * guessed cursor could skip lines or repeat them.
 */
function cursorAfterTrim(
	previous: LogCursor | null,
	held: readonly LogEntry[],
	dropped: readonly LogEntry[]
): LogCursor | null {
	if (previous === null) return null;
	const oldestHeld = offsetsByFile(held, (position) => position.start, isLess);
	const newestDropped = offsetsByFile(dropped, (position) => position.end, isGreater);
	if (!oldestHeld || !newestDropped) return null;
	const files = new Map(previous.files.map((file) => [fileKey(file), file]));
	for (const placed of [newestDropped, oldestHeld]) {
		for (const [key, file] of placed) {
			const current = files.get(key);
			if (!current || file.offset > current.offset) files.set(key, file);
		}
	}
	return { files: [...files.values()].filter((file) => file.offset > 0) };
}

/**
 * A line's place in its file, as `fileKey` and its start; null for a line that
 * carries none.
 */
function placeOf(entry: LogEntry): string | null {
	const position = entry[POSITION_KEY];
	return position ? `${fileKey(position)}@${position.start}` : null;
}

/**
 * The lines of @p page, a page older, that @p held does not already hold. By
 * place rather than by text (`withoutRepeats`), since a cursor rebuilt past a
 * held line (`cursorAfterTrim`) returns that very line again, while two lines
 * that read alike, an unparsed line repeated, are two lines.
 */
function notHeld(page: LogEntry[], held: readonly LogEntry[]): LogEntry[] {
	if (page.length === 0) return page;
	const heldPlaces = new Set(held.map(placeOf));
	return page.filter((entry) => {
		const place = placeOf(entry);
		return place === null || !heldPlaces.has(place);
	});
}

/**
 * @p held with @p added after it, cut to the bound from the oldest end. A cut
 * always makes a new cursor, so a page older requested before it is read again
 * from that cursor (`loadOlder`): it would sit behind the lines the cut dropped.
 */
function appendNewest(
	held: Held & Pick<LogsData, "cursor">,
	added: readonly LogEntry[]
): Partial<LogsData> & Held {
	const kept = trimToBound(
		{ records: [...held.records, ...added], bytes: held.bytes + totalBytes(added) },
		"oldest"
	);
	if (kept.dropped.length === 0) return { records: kept.records, bytes: kept.bytes };
	const cursor = cursorAfterTrim(held.cursor, kept.records, kept.dropped);
	return {
		records: kept.records,
		bytes: kept.bytes,
		cursor,
		more: cursor !== null && cursor.files.length > 0,
		// Nothing older than the held lines has been searched since the cut.
		scannedTo: null,
	};
}

/** @p known with the categories of @p records added; the same array when there is nothing new. */
function withCategories(known: string[], records: readonly LogEntry[]): string[] {
	const next = new Set(known);
	for (const entry of records) {
		if (!isUnparsedEntry(entry)) next.add(entry.cat);
	}
	return next.size === known.length ? known : [...next].sort();
}

interface LogsData {
	controls: LogControls;
	/** Oldest first. */
	records: LogEntry[];
	bytes: number;
	follow: boolean;
	/**
	 * Where the next page older starts; null until a read has answered, and
	 * after a trim that could not place a line (`cursorAfterTrim`).
	 */
	cursor: LogCursor | null;
	/** Older lines remain that the last read did not search or did not return. */
	more: boolean;
	/** The `ts` of the oldest line the last read examined, matching or not. */
	scannedTo: string | null;
	/** Lines the tail left out of a batch, since this list was read. */
	dropped: number;
	/** The newest lines are not all held, so the tail is not appended. */
	detached: boolean;
	/**
	 * Where the next page newer starts, after a jump. Null when there is none to
	 * read: the list is attached, or it dropped its newest lines paging older.
	 */
	newerCursor: LogCursor | null;
	/** The `ts` of the newest line the last page newer examined, matching or not. */
	newerScannedTo: string | null;
	status: "idle" | "loading" | "ready" | "error";
	loadingOlder: boolean;
	loadingNewer: boolean;
	error: string | null;
	/** Every category any read has returned, for the component filter's options. */
	knownCategories: string[];
	/** Changes whenever the list is replaced, so a window over it starts again. */
	generation: number;
}

interface LogsActions {
	/** Mount: read the newest lines and follow the tail. */
	start: () => Promise<void>;
	/** Unmount: end the tail and drop the lines. */
	stop: () => void;
	setControls: (patch: Partial<LogControls>) => void;
	/** Turning it on while detached reads the newest lines afresh. */
	setFollow: (follow: boolean) => void;
	loadOlder: () => Promise<void>;
	/** The page after the newest line held, while `newerCursor` says there is one. */
	loadNewer: () => Promise<void>;
	/** The lines around @p ts, an ISO instant: the newest at or before it, then a page after. */
	jumpTo: (ts: string) => Promise<void>;
	/** Read afresh with the current controls: also the retry after an error. */
	reload: () => Promise<void>;
}

export type LogsState = LogsData & LogsActions;

/** What the store holds with nothing loaded: the state after `stop()`. */
const NOTHING_LOADED = {
	records: [],
	bytes: 0,
	follow: true,
	cursor: null,
	more: false,
	scannedTo: null,
	dropped: 0,
	detached: false,
	newerCursor: null,
	newerScannedTo: null,
	status: "idle",
	loadingOlder: false,
	loadingNewer: false,
	error: null,
} satisfies Partial<LogsData>;

function bridge(): NonNullable<Window["electronAPI"]>["logs"] | undefined {
	return typeof window === "undefined" ? undefined : window.electronAPI?.logs;
}

function describeFailure(error: unknown): string {
	return `Couldn't read the logs - ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * The in-flight state that is not display state, so it is not in the store.
 * `loadId` is what each async step compares before it writes; `buffered` holds
 * the tail's lines while a read is answering and is null otherwise.
 */
let active = false;
let loadId = 0;
let buffered: LogEntry[] | null = null;
/** The read that last attached the tail, which its first batches can repeat; null once past. */
let overlapping: LogEntry[] | null = null;
let unsubscribe: (() => void) | null = null;

export const useLogsStore = create<LogsState>()((set, get) => {
	/** Show @p result as the whole list, with the tail's @p late lines after it. */
	function show(
		result: LogReadResult,
		late: LogEntry[],
		attach: Pick<LogsData, "follow" | "detached"> & Partial<Pick<LogsData, "newerCursor">>
	): void {
		const kept = appendNewest(
			{ records: result.records, bytes: totalBytes(result.records), cursor: result.cursor },
			late
		);
		set((state) => ({
			...NOTHING_LOADED,
			...attach,
			cursor: result.cursor,
			more: result.more,
			scannedTo: result.scannedTo,
			...kept,
			status: "ready",
			knownCategories: withCategories(state.knownCategories, kept.records),
			generation: state.generation + 1,
		}));
	}

	function fail(error: unknown): void {
		buffered = null;
		set({
			status: "error",
			error: describeFailure(error),
			loadingOlder: false,
			loadingNewer: false,
		});
	}

	/** The newest lines under the current filter, and a tail restarted on that filter. */
	async function reloadFresh(): Promise<void> {
		const logs = bridge();
		if (!logs) return;
		const id = ++loadId;
		const filter = buildLogFilter(get().controls);
		set({ status: "loading", error: null, loadingOlder: false, loadingNewer: false });
		try {
			// The tail first, so a line written while the read answers waits in
			// `buffered` instead of falling between the two.
			await logs.tailStart(filter);
			if (id !== loadId) return;
			const waiting: LogEntry[] = [];
			buffered = waiting;
			const result = await logs.read({ filter, limit: LOG_PAGE_SIZE });
			if (id !== loadId) return;
			buffered = null;
			show(result, withoutRepeats(waiting, result.records), {
				follow: true,
				detached: false,
			});
			overlapping = result.records;
		} catch (error) {
			if (id === loadId) fail(error);
		}
	}

	async function jumpTo(ts: string): Promise<void> {
		const logs = bridge();
		if (!logs) return;
		const id = ++loadId;
		set({ status: "loading", error: null, loadingOlder: false, loadingNewer: false });
		let newer: LogCursor | undefined;
		try {
			const filter = buildLogFilter(get().controls);
			const result = await logs.read({ around: ts, filter, limit: LOG_PAGE_SIZE });
			if (id !== loadId) return;
			newer = result.newer;
			show(result, [], { follow: false, detached: true, newerCursor: newer ?? null });
		} catch (error) {
			if (id === loadId) fail(error);
		}
		if (newer) await pageNewer(logs, id, newer, JUMP_NEWER_PAGE_SIZE);
	}

	/**
	 * One page newer than @p after, appended. The tail restarts first, as in
	 * `reloadFresh`: the page that reaches the end of the logs attaches it, and
	 * a line written while that page answers waits in `buffered`.
	 */
	async function pageNewer(
		logs: NonNullable<ReturnType<typeof bridge>>,
		id: number,
		after: LogCursor,
		limit: number
	): Promise<void> {
		const filter = buildLogFilter(get().controls);
		set({ loadingNewer: true, error: null });
		try {
			await logs.tailStart(filter);
			if (id !== loadId) return;
			const waiting: LogEntry[] = [];
			buffered = waiting;
			const result = await logs.read({ after, filter, limit });
			if (id !== loadId) return;
			buffered = null;
			appendNewer(after, result, result.more ? [] : withoutRepeats(waiting, result.records));
		} catch (error) {
			if (id !== loadId) return;
			buffered = null;
			set({ loadingNewer: false, error: describeFailure(error) });
		}
	}

	function appendNewer(after: LogCursor, result: LogReadResult, late: LogEntry[]): void {
		const state = get();
		// Paging older dropped the newest lines meanwhile: this page would sit after the hole.
		if (state.newerCursor !== after) {
			set({ loadingNewer: false });
			return;
		}
		const added = late.length > 0 ? [...result.records, ...late] : result.records;
		set({
			...appendNewest(state, added),
			detached: result.more,
			newerCursor: result.more ? result.cursor : null,
			newerScannedTo: result.scannedTo ?? state.newerScannedTo,
			loadingNewer: false,
			knownCategories: withCategories(state.knownCategories, added),
		});
		if (!result.more) overlapping = result.records;
	}

	async function loadNewer(): Promise<void> {
		const logs = bridge();
		const { newerCursor, loadingNewer, status } = get();
		if (!logs || !newerCursor || loadingNewer || status !== "ready") return;
		await pageNewer(logs, loadId, newerCursor, LOG_PAGE_SIZE);
	}

	async function loadOlder(): Promise<void> {
		const logs = bridge();
		const { cursor, more, loadingOlder, status, controls } = get();
		if (!logs || !cursor || !more || loadingOlder || status !== "ready") return;
		const id = loadId;
		const filter = buildLogFilter(controls);
		set({ loadingOlder: true, follow: false, error: null });
		try {
			// No cap on the passes: each is a whole read, the first that no trim
			// overtakes lands, and `stop()` or a filter change ends the loop through
			// `loadId`. A cap would only bring back the click that is thrown away.
			for (let before = cursor; ;) {
				const result = await logs.read({ before, filter, limit: LOG_PAGE_SIZE });
				if (id !== loadId) return;
				const now = get();
				if (now.cursor === before) {
					prependOlder(result);
					return;
				}
				// A trim moved the cursor meanwhile: this page would sit behind the
				// lines it dropped, so the page is read again from the new cursor.
				if (!now.cursor || !now.more) {
					set({ loadingOlder: false });
					return;
				}
				before = now.cursor;
			}
		} catch (error) {
			if (id === loadId) set({ loadingOlder: false, error: describeFailure(error) });
		}
	}

	/** @p result, the page older than the cursor held, before the held lines, cut from the newest end. */
	function prependOlder(result: LogReadResult): void {
		const state = get();
		const added = notHeld(result.records, state.records);
		const held = trimToBound(
			{ records: [...added, ...state.records], bytes: state.bytes + totalBytes(added) },
			"newest"
		);
		set({
			records: held.records,
			bytes: held.bytes,
			detached: state.detached || held.dropped.length > 0,
			newerCursor: held.dropped.length > 0 ? null : state.newerCursor,
			cursor: result.cursor,
			more: result.more,
			scannedTo: result.scannedTo ?? state.scannedTo,
			loadingOlder: false,
			knownCategories: withCategories(state.knownCategories, added),
		});
	}

	function receive(batch: LogBatch): void {
		if (!active) return;
		if (buffered) {
			buffered.push(...batch.records);
			return;
		}
		const state = get();
		if (state.detached || state.status !== "ready") return;
		const records = pastOverlap(batch.records);
		set({
			...appendNewest(state, records),
			dropped: state.dropped + batch.dropped,
			knownCategories: withCategories(state.knownCategories, records),
		});
	}

	/**
	 * @p records without the lines the read that attached the tail returned. A
	 * poll that listed the files before that read ended delivers only lines the
	 * read holds, so a batch that repeats none of them is past the overlap and
	 * ends the check.
	 */
	function pastOverlap(records: LogEntry[]): LogEntry[] {
		if (!overlapping) return records;
		const fresh = withoutRepeats(records, overlapping);
		if (fresh.length === records.length) overlapping = null;
		return fresh;
	}

	return {
		controls: DEFAULT_CONTROLS,
		knownCategories: [],
		generation: 0,
		...NOTHING_LOADED,

		start: async () => {
			const logs = bridge();
			if (!logs) return;
			active = true;
			unsubscribe?.();
			unsubscribe = logs.onRecords(receive);
			await reloadFresh();
		},

		stop: () => {
			if (!active) return;
			active = false;
			loadId++;
			buffered = null;
			overlapping = null;
			unsubscribe?.();
			unsubscribe = null;
			// A tail main cannot stop ends with the window or the app; nothing here
			// is left to show the user once the tab is gone.
			bridge()
				?.tailStop()
				.catch(() => undefined);
			set(NOTHING_LOADED);
		},

		setControls: (patch) => {
			const before = JSON.stringify(buildLogFilter(get().controls));
			const controls = { ...get().controls, ...patch };
			set({ controls });
			if (active && JSON.stringify(buildLogFilter(controls)) !== before) void reloadFresh();
		},

		setFollow: (follow) => {
			if (follow && get().detached) {
				void reloadFresh();
				return;
			}
			set({ follow });
		},

		loadOlder,
		loadNewer,
		jumpTo,
		reload: reloadFresh,
	};
});
