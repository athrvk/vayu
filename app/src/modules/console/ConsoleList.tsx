/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The session Console's list (#3634): the ring's rows, oldest first and newest
 * last, in the tab's own scroller.
 *
 * **The filter runs before the window is taken.** `useGrowingWindow` renders
 * the newest slice and grows upward from a sentinel above it; the toolbar's
 * filter is applied to every row in the ring first, so a match above what is
 * drawn is still listed. The filter is the window's reset key, so narrowing
 * starts from the newest slice again, and a row appended to the ring does not.
 *
 * **It follows the newest while scrolled to the end**, the way a console does:
 * a new row brings the list down only when the reader was already at the
 * bottom.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui";
import { GROWING_WINDOW_STEP, useGrowingWindow } from "@/hooks/useGrowingWindow";
import { formatBytes, formatNumber } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import {
	CONSOLE_MAX_BYTES,
	CONSOLE_MAX_ROWS,
	selectConsoleEvictedCount,
	selectConsoleRows,
	useConsoleStore,
	type ConsoleRow,
} from "@/stores/console-store";
import { filterConsoleRows, type ConsoleFilter } from "./console-filter";
import { LineRow } from "./LineRow";
import { RequestRow } from "./RequestRow";
import { StepRow } from "./StepRow";

/** How far from the end still counts as at the end: a fractional scroll position never lands exactly. */
const END_TOLERANCE_PX = 8;

/** Said once, above the oldest row the ring still holds. */
function EvictedNotice({ count }: { count: number }) {
	if (count === 0) return null;
	return (
		<p className="px-4 py-1.5 text-xs text-muted-foreground">
			{formatNumber(count)} older {pluralize(count, "row")} dropped: the console keeps the
			newest {formatNumber(CONSOLE_MAX_ROWS)} rows or {formatBytes(CONSOLE_MAX_BYTES)}. Sends
			and collection runs stay in History.
		</p>
	);
}

interface RowItemProps {
	row: ConsoleRow;
	expanded: boolean;
	onToggle: (id: number) => void;
}

function RowItem({ row, expanded, onToggle }: RowItemProps) {
	switch (row.kind) {
		case "line":
			return <LineRow row={row} />;
		case "step":
			return <StepRow row={row} isExpanded={expanded} onToggle={onToggle} />;
		case "send":
		case "scriptRequest":
			return <RequestRow row={row} isExpanded={expanded} onToggle={onToggle} />;
	}
}

interface ConsoleListProps {
	filter: ConsoleFilter;
	onClearFilter: () => void;
}

export function ConsoleList({ filter, onClearFilter }: ConsoleListProps) {
	const rows = useConsoleStore(selectConsoleRows);
	const evictedCount = useConsoleStore(selectConsoleEvictedCount);
	const listed = useMemo(() => filterConsoleRows(rows, filter), [rows, filter]);
	const { visible, sentinelRef, hasMore } = useGrowingWindow(
		listed.length,
		GROWING_WINDOW_STEP,
		filter
	);
	const scroller = useRef<HTMLDivElement>(null);
	const atEnd = useRef(true);
	const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

	useLayoutEffect(() => {
		const element = scroller.current;
		if (atEnd.current && element) element.scrollTop = element.scrollHeight;
	}, [listed]);

	const onScroll = () => {
		const element = scroller.current;
		if (!element) return;
		atEnd.current =
			element.scrollHeight - element.scrollTop - element.clientHeight <= END_TOLERANCE_PX;
	};

	const toggle = useCallback((id: number) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	}, []);

	if (rows.length === 0) {
		return (
			<EmptyState
				variant="inline"
				title="Nothing sent yet. Each Send and collection-run step in this window is listed here, with its scripts' requests and console lines."
			/>
		);
	}

	return (
		<div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
			<EvictedNotice count={evictedCount} />
			{hasMore && <div ref={sentinelRef} aria-hidden="true" />}
			{/* The ring holds rows, so an empty list is the filter's doing. */}
			{listed.length === 0 ? (
				<EmptyState
					variant="inline"
					title="No rows match these filters."
					action={
						<Button type="button" variant="link" onClick={onClearFilter}>
							Clear the filters
						</Button>
					}
				/>
			) : (
				<ul aria-label="Console rows" className="divide-y divide-rule">
					{listed.slice(-visible).map((row) => (
						<li key={row.id} className="skip-offscreen">
							<RowItem row={row} expanded={expanded.has(row.id)} onToggle={toggle} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
