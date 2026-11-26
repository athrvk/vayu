/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where a context-bar variable edit lands, and what it carries when it gets there. Shared by both
 * variables sections, which show different sets (the request tab what resolved, the collection tab
 * what that collection defines) while a commit is the same act either way; the defects the comments
 * below describe took a while to find, and a second copy would not receive their fixes.
 *
 * The caller supplies the `ResolvedVariable` whose definition it displayed; nothing here re-derives
 * a target, which is the whole point (see `commitScopeFor`).
 */

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSaveStore } from "@/stores";
import { isFailedOutcome, type SaveOutcome } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import { isDiskFullError } from "@/lib/disk-full";
import {
	useUpdateGlobalsMutation,
	useUpdateEnvironmentMutation,
	useUpdateCollectionMutation,
} from "@/queries";
import { queryKeys } from "@/queries/keys";
import { mergeVariableChanges, type VariableMap } from "@/lib/variable-merge";
import { variableTargetOf } from "@/lib/variable-target";
import type { Collection, Environment, GlobalVariables, ResolvedVariable } from "@/types";

/**
 * Where one scope's variables live and how a commit is written back, the only two ways the three
 * scopes differ, so they are named once. `read` goes to the query cache, not a hook's `data`: a
 * commit built from the render closure is a snapshot of the cache when the input was drawn, and the
 * transport replaces the whole map, so blurring a second variable before the first mutation settles
 * would re-send the first one's pre-edit value and silently revert it.
 */
interface CommitScope {
	/** The stored map as of now, not as of the render that drew the input. */
	read: () => VariableMap | undefined;
	/** Patch the cache so a later commit's `read` already sees this one. */
	write: (next: VariableMap) => void;
	/**
	 * Send the map to the engine. The mutation's own promise, never `mutate`'s per-call callbacks:
	 * an observer holds one set of those, replaced by the next `mutate` and never called once its
	 * host unmounts (query-core's `MutationObserver`), and a commit whose callbacks were dropped
	 * never settles, leaving the Dock on "Saving…" until restart.
	 */
	mutate: (next: VariableMap) => Promise<unknown>;
}

/**
 * The bar's single entry in the save-context registry. One id for the whole bar, not one per
 * section: the registry gives a tab at most one variables section (the request tab's resolved set,
 * or the collection tab's own definitions), so two are never mounted at once, and the quit-time
 * flush has one thing to wait for either way.
 */
const SAVE_CONTEXT_ID = "context-bar-variables";

/**
 * One verdict for every commit a flush waited on: failed if any failed, and
 * disk-full only when each failure was the engine's 507, the same rule
 * `flushAll` applies across contexts.
 */
function verdictOf(outcomes: SaveOutcome[]): SaveOutcome {
	const failures = outcomes.filter(isFailedOutcome);
	if (failures.length === 0) return "saved";
	return failures.every((outcome) => outcome === "disk-full") ? "disk-full" : "failed";
}

/**
 * Track in-flight commits so the quit-time flush waits for them. `onBeforeQuit` awaits `flushAll`
 * (`App.tsx`), which knows only *registered* save contexts, so without one the renderer could be
 * torn down mid-PUT with the input already showing the value as committed. One context covers the
 * whole bar: `hasPendingChanges` says whether any commit is outstanding, and `save()` resolves with
 * their verdict when the last one settles.
 *
 * The Dock shows "Saving…" under the bar's id while any commit is out. A failed commit rolls its
 * input back, so it leaves no unsaved edit: its batch withdraws the report instead of reporting it
 * saved, and the failure is the caller's toast, never "Not saved" (`save-store.ts`).
 *
 * Returns a function that opens a commit and hands back its `settle` callback, for when the
 * mutation's promise settles. Commits are held as promises rather than counted, so `save()` can
 * await the requests themselves.
 */
function usePendingCommits(): () => (outcome: SaveOutcome) => void {
	const registerContext = useSaveStore((s) => s.registerContext);
	const unregisterContext = useSaveStore((s) => s.unregisterContext);
	const updateContext = useSaveStore((s) => s.updateContext);
	const reportSaving = useSaveStore((s) => s.reportSaving);
	const reportSaved = useSaveStore((s) => s.reportSaved);
	const discard = useSaveStore((s) => s.discard);
	const pending = useRef<Set<Promise<SaveOutcome>>>(new Set());
	// What the commits settled since the bar last had none in flight.
	const settled = useRef<SaveOutcome[]>([]);

	useEffect(() => {
		const inFlight = pending.current;
		registerContext({
			id: SAVE_CONTEXT_ID,
			name: "Variables",
			save: async () => verdictOf(await Promise.all([...inFlight])),
			hasPendingChanges: false,
		});
		return () => unregisterContext(SAVE_CONTEXT_ID);
	}, [registerContext, unregisterContext]);

	return useCallback(() => {
		let settle: (outcome: SaveOutcome) => void = () => {};
		const commit = new Promise<SaveOutcome>((resolve) => {
			settle = resolve;
		});
		pending.current.add(commit);
		updateContext(SAVE_CONTEXT_ID, { hasPendingChanges: true });
		reportSaving(SAVE_CONTEXT_ID);

		return (outcome) => {
			pending.current.delete(commit);
			settled.current.push(outcome);
			settle(outcome);
			if (pending.current.size > 0) return;
			updateContext(SAVE_CONTEXT_ID, { hasPendingChanges: false });
			const batch = verdictOf(settled.current);
			settled.current = [];
			if (batch === "saved") reportSaved(SAVE_CONTEXT_ID);
			else discard(SAVE_CONTEXT_ID);
		};
	}, [updateContext, reportSaving, reportSaved, discard]);
}

/**
 * Commit an edited value back to the definition the bar displayed. The returned function takes the
 * input element, not the string, because every failure below puts the old value back on screen:
 * these inputs are uncontrolled (`defaultValue` with a `key` derived from the stored value), so a
 * rejected save changes nothing, the cache and so the key are untouched, and React keeps the DOM
 * node with the typed text looking committed. Nothing else catches the failure (no global
 * `MutationCache.onError`), the defect `CollectionDetail/shared.tsx` documents for the collection
 * tabs.
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
	const showToast = useToastStore((s) => s.showToast);
	const beginCommit = usePendingCommits();

	/**
	 * The scope that owns the definition the bar *displayed*, or null if that source is gone. Keyed
	 * off `resolved.sourceId`, which the resolver emits precisely to name the winning source
	 * (`useVariableResolver`, `ResolvedVariable`). Re-deriving the target, by walking the
	 * collection chain for the first definition with a truthy `enabled`, disagrees with the
	 * resolver's `isEnabledDefinition` wherever `enabled` is absent (D17: absent counts as
	 * enabled): a leaf definition with no `enabled` key displays while an *ancestor's* takes the
	 * write, silently and cross-collection. No re-derivation of a winner someone else picked can be
	 * kept from drifting.
	 */
	const commitScopeFor = (resolved: ResolvedVariable): CommitScope | null => {
		const target = variableTargetOf(resolved);
		if (!target) return null;

		if (target.scope === "global") {
			return {
				read: () =>
					queryClient.getQueryData<GlobalVariables>(queryKeys.globals.all)?.variables,
				write: (next) =>
					queryClient.setQueryData<GlobalVariables>(queryKeys.globals.all, (old) =>
						old ? { ...old, variables: next } : old
					),
				mutate: (next) => updateGlobalsMutation.mutateAsync({ variables: next }),
			};
		}

		const sourceId = target.id;
		if (target.scope === "environment") {
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
				mutate: (next) =>
					updateEnvironmentMutation.mutateAsync({ id: sourceId, variables: next }),
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
			mutate: (next) =>
				updateCollectionMutation.mutateAsync({ id: sourceId, variables: next }),
		};
	};

	return (name: string, resolved: ResolvedVariable, input: HTMLInputElement) => {
		const newValue = input.value;
		if (newValue === resolved.value) return;

		// A toast, not `reportFailed`: the input goes back to the stored value,
		// so no edit is left unsaved (`usePendingCommits`).
		const rollBack = (message: string) => {
			input.value = resolved.value;
			showToast(message, "error");
		};
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

		const next = mergeVariableChanges(stored ?? {}, {
			[name]: { ...previous, value: newValue },
		});
		scope.write(next);

		const settle = beginCommit();
		scope.mutate(next).then(
			() => settle("saved"),
			(error: unknown) => {
				// Restore this name alone, not the whole snapshot: another variable's commit may
				// have patched the map meanwhile, and replacing it wholesale would revert that one
				// too, the staleness the fresh read exists to avoid.
				const current = scope.read();
				if (current) scope.write(mergeVariableChanges(current, { [name]: previous }));
				const fallback = `Couldn't save {{${name}}}`;
				rollBack(error instanceof Error ? `${fallback} - ${error.message}` : fallback);
				settle(isDiskFullError(error) ? "disk-full" : "failed");
			}
		);
	};
}
