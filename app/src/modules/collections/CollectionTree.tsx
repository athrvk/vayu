/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef, useCallback, useMemo } from "react";
import { Folder, Plus, FolderPlus, Loader2, Download } from "lucide-react";
import { useTabsStore, useImportModalStore } from "@/stores";
import { useCollectionsStore } from "@/modules/collections/collections-store";
import { useCollectionsQuery, useMultipleCollectionRequests } from "@/queries";
import {
	Button,
	Input,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	DeleteConfirmDialog,
} from "@/components/ui";
import CollectionItem from "./CollectionItem";
import ExportSpecDialog from "./ExportSpecDialog";
import RunCollectionDialog from "./RunCollectionDialog";
import { useRovingTreeFocus } from "./useRovingTreeFocus";
import { useRevealActiveSelection } from "./useRevealActiveSelection";
import { useDeleteRefocus } from "./useDeleteRefocus";
import { useTreeCrud } from "./useTreeCrud";
import { useTreeDnd } from "./useTreeDnd";
import { MoveToDialog } from "./MoveToDialog";
import {
	CollectionTreeContext,
	type CollectionTreeContextValue,
} from "./context/CollectionTreeContext";
import { DrawerPanel, EmptyState, ErrorState, ListSkeleton } from "@/components/shared";
import type { Request } from "@/types";
import { compareTreeOrder } from "@/types";

export default function CollectionTree() {
	const openImport = useImportModalStore((s) => s.open);
	const { openTabs, activeTabId } = useTabsStore();
	const { expandedCollectionIds, expandCollections } = useCollectionsStore();
	const treeRef = useRef<HTMLDivElement>(null);
	const treeFocus = useRovingTreeFocus(treeRef);

	// Get selected collection and request IDs from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedCollectionId = activeTab?.type === "collection" ? activeTab.entityId : null;
	const selectedRequestId = activeTab?.type === "request" ? activeTab.entityId : null;

	// TanStack Query hooks
	// isError as well as isLoading. The query is destructured with `= []`, so a
	// failed fetch is indistinguishable from an empty workspace unless it is
	// asked about - and the empty state's "Add your first collection" would
	// invite a duplicate of collections that already exist.
	const {
		data: collections = [],
		isLoading: isLoadingCollections,
		isError: collectionsFailed,
		error: collectionsError,
		refetch: refetchCollections,
	} = useCollectionsQuery();

	// Fetch requests for ALL collections (prefetched data is already in cache)
	// This ensures the UI reflects the data immediately on load
	const allCollectionIds = collections.map((c) => c.id);
	const { requestsByCollection } = useMultipleCollectionRequests(allCollectionIds);

	const getRequestsByCollection = useCallback(
		(collectionId: string): Request[] => requestsByCollection.get(collectionId) ?? [],
		[requestsByCollection]
	);

	/*
	 * Roots are the collections with no parent *and* the ones whose parent is not
	 * loaded. An orphan used to match neither the roots filter nor any parent's
	 * children, so it rendered nowhere at all - which is precisely the shape a bad
	 * or half-applied reparent leaves behind, and the user saw a collection
	 * silently disappear rather than a tree that looked wrong. Degrading visibly
	 * is the point: the row is reachable, so it can be moved or deleted.
	 */
	const rootCollections = useMemo(() => {
		const loadedIds = new Set(collections.map((c) => c.id));
		return collections
			.filter((c) => !c.parentId || !loadedIds.has(c.parentId))
			.sort(compareTreeOrder);
	}, [collections]);

	const { revealEntity } = useRevealActiveSelection(treeRef, {
		selectedCollectionId,
		selectedRequestId,
		collections,
		requestsByCollection,
		expandedCollectionIds,
		expandCollections,
	});

	const { panel, rows } = useTreeCrud({
		collections,
		rootCollections,
		selectedCollectionId,
		requestsByCollection,
		getRequestsByCollection,
	});

	const deleteRefocus = useDeleteRefocus(treeRef, panel.deleteConfirm);

	/*
	 * A row mid-rename or mid-delete is neither a drag source nor a drop target:
	 * both states already own the row's input, and a move landing on a row that
	 * is about to disappear is the two-writers problem in its clearest form.
	 * Read from the CRUD slice rather than tracked again here - one source.
	 */
	const isRowBusy = useCallback(
		(entityId: string) =>
			entityId === rows.renamingId ||
			entityId === rows.renamingRequestId ||
			entityId === rows.deletingCollectionId ||
			entityId === rows.deletingRequestId,
		[rows.renamingId, rows.renamingRequestId, rows.deletingCollectionId, rows.deletingRequestId]
	);

	const { dnd, announcement, moveTarget, closeMoveDialog, moveToOwner } = useTreeDnd({
		collections,
		getRequestsByCollection,
		treeRef,
		isRowBusy,
		revealEntity,
	});

	const treeContext = useMemo<CollectionTreeContextValue>(
		() => ({
			allCollections: collections,
			expandedCollectionIds,
			selectedCollectionId,
			selectedRequestId,
			getRequestsByCollection,
			dnd,
			...rows,
		}),
		[
			collections,
			expandedCollectionIds,
			selectedCollectionId,
			selectedRequestId,
			getRequestsByCollection,
			dnd,
			rows,
		]
	);

	return (
		<DrawerPanel
			title="Collections"
			// h-7, not h-8: the header is the drawer's half of the 32px chrome
			// band now (it was a 40px header while the tab strip was up in the
			// title bar), and a 32px control in it fills the band edge to edge -
			// the hover fill lands on the rule underneath.
			actions={
				<>
					{/* No TooltipProvider - a bare nested one would reset this
					    subtree to Radix's 700ms, ignoring main.tsx. */}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={panel.openNewCollectionForm}
								disabled={panel.isCreatingCollection}
								className="h-7 w-7"
								aria-label="Add collection"
							>
								{panel.isCreatingCollection ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<FolderPlus className="w-4 h-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>Add collection</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={panel.createRequestFromToolbar}
								disabled={panel.isCreatingRequest}
								className="h-7 w-7"
								aria-label="Add request"
							>
								{panel.isCreatingRequest ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<Plus className="w-4 h-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{selectedCollectionId
								? `Add request in ${collections.find((c) => c.id === selectedCollectionId)?.name ?? "selected collection"}`
								: "Add request"}
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={openImport}
								className="h-7 w-7"
								aria-label="Import collection"
							>
								<Download className="w-4 h-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Import collection</TooltipContent>
					</Tooltip>
				</>
			}
		>
			<div ref={treeRef} className="flex h-full flex-col">
				{/* New Collection Form */}
				{/*
				 * px-3 pt-2 is not decorative. The DrawerPanel body scrolls
				 * (overflow-y-auto overflow-x-hidden) and is flush so rows run edge
				 * to edge, so it clips at its own edge - and this field's focus ring
				 * is drawn *outside* its border box. Flush against the top-left, the
				 * ring was clipped; the padding gives it room. Same fix the History
				 * search field uses (see HistoryList).
				 */}
				{panel.creatingCollection && (
					<div className="flex gap-2 mb-2 px-3 pt-2">
						<Input
							type="text"
							value={panel.newCollectionName}
							onChange={(e) => panel.setNewCollectionName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") panel.createCollection();
								if (e.key === "Escape") panel.cancelNewCollectionForm();
							}}
							placeholder="Collection name"
							className="flex-1 h-8 text-sm"
							disabled={panel.isCreatingCollection}
							autoFocus
						/>
						<Button
							size="sm"
							onClick={panel.createCollection}
							disabled={panel.isCreatingCollection}
						>
							{panel.isCreatingCollection && (
								<Loader2 className="w-3 h-3 animate-spin mr-1" />
							)}
							Add
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={panel.cancelNewCollectionForm}
							disabled={panel.isCreatingCollection}
						>
							Cancel
						</Button>
					</div>
				)}

				{/* Loading state */}
				{isLoadingCollections && <ListSkeleton rows={3} leading badge />}

				{/* Load failed - not the same as having none.
				    Gated on there being nothing cached: a background refetch can
				    fail while the tree still holds good data, and replacing a
				    working tree with an error pane would lose more than it
				    tells. */}
				{!isLoadingCollections && collectionsFailed && collections.length === 0 && (
					<ErrorState
						title="Couldn't load collections"
						detail={
							collectionsError instanceof Error ? collectionsError.message : undefined
						}
						onRetry={() => void refetchCollections()}
					/>
				)}

				{/* Zero collections empty state */}
				{!isLoadingCollections &&
					!collectionsFailed &&
					collections.length === 0 &&
					!panel.creatingCollection && (
						<EmptyState
							icon={Folder}
							title="No collections yet"
							description="Collections group related requests - make one to get started."
							action={
								<Button
									variant="link"
									onClick={panel.openNewCollectionForm}
									className="text-primary"
								>
									Add your first collection
								</Button>
							}
						/>
					)}

				{/* Root-level collections (no parent loaded) - sorted by order, scrollable.
			    role="tree" + roving tabindex: the whole tree is one tab stop and
			    arrow keys move between rows (see useRovingTreeFocus).
			    Everything a row needs beyond its own entity comes from the
			    context - see CollectionTreeContext for why it is not props. */}
				{!isLoadingCollections && rootCollections.length > 0 && (
					<div className="flex-1 min-h-0">
						{/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex - the tree is never a tab stop, useRovingTreeFocus.ts:118-123 seeds one row's `tabIndex={0}` and moves it */}
						<div
							role="tree"
							aria-label="Collections"
							onKeyDown={treeFocus.onKeyDown}
							onFocus={treeFocus.onFocus}
							className="space-y-0.5"
						>
							<CollectionTreeContext.Provider value={treeContext}>
								{rootCollections.map((collection, index) => (
									<CollectionItem
										key={collection.id}
										collection={collection}
										depth={0}
										posInSet={index + 1}
										setSize={rootCollections.length}
									/>
								))}
							</CollectionTreeContext.Provider>
						</div>
					</div>
				)}

				{/*
				 * The tree's live region, and it ships empty on purpose.
				 *
				 * A live region has to already be in the DOM for a change to it to
				 * be observed - mounting one alongside its first message is the
				 * classic way to ship an announcer that never announces (see
				 * ResponseAnnouncer, which carries the same constraint and the same
				 * markup). Keyboard move announcements are the first thing that will
				 * write here; until then the region exists and says nothing.
				 *
				 * Outside `role="tree"`: a tree's children are treeitems and groups,
				 * and this is neither.
				 */}
				<div
					role="status"
					aria-live="polite"
					// Explicit rather than left to role="status"'s implicit true -
					// one utterance of the whole message is what a single-line region
					// wants, and the Toaster shipped once assuming the wrong default.
					aria-atomic="true"
					className="sr-only"
					data-tree-live
				>
					{announcement}
				</div>

				<DeleteConfirmDialog
					open={!!panel.deleteConfirm}
					onOpenChange={(open) => !open && panel.dismissDeleteConfirm()}
					title={
						panel.deleteConfirm?.type === "collection"
							? "Delete collection?"
							: "Delete request?"
					}
					description={
						// What the engine does is a soft delete (issue #988): the row is
						// stamped and kept, and the Trash view (issue #989) is where it
						// is restored from. So the copy says where it went rather than
						// "cannot be undone", which stopped being true.
						panel.deleteConfirm?.type === "collection"
							? `"${panel.deleteConfirm?.name}" and all its requests will be moved to the Trash, where they can be restored.`
							: `"${panel.deleteConfirm?.name}" will be moved to the Trash, where it can be restored.`
					}
					onConfirm={panel.confirmDelete}
					// The row this dialog was opened from may stop existing, so
					// Radix's restore has nowhere to land (#1218). Where focus goes
					// follows the outcome: the row while it is still there, the
					// successor once the delete has actually removed it (#1234).
					onCloseAutoFocus={deleteRefocus.onCloseAutoFocus}
					isDeleting={panel.isDeleteInFlight}
				/>

				{/* Mounted only once a folder has been chosen, and unmounted when
				    the dialog closes - so the tree costs nothing for a feature
				    nobody has asked for, and each opening starts from the default
				    options rather than the previous folder's (see the prop note).
				    One dialog for the panel, never one per row: that would be a
				    Radix portal for every folder in the tree. */}
				{panel.runTarget && (
					<RunCollectionDialog
						collection={panel.runTarget}
						onOpenChange={(open) => !open && panel.dismissRunDialog()}
					/>
				)}

				{/* Mounted on the same terms as the run dialog above, and for the
				    same reasons: one per panel, only once a folder has been chosen,
				    and the mount is what resets the format choice. */}
				{panel.exportTarget && (
					<ExportSpecDialog
						collection={panel.exportTarget}
						onOpenChange={(open) => !open && panel.dismissExportDialog()}
					/>
				)}

				<MoveToDialog
					entity={moveTarget}
					collections={collections}
					onClose={closeMoveDialog}
					onMove={moveToOwner}
				/>
			</div>
		</DrawerPanel>
	);
}
