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
 *   with no items). Centred on both axes, icon-led, and the only variant that
 *   takes an action.
 * - `inline` - a small panel inside something else (a response tab, a card).
 *   One muted line, no icon, no action; an icon here would out-weigh the panel.
 *
 * Copy is sentence case, per the rest of the UI and Apple's HIG. It lives at
 * the call site rather than being forced with `text-transform`, so a heading
 * can still carry a proper noun.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
	/**
	 * Sentence case, no trailing period - it is a heading, not a sentence.
	 * "No run selected", not "No Run Selected." Ignored by `inline`, which
	 * renders it as its single line.
	 */
	title: string;
	/** What to do about it. One sentence, with a period. `pane` only. */
	description?: string;
	/** `pane` only. Decorative, so it is hidden from assistive tech. */
	icon?: LucideIcon;
	/** A Button, usually `variant="link"`. `pane` only. */
	action?: ReactNode;
	variant?: "pane" | "inline";
	className?: string;
}

export function EmptyState({
	title,
	description,
	icon: Icon,
	action,
	variant = "pane",
	className,
}: EmptyStateProps) {
	if (variant === "inline") {
		return (
			<div className={cn("p-8 text-center text-sm text-muted-foreground", className)}>
				{title}
			</div>
		);
	}

	return (
		<div
			className={cn(
				// `flex-1` so it fills a flex column parent; `min-h-0` so it can
				// shrink inside one rather than forcing the parent to scroll.
				"flex flex-1 min-h-0 flex-col items-center justify-center gap-3 p-8 text-center",
				className
			)}
		>
			{/* lucide hides icons by default; stated anyway so the intent survives
			    a swap of the icon set. */}
			{Icon && <Icon className="h-12 w-12 text-muted-foreground/40" aria-hidden="true" />}
			<div className="max-w-sm">
				<p className="text-md font-semibold text-foreground">{title}</p>
				{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
			</div>
			{action}
		</div>
	);
}
