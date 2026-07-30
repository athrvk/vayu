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
 * - Shows filtered list of variables based on search query
 * - Displays variable name and scope badge
 * - Handles keyboard navigation and selection
 * - Used when user types {{ to select a variable
 */

import { useMemo } from "react";
import { Command, CommandList, CommandEmpty, CommandGroup, CommandItem } from "./command";
import { VariableScopeBadge } from "./variable-scope-badge";
import { cn } from "@/lib/utils";
import type { ResolvedVariable } from "@/types";
import { DYNAMIC_VARIABLES } from "@/lib/dynamic-variables";

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
}

export function VariableAutocomplete({
	variables,
	searchQuery = "",
	onSelect,
	className,
}: VariableAutocompleteProps) {
	// Filter variables based on search query
	const filteredVariables = useMemo(() => {
		const entries = Object.entries(variables);
		if (!searchQuery) return entries;
		const lowerQuery = searchQuery.toLowerCase();
		return entries.filter(([name]) => name.toLowerCase().includes(lowerQuery));
	}, [variables, searchQuery]);

	/*
	 * Dynamic variables are offered from the table rather than from `variables`,
	 * which holds what the workspace defines. They are a second group, below,
	 * because they exist in every workspace and would otherwise dilute the list
	 * of names the user actually created. One that a real variable shadows is
	 * dropped: the resolver would ignore the generator there.
	 */
	const filteredDynamic = useMemo(() => {
		const lowerQuery = searchQuery.toLowerCase();
		return DYNAMIC_VARIABLES.filter(
			(v) => !(v.name in variables) && v.name.toLowerCase().includes(lowerQuery)
		);
	}, [variables, searchQuery]);

	if (filteredVariables.length === 0 && filteredDynamic.length === 0) {
		return null;
	}

	return (
		<div className={cn("w-64 rounded-lg border bg-popover shadow-md", className)}>
			<Command shouldFilter={false}>
				<CommandList>
					<CommandEmpty>No variables found.</CommandEmpty>
					{filteredVariables.length > 0 && (
						<CommandGroup heading="Variables">
							{filteredVariables.map(([name, varInfo]) => (
								<CommandItem
									key={name}
									value={name}
									onSelect={() => onSelect(name)}
									className="flex items-center justify-between cursor-pointer"
								>
									<span className="font-mono text-sm">{name}</span>
									<VariableScopeBadge scope={varInfo.scope} variant="compact" />
								</CommandItem>
							))}
						</CommandGroup>
					)}
					{filteredDynamic.length > 0 && (
						<CommandGroup heading="Dynamic">
							{filteredDynamic.map((dynamic) => (
								<CommandItem
									key={dynamic.name}
									value={dynamic.name}
									onSelect={() => onSelect(dynamic.name)}
									className="flex items-center justify-between cursor-pointer"
								>
									<span className="font-mono text-sm">{dynamic.name}</span>
									<span className="ml-2 truncate text-[11px] text-muted-foreground">
										{dynamic.description}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					)}
				</CommandList>
			</Command>
		</div>
	);
}
