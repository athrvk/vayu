/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The tiny "i" with a Radix tooltip, beside a label needing a sentence of explanation (timing
 * phases, chart axes, the wire/queue/total summary). One primitive, as the dashboard's and the
 * request builder's copies had drifted: only one got the `border-rule` fix. The dot is 12px and the
 * hit box 24px: the `after:` square states the target floor (`size-target`, 28px at Comfortable)
 * without moving the row, as `TabItem`'s close button does behind a 12px glyph. The border stays
 * the caller's, a real choice: `border-rule` inherits from the declared surface and falls back to
 * the invisible default under none, so it is right in a `surface-card` pane and wrong elsewhere.
 * The default is `border-border`; pass `className="border-rule"` on a declared surface. No
 * `TooltipProvider` of its own: the delay is set once at the root (`main.tsx`), and a five-phase
 * timing tab would otherwise mount five.
 */

import { type ReactNode } from "react";
import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { cn } from "@/lib/utils";

export interface InfoChipProps {
	tip: ReactNode;
	/** Merged over the defaults - `border-rule` on a declared surface, spacing. */
	className?: string;
}

export function InfoChip({ tip, className }: InfoChipProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					className={cn(
						"relative ml-1.5 inline-flex size-icon-sm items-center justify-center rounded-full border border-border bg-accent text-muted-foreground hover:border-primary/40 hover:bg-primary-tint hover:text-primary transition-colors cursor-help align-middle after:absolute after:left-1/2 after:top-1/2 after:size-target after:-translate-x-1/2 after:-translate-y-1/2",
						className
					)}
					aria-label="More information"
				>
					<Info className="h-2.5 w-2.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-[260px] text-label leading-relaxed">
				{tip}
			</TooltipContent>
		</Tooltip>
	);
}
