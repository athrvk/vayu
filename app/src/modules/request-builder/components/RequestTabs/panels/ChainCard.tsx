/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Something up the collection chain applies to this request, and here is the chain": the shared
 * chrome of `AuthInheritBanner` and `InheritedElementsNotice` (the tinted box, the summary row with
 * its `Info` icon and bottom rule, the captioned body, hairline-separated rows with the last bare).
 *
 * Not a `Callout`: that primitive is one row (icon, text, optional action) with no body slot, and
 * its `info` severity is a neutral `border-border bg-panel`, not this accent tint. A captioned list
 * is a different shape, so it gets a component, not a `Callout` severity only one shape could use.
 *
 * The tints are `--primary`-derived: the user's accent, for the app pointing at something it
 * resolved for them, the register of the resolved-variable highlight. `--primary` is right as a
 * tint and text colour; `--primary-fill` is for solid buttons.
 */

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/ui/eyebrow";

export interface ChainCardProps {
	/** The sentence in the header - what is being inherited, and from where. */
	summary: ReactNode;
	/** Small caps above the list: "Resolution chain", "Runs before your own". */
	caption: string;
	/** One node per link. The card draws the separators. */
	children: ReactNode[];
}

export function ChainCard({ summary, caption, children }: ChainCardProps) {
	return (
		<div className="enter-fade rounded-md border border-primary/30 bg-primary-tint">
			<div className="flex items-start gap-2 px-3 py-2.5 border-b border-primary/20">
				{/*
				 * `size-icon` (16px), not `size-icon-sm`: `Callout.tsx`'s leading-icon size, which
				 * centers on a `text-xs leading-relaxed` line at `mt-px`; a 12px icon there sits
				 * visibly above center.
				 */}
				<Info className="size-icon text-primary shrink-0 mt-px" aria-hidden="true" />
				<div className="flex-1 min-w-0">{summary}</div>
			</div>

			<div className="px-3 py-2">
				<Eyebrow size="xs" className="mb-1.5">
					{caption}
				</Eyebrow>
				{children.map((row, i) => (
					<ChainRow key={i} last={i === children.length - 1}>
						{row}
					</ChainRow>
				))}
			</div>
		</div>
	);
}

/**
 * One link, separated from the next by a hairline; the last is bare, so the list does not seem to
 * continue. `border-primary/10`, not `border-rule`: the rule contract covers neutral surfaces, and
 * on an accent tint a neutral rule reads as another material. Tint on tint is deliberate.
 */
function ChainRow({ children, last }: { children: ReactNode; last: boolean }) {
	return (
		<div className={cn("flex items-center gap-2 py-1", !last && "border-b border-primary/10")}>
			{children}
		</div>
	);
}

export default ChainCard;
