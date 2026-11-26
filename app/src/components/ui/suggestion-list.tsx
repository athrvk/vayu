/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A plain-text suggestion dropdown on the `Command` primitive `VariableAutocomplete` uses, so the
 * two lists cannot behave differently: `cmdk` does the highlight, Enter, Tab, Escape and the
 * click-before-blur a hand-rolled copy reimplemented.
 *
 * **The arrow keys are the exception.** `cmdk` reads them off its own `Command.Input`, which
 * neither list renders (the field is `VariableInput`'s, two components up), so the highlight cannot
 * move by itself: `value` / `onValueChange` let the caller step through the `items` it passed and
 * say where the highlight is (#1215).
 *
 * Filtering stays with the caller (`shouldFilter={false}`), which decides what "matches" means: the
 * header list matches substrings and hides an exact match, not cmdk's scoring.
 */

import {
	Command,
	CommandList,
	CommandGroup,
	CommandItem,
	CommandListboxProbe,
	CommandScrollIntoView,
	NO_HIGHLIGHT,
	type CommandListboxState,
} from "./command";
import { cn } from "@/lib/utils";

export interface SuggestionListProps {
	/** Already filtered and ordered by the caller. */
	items: string[];
	onSelect: (value: string) => void;
	/**
	 * Cap on what is shown; omitted, every item renders and `CommandList`'s
	 * `max-h-[300px] overflow-y-auto` scrolls, as the palette's list does.
	 */
	limit?: number;
	className?: string;
	/**
	 * The highlighted item, from `VariableInput`, which owns the arrows as they arrive at its field
	 * (#1215). Omitted, `cmdk` highlights the first row. `""` is "none highlighted", which `cmdk`
	 * would read as unset and answer with the first row (#3667).
	 */
	value?: string;
	/** Fires when `cmdk` moves the highlight itself - a pointer over a row. */
	onValueChange?: (value: string) => void;
	/**
	 * Reports the listbox and highlighted-option ids `cmdk` mints, which the outside combobox must
	 * name; must be stable.
	 */
	onListboxState?: (state: CommandListboxState) => void;
}

export function SuggestionList({
	items,
	onSelect,
	limit,
	className,
	value,
	onValueChange,
	onListboxState,
}: SuggestionListProps) {
	if (items.length === 0) return null;
	const shown = limit === undefined ? items : items.slice(0, limit);

	return (
		<div
			className={cn(
				// `w-3xs` (16rem), not `w-64`: suggestion text is a text measure, and `w-64` rides
				// `--spacing` (192px at Default, not 256px).
				"enter-fade w-3xs rounded-lg border bg-popover shadow-md",
				className
			)}
		>
			<Command
				shouldFilter={false}
				value={value === "" ? NO_HIGHLIGHT : value}
				onValueChange={onValueChange}
			>
				<CommandList>
					{onListboxState && <CommandListboxProbe onChange={onListboxState} />}
					<CommandScrollIntoView />
					<CommandGroup>
						{shown.map((item) => (
							<CommandItem
								key={item}
								value={item}
								/*
								 * `onMouseDown` with `preventDefault`, not `onClick`: the list
								 * hangs off a focused input, which a plain click blurs first.
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
