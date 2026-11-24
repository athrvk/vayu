/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The collapsible frame every context-bar section is drawn in.
 *
 * "A collapsed section costs nothing" rests on `CollapsibleContent` unmounting closed children
 * (Radix's `CollapsibleContentImpl` renders `isOpen && children`), not on a guard here: a manual
 * `{expanded && children}` would unmount at once and skip the ~200ms close animation. So a
 * collapsed section's body stays mounted, hooks and all, for that animation before Radix drops it.
 *
 * A section's `useRelevance` hook (see `types.ts`) is the one thing that runs while it is
 * collapsed, so the guarantee is "no *section* mounts, and no query beyond the one its relevance
 * already needs". Code, the one section whose query is a server round trip nobody asked for,
 * declares no relevance hook and so costs nothing while collapsed.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, ICON_MOTION } from "@/components/ui";
import { EYEBROW_CLASS } from "@/components/ui";
import { EmptyState } from "@/components/shared/EmptyState";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface ContextBarSectionFrameProps {
	title: string;
	expanded: boolean;
	onToggle: () => void;
	children: ReactNode;
}

/**
 * The chevron column's width, shared with the empty header's blank stand-in for it below, which
 * keeps every section title on one left edge whether or not its section can open. Two separately
 * typed widths would line up until one of them changed.
 */
const CHEVRON_COLUMN = "w-icon-sm";

export function ContextBarSectionFrame({
	title,
	expanded,
	onToggle,
	children,
}: ContextBarSectionFrameProps) {
	return (
		<Collapsible open={expanded} onOpenChange={onToggle} className="py-2">
			<CollapsibleTrigger
				className={cn(
					EYEBROW_CLASS,
					// `group`: a CollapsibleTrigger is not a `[data-slot="button"]`, and the
					// chevron inside it is what answers this control's hover.
					"group flex items-center gap-1 w-full text-left hover:text-foreground transition-colors"
				)}
			>
				{expanded ? (
					<ChevronDown
						className={cn(CHEVRON_COLUMN, "h-icon-sm shrink-0")}
						data-icon-motion={ICON_MOTION.nudgeY}
					/>
				) : (
					<ChevronRight
						className={cn(CHEVRON_COLUMN, "h-icon-sm shrink-0")}
						data-icon-motion={ICON_MOTION.nudgeX}
					/>
				)}
				{title}
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2">{children}</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * What a section with nothing to say is reduced to: its title, a word for why, and no way in. No
 * chevron, as there is nothing to expand, and no button, as there is nothing to press: a trigger
 * toggling an empty body lies about having something behind it. "Quiet" is the loss of the chevron,
 * the hover-to-foreground affordance and the body, not a fainter colour: `EYEBROW_CLASS` is already
 * `--muted-foreground`, and an opacity on it would take the title under the contrast floor
 * `docs/design-system/surfaces.md` holds for small text.
 *
 * The empty box where the chevron would be keeps these titles on the left edge of the sections
 * around them; without it a quiet section reads as an outdented heading over its neighbour.
 */
export function ContextBarSectionEmptyHeader({ title, note }: { title: string; note: string }) {
	return (
		<div className={cn(EYEBROW_CLASS, "flex items-center gap-1 py-2")}>
			<span className={cn(CHEVRON_COLUMN, "shrink-0")} aria-hidden />
			{title}
			{/* The eyebrow's uppercase and tracking are the title's, not the
			    note's: "NONE" set in the same caps reads as a second heading. */}
			<span className="font-normal normal-case tracking-normal">{note}</span>
		</div>
	);
}

/**
 * The one-line "nothing here" body, so every section says it the same way: the
 * app's `EmptyState`, inline and compact for the bar's width (#3501). It is for
 * an empty body only; a status that is not emptiness (a failed compose) is its
 * own line.
 */
export function SectionEmpty({ children }: { children: ReactNode }) {
	return <EmptyState variant="inline" compact title={children} />;
}

/** The one-line loading body. Same reason. */
export function SectionLoading() {
	return <p className="text-xs text-muted-foreground m-0">Loading…</p>;
}
