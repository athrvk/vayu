/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DetailSkeleton
 *
 * Loading placeholder for a detail pane — the variables editor, the collection
 * detail screen. `ListSkeleton` is the same idea for the drawer's list views;
 * this one holds the shape of a heading, a subtitle and a stack of rows.
 *
 * A skeleton rather than a spinner for the same reason as there: it holds the
 * shape of the content, so nothing jumps when the data lands, and there is no
 * message to translate. A spinner tells you the app is busy; a skeleton tells
 * you what is about to appear.
 *
 * **Loading and not-found have to be different renders.** Every query here
 * defaults to `[]`, so an entity restored from a previous session resolves to
 * `undefined` while its query is still in flight. Rendering the not-found state
 * then does not merely look wrong — it tells the user their collection is gone
 * when the truthful answer is "not loaded yet". Both call sites reached this
 * component by shipping that bug first.
 */

import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";

interface DetailSkeletonProps {
	/**
	 * Names the pane for assistive tech — "Loading collection", not "Loading".
	 * The bars carry no information, but which pane is loading does.
	 */
	label: string;
	/** Rows below the heading. Keep near what the pane usually shows. */
	rows?: number;
	className?: string;
}

export function DetailSkeleton({ label, rows = 4, className }: DetailSkeletonProps) {
	return (
		// role=status on the wrapper, aria-hidden on the bars: a screen reader
		// gets the label once instead of reading a fake heading and four fake rows.
		<div className={cn("flex-1 p-6", className)} role="status" aria-label={label}>
			<div className="space-y-3" aria-hidden="true">
				<Skeleton className="h-6 w-48 rounded-md" />
				<Skeleton className="h-4 w-72 rounded-md" />
				<div className="space-y-2 pt-4">
					{Array.from({ length: rows }, (_, i) => (
						<Skeleton key={i} className="h-9 w-full rounded-md" />
					))}
				</div>
			</div>
		</div>
	);
}
