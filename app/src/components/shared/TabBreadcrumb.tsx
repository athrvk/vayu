/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one "where am I" line a detail tab can draw (#1691), so the crumb shape cannot drift. **Every
 * crumb can be cut, none to nothing (#3495)**: each ancestor truncates to a 3ch floor, so its
 * chevron never lands on its first letter, and the current crumb is a `min-w-0` `TruncatedText`,
 * ellipsing with the full text on hover; jsdom has no layout, so tests assert those classes. **A
 * crumb navigates only if given somewhere to go**: the current one is inert (you are there, and a
 * do-nothing control is worse than text), and renaming belongs to each entity's one rename surface.
 * **No crumbs, or only blank labels, render no element**, not a reserved empty band.
 */

import { Fragment } from "react";
import { ChevronRight } from "lucide-react";

import { Heading } from "@/components/ui/heading";
import { cn } from "@/lib/utils";
import { TruncatedText } from "./TruncatedText";

/** An ancestor's label: never under 3ch, never past 16ch, so its chevron stays clear of it. */
const ANCESTOR_CLASS = "min-w-[3ch] max-w-[16ch]";

export interface BreadcrumbCrumb {
	/** Stable key - an entity id where there is one, else the label. */
	id: string;
	label: string;
	/**
	 * Where this crumb goes; omitted for a crumb already on screen and one with nothing to open (a
	 * view, not an entity).
	 */
	onSelect?: () => void;
}

interface TabBreadcrumbProps {
	/**
	 * The `nav`'s accessible name ("Request location", "Collection location"): several tabs can be
	 * mounted at once (Radix keeps drafts alive), so a generic "Breadcrumb" would give a screen
	 * reader identical landmarks.
	 */
	label: string;
	crumbs: BreadcrumbCrumb[];
	/**
	 * The current crumb is the pane's title: a heading at the outline's level
	 * (`heading-level.tsx`), the tab's `h1` where nothing above names the pane (the request
	 * builder, the dashboard; #3498). Off where the pane has a title the crumb would repeat.
	 */
	titlesPane?: boolean;
	className?: string;
}

export function TabBreadcrumb({
	label,
	crumbs,
	titlesPane = false,
	className,
}: TabBreadcrumbProps) {
	// Callers building crumbs from optional data (a collection with no parent, a run with no name)
	// pass blanks rather than filtering twice; the band draws what is left.
	const shown = crumbs.filter((crumb) => crumb.label.trim().length > 0);
	if (shown.length === 0) return null;

	const ancestors = shown.slice(0, -1);
	const current = shown[shown.length - 1];

	return (
		<nav
			aria-label={label}
			className={cn(
				"flex items-center gap-1 min-w-0 overflow-hidden px-3 pt-1.5 text-label text-muted-foreground bg-panel shrink-0",
				className
			)}
		>
			{ancestors.length > 0 && (
				// The segments are direct children, not each in a span: a `min-w-0` wrapper shrinks
				// below its label's floor and stacks the chevron on the first letter. `min-w-0`
				// here lets `truncate` engage, as a flex item otherwise defaults to min-content and
				// overflows.
				<div className="flex items-center gap-1 min-w-0">
					{ancestors.map((crumb) => (
						<Fragment key={crumb.id}>
							{crumb.onSelect ? (
								<button
									type="button"
									onClick={crumb.onSelect}
									className={cn(
										ANCESTOR_CLASS,
										"rounded-sm hover:text-foreground transition-colors"
									)}
								>
									<TruncatedText className="block">{crumb.label}</TruncatedText>
								</button>
							) : (
								<TruncatedText className={cn("block", ANCESTOR_CLASS)}>
									{crumb.label}
								</TruncatedText>
							)}
							<ChevronRight
								aria-hidden="true"
								className="size-icon-sm shrink-0 opacity-60"
							/>
						</Fragment>
					))}
				</div>
			)}
			{titlesPane ? (
				<Heading outside="span" className="min-w-0 text-muted-foreground">
					<TruncatedText>{current.label}</TruncatedText>
				</Heading>
			) : (
				<TruncatedText className="min-w-0 text-muted-foreground">
					{current.label}
				</TruncatedText>
			)}
		</nav>
	);
}
