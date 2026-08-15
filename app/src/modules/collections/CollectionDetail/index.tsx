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
import { Tabs, TabsContent, TabsList, TabsTrigger, TabLabel, TabCount } from "@/components/ui";
import { DetailSkeleton, EmptyState, ErrorState } from "@/components/shared";
import { useCollectionsQuery, useRequestsQuery } from "@/queries/collections";
import { useTabsStore, useSessionStore } from "@/stores";
import AuthTab from "./AuthTab";
import DataTab from "./DataTab";
import InfoTab from "./InfoTab";
import MockServerControl from "./MockServerControl";
import ScriptTab from "./ScriptTab";
import VariablesTab from "./VariablesTab";

type CollectionTab = "info" | "auth" | "pre-script" | "post-script" | "variables" | "data";

const TABS: { id: CollectionTab; label: string }[] = [
	{ id: "info", label: "Info" },
	{ id: "auth", label: "Auth" },
	{ id: "pre-script", label: "Pre-request" },
	{ id: "post-script", label: "Post-request" },
	{ id: "variables", label: "Variables" },
	{ id: "data", label: "Data" },
];

/**
 * Tabs that hold an unsaved draft, and therefore must not be torn down when the
 * user looks at a sibling.
 *
 * These four use the manual save-button model (`useEntityDraft`), which keeps
 * the draft in component state. Radix unmounts an inactive `TabsContent`, so
 * writing a script, glancing at Auth and coming back used to lose the script -
 * no save, no prompt, no trace. Keeping them mounted is the same fix, for the
 * same reason, as the request builder's body drafts living in its provider
 * rather than in `BodyPanel` (see `request-builder/utils/body-drafts.ts`).
 *
 * `variables` is absent deliberately: it autosaves and registers its own save
 * context on mount, so keeping it alive behind another tab would leave the
 * variables editor claiming Ctrl/Cmd+S while something else is on screen.
 *
 * `data` is absent for the opposite reason: it saves explicitly, per action, and
 * the only thing it holds between actions is a parsed file - which is user data
 * of unknown sensitivity, so letting it outlive a look at another tab is a cost
 * with nothing bought.
 */
const TABS_HOLDING_DRAFTS: ReadonlySet<CollectionTab> = new Set([
	"info",
	"auth",
	"pre-script",
	"post-script",
]);

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
	// Panels are force-mounted from their first visit onwards, not from mount:
	// a draft can only exist in a tab the user has opened, and two of these
	// carry a Monaco editor that costs nothing while nobody has asked for it.
	const [visited, setVisited] = useState<ReadonlySet<CollectionTab>>(() => new Set(["info"]));

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
	// Same affordance as the variables count, for the same reason: whether a
	// collection declares a data contract is worth knowing without opening the
	// tab to find out.
	const declaredColumnCount = collection.dataSchema?.columns?.length ?? 0;

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Header */}
			<div className="flex items-center gap-2.5 h-[52px] px-5 bg-panel border-b border-border shrink-0">
				<Folder className="w-[15px] h-[15px] text-primary shrink-0" />
				<span className="text-sm font-semibold text-foreground">{collection.name}</span>
				<span className="text-xs text-muted-foreground">
					- {requests.length} request{requests.length !== 1 ? "s" : ""}
				</span>
				{/* Right-aligned, because it is an action on the collection rather
				    than part of its identity. It knows nothing about the tabs
				    below: a mock serves the whole subtree, which is a property of
				    the collection, not of whichever tab is open. */}
				<div className="ml-auto flex min-w-0 items-center">
					<MockServerControl collectionId={collection.id} />
				</div>
			</div>

			{/* Tab bar */}
			<Tabs
				value={tab}
				onValueChange={(v) => {
					const next = v as CollectionTab;
					setTab(next);
					setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
				}}
				className="flex-1 flex flex-col overflow-hidden"
			>
				{/* The active trigger's weight change used to shift its neighbours
				    on every switch; TabLabel reserves the bold width, so it no
				    longer can. */}
				<TabsList className="bg-panel px-4 shrink-0 overflow-x-auto overflow-y-hidden flex-nowrap">
					{TABS.map((t) => {
						const count =
							t.id === "variables"
								? variableCount
								: t.id === "data"
									? declaredColumnCount
									: 0;
						return (
							<TabsTrigger key={t.id} value={t.id}>
								<TabLabel>{t.label}</TabLabel>
								{count > 0 && <TabCount value={count} />}
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
						// A force-mounted panel is kept alive rather than unmounted,
						// which is what lets the draft survive. Radix leaves it
						// *visible* too - our TabsContent hides an inactive one on
						// `data-state`; see components/ui/tabs.tsx.
						forceMount={
							TABS_HOLDING_DRAFTS.has(t.id) && visited.has(t.id) ? true : undefined
						}
						className="mt-0 flex-1 overflow-auto p-6 bg-background"
					>
						{t.id === "info" && (
							<InfoTab
								collection={collection}
								requestCount={requests.length}
								active={tab === "info"}
							/>
						)}
						{t.id === "auth" && (
							<AuthTab collection={collection} active={tab === "auth"} />
						)}
						{t.id === "pre-script" && (
							<ScriptTab
								collection={collection}
								kind="pre"
								active={tab === "pre-script"}
							/>
						)}
						{t.id === "post-script" && (
							<ScriptTab
								collection={collection}
								kind="post"
								active={tab === "post-script"}
							/>
						)}
						{t.id === "variables" && <VariablesTab collection={collection} />}
						{t.id === "data" && <DataTab collection={collection} />}
					</TabsContent>
				))}
			</Tabs>
		</div>
	);
}
