/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Logs tab's list (#3635): the held lines, oldest first, in the tab's own
 * scroller.
 *
 * **Follow is the scroll position.** Scrolling off the end turns it off, and
 * reaching the end turns it on again - unless the list is detached from the tail
 * (`logs-store.ts`), where reaching the end of what was paged in must not throw
 * the reader to the newest lines; only the Follow control does that. After a
 * jump, "Search newer" below the last row pages towards them, and the page that
 * reaches them attaches the tail, so reaching the end follows again.
 *
 * **The window is the newest lines.** `useGrowingWindow` is the app's one list
 * window for rows that are variable-height (an opened row is a block of JSON),
 * and its sentinel sits above the first rendered row, so scrolling up renders
 * the next older slice and the rest stay unmounted. `content-visibility` on each
 * row (`skip-offscreen`) skips layout for what is off screen. Lines added below
 * while the reader is not following widen the window by as many
 * (`useRowsAddedBelow`), so the rows they were reading stay mounted.
 */

import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { TimeValue } from "@/components/shared/TimeValue";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button, Eyebrow } from "@/components/ui";
import { GROWING_WINDOW_STEP, useGrowingWindow } from "@/hooks/useGrowingWindow";
import { cn } from "@/lib/utils";
import type { LogEntry } from "@/types/electron";
import { LOG_COLUMNS } from "./log-columns";
import { LogRow } from "./LogRow";
import { entryKey } from "./log-entry";
import { useLogsStore } from "./logs-store";

/** How far from the end still counts as at the end: a fractional scroll position never lands exactly. */
const END_TOLERANCE_PX = 8;

function ColumnHeader() {
	return (
		<div
			aria-hidden="true"
			className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-rule bg-panel px-3 py-px font-mono"
		>
			<Eyebrow size="xs" className={LOG_COLUMNS.time}>
				Time
			</Eyebrow>
			<Eyebrow size="xs" className="w-9 shrink-0 text-right">
				Level
			</Eyebrow>
			<Eyebrow size="xs" className={LOG_COLUMNS.source}>
				Source
			</Eyebrow>
			<Eyebrow size="xs" className={LOG_COLUMNS.component}>
				Component
			</Eyebrow>
			<Eyebrow size="xs" className={LOG_COLUMNS.message}>
				Message
			</Eyebrow>
			<Eyebrow size="xs" className={LOG_COLUMNS.fields}>
				Fields
			</Eyebrow>
		</div>
	);
}

/** A paging bar: how far a search has got, and the button that searches further. */
function PagingBar({
	children,
	search,
}: {
	children: ReactNode;
	search?: { label: string; loading: boolean; onSearch: () => void };
}) {
	return (
		<div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
			{children}
			{search && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={search.loading}
					onClick={search.onSearch}
				>
					{search.loading ? "Searching…" : search.label}
				</Button>
			)}
		</div>
	);
}

/** Where the search has got to, and the way to go further back. */
function OlderBar() {
	const more = useLogsStore((s) => s.more);
	const scannedTo = useLogsStore((s) => s.scannedTo);
	const olderLetGo = useLogsStore((s) => s.olderLetGo);
	const loadingOlder = useLogsStore((s) => s.loadingOlder);
	const loadOlder = useLogsStore((s) => s.loadOlder);

	if (olderLetGo) {
		return (
			<PagingBar>
				<span>
					Older lines were let go to hold the newest. Jump to a time to read them.
				</span>
			</PagingBar>
		);
	}
	if (!more) {
		return (
			<PagingBar>
				<span>Reached the start of the logs.</span>
			</PagingBar>
		);
	}
	return (
		<PagingBar
			search={{
				label: "Search older",
				loading: loadingOlder,
				onSearch: () => void loadOlder(),
			}}
		>
			{scannedTo !== null && (
				<span>
					Searched back to <TimeValue value={scannedTo} style="datetime" />
				</span>
			)}
		</PagingBar>
	);
}

/** After a jump: how far forward the search has got, and the way to go further. */
function NewerBar() {
	const newerCursor = useLogsStore((s) => s.newerCursor);
	const newerScannedTo = useLogsStore((s) => s.newerScannedTo);
	const loadingNewer = useLogsStore((s) => s.loadingNewer);
	const loadNewer = useLogsStore((s) => s.loadNewer);
	if (newerCursor === null) return null;

	return (
		<PagingBar
			search={{
				label: "Search newer",
				loading: loadingNewer,
				onSearch: () => void loadNewer(),
			}}
		>
			{newerScannedTo !== null && (
				<span>
					Searched forward to <TimeValue value={newerScannedTo} style="datetime" />
				</span>
			)}
		</PagingBar>
	);
}

/**
 * How many rows were added below the window while the reader was not
 * following: a page newer, or a tail batch while scrolled up. The window counts
 * from the newest line, so without these a page of 1,000 below would leave only
 * its own rows mounted and move the reader's out from under them. Counted from
 * where the previous newest line now sits, and reset with the list.
 */
function useRowsAddedBelow(records: LogEntry[], follow: boolean, generation: number): number {
	const last: LogEntry | undefined = records[records.length - 1];
	const [seen, setSeen] = useState({ generation, last, added: 0 });
	if (seen.generation === generation && seen.last === last) return seen.added;
	let added = 0;
	if (seen.generation === generation) {
		const at = follow || seen.last === undefined ? -1 : records.lastIndexOf(seen.last);
		added = seen.added + (at === -1 ? 0 : records.length - 1 - at);
	}
	// Adjusted during render, as `useGrowingWindow` resets its own window.
	setSeen({ generation, last, added });
	return added;
}

function LoadError() {
	const error = useLogsStore((s) => s.error);
	const reload = useLogsStore((s) => s.reload);
	if (error === null) return null;
	return (
		<div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs">
			<span className="text-status-error-text">{error}</span>
			<Button type="button" variant="link" size="sm" onClick={() => void reload()}>
				Try again
			</Button>
		</div>
	);
}

export function LogList() {
	const records = useLogsStore((s) => s.records);
	const follow = useLogsStore((s) => s.follow);
	const detached = useLogsStore((s) => s.detached);
	const generation = useLogsStore((s) => s.generation);
	const status = useLogsStore((s) => s.status);
	const setFollow = useLogsStore((s) => s.setFollow);
	const scroller = useRef<HTMLDivElement>(null);
	const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
	const { visible, sentinelRef } = useGrowingWindow(
		records.length,
		GROWING_WINDOW_STEP,
		generation
	);
	const addedBelow = useRowsAddedBelow(records, follow, generation);

	// After the list changes and while following: the newest line is in view.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (follow && element) element.scrollTop = element.scrollHeight;
	}, [follow, records]);

	const onScroll = () => {
		const element = scroller.current;
		if (!element) return;
		const atEnd =
			element.scrollHeight - element.scrollTop - element.clientHeight <= END_TOLERANCE_PX;
		if (follow && !atEnd) setFollow(false);
		else if (!follow && atEnd && !detached) setFollow(true);
	};

	const toggle = useCallback((entry: LogEntry) => {
		const key = entryKey(entry);
		setOpened((current) => {
			const next = new Set(current);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	}, []);

	const shown = records.slice(-(visible + addedBelow));

	return (
		<div
			ref={scroller}
			onScroll={onScroll}
			className={cn("min-h-0 flex-1 overflow-y-auto", status === "loading" && "opacity-70")}
		>
			<ColumnHeader />
			<LoadError />
			<OlderBar />
			{shown.length < records.length && <div ref={sentinelRef} aria-hidden="true" />}
			{records.length === 0 ? (
				<EmptyState
					variant="inline"
					compact
					title={status === "loading" ? "Reading the logs…" : "No lines to show."}
				/>
			) : (
				<ul>
					{shown.map((entry) => (
						<LogRow
							key={entryKey(entry)}
							entry={entry}
							expanded={opened.has(entryKey(entry))}
							onToggle={toggle}
						/>
					))}
				</ul>
			)}
			<NewerBar />
		</div>
	);
}
