/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ErrorState — the load failed, which is not the same as there being nothing.
 *
 * The third answer a data view can give, after `DetailSkeleton` (not yet) and
 * `EmptyState` (nothing to show). Every query in the app is destructured as
 * `{ data = [] }` and nothing sets `throwOnError`, so a query that settles as
 * an error resolves to `[]` and falls straight through to the empty state.
 * The collections tree then said "No collections yet" and offered "Add your
 * first collection" to a user whose collections exist and simply could not be
 * fetched — an invitation to create a duplicate.
 *
 * Deliberately not a variant of `EmptyState`. Folding them together would blur
 * exactly the distinction this exists to draw.
 *
 * The icon is not a prop. An empty state is about a particular kind of thing,
 * so it picks an icon to match; a failure is a failure, and giving every site
 * its own symbol for it would only make the same event look like different
 * events.
 *
 * **`onRetry` is close to required.** An error state with no way out leaves
 * the user with a dead pane and no idea whether waiting helps. Pass a query's
 * `refetch`. It is optional only for the few places that have nothing to
 * retry.
 */

import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
	/**
	 * What failed, in sentence case with no trailing period — "Couldn't load
	 * collections". Name the thing; "Something went wrong" tells nobody
	 * anything.
	 */
	title: string;
	/**
	 * The reason, when there is one worth showing. Vayu is a developer tool and
	 * "Failed to fetch" versus a 500 genuinely changes what the user does next,
	 * so the raw message earns its place here.
	 */
	detail?: string;
	/** A query's `refetch`. Renders the "Try again" button. */
	onRetry?: () => void;
	variant?: "pane" | "inline";
	className?: string;
}

export function ErrorState({
	title,
	detail,
	onRetry,
	variant = "pane",
	className,
}: ErrorStateProps) {
	if (variant === "inline") {
		return (
			<div className={cn("flex items-center justify-center gap-2 p-8 text-sm", className)}>
				<span className="text-destructive-text">{title}</span>
				{onRetry && (
					<Button variant="link" size="sm" onClick={onRetry} className="h-auto p-0">
						Try again
					</Button>
				)}
			</div>
		);
	}

	return (
		<div
			className={cn(
				"flex flex-1 min-h-0 flex-col items-center justify-center gap-3 p-8 text-center",
				className
			)}
		>
			<AlertCircle className="h-12 w-12 text-destructive-text/60" aria-hidden="true" />
			<div className="max-w-sm">
				<p className="text-[15px] font-semibold text-foreground">{title}</p>
				{detail && (
					// Mono, because it is a machine's words, not the product's.
					<p className="mt-1 break-words font-mono text-xs text-muted-foreground">
						{detail}
					</p>
				)}
			</div>
			{onRetry && (
				<Button variant="outline" size="sm" onClick={onRetry}>
					Try again
				</Button>
			)}
		</div>
	);
}
