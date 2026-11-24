/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one way to say "there is nothing here yet" (about twenty hand-rolled copies had drifted in
 * icon size, heading size and case). Two variants, as there are two shapes:
 *
 * - `pane` - owns a region (a detail view with nothing selected, an empty list), centred and
 *   icon-led.
 * - `inline` - a small panel inside something (a response tab, a card, a drawer group): one muted
 *   line, no icon, which would outweigh the panel. It takes an `action` (#1693): the drawer's group
 *   notes ("No inbox yet", "No environments") are dead ends whose create handler sits one row up in
 *   an easy-to-miss icon button. The action renders under the line as `pane`'s `variant="link"`
 *   button, so the note stays one column in a 50px-inset group.
 *
 * Copy is sentence case, as the rest of the UI and Apple's HIG, written at the call site rather
 * than forced by `text-transform`, so a heading can carry a proper noun.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Heading } from "@/components/ui/heading";
import { cn } from "@/lib/utils";

interface EmptyStateBaseProps {
	/**
	 * Sentence case. A `pane` title is a heading, so no trailing period ("No run selected"); an
	 * `inline` title is the whole message and may be a sentence. A node is phrasing content only
	 * (text, `code`, `span`): `pane` renders it in a heading at the outline's level, or a `<p>`
	 * outside the main pane (`heading-level.tsx`, #3498).
	 */
	title: ReactNode;
	/**
	 * A Button, usually `variant="link"`; a create path plus Import may be two in a `flex gap-2`
	 * wrapper. Both variants.
	 */
	action?: ReactNode;
	className?: string;
}

interface PaneEmptyStateProps extends EmptyStateBaseProps {
	variant?: "pane";
	/**
	 * What to do about it, one sentence with a period, inside a `<p>`, so phrasing content only
	 * (text, `Kbd`, `span`; a `div` is invalid). The response pane's "Press ⌘ ↵ or click Send" is
	 * the one caller passing more than a string.
	 */
	description?: ReactNode;
	/** Decorative, so it is hidden from assistive tech. */
	icon?: LucideIcon;
	/**
	 * Extra icon classes: `animate-spin` for a loading state reusing this pane rather than a
	 * bespoke spinner (a stored run's report in flight).
	 */
	iconClassName?: string;
	compact?: never;
}

/**
 * The inline line is the title alone, so the props it would drop are refused by the compiler rather
 * than discarded at runtime (#2129).
 */
interface InlineEmptyStateProps extends EmptyStateBaseProps {
	variant: "inline";
	description?: never;
	icon?: never;
	iconClassName?: never;
	/**
	 * For a line in a dense surface (a drawer tree, a dialog's list box, a settings card), where
	 * `p-8 text-sm` outsizes its host: `p-3 text-xs`, as the bare lines it replaced used.
	 */
	compact?: boolean;
}

type EmptyStateProps = PaneEmptyStateProps | InlineEmptyStateProps;

export function EmptyState({
	title,
	description,
	icon: Icon,
	iconClassName,
	action,
	variant = "pane",
	compact,
	className,
}: EmptyStateProps) {
	if (variant === "inline") {
		return (
			<div
				data-slot="empty-state"
				className={cn(
					"enter-fade text-center text-muted-foreground",
					compact ? "p-3 text-xs" : "p-8 text-sm",
					className
				)}
			>
				{title}
				{action && <div className="mt-1">{action}</div>}
			</div>
		);
	}

	return (
		<div
			data-slot="empty-state"
			className={cn(
				// `flex-1` fills a flex column parent; `min-h-0` lets it shrink there rather than
				// scroll the parent.
				"enter-fade flex flex-1 min-h-0 flex-col items-center justify-center gap-3 p-8 text-center",
				className
			)}
		>
			{/*
			 * lucide hides icons by default; stated anyway so the intent survives an icon-set swap.
			 */}
			{Icon && (
				<Icon
					className={cn("h-12 w-12 text-muted-foreground/40", iconClassName)}
					aria-hidden="true"
				/>
			)}
			<div className="max-w-sm">
				<Heading outside="p" className="text-md font-semibold text-foreground">
					{title}
				</Heading>
				{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
			</div>
			{action}
		</div>
	);
}
