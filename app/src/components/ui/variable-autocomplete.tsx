/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The variables the `{{` search offers (`buildVariableSuggestions`), each with its name and scope
 * badge. **It does not own the keyboard**: keys arrive at the text field the list hangs off and
 * this is never focused, so `VariableInput` moves the highlight through `value` and calls
 * `onSelect` (#1215). Both sides step through `lib/variable-suggestions.ts`'s ordering, one list.
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

// `ResolvedVariable` re-exported as `VariableInfo`, the name older importers use.
export type { ResolvedVariable as VariableInfo };

export interface VariableAutocompleteProps {
	variables: Record<string, ResolvedVariable>;
	searchQuery?: string;
	onSelect: (variableName: string) => void;
	className?: string;
	/**
	 * The data contract in scope, when the chain declares one (#600): its columns are offered as
	 * `data.<column>`, the string a token carries, and bare too (#1007), as Postman binds a
	 * dataset's columns to bare names, so an imported `{{username}}` is answered by a bound row
	 * like `{{data.username}}`.
	 */
	dataColumns?: DataContractScope;
	/**
	 * The highlighted entry, as a `variableSuggestionKey`, from `VariableInput`, which owns the
	 * arrows as they arrive at its field (#1215). Omitted, `cmdk` highlights itself, as a direct
	 * render in a test gets.
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
	 * Drawn group by group, in the one declared order, so a name no scope defines (a generator, a
	 * column, an iteration identity) is not interleaved with the user's; `variable-suggestions.ts`
	 * says which entry falls where and why.
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
		<div
			className={cn(
				// `w-3xs` (16rem), not `w-64`: names are a text measure, and `w-64` rides
				// `--spacing` (192px at Default, not 256px).
				"enter-fade w-3xs rounded-lg border bg-popover shadow-md",
				className
			)}
		>
			<Command shouldFilter={false} value={value} onValueChange={onValueChange}>
				<CommandList>
					{onListboxState && <CommandListboxProbe onChange={onListboxState} />}
					<CommandScrollIntoView />
					<CommandEmpty>No variables found</CommandEmpty>
					{groups.map(({ group, heading, items }) => (
						<CommandGroup key={group} heading={heading}>
							{items.map((suggestion) => {
								const key = variableSuggestionKey(suggestion);
								const detail = suggestionDetail(suggestion);
								return (
									<CommandItem
										key={key}
										/*
										 * The key, not the name: a bare column can share a
										 * workspace variable's name, and `cmdk` highlights by
										 * value.
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
											<span className="ml-2 truncate text-label text-muted-foreground">
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
