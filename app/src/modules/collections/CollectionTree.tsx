/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Folder, Plus, FolderPlus, Loader2, Download } from "lucide-react";
import { useTabsStore, useImportModalStore, useSessionStore } from "@/stores";
import { useCollectionsStore } from "@/modules/collections/collections-store";
import { useCollectionsQuery, useMultipleCollectionRequests } from "@/queries";
import { useNewRequest } from "@/hooks/useNewRequest";
import { CollectionPicker } from "@/modules/welcome/components/CollectionPicker";
import { resolveNewRequestTarget } from "@/modules/welcome/targetCollection";
import { LLM_REQUEST_TEMPLATES } from "@/modules/welcome/llm-request-presets";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Input,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	DeleteConfirmDialog,
	DialogCancelButton,
	ICON_MOTION,
} from "@/components/ui";
import CollectionTreeRows, { type TreeRowWindow } from "./CollectionTreeRows";
import { CollectionTreeContextMenu } from "./CollectionTreeContextMenu";
import {
	dropLineBeside,
	entityRowKey,
	flattenVisibleRows,
	folderIdOfRowKey,
	folderRowKey,
	navigableRows,
	rowEntity,
} from "./tree-rows";
import { focusTreeRow, type TreeRowModel } from "./tree-focus";
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
import type { RequestSummary } from "@/types";
import { isCommitEnter } from "@/lib/keyboard";

export default function CollectionTree() {
	const openImport = useImportModalStore((s) => s.open);
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const expandedCollectionIds = useCollectionsStore((s) => s.expandedCollectionIds);
	const expandCollections = useCollectionsStore((s) => s.expandCollections);
	const treeRef = useRef<HTMLDivElement>(null);
	// The `role="tree"` element as state, not a ref: the window measures from it,
	// and a ref on a parent is not set yet when its children's effects run.
	const [treeList, setTreeList] = useState<HTMLDivElement | null>(null);
	// The one way to act on a row that may be scrolled away (#2543).
	const rowWindowRef = useRef<TreeRowWindow>(null);

	// Get selected collection and request IDs from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedCollectionId = activeTab?.type === "collection" ? activeTab.entityId : null;
	const selectedRequestId = activeTab?.type === "request" ? activeTab.entityId : null;

	// isError as well as isLoading: with `= []` a failed fetch looks like an empty workspace, and
	// the empty state's "New collection" would invite duplicates of collections that exist.
	const {
		data: collections = [],
		isLoading: isLoadingCollections,
		isError: collectionsFailed,
		error: collectionsError,
		refetch: refetchCollections,
	} = useCollectionsQuery();

	// Every collection's requests; the prefetch already put them in the cache.
	const allCollectionIds = collections.map((c) => c.id);
	const { requestsByCollection } = useMultipleCollectionRequests(allCollectionIds);

	const getRequestsByCollection = useCallback(
		(collectionId: string): RequestSummary[] => requestsByCollection.get(collectionId) ?? [],
		[requestsByCollection]
	);

	const { revealEntity } = useRevealActiveSelection(treeRef, rowWindowRef, {
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
		revealEntity,
	});

	const creatingSubfolder = rowState.creatingSubfolder;
	const rows = useMemo(
		() =>
			flattenVisibleRows({
				collections,
				getRequestsByCollection,
				expandedCollectionIds,
				creatingSubfolder,
				selectedRequestId,
			}),
		[
			collections,
			getRequestsByCollection,
			expandedCollectionIds,
			creatingSubfolder,
			selectedRequestId,
		]
	);

	/*
	 * The keys walk every visible row, not the mounted ones: the window holds
	 * only what is in view, and End or a typeahead has to reach past it.
	 */
	const navigationModel = useMemo<TreeRowModel>(
		() => ({
			rows: navigableRows(rows, expandedCollectionIds),
			keyOf: (element) => rowWindowRef.current?.keyOf(element) ?? null,
			focusRow: (key) => {
				rowWindowRef.current?.revealRow(key, (row) => focusTreeRow(treeRef.current, row));
			},
			expand: (keys) => expandCollections(keys.flatMap((key) => folderIdOfRowKey(key) ?? [])),
		}),
		[rows, expandedCollectionIds, expandCollections]
	);
	const treeFocus = useRovingTreeFocus(treeRef, navigationModel);

	/*
	 * Where a dialog opened from a row's menu hands focus back (#3443): Radix would restore it to
	 * the menu item that opened the dialog, gone with its menu, so focus lands on `<body>`. Through
	 * the window, as the row may have scrolled out of the mounted set while the dialog was up.
	 */
	const returnFocusToRow = useCallback(
		(key: string) => (event: Event) => {
			event.preventDefault();
			rowWindowRef.current?.revealRow(key, (row) => focusTreeRow(treeRef.current, row));
		},
		[]
	);

	// The row an event came from, from the rows model: what the tree's one
	// right-click menu and its drag handlers act on, in place of a handler per row.
	const rowAt = useCallback(
		(element: Element) => rowWindowRef.current?.rowOf(element) ?? null,
		[]
	);
	const entityAt = useCallback(
		(element: Element) => {
			const row = rowAt(element);
			return row ? rowEntity(row) : null;
		},
		[rowAt]
	);

	/*
	 * The toolbar's "+" asks the question every other "New request" entry point asks, so it cannot
	 * disagree with them about where the request lands, with one exception: an open collection tab
	 * says which collection the user is in, and the button is on its screen. Only a collection that
	 * still exists counts; a tab can outlive it.
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
	 * A collection or request delete is a soft delete (issue #988) with an undo toast on completion
	 * (`useTreeCrud`'s `offerUndo`), so a blocking dialog is friction with nothing to protect
	 * against, the UX writing guide's rule for a recoverable action. The exception is a collection
	 * with a running mock server: Undo does not restart a stopped mock (engine-process state, not a
	 * database row), so that case still asks first.
	 */
	const deleteNeedsConfirm =
		panel.deleteConfirm?.type === "collection" &&
		!!panel.deleteConfirm.runningMocks &&
		panel.deleteConfirm.runningMocks.length > 0;

	/*
	 * Where focus goes when the deleted row was the tree's only one, which the tree's own rule
	 * cannot answer (a root otherwise falls back to the root before it). "Add collection" is the
	 * nearest surviving control, and the one thing left to do on an emptied tree.
	 */
	const addCollectionRef = useRef<HTMLButtonElement>(null);

	const deleteRefocus = useDeleteRefocus(treeRef, doomedRowSelector, addCollectionRef);

	/*
	 * Confirms on its own the instant a delete that needs no confirmation is requested.
	 * `deleteConfirm` is still set first so `doomedRowSelector` captures the row for focus
	 * restoration while it is on screen, and this effect is declared after `useDeleteRefocus` so
	 * that capture has run when `awaitRemoval` reads it (with no dialog, no close arms the
	 * refocus). Re-runs while the delete is in flight are harmless: `confirmDelete` refuses a
	 * second delete until the first settles, then `panel`'s memo picks up the cleared
	 * `deletingCollectionId`/`deletingRequestId` and gives this effect a fresh reference, which
	 * lets a delete requested mid-flight (kept in `deleteConfirm` by the guarded clear in
	 * `useTreeCrud`) go through in its turn.
	 */
	useEffect(() => {
		if (!panel.deleteConfirm || deleteNeedsConfirm) return;
		deleteRefocus.awaitRemoval();
		panel.confirmDelete();
	}, [panel, deleteNeedsConfirm, deleteRefocus]);

	/*
	 * A row mid-rename or mid-delete is neither drag source nor drop target: both states own the
	 * row's input, and a move landing on a row about to disappear is the two-writers problem. Read
	 * from the CRUD slice, the one source.
	 */
	const isRowBusy = useCallback(
		(entityId: string) =>
			entityId === rowState.renamingId ||
			entityId === rowState.renamingRequestId ||
			entityId === rowState.deletingCollectionId ||
			entityId === rowState.deletingRequestId,
		[rowState]
	);

	const dropLineBesideRow = useCallback(
		(key: string, position: "before" | "after") => dropLineBeside(rows, key, position),
		[rows]
	);

	const { dnd, treeHandlers, announcement, moveTarget, closeMoveDialog, moveToOwner } =
		useTreeDnd({
			collections,
			getRequestsByCollection,
			treeRef,
			entityAt,
			dropLineBeside: dropLineBesideRow,
			isRowBusy,
			revealEntity,
		});

	const rowHandlers = useMemo<CollectionTreeHandlers>(
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
			// h-7, not h-8: the header is the drawer's half of the 32px chrome band, and a 32px
			// control would fill the band edge to edge, landing its hover fill on the rule
			// underneath.
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
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										disabled={isAddingRequest}
										aria-label="New request from a template"
									>
										<ChevronDown className="size-icon" />
									</Button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent>New request from a template</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="end">
							{LLM_REQUEST_TEMPLATES.map(({ id, preset }) => (
								<DropdownMenuItem
									key={id}
									onSelect={() =>
										newRequest(preset, { collectionId: tabCollection?.id })
									}
								>
									{preset.name}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
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
				{/*
				 * px-3 pt-2 is not decorative: the DrawerPanel body scrolls (overflow-y-auto
				 * overflow-x-hidden) and is flush so rows run edge to edge, so it clips at its own
				 * edge, and this field's focus ring is drawn *outside* its border box. The padding
				 * gives the ring room, as in the History search field (see HistoryList).
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
								<Loader2 className="size-icon-sm animate-spin" />
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
						<CollectionTreeProviders
							handlers={rowHandlers}
							state={treeState}
							folderDraft={folderDraft}
						>
							{/* One right-click menu and one set of drag handlers for
							    every row, each resolving its row from the event
							    (#2543): nothing per row but the row. */}
							<CollectionTreeContextMenu rowAt={rowAt}>
								{/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex - the tree is never a tab stop, useRovingTreeFocus.ts:125-130 seeds one row's `tabIndex={0}` and moves it */}
								<div
									ref={setTreeList}
									role="tree"
									aria-label="Collections"
									onKeyDown={treeFocus.onKeyDown}
									onFocus={treeFocus.onFocus}
									{...treeHandlers}
									className="select-none"
								>
									<CollectionTreeRows
										rows={rows}
										list={treeList}
										windowRef={rowWindowRef}
									/>
								</div>
							</CollectionTreeContextMenu>
						</CollectionTreeProviders>
					</div>
				)}

				{/*
				 * The tree's live region, shipped empty on purpose: a live region must already be
				 * in the DOM for a change to it to be observed, and one mounted with its first
				 * message never announces (see ResponseAnnouncer, same constraint and markup).
				 * Keyboard move announcements will be the first to write here. Outside
				 * `role="tree"`: a tree's children are treeitems, and this is not one.
				 */}
				<div
					role="status"
					aria-live="polite"
					// Explicit, not role="status"'s implicit true: a single-line region wants one
					// utterance of the whole message, and the Toaster once shipped assuming the
					// wrong default.
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
							{/*
							 * A soft delete (issue #988): the row is stamped and kept, and restored
							 * from the Trash view (issue #989), so the copy says where it went
							 * rather than "cannot be undone".
							 */}
							{`"${panel.deleteConfirm?.name}" and all its requests will be moved to the Trash, where they can be restored.`}
							{/*
							 * A running mock is engine-process state, not a database row, so Undo
							 * does not bring it back: stopping it is the one irreversible part of
							 * this delete, and the reason this dialog asks at all.
							 */}
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

				{/*
				 * Mounted once a folder is chosen and unmounted on close, so the tree pays nothing
				 * for an unused feature and each opening starts from the default options (see the
				 * prop note). One dialog per panel, never one per row, which would be a Radix
				 * portal per folder.
				 */}
				{panel.runTarget && (
					<RunCollectionDialog
						collection={panel.runTarget}
						onOpenChange={(open) => !open && panel.dismissRunDialog()}
						onCloseAutoFocus={returnFocusToRow(folderRowKey(panel.runTarget.id))}
					/>
				)}

				{/* Mounted on the same terms as the run dialog above, and for the
				    same reasons: one per panel, only once a folder has been chosen,
				    and the mount is what resets the format and credentials choices. */}
				{panel.exportTarget?.format === "openapi" && (
					<ExportSpecDialog
						collection={panel.exportTarget.collection}
						onOpenChange={(open) => !open && panel.dismissExportDialog()}
						onCloseAutoFocus={returnFocusToRow(
							folderRowKey(panel.exportTarget.collection.id)
						)}
					/>
				)}
				{panel.exportTarget?.format === "postman" && (
					<ExportPostmanDialog
						collection={panel.exportTarget.collection}
						onOpenChange={(open) => !open && panel.dismissExportDialog()}
						onCloseAutoFocus={returnFocusToRow(
							folderRowKey(panel.exportTarget.collection.id)
						)}
					/>
				)}

				<MoveToDialog
					entity={moveTarget}
					collections={collections}
					onClose={closeMoveDialog}
					onMove={moveToOwner}
					onCloseAutoFocus={
						moveTarget ? returnFocusToRow(entityRowKey(moveTarget)) : undefined
					}
				/>

				<CollectionPicker {...pickerProps} />
			</div>
		</DrawerPanel>
	);
}
