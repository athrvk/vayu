
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

	if (filteredVariables.length === 0) {
		return null;
	}

	return (
		<div className={cn("w-64 border bg-popover shadow-md", className)}>
			<Command shouldFilter={false}>
				<CommandList>
					<CommandEmpty>No variables found.</CommandEmpty>
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
				</CommandList>
			</Command>
		</div>
	);
}
