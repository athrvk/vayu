/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A plain-text suggestion dropdown, built on the same `Command` primitive as
 * `VariableAutocomplete`.
 *
 * **This replaces a hand-rolled copy.** `VariableInput` carried its own
 * dropdown for header-name suggestions: a `selectedSuggestionIndex`, ArrowUp /
 * ArrowDown / Enter / Tab / Escape branches in `handleKeyDown`, a
 * `prevSuggestionCount` render-phase reset to keep the index in range, and a
 * `setTimeout(…, 200)` on blur so a click could land before the list closed.
 * Every one of those is something `cmdk` already does, and `cmdk` was already a
 * dependency - the variable dropdown two branches up in the same file *is* this
 * primitive.
 *
 * The two lists therefore behaved differently for no reason anyone chose, which
 * is precisely the defect the project guide describes: a hand-rolled copy of a
 * primitive does not receive the primitive's fixes.
 *
 * Filtering stays with the caller (`shouldFilter={false}`) because the caller
 * decides what "matches" means - the header list matches on substring and hides
 * an exact match, which is not cmdk's default scoring.
 */

import { Command, CommandList, CommandGroup, CommandItem } from "./command";
import { cn } from "@/lib/utils";

export interface SuggestionListProps {
	/** Already filtered and ordered by the caller. */
	items: string[];
	onSelect: (value: string) => void;
	/** Cap on what is shown; the caller may pass more. */
	limit?: number;
	className?: string;
}

export function SuggestionList({ items, onSelect, limit = 10, className }: SuggestionListProps) {
	if (items.length === 0) return null;

	return (
		<div className={cn("w-64 rounded-lg border bg-popover shadow-md", className)}>
			<Command shouldFilter={false}>
				<CommandList>
					<CommandGroup>
						{items.slice(0, limit).map((item) => (
							<CommandItem
								key={item}
								value={item}
								/*
								 * `onMouseDown` with `preventDefault`, not `onClick`.
								 * The list hangs off a focused input, and a plain click
								 * blurs it first - which is what the replaced code was
								 * buying with a 200ms timeout on blur.
								 */
								onMouseDown={(e) => {
									e.preventDefault();
									onSelect(item);
								}}
								onSelect={() => onSelect(item)}
								className="cursor-pointer text-sm"
							>
								{item}
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
			</Command>
		</div>
	);
}
