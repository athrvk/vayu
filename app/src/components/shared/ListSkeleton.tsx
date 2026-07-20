/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ListSkeleton
 *
 * Loading placeholder for the drawer's list views. The three of them previously
 * handled loading three different ways — skeleton rows, a centred spinner, and
 * nothing at all. The last case was the worst: with `= []` defaults, an
 * in-flight query renders as a populated-but-empty tree, so the user is told
 * "you have no environments" when the real answer is "not loaded yet".
 *
 * Skeletons over a spinner: they hold the shape of the content, so nothing
 * jumps when data lands, and there is no message to translate.
 */

import { Skeleton } from "@/components/ui";

interface ListSkeletonProps {
	/** Rows to draw. Keep near the number the list usually shows. */
	rows?: number;
	/** Leading square, for lists whose rows start with an icon or badge. */
	leading?: boolean;
	className?: string;
}

export function ListSkeleton({ rows = 3, leading = true, className }: ListSkeletonProps) {
	return (
		<div className={className} aria-hidden="true">
			<div className="space-y-2 py-2">
				{Array.from({ length: rows }, (_, i) => (
					<div key={i} className="flex items-center gap-2 px-2 py-1.5">
						{leading && <Skeleton className="h-4 w-4 rounded-md shrink-0" />}
						<Skeleton className="h-4 flex-1 rounded-md" />
					</div>
				))}
			</div>
		</div>
	);
}
