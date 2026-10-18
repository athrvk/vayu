/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * EmptyState
 *
 * The one way to say "there is nothing here yet". Before this, ~20 call sites
 * each rolled their own and drifted apart: icons at 12 vs 16 units and
 * opacity-50 vs opacity-30, headings at `text-lg` (18px, outside the type
 * scale) vs 14px vs none at all, descriptions at `mt-1` vs `mt-2`, and copy
 * split between Title Case ("No Run Selected") and sentence case ("No
 * collections yet").
 *
 * Two variants, because there are genuinely two shapes:
 *
 * - `pane` - owns a whole region (a detail view with nothing selected, a list
 *   with no items). Centred on both axes and icon-led.
 * - `inline` - a small panel inside something else (a response tab, a card, a
 *   drawer group). One muted line and no icon; an icon here would out-weigh
 *   the panel. It does take an `action` (issue #1693): the drawer's group
 *   notes - "No inbox yet", "No environments" - are exactly the dead ends the
 *   sweep was about, and their create handler lives one row up in a tooltip
 *   icon button that is easy to miss. The action renders under the line as
 *   the same `variant="link"` button `pane` uses, not beside it, so the note
 *   stays one column wide inside a 50px-inset group.
 *
 * Copy is sentence case, per the rest of the UI and Apple's HIG. It lives at
 * the call site rather than being forced with `text-transform`, so a heading
 * can still carry a proper noun.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateBaseProps {
	/**
	 * Sentence case. A `pane` title is a heading, so no trailing period ("No
	 * run selected"); an `inline` title is the whole message and may be a
	 * sentence.
	 */
	title: string;
	/**
	 * A Button, usually `variant="link"`. A create path plus Import may be two
	 * Buttons in a `flex gap-2` wrapper. Both variants.
	 */
	action?: ReactNode;
	className?: string;
}

interface PaneEmptyStateProps extends EmptyStateBaseProps {
	variant?: "pane";
	/**
	 * What to do about it. One sentence, with a period. It renders inside a
	 * `<p>`, so a node here is phrasing content only (text, `Kbd`, `span`): a
	 * `div` would be invalid HTML. The response pane's "Press ⌘ ↵ or click
	 * Send" is the one caller that passes more than a string.
	 */
	description?: ReactNode;
	/** Decorative, so it is hidden from assistive tech. */
	icon?: LucideIcon;
	/**
	 * Extra classes on the icon itself - `animate-spin` for a loading state
	 * that reuses this pane rather than a bespoke spinner, e.g. a stored
	 * run's report still in flight.
	 */
	iconClassName?: string;
}

/**
 * The inline line is the title and nothing else, so the props it would drop
 * are refused by the compiler rather than discarded at runtime (#2129).
 */
interface InlineEmptyStateProps extends EmptyStateBaseProps {
	variant: "inline";
	description?: never;
	icon?: never;
	iconClassName?: never;
}

type EmptyStateProps = PaneEmptyStateProps | InlineEmptyStateProps;

export function EmptyState({
	title,
	description,
	icon: Icon,
	iconClassName,
	action,
	variant = "pane",
	className,
}: EmptyStateProps) {
	if (variant === "inline") {
		return (
			<div
				data-slot="empty-state"
				className={cn(
					"enter-fade p-8 text-center text-sm text-muted-foreground",
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
				// `flex-1` so it fills a flex column parent; `min-h-0` so it can
				// shrink inside one rather than forcing the parent to scroll.
				"enter-fade flex flex-1 min-h-0 flex-col items-center justify-center gap-3 p-8 text-center",
				className
			)}
		>
			{/* lucide hides icons by default; stated anyway so the intent survives
			    a swap of the icon set. */}
			{Icon && (
				<Icon
					className={cn("h-12 w-12 text-muted-foreground/40", iconClassName)}
					aria-hidden="true"
				/>
			)}
			<div className="max-w-sm">
				<p className="text-md font-semibold text-foreground">{title}</p>
				{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
			</div>
			{action}
		</div>
	);
}
