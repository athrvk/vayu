/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The load failed, which is not there being nothing: the third answer a data view gives, after
 * `DetailSkeleton` (not yet) and `EmptyState` (nothing). Every query is destructured
 * `{ data = [] }` without `throwOnError`, so an error settles as `[]` and falls through to the
 * empty state: the collections tree said "No collections yet" and offered "Add your first
 * collection" to a user whose collections exist, inviting a duplicate. Not a variant of
 * `EmptyState`, which would blur that distinction. The icon is not a prop: a failure is a failure,
 * and a symbol per site would make one event look like several. **`onRetry` is close to required**:
 * an error with no way out is a dead pane. Pass a query's `refetch`; optional only where there is
 * nothing to retry.
 */

import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Button, Heading } from "@/components/ui";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
	/**
	 * What failed, sentence case, no trailing period ("Couldn't load collections"): name the thing,
	 * as "Something went wrong" tells nobody anything.
	 */
	title: string;
	/**
	 * The reason, when worth showing: in a developer tool "Failed to fetch" versus a 500 changes
	 * what the user does next, so the raw message earns its place.
	 */
	detail?: string;
	/** A query's `refetch`. Renders the "Try again" button. */
	onRetry?: () => void;
	/**
	 * A second way out beside "Try again" ("Close tab" for a pane whose entity is gone): retrying a
	 * deleted thing is pointless, and a doomed retry alone is a dead end.
	 */
	action?: ReactNode;
	variant?: "pane" | "inline";
	className?: string;
}

export function ErrorState({
	title,
	detail,
	onRetry,
	action,
	variant = "pane",
	className,
}: ErrorStateProps) {
	if (variant === "inline") {
		return (
			<div
				className={cn(
					"enter-fade flex items-center justify-center gap-2 p-8 text-sm",
					className
				)}
			>
				<span className="text-destructive-text">{title}</span>
				{onRetry && (
					<Button variant="link" size="sm" onClick={onRetry} className="h-auto p-0">
						Try again
					</Button>
				)}
				{action}
			</div>
		);
	}

	return (
		<div
			className={cn(
				"enter-fade flex flex-1 min-h-0 flex-col items-center justify-center gap-3 p-8 text-center",
				className
			)}
		>
			<AlertCircle className="h-12 w-12 text-destructive-text/60" aria-hidden="true" />
			<div className="max-w-sm">
				{/*
				 * A heading in the main pane's outline, as `EmptyState`'s (#3498); the inline line
				 * is a status, not a title.
				 */}
				<Heading outside="p" className="text-md font-semibold text-foreground">
					{title}
				</Heading>
				{detail && (
					// Mono, because it is a machine's words, not the product's.
					<p className="mt-1 break-words font-mono text-xs text-muted-foreground">
						{detail}
					</p>
				)}
			</div>
			{(onRetry || action) && (
				<div className="flex items-center gap-2">
					{onRetry && (
						<Button variant="outline" size="sm" onClick={onRetry}>
							Try again
						</Button>
					)}
					{action}
				</div>
			)}
		</div>
	);
}
