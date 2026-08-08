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
					<ChevronDown className="w-3 h-3 shrink-0" />
				) : (
					<ChevronRight className="w-3 h-3 shrink-0" />
				)}
				{title}
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2">{expanded && children}</CollapsibleContent>
		</Collapsible>
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
