/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The loading placeholder for the drawer's list views: with `= []` defaults an in-flight query
 * renders as an empty list, telling the user "you have no environments" before anything loaded. A
 * skeleton, not a spinner: it holds the content's shape, so nothing jumps, and has no message to
 * translate.
 */

import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";

interface ListSkeletonProps {
	/** Rows to draw. Keep near the number the list usually shows. */
	rows?: number;
	/** Leading square, for lists whose rows start with an icon. */
	leading?: boolean;
	/** Short second block, for rows carrying a method badge before the name. */
	badge?: boolean;
	className?: string;
}

export function ListSkeleton({
	rows = 3,
	leading = true,
	badge = false,
	className,
}: ListSkeletonProps) {
	return (
		// aria-hidden bars, role=status on the wrapper: the bars say nothing, their presence does,
		// so a screen reader hears "Loading" once rather than a fake list.
		<div className={cn("enter-fade", className)} role="status" aria-label="Loading">
			<div className="space-y-2 py-2" aria-hidden="true">
				{Array.from({ length: rows }, (_, i) => (
					<div key={i} className="flex items-center gap-2 px-2 py-1.5">
						{leading && <Skeleton className="size-icon rounded-md shrink-0" />}
						{badge && <Skeleton className="h-4 w-5 rounded-md shrink-0" />}
						<Skeleton className="h-4 flex-1 rounded-md" />
					</div>
				))}
			</div>
		</div>
	);
}
