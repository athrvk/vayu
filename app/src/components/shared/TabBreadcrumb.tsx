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
 * **The last crumb is where you are, and it never gives way.** A deep chain has
 * to shrink somewhere, and the part you are looking for is the end of it: the
 * ancestors get `min-w-0` and truncate, the current crumb is `shrink-0` and
 * does not. jsdom has no layout, so those classes are what the tests assert.
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

import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { TruncatedText } from "./TruncatedText";

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
	className?: string;
}

export function TabBreadcrumb({ label, crumbs, className }: TabBreadcrumbProps) {
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
				"flex items-center gap-1 min-w-0 overflow-hidden px-3 pt-1.5 text-[11px] text-subtle-foreground bg-panel shrink-0",
				className
			)}
		>
			{ancestors.length > 0 && (
				// The shrinking half. `min-w-0` on both this row and each segment is
				// what lets `truncate` engage at all - a flex item defaults to
				// min-content width and simply overflows instead.
				<div className="flex items-center gap-1 min-w-0">
					{ancestors.map((crumb) => (
						<span key={crumb.id} className="flex items-center gap-1 min-w-0">
							{crumb.onSelect ? (
								<button
									type="button"
									onClick={crumb.onSelect}
									className="min-w-0 max-w-[16ch] rounded-sm hover:text-foreground transition-colors"
								>
									<TruncatedText className="block">{crumb.label}</TruncatedText>
								</button>
							) : (
								<TruncatedText className="block min-w-0 max-w-[16ch]">
									{crumb.label}
								</TruncatedText>
							)}
							<ChevronRight
								aria-hidden="true"
								className="size-3 shrink-0 opacity-60"
							/>
						</span>
					))}
				</div>
			)}
			<span className="shrink-0 text-muted-foreground">{current.label}</span>
		</nav>
	);
}
