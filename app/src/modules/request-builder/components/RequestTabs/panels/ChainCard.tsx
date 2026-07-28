/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Something up the collection chain applies to this request, and here is the
 * chain." Two panels say that, about two different things.
 *
 * `AuthInheritBanner` and `InheritedScriptsNotice` had the chrome written out
 * twice, identically: the tinted box, the summary row with its `Info` icon and
 * bottom rule, the captioned body, and rows separated by a hairline with the
 * last one bare. Nine class strings each, matching character for character.
 *
 * Not a `Callout`. That primitive is one row - icon, text, optional action -
 * and deliberately so; it has no body slot, and its `info` severity is a
 * neutral `border-border bg-panel` rather than this accent tint. A card with a
 * captioned list underneath is a different thing, so it gets its own component
 * rather than a fourth `Callout` severity that only one shape can use.
 *
 * The tints stay `--primary`-derived. That is the accent the user chose, and
 * these cards are the app pointing at something it resolved on their behalf -
 * the same register as the resolved-variable highlight. `--primary` is correct
 * as a tint and a text colour here; `--primary-fill` is for solid buttons.
 */

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

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
		<div className="rounded-md border border-primary/30 bg-primary/10">
			<div className="flex items-start gap-2 px-3 py-2.5 border-b border-primary/20">
				<Info className="w-3.5 h-3.5 text-primary shrink-0 mt-px" aria-hidden="true" />
				<div className="flex-1 min-w-0">{summary}</div>
			</div>

			<div className="px-3 py-2">
				<div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground mb-1.5">
					{caption}
				</div>
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
 * One link. Separated from the next by a hairline; the last one bare, so the
 * list does not appear to continue past its end.
 *
 * `border-primary/10` rather than `border-rule`: the rule contract covers the
 * neutral surfaces, and this row sits on an accent tint where a neutral rule
 * would read as a different material. Tint on tint is the deliberate choice.
 */
function ChainRow({ children, last }: { children: ReactNode; last: boolean }) {
	return (
		<div className={cn("flex items-center gap-2 py-1", !last && "border-b border-primary/10")}>
			{children}
		</div>
	);
}

export default ChainCard;
