/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The loading placeholder for a detail pane (the variables editor, the collection detail), the
 * shape of a heading, a subtitle and rows; `ListSkeleton` is the drawer lists' twin. A skeleton,
 * not a spinner: it holds the content's shape, so nothing jumps when data lands, and has no message
 * to translate. **Loading and not-found must be different renders**: every query defaults to `[]`,
 * so a restored entity is `undefined` while its query is in flight, and the not-found state then
 * tells the user their collection is gone when it is not loaded yet.
 */

import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";

interface DetailSkeletonProps {
	/**
	 * Names the pane for assistive tech ("Loading collection", not "Loading"): the bars say
	 * nothing, which pane is loading does.
	 */
	label: string;
	/** Rows below the heading. Keep near what the pane usually shows. */
	rows?: number;
	className?: string;
}

export function DetailSkeleton({ label, rows = 4, className }: DetailSkeletonProps) {
	return (
		// role=status on the wrapper, aria-hidden on the bars: a screen reader gets the label once,
		// not a fake heading and four fake rows.
		<div className={cn("enter-fade flex-1 p-6", className)} role="status" aria-label={label}>
			<div className="space-y-3" aria-hidden="true">
				{/*
				 * `w-[12rem]` / `w-2xs`, not `w-48` / `w-72`: the bars preview a heading and
				 * subtitle, text measures, and `w-48`/`w-72` ride `--spacing`, narrower at Default
				 * than the text. `w-[12rem]` is literal as no named step sits below `3xs` (16rem);
				 * `w-2xs` (18rem) is nearest the subtitle's intended 288px.
				 */}
				<Skeleton className="h-6 w-[12rem] rounded-md" />
				<Skeleton className="h-4 w-2xs rounded-md" />
				<div className="space-y-2 pt-4">
					{Array.from({ length: rows }, (_, i) => (
						<Skeleton key={i} className="h-9 w-full rounded-md" />
					))}
				</div>
			</div>
		</div>
	);
}
