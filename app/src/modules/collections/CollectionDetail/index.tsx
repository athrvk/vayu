/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Tab shell for the Collection Detail screen. Reached via
 * navigation-store.navigateToCollection(collectionId).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder } from "lucide-react";
import {
	HeadingSection,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	TabLabel,
	TabCount,
} from "@/components/ui";
import { DetailSkeleton, EmptyState, ErrorState, TabBreadcrumb } from "@/components/shared";
import { useCollectionsQuery, useMultipleCollectionRequests } from "@/queries/collections";
import { collectSubtreeIds, walkAncestors } from "@/modules/collections/tree-utils";
import { useTabsStore, useSessionStore } from "@/stores";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import AuthTab from "./AuthTab";
import DataTab from "./DataTab";
import ElementsTab from "./ElementsTab";
import InfoTab from "./InfoTab";
import MockServerControl from "./MockServerControl";
import SpecTab from "./SpecTab";
import VariablesTab from "./VariablesTab";
import { pluralize } from "@/modules/dashboard/utils/format";

export type CollectionTab = "info" | "auth" | "elements" | "variables" | "data" | "spec";

const TABS: { id: CollectionTab; label: string }[] = [
	{ id: "info", label: "Info" },
	{ id: "auth", label: "Auth" },
	{ id: "elements", label: "Elements" },
	{ id: "variables", label: "Variables" },
	{ id: "data", label: "Data" },
	{ id: "spec", label: "Spec" },
];

/**
 * Tabs holding an unsaved draft (`useEntityDraft`), which must not be torn down while the user
 * looks at a sibling: Radix unmounts an inactive `TabsContent`. The draft itself lives in
 * `entity-draft-store` (#3459), which carries it across `Shell.tsx` unmounting this whole screen;
 * keeping a visited panel mounted keeps what that store does not hold, the editors' own undo
 * history and scroll position.
 *
 * `variables` is absent deliberately: it autosaves and registers its own save context on mount, so
 * kept alive behind another tab it would claim Ctrl/Cmd+S while something else is on screen.
 *
 * `data` is absent for the opposite reason: it saves per gesture (a pick, a Remove), and all it
 * holds between actions is a parsed file, user data of unknown sensitivity, so letting it outlive a
 * look at another tab costs something and buys nothing. `spec` likewise: binding is an explicit
 * action, and what it holds between actions is a whole OpenAPI document read from disk.
 */
const TABS_HOLDING_DRAFTS: ReadonlySet<CollectionTab> = new Set(["info", "auth", "elements"]);

const withVisited = (visited: ReadonlySet<CollectionTab>, tab: CollectionTab) =>
	visited.has(tab) ? visited : new Set(visited).add(tab);

export default function CollectionDetail() {
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const takeNavIntent = useTabsStore((s) => s.takeNavIntent);
	const openTab = useTabsStore((s) => s.openTab);

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
	/*
	 * The whole subtree, not this collection's own requests (issue #723): an OpenAPI import files
	 * its requests under one sub-collection per tag, so a spec-bound root owns none directly and
	 * would read "0 requests" above a mock serving a thousand routes. Every other surface here
	 * means the subtree by "this collection" (the mock toggle serves it, the Run dialog runs it,
	 * the export walks it, the Spec tab counts it), and the count says the same rather than naming
	 * a narrower set.
	 *
	 * No extra fetches in practice: `CollectionTree` already holds a query per collection, so these
	 * resolve from the cache the sidebar filled.
	 */
	const subtreeIds = useMemo(
		() => (selectedCollectionId ? collectSubtreeIds(selectedCollectionId, collections) : []),
		[selectedCollectionId, collections]
	);
	const { requestsByCollection } = useMultipleCollectionRequests(subtreeIds);
	const requestCount = useMemo(
		() => [...requestsByCollection.values()].reduce((total, r) => total + r.length, 0),
		[requestsByCollection]
	);

	const collection = useMemo(
		() => collections.find((c) => c.id === selectedCollectionId) ?? null,
		[collections, selectedCollectionId]
	);

	/*
	 * Where this collection sits, above the tab strip (#1691), only for a nested collection: for a
	 * root one the chain is a line repeating the header title. A parent segment opens that
	 * collection's tab; the last is inert, as you are already there and renaming is the Info tab's
	 * job. Walked from the collections in hand rather than `useCollectionAncestors`: this screen
	 * holds the whole list for its subtree count, so it is one memo, not a second query
	 * subscription over the same data; `walkAncestors` carries the cycle guard.
	 */
	const ancestors = useMemo(
		() => (selectedCollectionId ? walkAncestors(selectedCollectionId, collections) : []),
		[selectedCollectionId, collections]
	);
	const crumbs = useMemo(
		() =>
			ancestors.length > 1
				? ancestors.map((entry, index) => ({
						id: entry.id,
						label: entry.name,
						onSelect:
							index < ancestors.length - 1
								? () => openTab({ type: "collection", entityId: entry.id })
								: undefined,
					}))
				: [],
		[ancestors, openTab]
	);

	/*
	 * Kept per collection id (`tab-selection-store`), so the active sub-tab survives `Shell.tsx`
	 * unmounting this screen when its workspace tab is not on screen. `CollectionDetail` is not
	 * remounted on a switch to a sibling collection's tab (`DataTab` needs the same fact), so the
	 * derived-during-render sync below restores it on every collection change too.
	 */
	const getCollectionTab = useTabSelectionStore((s) => s.getCollectionTab);
	const setCollectionTab = useTabSelectionStore((s) => s.setCollectionTab);
	const storedTab = useTabSelectionStore((s) =>
		selectedCollectionId ? (s.collectionTab.get(selectedCollectionId) ?? null) : null
	);
	const initialTab = (): CollectionTab =>
		(selectedCollectionId ? getCollectionTab(selectedCollectionId) : null) ?? "info";
	const [tab, setTabState] = useState<CollectionTab>(initialTab);
	const setTab = useCallback(
		(next: CollectionTab) => {
			setTabState(next);
			if (selectedCollectionId) setCollectionTab(selectedCollectionId, next);
		},
		[selectedCollectionId, setCollectionTab]
	);
	// Panels force-mount from their first visit, not from mount: a draft exists only in a tab the
	// user has opened, and two of these carry a Monaco editor that costs nothing until asked for.
	// Seeded from the restored tab, not a bare "info": a restored "elements" tab paints its panel
	// this render, and an unseeded `visited` would drop it, and the draft `TABS_HOLDING_DRAFTS`
	// protects, the moment the user glanced at a sibling tab.
	const [visited, setVisited] = useState<ReadonlySet<CollectionTab>>(
		() => new Set([initialTab()])
	);

	/*
	 * The `useState` initializer runs once, for the first collection this screen rendered; a later
	 * collection shown without a remount (the sibling-tab switch above) needs this
	 * derived-during-render sync, the shape of `RequestBuilderProvider`'s per-request reset, so the
	 * previous collection's tab never paints a frame under the new one.
	 */
	const [tabSyncedFor, setTabSyncedFor] = useState(selectedCollectionId);
	if (selectedCollectionId !== tabSyncedFor) {
		setTabSyncedFor(selectedCollectionId);
		const next = initialTab();
		setTabState(next);
		setVisited((prev) => withVisited(prev, next));
	} else if (storedTab && storedTab !== tab) {
		// A write from outside this screen (`setCollectionTab`) while it is already on this
		// collection, such as the import toast's "Review import notes"; every write of our own
		// updates both, so a mismatch here is someone else's.
		setTabState(storedTab);
		setVisited((prev) => withVisited(prev, storedTab));
	}

	/*
	 * Something outside this screen pointed at a collection's Spec tab (the import dialog, offering
	 * Sync for a document that is already bound, issue #680). The store carries the collection
	 * rather than the section, as `openTab` can only name a collection and which sub-tab shows is
	 * state that lives here.
	 *
	 * Taken once acted on, so a later visit to the same collection opens on Info like any other;
	 * the store drops it itself when the next navigation is not this one. It cannot be derived
	 * away: the intent must survive this tab mounting for the first time, and the tab it selects
	 * must stay put when the intent is taken, so the state is handed over once per navigation, not
	 * mirrored per render.
	 */
	const specRequested = useTabsStore(
		(s) => s.navIntent?.kind === "spec" && s.navIntent.target === selectedCollectionId
	);
	useEffect(() => {
		if (!specRequested || !selectedCollectionId) return;
		if (!takeNavIntent("spec", selectedCollectionId)) return;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- see above
		setTab("spec");
		setVisited((prev) => withVisited(prev, "spec"));
	}, [specRequested, selectedCollectionId, takeNavIntent, setTab]);

	// Loading and missing are different answers: `collections` defaults to `[]`, so a collection
	// tab restored from a previous session resolves to nothing while its query is in flight, and
	// "your collection is gone" is worse than "nothing yet".
	if (collectionsLoading) {
		return <DetailSkeleton label="Loading collection" />;
	}

	// Failed is the third answer, the most damaging to get wrong here: "Collection not found"
	// asserts a deletion when a fetch failed. Only with no collection to show: TanStack keeps the
	// last good data through a failed background refetch, and an error in place of a working pane
	// takes away more than it tells.
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
			<div className="flex items-center gap-2.5 h-band-lg px-5 bg-panel border-b border-rule shrink-0">
				<Folder className="size-icon text-primary shrink-0" />
				<h1 className="text-sm font-semibold text-foreground">{collection.name}</h1>
				<span className="text-xs text-muted-foreground">
					- {requestCount} {pluralize(requestCount, "request")}
				</span>
				{/* Right-aligned, because it is an action on the collection rather
				    than part of its identity. It knows nothing about the tabs
				    below: a mock serves the whole subtree, which is a property of
				    the collection, not of whichever tab is open. */}
				<div className="ml-auto flex min-w-0 items-center">
					<MockServerControl collectionId={collection.id} />
				</div>
			</div>

			<TabBreadcrumb label="Collection location" crumbs={crumbs} className="px-5 pt-2" />

			{/* Tab bar, and the tabs: a section under the collection's `h1` (#3498). */}
			<HeadingSection>
				<Tabs
					value={tab}
					onValueChange={(v) => {
						const next = v as CollectionTab;
						setTab(next);
						setVisited((prev) => withVisited(prev, next));
					}}
					className="flex-1 flex flex-col overflow-hidden"
				>
					{/* TabLabel reserves the bold width, so the active trigger's weight
				    change cannot shift its neighbours. */}
					<TabsList
						variant="pane"
						className="shrink-0 overflow-x-auto overflow-y-hidden flex-nowrap scrollbar-strip"
					>
						{TABS.map((t) => {
							/*
							 * Two of the six can carry a count and always render `TabCount`, which
							 * animates its own track open from zero width, so the first variable
							 * grows in rather than pushing Data and Spec rightward, and costs
							 * nothing with nothing to count. The other four render no `TabCount`
							 * and pay no width, ever.
							 */
							const counted = t.id === "variables" || t.id === "data";
							const count =
								t.id === "variables" ? variableCount : declaredColumnCount;
							return (
								<TabsTrigger key={t.id} value={t.id}>
									<TabLabel>{t.label}</TabLabel>
									{counted && <TabCount value={count} />}
								</TabsTrigger>
							);
						})}
					</TabsList>

					{/*
					 * TabsContent per tab, keyed off the triggers' TABS list: Radix derives each
					 * trigger's aria-controls from its value, so content outside the Tabs tree
					 * leaves every trigger pointing at a panel id never rendered. Only the active
					 * panel mounts, so the switch below resolves to exactly one tab.
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
								TABS_HOLDING_DRAFTS.has(t.id) && visited.has(t.id)
									? true
									: undefined
							}
							className="mt-0 flex-1 overflow-auto p-6 bg-background"
						>
							{/* The draft editors are keyed too: a draft left dirty on
						    the collection switched away from keeps saving through
						    its editor's mutation observer (`useDraftSaveContext`'s
						    `detach`), and one observer shared with the next
						    collection would paint that save's failure there. */}
							{t.id === "info" && (
								<InfoTab
									key={collection.id}
									collection={collection}
									requestCount={requestCount}
									active={tab === "info"}
								/>
							)}
							{t.id === "auth" && (
								<AuthTab
									key={collection.id}
									collection={collection}
									active={tab === "auth"}
								/>
							)}
							{t.id === "elements" && (
								<ElementsTab
									key={collection.id}
									collection={collection}
									active={tab === "elements"}
								/>
							)}
							{t.id === "variables" && <VariablesTab collection={collection} />}
							{/* Keyed: the Data tab reads the remembered file on mount
						    (issue #727), and this component is not remounted when
						    the user switches to another collection's tab - so
						    without a key, collection B would show A's file and
						    never open its own. It holds no draft to lose. */}
							{t.id === "data" && (
								<DataTab key={collection.id} collection={collection} />
							)}
							{t.id === "spec" && <SpecTab collection={collection} />}
						</TabsContent>
					))}
				</Tabs>
			</HeadingSection>
		</div>
	);
}
