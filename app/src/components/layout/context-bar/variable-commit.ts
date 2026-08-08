/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where a context-bar variable edit lands, and what it carries when it gets
 * there.
 *
 * This was `VariablesSection`'s own code until the collection tab grew a
 * variables section of its own. The two show different sets - the request tab
 * shows what resolved, the collection tab shows what that collection defines -
 * but a commit is the same act either way, and the comments below describe
 * defects that took a while to find. A second copy of them is exactly the
 * "hand-rolled copy does not receive the primitive's fixes" trap.
 *
 * The caller supplies the `ResolvedVariable` whose definition it displayed;
 * nothing here re-derives a target. That is the whole point - see the note on
 * `commitScopeFor`.
 */

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSaveStore } from "@/stores";
import {
	useUpdateGlobalsMutation,
	useUpdateEnvironmentMutation,
	useUpdateCollectionMutation,
} from "@/queries";
import { queryKeys } from "@/queries/keys";
import type {
	Collection,
	Environment,
	GlobalVariables,
	ResolvedVariable,
	VariableValue,
} from "@/types";

type VariableMap = Record<string, VariableValue>;

/**
 * Where one scope's variables live and how a commit gets written back.
 *
 * The three scopes differ only in those two things, so they are named once
 * rather than spelled out three times. `read` deliberately goes to the query
 * cache rather than to a hook's `data`: a commit built from the render closure
 * is a snapshot of the cache as it was when the input was drawn, and the
 * transport replaces the whole map - so blurring a second variable before the
 * first mutation settled re-sent the first one's pre-edit value and silently
 * reverted it.
 */
interface CommitScope {
	/** The stored map as of now, not as of the render that drew the input. */
	read: () => VariableMap | undefined;
	/** Patch the cache so a later commit's `read` already sees this one. */
	write: (next: VariableMap) => void;
	/** Send the map to the engine. */
	mutate: (
		next: VariableMap,
		handlers: { onError: (e: unknown) => void; onSettled: () => void }
	) => void;
}

/**
 * The bar's single entry in the save-context registry.
 *
 * One id for the whole bar, not one per section: the registry gives a tab at
 * most one variables section (the request tab's resolved set, or the collection
 * tab's own definitions), so two of them are never mounted at once, and the
 * quit-time flush has one thing to wait for either way.
 */
const SAVE_CONTEXT_ID = "context-bar-variables";

/**
 * Track in-flight commits so the quit-time flush waits for them.
 *
 * `onBeforeQuit` awaits `flushAll` (`App.tsx`), which only knows about
 * *registered* save contexts - the bar registered none, so the renderer could be
 * torn down mid-PUT with the input already showing the value as committed. One
 * context covers the whole bar: `hasPendingChanges` says whether any commit is
 * outstanding, and `save()` resolves when the last one settles.
 *
 * Returns a function that opens a commit and hands back its `settle` callback,
 * for the mutation's `onSettled`. Commits are held as promises rather than
 * counted so `save()` can await the requests themselves.
 */
function usePendingCommits(): () => () => void {
	const registerContext = useSaveStore((s) => s.registerContext);
	const unregisterContext = useSaveStore((s) => s.unregisterContext);
	const updateContext = useSaveStore((s) => s.updateContext);
	const pending = useRef<Set<Promise<void>>>(new Set());

	useEffect(() => {
		const inFlight = pending.current;
		registerContext({
			id: SAVE_CONTEXT_ID,
			name: "Variables",
			save: async () => {
				await Promise.all([...inFlight]);
			},
			hasPendingChanges: false,
		});
		return () => unregisterContext(SAVE_CONTEXT_ID);
	}, [registerContext, unregisterContext]);

	return useCallback(() => {
		let settle: () => void = () => {};
		const commit = new Promise<void>((resolve) => {
			settle = resolve;
		});
		pending.current.add(commit);
		updateContext(SAVE_CONTEXT_ID, { hasPendingChanges: true });
		useSaveStore.getState().startSaving();

		return () => {
			pending.current.delete(commit);
			settle();
			if (pending.current.size > 0) return;
			updateContext(SAVE_CONTEXT_ID, { hasPendingChanges: false });
			// A failed commit already reported itself through `failSave`; painting
			// "Saved" over it is the same defect `runSave` guards against in the
			// save store.
			//
			// `completeSaveThenIdle`, not a success plus a hand-rolled reset timer:
			// the store holds one status for the whole app, so a bare
			// `setTimeout(() => setStatus("idle"))` clears whatever is current when
			// it lands. This path armed no reset at all before #369, which left
			// "Saved" in the Dock until something else changed it.
			if (useSaveStore.getState().status !== "error") {
				useSaveStore.getState().completeSaveThenIdle();
			}
		};
	}, [updateContext]);
}

/**
 * Commit an edited value back to the definition the bar displayed.
 *
 * The returned function takes the input element, not the string, because every
 * failure below has to put the old value back on screen. These inputs are
 * uncontrolled - `defaultValue` with a `key` derived from the stored value - so
 * a rejected save changes nothing: the cache is untouched, therefore the key is
 * untouched, therefore React keeps the DOM node and the typed text sits there
 * looking committed. Failures used to end here entirely (no `onError`, no
 * `isError` reader, and there is no global `MutationCache.onError` either),
 * which is the same defect `CollectionDetail/shared.tsx` documents for the
 * collection tabs.
 */
export function useVariableCommit(): (
	name: string,
	resolved: ResolvedVariable,
	input: HTMLInputElement
) => void {
	const queryClient = useQueryClient();
	const updateGlobalsMutation = useUpdateGlobalsMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();
	const failSave = useSaveStore((s) => s.failSave);
	const beginCommit = usePendingCommits();

	/**
	 * The scope that owns the definition the bar *displayed*, or null if that
	 * source is gone.
	 *
	 * Keyed off `resolved.sourceId`, which the resolver emits precisely to name
	 * the winning source (`useVariableResolver`, `ResolvedVariable`). The bar used
	 * to re-derive the target instead - walking the collection chain for the first
	 * definition with a truthy `enabled` - which disagrees with the resolver's
	 * `isEnabledDefinition` wherever `enabled` is absent (D17: absent counts as
	 * enabled). A leaf definition with no `enabled` key therefore displayed while
	 * an *ancestor's* definition took the write, silently and cross-collection.
	 * Re-deriving a winner someone else already picked is the whole bug; there is
	 * no version of that walk that cannot drift from the resolver again.
	 */
	const commitScopeFor = (resolved: ResolvedVariable): CommitScope | null => {
		if (resolved.scope === "global") {
			return {
				read: () =>
					queryClient.getQueryData<GlobalVariables>(queryKeys.globals.all)?.variables,
				write: (next) =>
					queryClient.setQueryData<GlobalVariables>(queryKeys.globals.all, (old) =>
						old ? { ...old, variables: next } : old
					),
				mutate: (next, handlers) =>
					updateGlobalsMutation.mutate({ variables: next }, handlers),
			};
		}

		// Every non-global winner carries the id of the environment or collection
		// it came from. One without is a resolver that changed shape, not a
		// variable to guess a home for.
		const sourceId = resolved.sourceId;
		if (!sourceId) return null;

		if (resolved.scope === "environment") {
			const key = queryKeys.environments.list();
			const source = queryClient
				.getQueryData<Environment[]>(key)
				?.find((e) => e.id === sourceId);
			if (!source) return null;
			return {
				read: () =>
					queryClient.getQueryData<Environment[]>(key)?.find((e) => e.id === sourceId)
						?.variables,
				write: (next) =>
					queryClient.setQueryData<Environment[]>(key, (old) =>
						old?.map((e) => (e.id === sourceId ? { ...e, variables: next } : e))
					),
				mutate: (next, handlers) =>
					updateEnvironmentMutation.mutate({ id: sourceId, variables: next }, handlers),
			};
		}

		const key = queryKeys.collections.list();
		const source = queryClient.getQueryData<Collection[]>(key)?.find((c) => c.id === sourceId);
		if (!source) return null;
		return {
			read: () =>
				queryClient.getQueryData<Collection[]>(key)?.find((c) => c.id === sourceId)
					?.variables,
			write: (next) =>
				queryClient.setQueryData<Collection[]>(key, (old) =>
					old?.map((c) => (c.id === sourceId ? { ...c, variables: next } : c))
				),
			mutate: (next, handlers) =>
				updateCollectionMutation.mutate({ id: sourceId, variables: next }, handlers),
		};
	};

	return (name: string, resolved: ResolvedVariable, input: HTMLInputElement) => {
		const newValue = input.value;
		if (newValue === resolved.value) return;

		const rollBack = (message: string) => {
			input.value = resolved.value;
			failSave(message);
		};
		// `failSave` is the app's one save-failure surface (it toasts and sets the
		// Dock's status) - see the note on it in save-store.
		// The definition this bar resolved against is gone - deleted from its
		// scope, or its environment or collection removed, between render and blur.
		// Writing it back would resurrect it, so the edit is refused; saying so
		// is the difference between "refused" and "silently swallowed".
		const gone = () =>
			rollBack(`{{${name}}} is no longer defined in its ${resolved.scope} scope`);

		const scope = commitScopeFor(resolved);
		if (!scope) return gone();

		const stored = scope.read();
		const previous = stored?.[name];
		if (!previous) return gone();

		const next = { ...stored, [name]: { ...previous, value: newValue } };
		scope.write(next);

		const settle = beginCommit();
		scope.mutate(next, {
			onError: (error: unknown) => {
				// Restore this name alone rather than the whole snapshot: another
				// variable's commit may have patched the map in the meantime, and
				// replacing it wholesale would revert that one too - the very
				// staleness the fresh read exists to avoid.
				const current = scope.read();
				if (current) scope.write({ ...current, [name]: previous });
				rollBack(error instanceof Error ? error.message : `Couldn't save {{${name}}}`);
			},
			onSettled: settle,
		});
	};
}
