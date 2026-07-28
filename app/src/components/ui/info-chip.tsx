/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The tiny "i" affordance with a Radix tooltip, used beside a label that needs
 * a sentence of explanation - timing phases, chart axes, the wire/queue/total
 * summary.
 *
 * It existed twice: `modules/dashboard/components/shared.tsx` (reachable only
 * by the dashboard, since a module importing from another module is the wrong
 * direction) and a hand-rolled `InfoTip` inside the request-builder's
 * `ResponseTimingTab`. The copy is what this file is here to end - a
 * hand-rolled copy of a primitive does not receive the primitive's fixes, and
 * this one proves it: the builder's copy carries a `border-rule` fix, with a
 * comment explaining that on a card `--border` is the same colour as `--card`
 * in dark so the dot had no outline, and the dashboard's copy never got it.
 *
 * The border stays a caller decision rather than being unified, because it is
 * genuinely one: `border-rule` inherits from the declared surface and falls
 * back to the invisible default under none, so it is right inside a
 * `surface-card` pane and wrong on a surface that declares nothing. The default
 * is `border-border`; pass `className="border-rule"` on a declared surface.
 *
 * No `TooltipProvider` of its own - the delay is set once at the app root
 * (`main.tsx`), and one here would only re-declare what it inherits. It matters
 * more than it sounds: a five-phase timing tab would otherwise mount five.
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
						"ml-1.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-accent text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors cursor-help align-middle",
						className
					)}
					aria-label="More information"
				>
					<Info className="h-2.5 w-2.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-[260px] text-[11px] leading-relaxed">
				{tip}
			</TooltipContent>
		</Tooltip>
	);
}
