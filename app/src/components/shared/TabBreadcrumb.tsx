/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TabBreadcrumb - the one "where am I" line a detail tab can draw.
 *
 * It began as `RequestBreadcrumb` in the request builder and was the only
 * surface in the app that answered the question (#1691): a collection tab, a
 * run report and the live dashboard all opened with a bare title and no chain,
 * even though each of them is reached from somewhere and each of those
 * somewheres is openable. Generalising the component rather than copying it is
 * what keeps the three from drifting into three different crumb shapes.
 *
 * **Every crumb can be cut, none to nothing (#3495).** A deep chain has to
 * shrink somewhere: each ancestor truncates down to a 3ch floor, so its chevron
 * never lands on its first letter, and the current crumb is `min-w-0` and a
 * `TruncatedText`, so a long name ellipses with its full text on hover. jsdom
 * has no layout, so those classes are what the tests assert.
 *
 * **A crumb navigates only if the caller gives it somewhere to go.** The
 * current crumb is deliberately inert - you are already there, and a control
 * that does nothing is worse than text. Renaming is never here either; it
 * belongs to the one rename surface each entity already has.
 *
 * **It costs nothing when there is nothing to say.** No crumbs, or only blank
 * labels, renders no element at all rather than a reserved empty band - the
 * ~30px the request builder's description band charged every request before it
 * became the Info tab.
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
	 * Where this crumb goes. Omitted for a crumb that is already on screen, and
	 * for one with nothing to open (a view rather than an entity).
	 */
	onSelect?: () => void;
}

interface TabBreadcrumbProps {
	/**
	 * The `nav`'s accessible name - "Request location", "Collection location".
	 * Several tabs can be mounted at once (Radix keeps drafts alive), so a
	 * generic "Breadcrumb" would give a screen reader several identical landmarks.
	 */
	label: string;
	crumbs: BreadcrumbCrumb[];
	/**
	 * The current crumb is the pane's title: a heading at the outline's level
	 * (`heading-level.tsx`), the tab's `h1` where nothing above it names the
	 * pane - the request builder, the dashboard (#3498). Off where the pane
	 * already has a title the crumb only repeats.
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
	// A caller assembling crumbs from optional data (a collection that may have
	// no parent, a run with no name) hands over blanks rather than filtering
	// twice; the band is drawn on what is left.
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
				// The segments are direct children of this row, not wrapped in a span
				// each: a wrapper with `min-w-0` shrinks below its label's floor and
				// leaves the chevron stacked on the first letter. `min-w-0` here is
				// what lets `truncate` engage at all - a flex item defaults to
				// min-content width and simply overflows instead.
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
