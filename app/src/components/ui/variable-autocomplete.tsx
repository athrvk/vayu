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
import type { DataContractScope, ResolvedVariable } from "@/types";
import { DATA_NAMESPACE_PREFIX } from "@/lib/variable-resolution";
import { DYNAMIC_VARIABLES } from "@/lib/dynamic-variables";
import { ITERATION_VARIABLES } from "@/lib/iteration-variables";

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
}

export function VariableAutocomplete({
	variables,
	searchQuery = "",
	onSelect,
	className,
	dataColumns,
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

	/*
	 * The reserved identity namespace (issue #994), a group of its own for the
	 * same reason `data.*` is: it is not a variable a scope could ever define
	 * (`variable-resolution.ts` reserves the names ahead of the scope lookup),
	 * so unlike the generators below there is no shadowing check here - both
	 * names are always offered.
	 */
	const filteredIteration = useMemo(() => {
		const lowerQuery = searchQuery.toLowerCase();
		return ITERATION_VARIABLES.filter((v) => v.name.toLowerCase().includes(lowerQuery));
	}, [searchQuery]);

	/*
	 * Columns are their own group for the same reason generators are: they are
	 * not variables, and interleaving them would put a name no scope defines
	 * among the ones the user created. They are offered from the contract rather
	 * than from `variables` because the namespace is disjoint from the scopes -
	 * a stored variable named `data.email` cannot shadow the column, so there is
	 * no shadowing check to make here.
	 *
	 * Each column offers both spellings a bound row answers (issue #1007): the
	 * prefixed one first, then bare - `bare` on the entry is what the row below
	 * reads to label which is which, since the token text alone does not say it.
	 */
	const filteredColumns = useMemo(() => {
		const lowerQuery = searchQuery.toLowerCase();
		const entries: Array<{ name: string; bare: boolean }> = [];
		for (const column of dataColumns?.columns ?? []) {
			const prefixed = `${DATA_NAMESPACE_PREFIX}${column}`;
			if (prefixed.toLowerCase().includes(lowerQuery))
				entries.push({ name: prefixed, bare: false });
			if (column.toLowerCase().includes(lowerQuery))
				entries.push({ name: column, bare: true });
		}
		return entries;
	}, [dataColumns, searchQuery]);

	if (
		filteredVariables.length === 0 &&
		filteredIteration.length === 0 &&
		filteredDynamic.length === 0 &&
		filteredColumns.length === 0
	) {
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
					{filteredIteration.length > 0 && (
						<CommandGroup heading="Iteration">
							{filteredIteration.map((identity) => (
								<CommandItem
									key={identity.name}
									value={identity.name}
									onSelect={() => onSelect(identity.name)}
									className="flex items-center justify-between cursor-pointer"
								>
									<span className="font-mono text-sm">{identity.name}</span>
									<span className="ml-2 truncate text-[11px] text-muted-foreground">
										{identity.description}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					)}
					{filteredColumns.length > 0 && (
						<CommandGroup heading="Data columns">
							{filteredColumns.map(({ name, bare }) => (
								<CommandItem
									key={name}
									value={name}
									onSelect={() => onSelect(name)}
									className="flex items-center justify-between cursor-pointer"
								>
									<span className="font-mono text-sm">{name}</span>
									<span className="ml-2 truncate text-[11px] text-muted-foreground">
										{dataColumns?.collectionName}
										{bare ? " \u00b7 bare" : ""}
									</span>
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
