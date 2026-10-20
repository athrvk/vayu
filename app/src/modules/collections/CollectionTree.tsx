/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef, useCallback, useEffect, useMemo } from "react";
import { Folder, Plus, FolderPlus, Loader2, Download } from "lucide-react";
import { useTabsStore, useImportModalStore, useSessionStore } from "@/stores";
import { useCollectionsStore } from "@/modules/collections/collections-store";
import { useCollectionsQuery, useMultipleCollectionRequests } from "@/queries";
import { useNewRequest } from "@/hooks/useNewRequest";
import { CollectionPicker } from "@/modules/welcome/components/CollectionPicker";
import { resolveNewRequestTarget } from "@/modules/welcome/targetCollection";
import {
	Button,
	Input,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	DeleteConfirmDialog,
	DialogCancelButton,
	ICON_MOTION,
} from "@/components/ui";
import CollectionTreeRows from "./CollectionTreeRows";
import { flattenVisibleRows } from "./tree-rows";
import ExportSpecDialog from "./ExportSpecDialog";
import ExportPostmanDialog from "./ExportPostmanDialog";
import RunCollectionDialog from "./RunCollectionDialog";
import { useRovingTreeFocus } from "./useRovingTreeFocus";
import { useRevealActiveSelection } from "./useRevealActiveSelection";
import { useDeleteRefocus } from "./useDeleteRefocus";
import { useTreeCrud } from "./useTreeCrud";
import { useTreeDnd } from "./useTreeDnd";
import { MoveToDialog } from "./MoveToDialog";
import type { CollectionTreeHandlers, CollectionTreeState } from "./context/CollectionTreeContext";
import { CollectionTreeProviders } from "./context/CollectionTreeProviders";
import { DrawerPanel, EmptyState, ErrorState, ListSkeleton } from "@/components/shared";
import type { Request } from "@/types";
import { isCommitEnter } from "@/lib/keyboard";

export default function CollectionTree() {
	const openImport = useImportModalStore((s) => s.open);
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const expandedCollectionIds = useCollectionsStore((s) => s.expandedCollectionIds);
	const expandCollections = useCollectionsStore((s) => s.expandCollections);
	const treeRef = useRef<HTMLDivElement>(null);
	const treeFocus = useRovingTreeFocus(treeRef);

	// Get selected collection and request IDs from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedCollectionId = activeTab?.type === "collection" ? activeTab.entityId : null;
	const selectedRequestId = activeTab?.type === "request" ? activeTab.entityId : null;

	// TanStack Query hooks
	// isError as well as isLoading. The query is destructured with `= []`, so a
	// failed fetch is indistinguishable from an empty workspace unless it is
	// asked about - and the empty state's "New collection" would invite a
	// duplicate of collections that already exist.
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

	const { revealEntity } = useRevealActiveSelection(treeRef, {
		selectedCollectionId,
		selectedRequestId,
		collections,
		requestsByCollection,
		expandedCollectionIds,
		expandCollections,
	});

	const { panel, handlers, rowState, folderDraft } = useTreeCrud({
		collections,
		requestsByCollection,
		getRequestsByCollection,
	});

	const creatingSubfolder = rowState.creatingSubfolder;
	const rows = useMemo(
		() =>
			flattenVisibleRows({
				collections,
				getRequestsByCollection,
				expandedCollectionIds,
				creatingSubfolder,
			}),
		[collections, getRequestsByCollection, expandedCollectionIds, creatingSubfolder]
	);

	/*
	 * The toolbar's "+" asks the same question every other "New request" entry
	 * point asks, so it cannot disagree with them about where the request lands.
	 * One thing outranks that rule here: a collection's own tab being open says
	 * which collection the user is in, and the button is on that collection's
	 * screen. Only a collection that still exists counts - a tab can outlive it.
	 */
	const { newRequest, isCreating, pickerProps } = useNewRequest();
	const lastCollectionId = useSessionStore((s) => s.lastCollectionId);
	const tabCollection = collections.find((c) => c.id === selectedCollectionId);
	/*
	 * The collection the button would fill, when that is not a guess: the open
	 * tab's, or the one the rule resolves to without asking. Null when it would
	 * ask or create, and the tooltip then names nothing rather than a collection
	 * the click might not use.
	 */
	const addRequestTarget = useMemo(() => {
		if (tabCollection) return tabCollection;
		const target = resolveNewRequestTarget(lastCollectionId, collections);
		if (target.kind !== "collection") return null;
		return collections.find((c) => c.id === target.collectionId) ?? null;
	}, [tabCollection, lastCollectionId, collections]);
	const isAddingRequest = isCreating || panel.isCreatingRequest;

	/*
	 * The row the open delete dialog would remove. Collections and requests carry
	 * their ids on different attributes, which is the one thing the shared
	 * refocus hook cannot know for a tree.
	 */
	const doomedRowSelector = panel.deleteConfirm
		? `[${panel.deleteConfirm.type === "collection" ? "data-collection-id" : "data-request-id"}="${CSS.escape(panel.deleteConfirm.id)}"]`
		: null;

	/*
	 * A collection or request delete is a soft delete (issue #988) with an
	 * undo toast already offered on completion (`useTreeCrud`'s `offerUndo`),
	 * so a blocking dialog in front of it is friction with nothing to protect
	 * against - the UX writing guide's own rule for a recoverable action. The
	 * one exception is a collection with a running mock server: stopping that
	 * mock is not undone by Undo (it is engine-process state, not a database
	 * row), so that one case keeps asking first.
	 */
	const deleteNeedsConfirm =
		panel.deleteConfirm?.type === "collection" &&
		!!panel.deleteConfirm.runningMocks &&
		panel.deleteConfirm.runningMocks.length > 0;

	/*
	 * Where focus goes when the deleted row was the only one in the tree - the
	 * one case the tree's own rule cannot answer, since a root otherwise falls
	 * back to the root before it. "Add collection" is the nearest surviving
	 * control, and the one thing left to do on an emptied tree.
	 */
	const addCollectionRef = useRef<HTMLButtonElement>(null);

	const deleteRefocus = useDeleteRefocus(treeRef, doomedRowSelector, addCollectionRef);

	/*
	 * Skips the dialog for the common case by confirming on its own the instant
	 * a delete that needs no confirmation is requested. `deleteConfirm` is still
	 * set first so `doomedRowSelector` captures the row for focus restoration
	 * while it is on screen, and this effect is declared after
	 * `useDeleteRefocus` so that capture has run by the time `awaitRemoval`
	 * reads it - with no dialog there is no close to arm the refocus from.
	 * Re-runs while the delete is in flight are harmless: `confirmDelete` refuses
	 * a second delete until the first settles, and once it does, `panel`'s own
	 * memo picks up the cleared `deletingCollectionId`/`deletingRequestId` and
	 * gives this effect a fresh reference to run again - which is what lets a
	 * delete requested mid-flight (still sitting in `deleteConfirm`, per the
	 * guarded clear in `useTreeCrud`) actually go through once its turn comes.
	 */
	useEffect(() => {
		if (!panel.deleteConfirm || deleteNeedsConfirm) return;
		deleteRefocus.awaitRemoval();
		panel.confirmDelete();
	}, [panel, deleteNeedsConfirm, deleteRefocus]);

	/*
	 * A row mid-rename or mid-delete is neither a drag source nor a drop target:
	 * both states already own the row's input, and a move landing on a row that
	 * is about to disappear is the two-writers problem in its clearest form.
	 * Read from the CRUD slice rather than tracked again here - one source.
	 */
	const isRowBusy = useCallback(
		(entityId: string) =>
			entityId === rowState.renamingId ||
			entityId === rowState.renamingRequestId ||
			entityId === rowState.deletingCollectionId ||
			entityId === rowState.deletingRequestId,
		[rowState]
	);

	const { dnd, announcement, moveTarget, closeMoveDialog, moveToOwner } = useTreeDnd({
		collections,
		getRequestsByCollection,
		treeRef,
		isRowBusy,
		revealEntity,
	});

	const treeHandlers = useMemo<CollectionTreeHandlers>(
		() => ({ ...handlers, dnd }),
		[handlers, dnd]
	);

	const treeState = useMemo<CollectionTreeState>(
		() => ({
			...rowState,
			allCollections: collections,
			expandedCollectionIds,
			selectedCollectionId,
			selectedRequestId,
			getRequestsByCollection,
		}),
		[
			rowState,
			collections,
			expandedCollectionIds,
			selectedCollectionId,
			selectedRequestId,
			getRequestsByCollection,
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
								ref={addCollectionRef}
								variant="ghost"
								size="icon"
								onClick={panel.openNewCollectionForm}
								disabled={panel.isCreatingCollection}
								aria-label="Add collection"
							>
								{panel.isCreatingCollection ? (
									<Loader2 className="size-icon animate-spin" />
								) : (
									<FolderPlus className="size-icon" />
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
								onClick={() =>
									newRequest(undefined, { collectionId: tabCollection?.id })
								}
								disabled={isAddingRequest}
								aria-label="Add request"
							>
								{isAddingRequest ? (
									<Loader2 className="size-icon animate-spin" />
								) : (
									<Plus className="size-icon" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{addRequestTarget
								? `Add request in ${addRequestTarget.name}`
								: "Add request"}
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={openImport}
								aria-label="Import collection"
							>
								<Download
									className="size-icon"
									data-icon-motion={ICON_MOTION.drop}
								/>
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
							size="sm"
							type="text"
							value={panel.newCollectionName}
							onChange={(e) => panel.setNewCollectionName(e.target.value)}
							onKeyDown={(e) => {
								// `isCommitEnter`, not a bare Enter (#939, #935): an IME
								// commits its composition buffer with an ordinary Enter
								// keydown, and mod+Enter is the Send chord.
								if (isCommitEnter(e)) panel.createCollection();
								if (e.key === "Escape") panel.cancelNewCollectionForm();
							}}
							placeholder="Collection name"
							className="flex-1 text-sm"
							disabled={panel.isCreatingCollection}
							autoFocus
						/>
						<Button
							size="sm"
							onClick={panel.createCollection}
							disabled={panel.isCreatingCollection}
						>
							{panel.isCreatingCollection && (
								<Loader2 className="size-icon-sm animate-spin mr-1" />
							)}
							Add
						</Button>
						<DialogCancelButton
							size="sm"
							onClick={panel.cancelNewCollectionForm}
							disabled={panel.isCreatingCollection}
						/>
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
							description="Requests live in collections; your first one is created for you."
							action={
								<div className="flex gap-2">
									<Button
										size="sm"
										onClick={() => newRequest()}
										disabled={isAddingRequest}
									>
										New request
									</Button>
									<Button variant="outline" size="sm" onClick={openImport}>
										Import
									</Button>
								</div>
							}
						/>
					)}

				{/* Every visible row, one flat list in `flattenVisibleRows` order.
				    role="tree" + roving tabindex: the whole tree is one tab stop and
				    arrow keys move between rows (see useRovingTreeFocus).
				    Everything a row needs beyond its own entity comes from the
				    contexts - see CollectionTreeContext for why it is not props. */}
				{!isLoadingCollections && rows.length > 0 && (
					<div className="flex-1 min-h-0">
						{/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex - the tree is never a tab stop, useRovingTreeFocus.ts:118-123 seeds one row's `tabIndex={0}` and moves it */}
						<div
							role="tree"
							aria-label="Collections"
							onKeyDown={treeFocus.onKeyDown}
							onFocus={treeFocus.onFocus}
							className="select-none"
						>
							<CollectionTreeProviders
								handlers={treeHandlers}
								state={treeState}
								folderDraft={folderDraft}
							>
								<CollectionTreeRows rows={rows} />
							</CollectionTreeProviders>
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
				 * Outside `role="tree"`: a tree's children are treeitems, and this is
				 * not one.
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
					// Only ever open for a collection with a running mock server -
					// `deleteNeedsConfirm` - so the copy below only has that one case
					// to describe; every other delete confirms itself (see the effect
					// after `useDeleteRefocus`) and goes straight to the undo toast.
					open={deleteNeedsConfirm}
					onOpenChange={(open) => !open && panel.dismissDeleteConfirm()}
					title={`Delete "${panel.deleteConfirm?.name}"?`}
					confirmLabel="Delete collection"
					description={
						<>
							{/* What the engine does is a soft delete (issue #988): the row
							    is stamped and kept, and the Trash view (issue #989) is where
							    it is restored from. So the copy says where it went rather
							    than "cannot be undone", which stopped being true. */}
							{`"${panel.deleteConfirm?.name}" and all its requests will be moved to the Trash, where they can be restored.`}
							{/* A running mock is engine-process state, not a database row
							    (unlike the delete itself), so it does not come back on
							    Undo - stopping it here is the one irreversible part of an
							    otherwise-reversible action, and the reason this dialog is
							    asking at all. */}
							{panel.deleteConfirm?.runningMocks &&
								panel.deleteConfirm.runningMocks.length > 0 && (
									<span className="mt-2 block">
										{panel.deleteConfirm.runningMocks.length === 1
											? `A mock server is running for this collection (port ${panel.deleteConfirm.runningMocks[0].port}) - it will be stopped.`
											: `${panel.deleteConfirm.runningMocks.length} mock servers are running for this collection and its sub-collections - they will be stopped: ${panel.deleteConfirm.runningMocks
													.map(
														(mock) =>
															`${mock.collectionName} (port ${mock.port})`
													)
													.join(", ")}.`}
									</span>
								)}
						</>
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
				    and the mount is what resets the format and credentials choices. */}
				{panel.exportTarget?.format === "openapi" && (
					<ExportSpecDialog
						collection={panel.exportTarget.collection}
						onOpenChange={(open) => !open && panel.dismissExportDialog()}
					/>
				)}
				{panel.exportTarget?.format === "postman" && (
					<ExportPostmanDialog
						collection={panel.exportTarget.collection}
						onOpenChange={(open) => !open && panel.dismissExportDialog()}
					/>
				)}

				<MoveToDialog
					entity={moveTarget}
					collections={collections}
					onClose={closeMoveDialog}
					onMove={moveToOwner}
				/>

				<CollectionPicker {...pickerProps} />
			</div>
		</DrawerPanel>
	);
}
