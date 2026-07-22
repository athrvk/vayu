/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * CollectionDetail
 *
 * Tab shell for the Collection Detail screen. Reached via
 * navigation-store.navigateToCollection(collectionId).
 */

import { useEffect, useMemo, useState } from "react";
import { Folder } from "lucide-react";
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { DetailSkeleton, EmptyState, ErrorState } from "@/components/shared";
import { useCollectionsQuery, useRequestsQuery } from "@/queries/collections";
import { useTabsStore, useSessionStore } from "@/stores";
import AuthTab from "./AuthTab";
import InfoTab from "./InfoTab";
import ScriptTab from "./ScriptTab";
import VariablesTab from "./VariablesTab";

type CollectionTab = "info" | "auth" | "pre-script" | "post-script" | "variables";

const TABS: { id: CollectionTab; label: string }[] = [
	{ id: "info", label: "Info" },
	{ id: "auth", label: "Auth" },
	{ id: "pre-script", label: "Pre-request" },
	{ id: "post-script", label: "Post-request" },
	{ id: "variables", label: "Variables" },
];

export default function CollectionDetail() {
	const { openTabs, activeTabId } = useTabsStore();

	// Get selected collection ID from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedCollectionId = activeTab?.type === "collection" ? activeTab.entityId : null;

	// Remember the collection the user is working in (see RequestBuilder).
	const setLastCollectionId = useSessionStore((s) => s.setLastCollectionId);
	useEffect(() => {
		if (selectedCollectionId) setLastCollectionId(selectedCollectionId);
	}, [selectedCollectionId, setLastCollectionId]);

	const {
		data: collections = [],
		isLoading: collectionsLoading,
		isError: collectionsFailed,
		error: collectionsError,
		refetch: refetchCollections,
	} = useCollectionsQuery();
	const { data: requests = [] } = useRequestsQuery(selectedCollectionId);

	const collection = useMemo(
		() => collections.find((c) => c.id === selectedCollectionId) ?? null,
		[collections, selectedCollectionId]
	);

	const [tab, setTab] = useState<CollectionTab>("info");

	// Loading and missing are different answers. `collections` defaults to `[]`,
	// so a collection tab restored from a previous session resolves to nothing
	// while its query is still in flight - and telling the user their collection
	// is gone is worse than telling them nothing yet.
	if (collectionsLoading) {
		return <DetailSkeleton label="Loading collection" />;
	}

	// Failed is the third answer, and here the most damaging one to get wrong:
	// "Collection not found" asserts that the thing the user opened has been
	// deleted, when all that happened is a fetch failed.
	//
	// Gated on there being no collection to show. TanStack keeps the last good
	// data through a failed background refetch, and swapping a working pane for
	// an error would take away more than it tells.
	if (collectionsFailed && !collection) {
		return (
			<ErrorState
				title="Couldn't load the collection"
				detail={collectionsError instanceof Error ? collectionsError.message : undefined}
				onRetry={() => void refetchCollections()}
			/>
		);
	}

	if (!collection) {
		return <EmptyState title="Collection not found" />;
	}

	const variableCount = Object.keys(collection.variables ?? {}).length;

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Header */}
			<div className="flex items-center gap-2.5 h-[52px] px-5 bg-panel border-b border-border shrink-0">
				<Folder className="w-[15px] h-[15px] text-primary shrink-0" />
				<span className="text-[14px] font-semibold text-foreground">{collection.name}</span>
				<span className="text-xs text-muted-foreground">
					- {requests.length} request{requests.length !== 1 ? "s" : ""}
				</span>
			</div>

			{/* Tab bar */}
			<Tabs
				value={tab}
				onValueChange={(v) => setTab(v as CollectionTab)}
				className="flex-1 flex flex-col overflow-hidden"
			>
				<TabsList className="flex justify-start h-auto p-0 bg-panel border-b border-border rounded-none px-5 shrink-0 overflow-x-auto overflow-y-hidden flex-nowrap">
					{TABS.map((t) => {
						const showBadge = t.id === "variables" && variableCount > 0;
						return (
							<TabsTrigger
								key={t.id}
								value={t.id}
								className="shrink-0 relative px-3 py-2.5 text-xs font-medium border-b-2 border-transparent rounded-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-semibold"
							>
								{t.label}
								{showBadge && (
									<Badge
										variant="secondary"
										className="ml-1.5 h-[18px] min-w-[20px] px-1.5 text-[10px]"
									>
										{variableCount}
									</Badge>
								)}
							</TabsTrigger>
						);
					})}
				</TabsList>

				{/*
				 * TabsContent per tab, keyed off the same TABS list as the
				 * triggers. Radix derives each trigger's aria-controls from its
				 * value, so content in a plain <div> outside the Tabs tree left
				 * every trigger pointing at a panel id that was never rendered.
				 * Only the active panel mounts, so the switch below still resolves
				 * to exactly one tab.
				 */}
				{TABS.map((t) => (
					<TabsContent
						key={t.id}
						value={t.id}
						className="mt-0 flex-1 overflow-auto p-6 bg-background"
					>
						{t.id === "info" && (
							<InfoTab collection={collection} requestCount={requests.length} />
						)}
						{t.id === "auth" && <AuthTab collection={collection} />}
						{t.id === "pre-script" && <ScriptTab collection={collection} kind="pre" />}
						{t.id === "post-script" && (
							<ScriptTab collection={collection} kind="post" />
						)}
						{t.id === "variables" && <VariablesTab collection={collection} />}
					</TabsContent>
				))}
			</Tabs>
		</div>
	);
}
