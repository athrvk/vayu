/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Environments and variable keys, as palette results.
 *
 * A `{{token}}` that resolves to the wrong thing is one of the app's easiest
 * mistakes to make and hardest to find, because answering "where is this
 * defined" means opening the Variables tab and clicking through every scope.
 * This makes the key itself the thing you search for, and lands on the scope
 * that defines it.
 *
 * **Values are never indexed, secret or not.** A variable's value is the one
 * piece of this data that can be a bearer token, and the palette is a surface
 * that renders whatever it matches - so this source reads keys and scope names
 * and never touches `.value`. `secret` is only a masking hint (see
 * `VariableValue`), so a rule that trusted it would leak every token nobody
 * remembered to flag. `useVariableItems.test.ts` holds the invariant.
 *
 * Client-side throughout: collections, environments and globals are all in
 * cache, so typing here costs nothing.
 */

import { useMemo } from "react";
import { Braces, Cloud, Globe, Layers } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTabsStore } from "@/stores";
import { useCollectionsQuery, useEnvironmentsQuery, useGlobalsQuery } from "@/queries";
import { useVariablesStore, type VariableCategory } from "@/modules/variables/variables-store";
import { DEEP_GROUP_LIMIT, type PaletteItem } from "../types";

/** One scope's identity: what it is called, what opens it, how it is drawn. */
interface Scope {
	/** Stable within a run of the app - the scope's own id, or "globals". */
	key: string;
	label: string;
	icon: LucideIcon;
	category: VariableCategory;
	/** The keys defined in this scope. Never their values. */
	variableKeys: string[];
}

/**
 * Open the Variables tab on one scope - the two calls the variables tree's own
 * `selectCategory` makes, in that order.
 */
function openScope(category: VariableCategory): void {
	useVariablesStore.getState().setSelectedCategory(category);
	useTabsStore.getState().openTab({ type: "variables", entityId: null });
}

/**
 * Prefix matches before contained ones, and everything else in scope order.
 *
 * Lower sorts first; `null` means no match. Deliberately smaller than
 * `searchSettings`' ranking: a variable has a key and a scope name and nothing
 * else to weigh.
 */
function matchRank(haystack: string, needle: string): number | null {
	const value = haystack.toLowerCase();
	if (value.startsWith(needle)) return 0;
	if (value.includes(needle)) return 1;
	return null;
}

export function useVariableItems(query: string): PaletteItem[] {
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();
	const { data: globals } = useGlobalsQuery();
	const needle = query.trim().toLowerCase();

	const scopes = useMemo<Scope[]>(() => {
		// Resolution order runs environment > collection > global, and the tree
		// lists the scopes that way round; this follows it, so the palette agrees
		// with the screen about which scope wins.
		const built: Scope[] = environments.map((environment) => ({
			key: environment.id,
			label: environment.name,
			icon: Cloud,
			category: { type: "environment", environmentId: environment.id },
			variableKeys: Object.keys(environment.variables ?? {}),
		}));
		for (const collection of collections) {
			built.push({
				key: collection.id,
				label: collection.name,
				icon: Layers,
				category: { type: "collection", collectionId: collection.id },
				variableKeys: Object.keys(collection.variables ?? {}),
			});
		}
		built.push({
			key: "globals",
			label: "Globals",
			icon: Globe,
			category: { type: "globals" },
			variableKeys: Object.keys(globals?.variables ?? {}),
		});
		return built;
	}, [collections, environments, globals]);

	return useMemo(() => {
		// Deep search is search - see `useSettingsItems` for why the empty query
		// contributes nothing.
		if (needle === "") return [];

		const ranked: { item: PaletteItem; rank: number }[] = [];

		for (const scope of scopes) {
			// An environment is findable by its own name, not only by what it
			// defines - it is the thing a user switches between.
			if (scope.category.type === "environment") {
				const rank = matchRank(scope.label, needle);
				if (rank !== null) {
					ranked.push({
						rank,
						item: {
							id: `variable-scope:${scope.key}`,
							kind: "variable",
							title: scope.label,
							subtitle: "Environment",
							keywords: ["environment", "env", "scope"],
							icon: scope.icon,
							perform: () => openScope(scope.category),
						},
					});
				}
			}

			for (const variableKey of scope.variableKeys) {
				const rank = matchRank(variableKey, needle);
				if (rank === null) continue;
				ranked.push({
					// +2 so a scope whose *name* matches outranks a key inside
					// some other scope that merely contains the same letters.
					rank: rank + 2,
					item: {
						id: `variable:${scope.key}:${variableKey}`,
						kind: "variable",
						title: variableKey,
						subtitle: scope.label,
						keywords: ["variable", `{{${variableKey}}}`],
						icon: Braces,
						perform: () => openScope(scope.category),
					},
				});
			}
		}

		// Stable sort, so ties keep scope order (environments, collections,
		// globals) rather than reshuffling as the query grows.
		ranked.sort((a, b) => a.rank - b.rank);
		// No escape row: unlike settings and runs there is no surface that
		// browses variables across scopes - the Variables tab edits one scope at
		// a time - so a "see all" row would have nowhere to go.
		return ranked.slice(0, DEEP_GROUP_LIMIT).map((entry) => entry.item);
	}, [scopes, needle]);
}
