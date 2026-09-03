/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * VariableAutocomplete Component
 *
 * Use Case 1: Display a list of available variables for selection
 * - Shows the entries `buildVariableSuggestions` offers for the search query
 * - Displays variable name and scope badge
 * - Used when user types {{ to select a variable
 *
 * **It does not own the keyboard.** The keys arrive at the text field the list
 * hangs off, not at this list - nothing here is ever focused - so `VariableInput`
 * moves the highlight through the controlled `value` prop and calls `onSelect`
 * itself (issue #1215). The ordering both sides step through is
 * `lib/variable-suggestions.ts`, so there is one list and not two.
 */

import { useMemo } from "react";
import {
	Command,
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandListboxProbe,
	CommandScrollIntoView,
	type CommandListboxState,
} from "./command";
import { VariableScopeBadge } from "./variable-scope-badge";
import { cn } from "@/lib/utils";
import type { DataContractScope, ResolvedVariable } from "@/types";
import {
	buildVariableSuggestions,
	variableSuggestionKey,
	VARIABLE_SUGGESTION_GROUPS,
	type VariableSuggestion,
} from "@/lib/variable-suggestions";

// Re-export ResolvedVariable as VariableInfo for backward compatibility
export type { ResolvedVariable as VariableInfo };

export interface VariableAutocompleteProps {
	/** All available variables */
	variables: Record<string, ResolvedVariable>;
	/** Search query to filter variables */
	searchQuery?: string;
	/** Callback when a variable is selected */
	onSelect: (variableName: string) => void;
	/** Optional className for the container */
	className?: string;
	/**
	 * The data contract in scope, when the collection chain declares one
	 * (issue #600). Its columns are offered as `data.<column>` names, which is
	 * how a request field addresses them - the same string the token carries.
	 *
	 * Each column is offered a second way too, bare (issue #1007): Postman binds
	 * a dataset's columns to bare names, so an imported collection is already
	 * written `{{username}}`, and a bound row answers that spelling exactly as it
	 * answers `{{data.username}}`.
	 */
	dataColumns?: DataContractScope;
	/**
	 * The highlighted entry, as a `variableSuggestionKey`. Supplied by
	 * `VariableInput`, which owns arrow-key navigation because the keys arrive at
	 * the text field rather than at this list (issue #1215) - so the highlight
	 * has to be state the field can move. Omitted, `cmdk` highlights on its own,
	 * which is what a direct render in a test gets.
	 */
	value?: string;
	/** Fires when `cmdk` moves the highlight itself - a pointer over a row. */
	onValueChange?: (value: string) => void;
	/**
	 * Reports the listbox and highlighted-option ids, which `cmdk` mints and
	 * which the combobox outside this list has to name. Must be stable.
	 */
	onListboxState?: (state: CommandListboxState) => void;
}

/** The secondary text on a row, which differs by group. */
function suggestionDetail(suggestion: VariableSuggestion): string | undefined {
	if (suggestion.group === "columns")
		return `${suggestion.collectionName ?? ""}${suggestion.bare ? " · bare" : ""}`;
	return suggestion.description;
}

export function VariableAutocomplete({
	variables,
	searchQuery = "",
	onSelect,
	className,
	dataColumns,
	value,
	onValueChange,
	onListboxState,
}: VariableAutocompleteProps) {
	const suggestions = useMemo(
		() => buildVariableSuggestions({ variables, searchQuery, dataColumns }),
		[variables, searchQuery, dataColumns]
	);

	/*
	 * Drawn group by group, in the one declared order. The groups exist so a name
	 * no scope defines - a generator, a column, an iteration identity - is not
	 * interleaved with the ones the user created; `variable-suggestions.ts` says
	 * which entry falls where and why.
	 */
	const groups = useMemo(
		() =>
			VARIABLE_SUGGESTION_GROUPS.map(({ group, heading }) => ({
				group,
				heading,
				items: suggestions.filter((s) => s.group === group),
			})).filter(({ items }) => items.length > 0),
		[suggestions]
	);

	if (suggestions.length === 0) {
		return null;
	}

	return (
		<div className={cn("w-64 rounded-lg border bg-popover shadow-md", className)}>
			<Command shouldFilter={false} value={value} onValueChange={onValueChange}>
				<CommandList>
					{onListboxState && <CommandListboxProbe onChange={onListboxState} />}
					<CommandScrollIntoView />
					<CommandEmpty>No variables found.</CommandEmpty>
					{groups.map(({ group, heading, items }) => (
						<CommandGroup key={group} heading={heading}>
							{items.map((suggestion) => {
								const key = variableSuggestionKey(suggestion);
								const detail = suggestionDetail(suggestion);
								return (
									<CommandItem
										key={key}
										/*
										 * The key, not the name: a column offered bare can
										 * collide with a workspace variable of the same name,
										 * and `cmdk` highlights by value.
										 */
										value={key}
										onSelect={() => onSelect(suggestion.name)}
										className="flex items-center justify-between cursor-pointer"
									>
										<span className="font-mono text-sm">{suggestion.name}</span>
										{suggestion.scope ? (
											<VariableScopeBadge
												scope={suggestion.scope}
												variant="compact"
											/>
										) : (
											<span className="ml-2 truncate text-[11px] text-muted-foreground">
												{detail}
											</span>
										)}
									</CommandItem>
								);
							})}
						</CommandGroup>
					))}
				</CommandList>
			</Command>
		</div>
	);
}
