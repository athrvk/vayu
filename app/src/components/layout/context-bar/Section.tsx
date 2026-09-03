/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The collapsible frame every context-bar section is drawn in.
 *
 * The body is rendered only while the section is expanded, which is the whole
 * mechanism behind "a collapsed section costs nothing": its hooks never run, so
 * its queries are never registered. Relying on `CollapsibleContent` alone to
 * unmount would tie that guarantee to a Radix implementation detail, and this is
 * a guarantee the bar makes to the user - the bar is open on every request tab,
 * and a user who collapsed the Code section did so to stop it composing.
 *
 * A section's `useRelevance` hook (see `types.ts`) is the one thing that does
 * run while it is collapsed, so the guarantee is now precisely "no *section*
 * mounts, and no query beyond the one its relevance already needs". Code, the
 * one section whose query is a server round trip nobody asked for, declares no
 * relevance hook at all and so still costs exactly nothing while collapsed.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";
import { EYEBROW_CLASS } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface ContextBarSectionFrameProps {
	title: string;
	expanded: boolean;
	onToggle: () => void;
	children: ReactNode;
}

/**
 * The width of the chevron's column, shared with the empty header's blank stand-in
 * for it below - the one thing that keeps every section title on the same left
 * edge whether or not its section can be opened. Two hardcoded `w-3`s would line
 * up until one of them changed.
 */
const CHEVRON_COLUMN = "w-3";

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
					"flex items-center gap-1 w-full text-left hover:text-foreground transition-colors"
				)}
			>
				{expanded ? (
					<ChevronDown className={cn(CHEVRON_COLUMN, "h-3 shrink-0")} />
				) : (
					<ChevronRight className={cn(CHEVRON_COLUMN, "h-3 shrink-0")} />
				)}
				{title}
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2">{expanded && children}</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * What a section with nothing to say is reduced to: its title, a word for why,
 * and no way in.
 *
 * There is no chevron because there is nothing to expand, and no button because
 * there is nothing to press - a trigger that toggles an empty body is a control
 * that lies about having something behind it. "Quiet" here is the loss of the
 * chevron, the hover-to-foreground affordance and the body, not a fainter
 * colour: `EYEBROW_CLASS` is already `--muted-foreground`, and stacking an
 * opacity on it would take the title under the contrast floor
 * `docs/design-system.md` holds for small text.
 *
 * The empty box where the chevron would be keeps these titles on the same left
 * edge as the sections above and below them; without it a quiet section reads
 * as an outdented heading over its neighbour.
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

/** The one-line "nothing here" body, so every section says it the same way. */
export function SectionEmpty({ children }: { children: ReactNode }) {
	return <p className="text-xs text-muted-foreground m-0">{children}</p>;
}

/** The one-line loading body. Same reason. */
export function SectionLoading() {
	return <p className="text-xs text-muted-foreground m-0">Loading…</p>;
}
