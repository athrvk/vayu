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
 * tab passes the collection it is editing directly. That id is only where a
 * *new* collection variable is created: an edit writes to the definition the
 * resolver named (`sourceId`), which in a collection chain is often an
 * ancestor of this one (#3683).
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
import { variableTargetOf } from "@/lib/variable-target";
import type { VariableScope, VariableValue } from "@/types";

interface UseVariableWriterOptions {
	collectionId?: string;
}

interface UseVariableWriterReturn {
	/**
	 * Write a new value for a name, from a token's edit popover. `sourceId`
	 * names the collection or environment an edit's definition lives in; a
	 * create omits it. See `updateVariable` below.
	 */
	updateVariable: (
		name: string,
		newValue: string,
		scope: VariableScope,
		sourceId?: string
	) => void;
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
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);

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
	 *
	 * An edit carries the `sourceId` of the definition the popover displayed and
	 * writes there. A create carries none and lands in this hook's own
	 * collection or the active environment. A `sourceId` naming a collection or
	 * environment that is gone is a no-op, never a fallback to the create
	 * target: that is the copy-into-the-wrong-collection defect (#3683).
	 */
	const updateVariable = useCallback(
		(name: string, newValue: string, scope: VariableScope, sourceId?: string) => {
			const createId = scope === "collection" ? collectionId : activeEnvironmentId;
			const target = variableTargetOf({ scope, sourceId: sourceId ?? createId ?? undefined });
			if (!target) return;

			switch (target.scope) {
				case "global": {
					if (!globalsData?.variables) return;
					updateGlobalsMutation.mutate({
						variables: mergeVariable(globalsData.variables, name, newValue),
					});
					break;
				}
				case "collection": {
					const collection = collections.find((c) => c.id === target.id);
					if (!collection) return;
					updateCollectionMutation.mutate({
						id: target.id,
						variables: mergeVariable(collection.variables, name, newValue),
					});
					break;
				}
				case "environment": {
					const environment = environments.find((e) => e.id === target.id);
					if (!environment) return;
					updateEnvironmentMutation.mutate({
						id: target.id,
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
	 * same targets a create resolves in `updateVariable` - kept beside it so a
	 * target changing above is the next thing in this file to change, per this
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
