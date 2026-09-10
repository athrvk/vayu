/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The write half of variable scope, extracted from `RequestBuilderProvider`
 * (issue #1651) so a tree with no request builder above it can still edit a
 * variable a token's popover opens - the collection Elements tab's script
 * editors, first. `useVariableResolver` already takes the same shape
 * (`collectionId` optional, everything else read off the global queries and
 * session store) for exactly this reason; this is its write-side twin.
 *
 * Parameterised by `collectionId` rather than reading one off context, the
 * same call convention `useVariableResolver`/`useDataContract` already use -
 * the request builder passes the request's own collection id, the Elements
 * tab passes the collection it is editing directly.
 */

import { useCallback, useMemo } from "react";
import {
	useCollectionsQuery,
	useEnvironmentsQuery,
	useGlobalsQuery,
	useUpdateCollectionMutation,
	useUpdateEnvironmentMutation,
	useUpdateGlobalsMutation,
} from "@/queries";
import { useSessionStore } from "@/stores";
import type { VariableScope, VariableValue } from "@/types";

interface UseVariableWriterOptions {
	collectionId?: string;
}

interface UseVariableWriterReturn {
	/** Write a new value for a name, from a token's edit popover. */
	updateVariable: (name: string, newValue: string, scope: VariableScope) => void;
	/** The scopes `updateVariable` can actually write to right now. */
	writableScopes: VariableScope[];
}

/*
 * Merge one variable into a scope's map.
 *
 * A write here always enables the entry - see the caller-facing doc on
 * `updateVariable` below for why a value written to a disabled variable must
 * not leave it disabled. An existing entry is spread first so its
 * `createdAt` (the variables editor's row-ordering key) survives untouched;
 * only a variable created here is stamped, so it lands at the bottom of its
 * scope's list rather than above every row that already existed (#135).
 */
function mergeVariable(
	existing: Record<string, VariableValue> | undefined,
	name: string,
	newValue: string
): Record<string, VariableValue> {
	const current = existing?.[name];
	return {
		...existing,
		[name]: current
			? { ...current, value: newValue, enabled: true }
			: { value: newValue, enabled: true, createdAt: Date.now() },
	};
}

export function useVariableWriter(options?: UseVariableWriterOptions): UseVariableWriterReturn {
	const collectionId = options?.collectionId;

	const { data: globalsData } = useGlobalsQuery();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();
	const { activeEnvironmentId } = useSessionStore();

	const updateGlobalsMutation = useUpdateGlobalsMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();

	/*
	 * Setting a value here always enables the variable - see `mergeVariable`.
	 * A name disabled at the scope that would otherwise win resolves to
	 * nothing, so its token is red and the popover offers to write it; a write
	 * that preserved `enabled: false` would appear to work and change nothing
	 * visible, which is the dead end this rule exists to remove. Enabling and
	 * disabling on purpose still belongs to the variables editor.
	 */
	const updateVariable = useCallback(
		(name: string, newValue: string, scope: VariableScope) => {
			switch (scope) {
				case "global": {
					if (!globalsData?.variables) return;
					updateGlobalsMutation.mutate({
						variables: mergeVariable(globalsData.variables, name, newValue),
					});
					break;
				}
				case "collection": {
					if (!collectionId) return;
					const collection = collections.find((c) => c.id === collectionId);
					if (!collection) return;
					updateCollectionMutation.mutate({
						id: collectionId,
						variables: mergeVariable(collection.variables, name, newValue),
					});
					break;
				}
				case "environment": {
					if (!activeEnvironmentId) return;
					const environment = environments.find((e) => e.id === activeEnvironmentId);
					if (!environment) return;
					updateEnvironmentMutation.mutate({
						id: activeEnvironmentId,
						variables: mergeVariable(environment.variables, name, newValue),
					});
					break;
				}
			}
		},
		[
			globalsData,
			collections,
			environments,
			collectionId,
			activeEnvironmentId,
			updateGlobalsMutation,
			updateCollectionMutation,
			updateEnvironmentMutation,
		]
	);

	/*
	 * Which scopes `updateVariable` would actually write to, derived from the
	 * same three guards it opens each branch with - kept beside it so a guard
	 * changing above is the next thing in this file to change, per this
	 * codebase's own "written in one branch, re-derived in another" defect
	 * shape. A caller that offers a scope not in here gets a silent no-op.
	 */
	const writableScopes = useMemo((): VariableScope[] => {
		const scopes: VariableScope[] = [];
		if (globalsData?.variables) scopes.push("global");
		if (collectionId && collections.some((c) => c.id === collectionId))
			scopes.push("collection");
		if (activeEnvironmentId && environments.some((e) => e.id === activeEnvironmentId)) {
			scopes.push("environment");
		}
		return scopes;
	}, [globalsData, collections, collectionId, environments, activeEnvironmentId]);

	return { updateVariable, writableScopes };
}
