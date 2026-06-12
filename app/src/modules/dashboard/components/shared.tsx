/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { type ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TIMING } from "@/config/timing";

export const EYEBROW_CLASS =
	"text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground";

/** Tiny "i" affordance with a Radix tooltip. */
export function InfoChip({ tip }: { tip: ReactNode }) {
	return (
		<TooltipProvider delayDuration={TIMING.TOOLTIP_DELAY_MS}>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="ml-1.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-accent text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors cursor-help align-middle"
						aria-label="More information"
					>
						<Info className="h-2.5 w-2.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent className="max-w-[260px] text-[11.5px] leading-relaxed">
					{tip}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

export function Eyebrow({ children }: { children: ReactNode }) {
	return <p className={EYEBROW_CLASS}>{children}</p>;
}

/** Format a possibly-undefined number, falling back to an em-dash. */
export function fmt(v: number | undefined, digits = 1): string {
	return v !== undefined ? v.toFixed(digits) : "—";
}
