/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { useLayoutStore, useTabsStore, useSaveStore } from "@/stores";
import { DEFAULT_CONTEXT_BAR_WIDTH } from "@/constants/layout";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import {
	useRequestQuery,
	useUpdateGlobalsMutation,
	useUpdateEnvironmentMutation,
	useUpdateCollectionMutation,
} from "@/queries";
import { queryKeys } from "@/queries/keys";
import { Input } from "@/components/ui";
import type {
	Collection,
	Environment,
	GlobalVariables,
	ResolvedVariable,
	VariableValue,
} from "@/types";

interface ContextBarProps {
	mode?: "push" | "overlay";
}

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

/** The bar's single entry in the save-context registry. */
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
			if (useSaveStore.getState().status !== "error") useSaveStore.getState().completeSave();
		};
	}, [updateContext]);
}

export function ContextBar({ mode = "push" }: ContextBarProps) {
	const { contextBarOpen, setContextBarOpen, contextBarWidth, setContextBarWidth } =
		useLayoutStore();
	const { openTabs, activeTabId } = useTabsStore();
	const activeTab = openTabs.find((t) => t.id === activeTabId);

	// Resolve the active request's collection so collection-scope variables show up
	const { data: request } = useRequestQuery(
		activeTab?.type === "request" ? activeTab.entityId : null
	);
	const { getAllVariables } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});
	const variables = getAllVariables();

	const queryClient = useQueryClient();
	const updateGlobalsMutation = useUpdateGlobalsMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();
	const failSave = useSaveStore((s) => s.failSave);
	const beginCommit = usePendingCommits();

	if (!contextBarOpen || activeTab?.type !== "request") return null;

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

	/**
	 * Write the edited value back to the definition the bar displayed.
	 *
	 * Takes the input element, not the string, because every failure below has to
	 * put the old value back on screen. These inputs are uncontrolled -
	 * `defaultValue` with a `key` derived from the stored value - so a rejected
	 * save changes nothing: the cache is untouched, therefore the key is
	 * untouched, therefore React keeps the DOM node and the typed text sits there
	 * looking committed. Failures used to end here entirely (no `onError`, no
	 * `isError` reader, and there is no global `MutationCache.onError` either),
	 * which is the same defect `CollectionDetail/shared.tsx` documents for the
	 * collection tabs.
	 */
	const commitValue = (name: string, resolved: ResolvedVariable, input: HTMLInputElement) => {
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

	const entries = Object.entries(variables);

	return (
		<div
			className={cn(
				"flex flex-col shrink-0 border-l border-border bg-panel overflow-y-auto",
				mode === "overlay" ? "absolute right-0 top-0 bottom-0 shadow-lg z-10" : "relative"
			)}
			style={{ width: contextBarWidth }}
		>
			<PanelResizeHandle
				side="left"
				width={contextBarWidth}
				setWidth={setContextBarWidth}
				defaultWidth={DEFAULT_CONTEXT_BAR_WIDTH}
				label="Resize context bar"
			/>

			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
				<span className="text-xs font-medium text-foreground">Context</span>
				<button
					onClick={() => setContextBarOpen(false)}
					className="text-muted-foreground hover:text-foreground"
					aria-label="Close context bar"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			{/* Variables in scope */}
			<div className="p-3">
				<p className="text-xs font-medium text-muted-foreground mb-2">Variables in scope</p>
				{entries.length === 0 ? (
					<p className="text-xs text-muted-foreground">No variables in scope</p>
				) : (
					<div className="space-y-1">
						{/* Column headers - mirrors the key-value editor used for headers */}
						{/* <div className="grid grid-cols-2 gap-2 px-1 text-xs font-medium text-muted-foreground">
							<div>Variable</div>
							<div>Value</div>
						</div> */}
						{entries.map(([name, resolved]) => (
							<div key={name} className="grid grid-cols-2 gap-2 items-center">
								<span
									className="text-xs font-mono text-foreground truncate px-1"
									title={`{{${name}}} - ${resolved.scope} scope`}
								>
									{`${name}`}
								</span>
								{resolved.secret ? (
									<Input
										value="••••••"
										readOnly
										className="h-7 text-xs font-mono text-muted-foreground"
										title="Secret values can be edited from the Variables page"
									/>
								) : (
									<Input
										/*
										 * Scope and source belong in the key, not just the
										 * value. On the value alone, an environment switch
										 * or a Ctrl+N tab switch mid-edit that happens to
										 * resolve the same string kept the DOM node alive
										 * and let the blur write into the *newly* resolved
										 * definition. Including the source remounts the
										 * node instead, so an abandoned edit is dropped -
										 * the lesser outcome, and never a mistargeted one.
										 */
										key={`${name}:${resolved.scope}:${resolved.sourceId}:${resolved.value}`}
										defaultValue={resolved.value}
										className="h-7 text-xs font-mono"
										onBlur={(e) => commitValue(name, resolved, e.target)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.currentTarget.blur();
											} else if (e.key === "Escape") {
												e.currentTarget.value = resolved.value;
												e.currentTarget.blur();
											}
										}}
									/>
								)}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
