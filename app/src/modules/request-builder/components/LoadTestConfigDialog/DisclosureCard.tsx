/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";
import { Card, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";

interface DisclosureCardProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	/** What the card holds, readable while it is closed (a count, a lone value). */
	summary?: ReactNode;
	children: ReactNode;
}

/**
 * Header and contents are one card: contents on the dialog background would read as loose fields,
 * not as the section that revealed them. It is the design system's `Card`
 * (docs/design-system/component-patterns.md "Cards"), rendered by the `Collapsible` root
 * (`asChild`) so the open state lands on the card's element. `overflow-hidden` keeps the trigger's
 * hover fill inside the rounded corners, so `panel-clip` is required: it tucks focus rings inward
 * where the clip cannot eat them.
 */
export function DisclosureCard({
	open,
	onOpenChange,
	title,
	summary,
	children,
}: DisclosureCardProps) {
	return (
		<Collapsible open={open} onOpenChange={onOpenChange} asChild>
			<Card className="panel-clip overflow-hidden">
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
				 * `border-rule`: a divider *inside* the card, so the surface sets its colour.
				 * `--border` is tuned for the canvas and equals `--card` in dark (1.003), so the
				 * divider vanished; the Card's `surface-card` resolves it to 1.278 dark / 1.304
				 * light. The card's outline stays `border-border`: that edge faces the dialog
				 * background, where the canvas token is right.
				 */}
				<CollapsibleContent className="space-y-4 border-t border-rule px-3 py-3">
					{children}
				</CollapsibleContent>
			</Card>
		</Collapsible>
	);
}
