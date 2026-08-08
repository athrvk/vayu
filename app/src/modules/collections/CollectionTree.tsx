/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Folder, Plus, Trash2, Edit2, FolderPlus, Loader2, Download } from "lucide-react";
import { useTabsStore, useSaveStore, useImportModalStore } from "@/stores";
import { useCollectionsStore } from "@/modules/collections/collections-store";
import {
	useCollectionsQuery,
	useMultipleCollectionRequests,
	useCreateCollectionMutation,
	useUpdateCollectionMutation,
	useDeleteCollectionMutation,
	useCreateRequestMutation,
	useDeleteRequestMutation,
	useUpdateRequestMutation,
} from "@/queries";
import {
	Button,
	Input,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	DeleteConfirmDialog,
} from "@/components/ui";
import CollectionItem from "./CollectionItem";
import { useRovingTreeFocus } from "./useRovingTreeFocus";
import { walkAncestors, collectDescendantEntityIds } from "./tree-utils";
import { DrawerPanel, EmptyState, ErrorState, ListSkeleton } from "@/components/shared";
import type { RowAction } from "@/components/shared";
import type { Collection, Request } from "@/types";
import { compareTreeOrder } from "@/types";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { DEFAULT_COLLECTION_NAME, DEFAULT_FOLDER_NAME } from "@/constants/collection";

export default function CollectionTree() {
	const openImport = useImportModalStore((s) => s.open);
	const { openTab, openTabs, activeTabId, closeTabsForEntities } = useTabsStore();
	const { expandedCollectionIds, toggleCollectionExpanded, expandCollection, expandCollections } =
		useCollectionsStore();
	const { startSaving, completeSaveThenIdle, failSave } = useSaveStore();
	const treeRef = useRef<HTMLDivElement>(null);
	const treeFocus = useRovingTreeFocus(treeRef);
	// Both reveal and scroll are once-per-selection, and each records the
	// selection it last acted on. They cannot share one ref: the scroll can only
	// run a render *after* the reveal, once the expanded ancestors have put the
	// row in the DOM.
	const revealedSelectionRef = useRef<string | null>(null);
	const scrolledSelectionRef = useRef<string | null>(null);

	// Get selected collection and request IDs from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedCollectionId = activeTab?.type === "collection" ? activeTab.entityId : null;
	const selectedRequestId = activeTab?.type === "request" ? activeTab.entityId : null;

	// Memoised because the callbacks below list them as dependencies: redefined
	// each render, they would rebuild every handler that opens a tab.
	const navigateToRequest = useCallback(
		(_collectionId: string, requestId: string) =>
			openTab({ type: "request", entityId: requestId }),
		[openTab]
	);
	const navigateToCollection = useCallback(
		(collectionId: string) => openTab({ type: "collection", entityId: collectionId }),
		[openTab]
	);

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

	// Mutation hooks
	const createCollectionMutation = useCreateCollectionMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();
	const deleteCollectionMutation = useDeleteCollectionMutation();
	const createRequestMutation = useCreateRequestMutation();
	const deleteRequestMutation = useDeleteRequestMutation();
	const updateRequestMutation = useUpdateRequestMutation();

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

	/*
	 * Reveal whatever the active tab points at: expand its ancestor folders so
	 * the row is rendered, then (in the effect below) scroll it into view.
	 *
	 * This used to handle requests only, which is why switching to a *collection*
	 * tab looked like the sidebar ignored it - a collection nested inside a
	 * collapsed parent has no row in the tree at all, so there was nothing to
	 * highlight and nothing to scroll to. `selectedCollectionId` was computed and
	 * then only used for a label and a highlight, so nothing revealed it.
	 *
	 * Settings and Variables never had the problem because they own a whole
	 * drawer view; a request did not because of this effect. A collection fell
	 * between the two.
	 *
	 * Guarded by a ref so it fires once per selection - the same discipline the
	 * scroll effect below has always had. Unguarded, it re-ran after *every*
	 * render of the tree (it lists `requestsByCollection` and `collections`, and
	 * the tree re-renders on any expand-state change), so collapsing a
	 * collection that held the selected request re-expanded it in the same
	 * frame: the chevron looked dead and every ancestor of the active tab was
	 * pinned open. Once per selection *change* means switching tabs away and
	 * back reveals again, which is the behaviour that was wanted all along.
	 */
	useEffect(() => {
		const selectionId = selectedCollectionId ?? selectedRequestId;
		if (!selectionId) {
			// Settings, Variables, no tab at all: re-selecting the entity later is a
			// fresh selection and must reveal again.
			revealedSelectionRef.current = null;
			scrolledSelectionRef.current = null;
			return;
		}
		if (revealedSelectionRef.current === selectionId) return;

		// A collection reveals itself; a request reveals the collection holding it.
		let target: string | undefined;
		if (selectedCollectionId) {
			target = selectedCollectionId;
		} else {
			for (const [collectionId, reqs] of requestsByCollection) {
				if (reqs.some((r) => r.id === selectedRequestId)) {
					target = collectionId;
					break;
				}
			}
		}
		// The owning collection's requests may not have arrived yet. Leave the ref
		// unset so this reveals once they do, rather than counting as done.
		if (!target) return;

		// walkAncestors, not a local loop: this walk is unbounded on a `parentId`
		// cycle, which hangs the renderer inside an effect (see tree-utils).
		const ancestorChain = walkAncestors(target, collections).map((c) => c.id);
		revealedSelectionRef.current = selectionId;
		expandCollections(ancestorChain);
	}, [
		selectedRequestId,
		selectedCollectionId,
		requestsByCollection,
		collections,
		expandCollections,
	]);

	/*
	 * Once the selected row exists (after ancestors expand), scroll it into view.
	 * Guarded by a ref so it only fires once per selection - otherwise every
	 * expand/collapse elsewhere in the tree would yank the view back.
	 */
	useEffect(() => {
		const id = selectedCollectionId ?? selectedRequestId;
		if (!id || scrolledSelectionRef.current === id) return;
		const attr = selectedCollectionId ? "data-collection-id" : "data-request-id";
		const row = treeRef.current?.querySelector(`[${attr}="${CSS.escape(id)}"]`);
		if (row) {
			row.scrollIntoView({ block: "nearest" });
			scrolledSelectionRef.current = id;
		}
	}, [selectedRequestId, selectedCollectionId, expandedCollectionIds, requestsByCollection]);

	const [creatingCollection, setCreatingCollection] = useState(false);
	const [creatingSubfolder, setCreatingSubfolder] = useState<string | null>(null); // parent collection ID
	const [newCollectionName, setNewCollectionName] = useState(DEFAULT_COLLECTION_NAME);
	const [newSubCollectionName, setNewSubCollectionName] = useState(DEFAULT_FOLDER_NAME);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [renamingRequestId, setRenamingRequestId] = useState<string | null>(null);
	const [renameRequestValue, setRenameRequestValue] = useState("");
	const [deletingCollectionId, setDeletingCollectionId] = useState<string | null>(null);
	const [deletingRequestId, setDeletingRequestId] = useState<string | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<{
		type: "collection" | "request";
		id: string;
		name: string;
	} | null>(null);
	/**
	 * Report a failed mutation through the same channel the rename path already
	 * uses - `failSave` puts "Save failed" in the Dock.
	 *
	 * Rename was the only handler here that caught anything. Create and delete
	 * called `mutateAsync` bare, so a rejection was an unhandled promise and
	 * nothing else: a failed delete closed the confirm dialog, un-dimmed the row
	 * and left the collection sitting there with no explanation, which reads as
	 * "the click didn't register" rather than "the delete failed".
	 */
	const reportFailure = useCallback(
		(error: unknown, fallback: string) =>
			failSave(error instanceof Error ? error.message : fallback),
		[failSave]
	);

	const handleRenameCancel = useCallback(() => {
		setRenamingId(null);
		setRenameValue("");
	}, []);

	const handleCancelSubfolder = useCallback(() => {
		setCreatingSubfolder(null);
		setNewSubCollectionName(DEFAULT_FOLDER_NAME);
	}, []);

	const handleCollectionClick = useCallback(
		(collection: Collection) => {
			navigateToCollection(collection.id);
		},
		[navigateToCollection]
	);

	const handleCollectionToggle = useCallback(
		(collection: Collection) => {
			toggleCollectionExpanded(collection.id);
		},
		[toggleCollectionExpanded]
	);

	const handleOpenNewCollectionForm = useCallback(() => {
		setNewCollectionName(DEFAULT_COLLECTION_NAME);
		setCreatingCollection(true);
	}, []);

	// Handle "New Request" button click - use selected collection or first root
	const handleNewRequestClick = () => {
		if (rootCollections.length === 0) {
			// No collections - prompt to create one first
			handleOpenNewCollectionForm();
			return;
		}

		// Use selected collection only if it still exists; otherwise first root collection
		const selectedExists =
			selectedCollectionId && collections.some((c) => c.id === selectedCollectionId);
		const targetCollection =
			(selectedExists ? selectedCollectionId : null) ?? rootCollections[0].id;
		handleCreateRequest(targetCollection);
	};

	const handleRequestClick = (collectionId: string, requestId: string) => {
		navigateToRequest(collectionId, requestId);
	};

	const handleCreateCollection = async () => {
		if (!newCollectionName.trim() || createCollectionMutation.isPending) return;

		try {
			await createCollectionMutation.mutateAsync({ name: newCollectionName.trim() });
		} catch (error) {
			reportFailure(error, "Failed to create collection");
			return; // Keep the form open with the typed name so it can be retried.
		}
		setNewCollectionName("");
		setCreatingCollection(false);
	};

	const handleCreateSubfolder = async (parentId: string) => {
		if (!newSubCollectionName.trim() || createCollectionMutation.isPending) return;

		expandCollection(parentId);

		try {
			await createCollectionMutation.mutateAsync({
				name: newSubCollectionName.trim(),
				parentId: parentId,
			});
		} catch (error) {
			reportFailure(error, "Failed to create folder");
			return;
		}
		handleCancelSubfolder();
	};

	// Memoised because `getCollectionActions` lists it: rebuilt every render, it
	// would rebuild every collection's ⋯ menu with it.
	const handleCreateRequest = useCallback(
		async (collectionId: string) => {
			if (createRequestMutation.isPending) return;

			expandCollection(collectionId);

			let request: Request | undefined;
			try {
				request = await createRequestMutation.mutateAsync({
					collectionId: collectionId,
					name: DEFAULT_REQUEST_NAME,
					method: "GET",
					url: "",
				});
			} catch (error) {
				reportFailure(error, "Failed to create request");
				return;
			}

			if (request) {
				navigateToRequest(collectionId, request.id);
			}
		},
		[createRequestMutation, expandCollection, navigateToRequest, reportFailure]
	);

	const handleRenameCollection = useCallback((collection: Collection) => {
		setRenamingId(collection.id);
		setRenameValue(collection.name);
	}, []);

	// Named, so the ⋯ menu's Delete and the row's hidden `data-tree-delete`
	// control (the Delete key's target) open the very same dialog rather than
	// being two copies of one object literal that can drift apart.
	const handleCollectionDeleteClick = useCallback((id: string, name: string) => {
		setDeleteConfirm({ type: "collection", id, name });
	}, []);

	const handleRenameSubmit = async (collectionId: string) => {
		const trimmedValue = renameValue.trim();
		// Enter submits and then blur submits again, because the field is still
		// mounted while the PUT is in flight. Clearing the rename state *before*
		// awaiting unmounts the field, so there is no second blur to fire - and a
		// name that did not change never reaches the wire at all, which is the
		// guard the request-rename path has always had and this one had not.
		setRenamingId(null);
		setRenameValue("");

		const original = collections.find((c) => c.id === collectionId);
		if (!trimmedValue || original?.name === trimmedValue) return;

		startSaving();
		try {
			await updateCollectionMutation.mutateAsync({
				id: collectionId,
				name: trimmedValue,
			});
			completeSaveThenIdle();
		} catch (error) {
			failSave(error instanceof Error ? error.message : "Failed to rename collection");
		}
	};

	/**
	 * Duplicate a request, contents and all - method, URL, params, headers,
	 * body, auth and both scripts. Collections deliberately have no equivalent:
	 * copying one means recursing through nested folders and issuing a create
	 * per request, which is its own feature. The previous collection "Duplicate"
	 * only created an empty folder named "(Copy)", which read as a working clone
	 * and was not one, so it was removed rather than left misleading.
	 */
	const handleDuplicateRequest = useCallback(
		async (request: Request) => {
			if (createRequestMutation.isPending) return;
			try {
				const copy = await createRequestMutation.mutateAsync({
					collectionId: request.collectionId,
					name: `${request.name} (Copy)`,
					description: request.description,
					method: request.method,
					url: request.url,
					params: request.params,
					headers: request.headers,
					body: request.body,
					bodyType: request.bodyType,
					auth: request.auth,
					preRequestScript: request.preRequestScript,
					postRequestScript: request.postRequestScript,
					/*
					 * The copy takes its source's `order`, which lands it directly
					 * *after* the source: the tie falls to `createdAt` and the copy is
					 * newer (see `compareTreeOrder`, pinned to the engine's SQL). An
					 * omitted order would append it to the end of the collection, and
					 * inserting it at `order + 1` would need every following sibling
					 * renumbered - a multi-row write that belongs to the atomic batch
					 * reorder endpoint, not to a duplicate.
					 */
					order: request.order,
				});
				openTab({ type: "request", entityId: copy.id });
			} catch (error) {
				reportFailure(error, "Failed to duplicate request");
			}
		},
		[createRequestMutation, openTab, reportFailure]
	);

	/**
	 * Actions for a collection's "⋯" menu. Defined here, where the handlers and
	 * state live, and rendered by the shared RowActionsMenu - the same component
	 * request and environment rows use, so every row menu looks and behaves
	 * alike. This replaced a hand-rolled fixed-position popover that had to
	 * compute its own coordinates and close itself on an outside click, and
	 * which had no keyboard support.
	 */
	const getCollectionActions = useCallback(
		(collection: Collection): RowAction[] => [
			{
				label: "Rename",
				icon: Edit2,
				onSelect: () => handleRenameCollection(collection),
			},
			{
				label: "Add Request",
				icon: Plus,
				onSelect: () => void handleCreateRequest(collection.id),
			},
			{
				label: "Add Folder",
				icon: FolderPlus,
				onSelect: () => {
					expandCollection(collection.id);
					setCreatingSubfolder(collection.id);
				},
			},
			{
				label: "Delete",
				icon: Trash2,
				destructive: true,
				onSelect: () => handleCollectionDeleteClick(collection.id, collection.name),
			},
		],
		// Honest deps, which is only possible now that both handlers are memoised
		// and the expand goes through `expandCollection` rather than reading the
		// expanded set. The suppression that used to sit here hid two callbacks
		// captured from whichever render last rebuilt this - benign only by
		// accident, and this is the seam the drag-and-drop work extends.
		[expandCollection, handleCreateRequest, handleRenameCollection, handleCollectionDeleteClick]
	);

	const handleDeleteCollection = useCallback(
		async (collectionId: string) => {
			setDeletingCollectionId(collectionId);
			// Gather the collection, its descendant folders, and every request they
			// contain: deleting a collection cascades, so all their tabs go stale.
			const affected = collectDescendantEntityIds(collectionId, collections, (id) =>
				getRequestsByCollection(id).map((r) => r.id)
			);
			try {
				await deleteCollectionMutation.mutateAsync(collectionId);
				closeTabsForEntities(affected);
			} catch (error) {
				reportFailure(error, "Failed to delete collection");
			} finally {
				// Only now: the dialog stays up, with its confirm button spinning,
				// for as long as the delete is actually running.
				setDeleteConfirm(null);
				setDeletingCollectionId(null);
			}
		},
		[
			deleteCollectionMutation,
			closeTabsForEntities,
			collections,
			getRequestsByCollection,
			reportFailure,
		]
	);

	const handleDeleteRequest = useCallback(
		async (requestId: string) => {
			setDeletingRequestId(requestId);
			try {
				await deleteRequestMutation.mutateAsync(requestId);
				// Close any open tab pointing at the now-deleted request.
				closeTabsForEntities([requestId]);
			} catch (error) {
				reportFailure(error, "Failed to delete request");
			} finally {
				setDeleteConfirm(null);
				setDeletingRequestId(null);
			}
		},
		[deleteRequestMutation, closeTabsForEntities, reportFailure]
	);

	const handleRequestDeleteClick = useCallback((requestId: string, requestName: string) => {
		setDeleteConfirm({ type: "request", id: requestId, name: requestName });
	}, []);

	const handleConfirmDelete = useCallback(() => {
		if (!deleteConfirm) return;
		// The dialog now stays open while the delete runs, so its confirm button
		// survives long enough to be clicked twice. `isDeleting` disables it from
		// the next render on; this covers the frame before that.
		if (deletingCollectionId || deletingRequestId) return;
		if (deleteConfirm.type === "collection") {
			handleDeleteCollection(deleteConfirm.id);
		} else {
			handleDeleteRequest(deleteConfirm.id);
		}
	}, [
		deleteConfirm,
		deletingCollectionId,
		deletingRequestId,
		handleDeleteCollection,
		handleDeleteRequest,
	]);

	const handleStartRequestRename = (request: Request) => {
		setRenamingRequestId(request.id);
		setRenameRequestValue(request.name);
	};

	const handleRequestRenameSubmit = async (requestId: string) => {
		const trimmedValue = renameRequestValue.trim();
		// Cleared before the await for the same reason as the collection path:
		// while the field is still mounted, the blur that follows Enter submits a
		// second time.
		setRenamingRequestId(null);
		setRenameRequestValue("");

		// Find the original request to check if name actually changed
		// Search through all collections to find the request
		let originalRequest: Request | undefined;
		for (const requests of requestsByCollection.values()) {
			const found = requests.find((r) => r.id === requestId);
			if (found) {
				originalRequest = found;
				break;
			}
		}

		// Empty name, or a name that did not change: nothing to save.
		if (!trimmedValue || originalRequest?.name === trimmedValue) return;

		startSaving();
		try {
			await updateRequestMutation.mutateAsync({
				id: requestId,
				name: trimmedValue,
			});
			completeSaveThenIdle();
		} catch (error) {
			failSave(error instanceof Error ? error.message : "Failed to rename request");
		}
	};

	const handleRequestRenameCancel = useCallback(() => {
		setRenamingRequestId(null);
		setRenameRequestValue("");
	}, []);

	return (
		<DrawerPanel
			title="Collections"
			actions={
				<>
					{/* No TooltipProvider - a bare nested one would reset this
					    subtree to Radix's 700ms, ignoring main.tsx. */}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={handleOpenNewCollectionForm}
								disabled={createCollectionMutation.isPending}
								className="h-8 w-8"
								aria-label="Add collection"
							>
								{createCollectionMutation.isPending ? (
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
								onClick={handleNewRequestClick}
								disabled={createRequestMutation.isPending}
								className="h-8 w-8"
								aria-label="Add request"
							>
								{createRequestMutation.isPending ? (
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
								className="h-8 w-8"
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
				{creatingCollection && (
					<div className="flex gap-2 mb-2 px-3 pt-2">
						<Input
							type="text"
							value={newCollectionName}
							onChange={(e) => setNewCollectionName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleCreateCollection();
								if (e.key === "Escape") {
									setCreatingCollection(false);
									setNewCollectionName("");
								}
							}}
							placeholder="Collection name"
							className="flex-1 h-8 text-sm"
							disabled={createCollectionMutation.isPending}
							autoFocus
						/>
						<Button
							size="sm"
							onClick={handleCreateCollection}
							disabled={createCollectionMutation.isPending}
						>
							{createCollectionMutation.isPending && (
								<Loader2 className="w-3 h-3 animate-spin mr-1" />
							)}
							Add
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setCreatingCollection(false);
								setNewCollectionName("");
							}}
							disabled={createCollectionMutation.isPending}
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
					!creatingCollection && (
						<EmptyState
							icon={Folder}
							title="No collections yet"
							description="Collections group related requests - make one to get started."
							action={
								<Button
									variant="link"
									onClick={handleOpenNewCollectionForm}
									className="text-primary"
								>
									Add your first collection
								</Button>
							}
						/>
					)}

				{/* Root-level collections (no parent loaded) - sorted by order, scrollable.
			    role="tree" + roving tabindex: the whole tree is one tab stop and
			    arrow keys move between rows (see useRovingTreeFocus). */}
				{!isLoadingCollections && rootCollections.length > 0 && (
					<div className="flex-1 min-h-0">
						<div
							role="tree"
							aria-label="Collections"
							onKeyDown={treeFocus.onKeyDown}
							onFocus={treeFocus.onFocus}
							className="space-y-0.5"
						>
							{rootCollections.map((collection, index) => (
								<CollectionItem
									key={collection.id}
									collection={collection}
									allCollections={collections}
									depth={0}
									posInSet={index + 1}
									setSize={rootCollections.length}
									expandedCollectionIds={expandedCollectionIds}
									selectedCollectionId={selectedCollectionId}
									selectedRequestId={selectedRequestId}
									renamingId={renamingId}
									renameValue={renameValue}
									deletingCollectionId={deletingCollectionId}
									deletingRequestId={deletingRequestId}
									creatingSubfolder={creatingSubfolder}
									newSubCollectionName={newSubCollectionName}
									isCreatingSubfolder={createCollectionMutation.isPending}
									getRequestsByCollection={getRequestsByCollection}
									onCollectionClick={handleCollectionClick}
									onCollectionToggle={handleCollectionToggle}
									onRequestClick={handleRequestClick}
									getCollectionActions={getCollectionActions}
									onRenameChange={setRenameValue}
									onRenameSubmit={handleRenameSubmit}
									onRenameCancel={handleRenameCancel}
									onStartRename={handleRenameCollection}
									onDeleteRequest={handleDeleteRequest}
									onSubCollectionNameChange={setNewSubCollectionName}
									onCreateSubfolder={handleCreateSubfolder}
									onCancelSubfolder={handleCancelSubfolder}
									renamingRequestId={renamingRequestId}
									renameRequestValue={renameRequestValue}
									onRequestRenameChange={setRenameRequestValue}
									onRequestRenameSubmit={handleRequestRenameSubmit}
									onRequestRenameCancel={handleRequestRenameCancel}
									onStartRequestRename={handleStartRequestRename}
									onRequestDeleteClick={handleRequestDeleteClick}
									onCollectionDeleteClick={handleCollectionDeleteClick}
									onDuplicateRequest={handleDuplicateRequest}
								/>
							))}
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
				/>

				<DeleteConfirmDialog
					open={!!deleteConfirm}
					onOpenChange={(open) => !open && setDeleteConfirm(null)}
					title={
						deleteConfirm?.type === "collection"
							? "Delete collection?"
							: "Delete request?"
					}
					description={
						deleteConfirm?.type === "collection"
							? `"${deleteConfirm?.name}" and all its requests will be permanently removed. This cannot be undone.`
							: `"${deleteConfirm?.name}" will be permanently removed. This cannot be undone.`
					}
					onConfirm={handleConfirmDelete}
					isDeleting={
						(deleteConfirm?.type === "collection" &&
							deletingCollectionId === deleteConfirm?.id) ||
						(deleteConfirm?.type === "request" &&
							deletingRequestId === deleteConfirm?.id)
					}
				/>
			</div>
		</DrawerPanel>
	);
}
