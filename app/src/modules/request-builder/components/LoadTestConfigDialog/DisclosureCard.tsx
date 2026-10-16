/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";

interface DisclosureCardProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	/** What the card holds, readable while it is closed (a count, a lone value). */
	summary?: ReactNode;
	children: ReactNode;
}

/**
 * Header and contents are one card, not a bordered header with loose fields
 * under it: a disclosure whose contents sit on the dialog background reads as
 * loose fields rather than as the section that revealed them. The card is the
 * design system's panel pattern (`bg-card` + `border-border` + `rounded-md`,
 * docs/design-system.md "Cards"). `panel-clip` is required by the
 * `overflow-hidden` that keeps the trigger's hover fill inside the rounded
 * corners - it tucks focus rings inward so the clip cannot eat them.
 */
export function DisclosureCard({
	open,
	onOpenChange,
	title,
	summary,
	children,
}: DisclosureCardProps) {
	return (
		<Collapsible
			open={open}
			onOpenChange={onOpenChange}
			className="panel-clip overflow-hidden rounded-md border border-border surface-card"
		>
			<CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="shrink-0">{title}</span>
					{summary && (
						<span className="truncate text-label font-normal text-muted-foreground">
							{summary}
						</span>
					)}
				</span>
				<span className="ml-3 shrink-0 text-label font-normal text-muted-foreground">
					{open ? "Hide" : "Show"}
				</span>
			</CollapsibleTrigger>
			{/*
			    `border-rule`: a divider *inside* the card, so the surface decides
			    its colour rather than this line doing so. `--border` is tuned for
			    the canvas and is the same colour as `--card` in dark (1.003), which
			    is why the divider was not there at all; `surface-card` above
			    resolves it to 1.278 dark / 1.304 light.

			    The card's own outline stays `border-border` - that edge faces the
			    dialog background, where the canvas token is correct.
			 */}
			<CollapsibleContent className="space-y-4 border-t border-rule px-3 py-3">
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
}
