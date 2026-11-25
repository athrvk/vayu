/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Logs tab's list (#3635): the held lines, oldest first, in the tab's own scroller.
 *
 * **Follow is the scroll position.** Scrolling off the end turns it off and reaching the end turns
 * it on again, unless the list is detached from the tail (`logs-store.ts`), where reaching the end
 * of what was paged in must not throw the reader to the newest lines; only the Follow control does
 * that. After a jump, "Search newer" below the last row pages towards them, and the page that
 * reaches them attaches the tail, so reaching the end follows again.
 *
 * **The window is bounded and has two ends** (`useLogWindow`, #3670): at most a few hundred rows
 * are mounted, whatever the store holds. While following they are the newest; otherwise the window
 * stays on the reader's rows, a sentinel above the first and below the last mounts the next step as
 * either end scrolls into view, and lines added below (a tail batch, a page newer) wait past the
 * lower end until the reader reaches them. Reaching the end of the window with rows still below it
 * is not reaching the end, so it does not follow.
 *
 * **The older bar sits above the oldest line held, not above the window** (#3675): while rows are
 * held above the window it says nothing, since "Search older" and "Reached the start" speak of the
 * lines above everything held. Growing the window upward keeps the reader's place (`useHoldPlace`),
 * so a steady scroll up reaches it.
 *
 * **A jump is marked and scrolled to** (#3674): the window opens on the time (`useLogWindow`), a
 * rule naming it sits between the last line before it and the first at or after it, and once the
 * first page newer has landed (`jumpPaging`) the list scrolls that rule to the middle of its own
 * scroller, once per jump (clamped by the browser where too few rows sit below the rule to fill
 * half the scroller: the end of the logs). Not sooner: that page's lines change which rows are
 * mounted, so an earlier scroll would be to a place that then moves. The scroll is the list's own,
 * through `scrollOwn`, so it never reads as the reader reaching the end: Follow stays off however
 * near the end the time lies. Resetting the scroller to its end instead would show the newest
 * lines, which a jump is not for.
 *
 * **The pin is `useStickToEnd`** (#3671): it pins again when the rows settle to their real height
 * and ignores the scroll event its own pin causes, so only the reader's scrolls turn Follow off.
 */

import {
	Fragment,
	type ReactNode,
	type Ref,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useHoldPlace } from "@/hooks/useHoldPlace";
import { useStickToEnd } from "@/hooks/useStickToEnd";
import { TimeValue } from "@/components/shared/TimeValue";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button, Eyebrow } from "@/components/ui";
import { formatInstant } from "@/lib/time-value";
import { scrollWithin } from "@/lib/scroll-within";
import { cn } from "@/lib/utils";
import type { LogEntry } from "@/types/electron";
import { LOG_COLUMNS } from "./log-columns";
import { LogRow } from "./LogRow";
import { entryKey } from "./log-entry";
import { useLogsStore } from "./logs-store";
import { useLogWindow } from "./useLogWindow";

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
	const loadingOlder = useLogsStore((s) => s.loadingOlder);
	const loadOlder = useLogsStore((s) => s.loadOlder);

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

/** The rule a jump draws between the lines before its time and the lines at or after it. */
function JumpMarker({ target, markerRef }: { target: string; markerRef: Ref<HTMLLIElement> }) {
	return (
		<li
			ref={markerRef}
			role="separator"
			aria-label={`Jumped to ${formatInstant(target)}`}
			className="flex items-center gap-2 px-3 py-1 text-xs text-primary"
		>
			<span aria-hidden="true" className="h-px flex-1 bg-primary" />
			<span>
				Jumped to <TimeValue value={target} style="datetime" />
			</span>
			<span aria-hidden="true" className="h-px flex-1 bg-primary" />
		</li>
	);
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
	const jumpTarget = useLogsStore((s) => s.jumpTarget);
	const jumpPaging = useLogsStore((s) => s.jumpPaging);
	const status = useLogsStore((s) => s.status);
	const setFollow = useLogsStore((s) => s.setFollow);
	const scroller = useRef<HTMLDivElement>(null);
	const marker = useRef<HTMLLIElement>(null);
	/** The generation whose jump the scroller has been taken to. */
	const scrolledTo = useRef<number | null>(null);
	const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
	// Before the follow pin below: an effect that pins the newest line must win.
	const holdPlace = useHoldPlace(scroller);
	const { shown, hasAbove, hasBelow, jumpAt, topSentinelRef, bottomSentinelRef } = useLogWindow(
		records,
		follow,
		generation,
		holdPlace,
		jumpTarget,
		jumpPaging
	);

	const { onScroll, listRef, scrollOwn } = useStickToEnd(scroller, {
		following: follow,
		onFollowingChange: setFollow,
		canResume: !detached && !hasBelow,
		rows: records,
	});

	// Every commit, so the check sees the marker the moment its page has landed.
	useLayoutEffect(() => {
		if (!marker.current || !scroller.current || jumpPaging) return;
		if (scrolledTo.current === generation) return;
		scrolledTo.current = generation;
		const container = scroller.current;
		const target = marker.current;
		scrollOwn(() => scrollWithin(container, target, { block: "center" }));
	});

	const toggle = useCallback((entry: LogEntry) => {
		const key = entryKey(entry);
		setOpened((current) => {
			const next = new Set(current);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	}, []);

	const jumpMarker =
		jumpTarget !== null && jumpAt !== null ? (
			<JumpMarker target={jumpTarget} markerRef={marker} />
		) : null;

	return (
		<div
			ref={scroller}
			onScroll={onScroll}
			className={cn("min-h-0 flex-1 overflow-y-auto", status === "loading" && "opacity-70")}
		>
			<ColumnHeader />
			<LoadError />
			{!hasAbove && <OlderBar />}
			{hasAbove && <div ref={topSentinelRef} aria-hidden="true" />}
			{records.length === 0 ? (
				<EmptyState
					variant="inline"
					compact
					title={status === "loading" ? "Reading the logs…" : "No lines to show."}
				/>
			) : (
				<ul ref={listRef}>
					{shown.map((entry, index) => (
						<Fragment key={entryKey(entry)}>
							{index === jumpAt && jumpMarker}
							<LogRow
								entry={entry}
								expanded={opened.has(entryKey(entry))}
								onToggle={toggle}
							/>
						</Fragment>
					))}
					{jumpAt === shown.length && jumpMarker}
				</ul>
			)}
			{hasBelow && <div ref={bottomSentinelRef} aria-hidden="true" />}
			<NewerBar />
		</div>
	);
}
