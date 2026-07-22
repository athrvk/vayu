/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { useLayoutStore, useTabsStore, useSessionStore } from "@/stores";
import { DEFAULT_CONTEXT_BAR_WIDTH } from "@/constants/layout";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import {
	useRequestQuery,
	useCollectionsQuery,
	useEnvironmentsQuery,
	useGlobalsQuery,
	useUpdateGlobalsMutation,
	useUpdateEnvironmentMutation,
	useUpdateCollectionMutation,
} from "@/queries";
import { Input } from "@/components/ui";
import type { Collection, ResolvedVariable } from "@/types";

interface ContextBarProps {
	mode?: "push" | "overlay";
}

/** Leaf-first ancestor chain for a collection (inclusive of the collection itself). */
function buildLeafFirstChain(startId: string, collections: Collection[]): Collection[] {
	const chain: Collection[] = [];
	let currentId: string | undefined = startId;
	while (currentId) {
		const col = collections.find((c) => c.id === currentId);
		if (!col) break;
		chain.push(col);
		currentId = col.parentId;
	}
	return chain;
}

export function ContextBar({ mode = "push" }: ContextBarProps) {
	const { contextBarOpen, setContextBarOpen, contextBarWidth, setContextBarWidth } =
		useLayoutStore();
	const { openTabs, activeTabId } = useTabsStore();
	const { activeEnvironmentId } = useSessionStore();
	const activeTab = openTabs.find((t) => t.id === activeTabId);

	// Resolve the active request's collection so collection-scope variables show up
	const { data: request } = useRequestQuery(
		activeTab?.type === "request" ? activeTab.entityId : null
	);
	const { getAllVariables } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});
	const variables = getAllVariables();

	const { data: globalsData } = useGlobalsQuery();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();
	const updateGlobalsMutation = useUpdateGlobalsMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();

	if (!contextBarOpen || activeTab?.type !== "request") return null;

	// Write the edited value back to the scope the resolved variable came from
	const commitValue = (name: string, resolved: ResolvedVariable, newValue: string) => {
		if (newValue === resolved.value) return;

		if (resolved.scope === "global") {
			const vars = globalsData?.variables;
			if (!vars?.[name]) return;
			updateGlobalsMutation.mutate({
				variables: { ...vars, [name]: { ...vars[name], value: newValue } },
			});
			return;
		}

		if (resolved.scope === "environment") {
			const env = environments.find((e) => e.id === activeEnvironmentId);
			if (!env?.variables?.[name]) return;
			updateEnvironmentMutation.mutate({
				id: env.id,
				variables: {
					...env.variables,
					[name]: { ...env.variables[name], value: newValue },
				},
			});
			return;
		}

		// Collection scope: the leaf-most enabled definition is the one shown
		if (request?.collectionId) {
			const chain = buildLeafFirstChain(request.collectionId, collections);
			const source = chain.find((col) => col.variables?.[name]?.enabled);
			if (!source?.variables) return;
			updateCollectionMutation.mutate({
				id: source.id,
				variables: {
					...source.variables,
					[name]: { ...source.variables[name], value: newValue },
				},
			});
		}
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
										key={`${name}:${resolved.value}`}
										defaultValue={resolved.value}
										className="h-7 text-xs font-mono"
										onBlur={(e) => commitValue(name, resolved, e.target.value)}
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
