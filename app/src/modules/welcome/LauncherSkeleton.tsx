/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LauncherSkeleton
 *
 * What the welcome screen shows while its two queries are in flight.
 *
 * It used to render `null`. That was a deliberate fix for a worse bug - both
 * queries start as `[]`, so rendering normally flashed the first-run empty
 * state ("get started, import a collection") at users who already had a
 * workspace. But trading a wrong screen for a blank one still leaves the app
 * looking broken for the length of the load.
 *
 * This mirrors the Launcher's own structure - section label, four action
 * tiles, a few recent-run rows, a count line - so the real content lands in
 * place instead of pushing a blank page around.
 */

import { Skeleton } from "@/components/ui";

export function LauncherSkeleton() {
	return (
		<div className="flex flex-col gap-8" role="status" aria-label="Loading">
			{/* Start - label + the 2x4 action tile grid */}
			<section aria-hidden="true">
				<Skeleton className="mb-2 h-3 w-10 rounded-md" />
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					{Array.from({ length: 4 }, (_, i) => (
						// Matches ActionTile: bordered card, icon over label.
						<div
							key={i}
							className="flex flex-col items-start gap-2 rounded-md border border-border bg-card p-3"
						>
							<Skeleton className="h-4 w-4 rounded-md" />
							<Skeleton className="h-3 w-16 rounded-md" />
						</div>
					))}
				</div>
			</section>

			{/* Recent runs - label + rows at the same 30px rhythm as the real list */}
			<section aria-hidden="true">
				<Skeleton className="mb-2 h-3 w-20 rounded-md" />
				<div className="flex flex-col">
					{Array.from({ length: 3 }, (_, i) => (
						<div key={i} className="flex items-center gap-3 px-2 py-1.5">
							<Skeleton className="h-4 w-10 shrink-0 rounded-md" />
							<Skeleton className="h-3 flex-1 rounded-md" />
						</div>
					))}
				</div>
			</section>

			<Skeleton className="h-3 w-40 rounded-md" aria-hidden="true" />
		</div>
	);
}
