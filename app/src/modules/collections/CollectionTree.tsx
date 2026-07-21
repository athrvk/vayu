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
	TooltipProvider,
	DeleteConfirmDialog,
} from "@/components/ui";
import CollectionItem from "./CollectionItem";
import { useRovingTreeFocus } from "./useRovingTreeFocus";
import { DrawerPanel, EmptyState, ListSkeleton } from "@/components/shared";
import type { RowAction } from "@/components/shared";
import type { Collection, Request } from "@/types";
import { compareCollectionOrder } from "@/types";
import { TIMING } from "@/config/timing";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { DEFAULT_COLLECTION_NAME, DEFAULT_FOLDER_NAME } from "@/constants/collection";

export default function CollectionTree() {
	const openImport = useImportModalStore((s) => s.open);
	const { openTab, openTabs, activeTabId, closeTabsForEntities } = useTabsStore();
	const { expandedCollectionIds, toggleCollectionExpanded, expandCollections } =
		useCollectionsStore();
	const { startSaving, completeSave, failSave, setStatus } = useSaveStore();
	const treeRef = useRef<HTMLDivElement>(null);
	const treeFocus = useRovingTreeFocus(treeRef);
	const scrolledRequestRef = useRef<string | null>(null);

	// Get selected collection and request IDs from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedCollectionId = activeTab?.type === "collection" ? activeTab.entityId : null;
	const selectedRequestId = activeTab?.type === "request" ? activeTab.entityId : null;

	const navigateToRequest = (_collectionId: string, requestId: string) =>
		openTab({ type: "request", entityId: requestId });
	const navigateToCollection = (collectionId: string) =>
		openTab({ type: "collection", entityId: collectionId });

	// TanStack Query hooks
	const { data: collections = [], isLoading: isLoadingCollections } = useCollectionsQuery();

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

	const rootCollections = useMemo(
		() => [...collections].filter((c) => !c.parentId).sort(compareCollectionOrder),
		[collections]
	);

	// Reveal the active request in the tree: expand its ancestor folders so the
	// row is rendered, then (in the effect below) scroll it into view.
	useEffect(() => {
		if (!selectedRequestId) {
			scrolledRequestRef.current = null;
			return;
		}
		let owningCollectionId: string | undefined;
		for (const [collectionId, reqs] of requestsByCollection) {
			if (reqs.some((r) => r.id === selectedRequestId)) {
				owningCollectionId = collectionId;
				break;
			}
		}
		if (!owningCollectionId) return;

		const ancestorChain: string[] = [];
		let cursor: string | undefined = owningCollectionId;
		while (cursor) {
			ancestorChain.push(cursor);
			cursor = collections.find((c) => c.id === cursor)?.parentId ?? undefined;
		}
		expandCollections(ancestorChain);
	}, [selectedRequestId, requestsByCollection, collections, expandCollections]);

	// Once the selected request's row exists (after ancestors expand), scroll it
	// into view. Guarded by a ref so it only fires once per selection.
	useEffect(() => {
		if (!selectedRequestId || scrolledRequestRef.current === selectedRequestId) return;
		const row = treeRef.current?.querySelector(
			`[data-request-id="${CSS.escape(selectedRequestId)}"]`
		);
		if (row) {
			row.scrollIntoView({ block: "nearest" });
			scrolledRequestRef.current = selectedRequestId;
		}
	}, [selectedRequestId, expandedCollectionIds, requestsByCollection]);

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

		await createCollectionMutation.mutateAsync({ name: newCollectionName.trim() });
		setNewCollectionName("");
		setCreatingCollection(false);
	};

	const handleCreateSubfolder = async (parentId: string) => {
		if (!newSubCollectionName.trim() || createCollectionMutation.isPending) return;

		// Ensure parent collection is expanded
		if (!expandedCollectionIds.has(parentId)) {
			toggleCollectionExpanded(parentId);
		}

		await createCollectionMutation.mutateAsync({
			name: newSubCollectionName.trim(),
			parentId: parentId,
		});
		handleCancelSubfolder();
	};

	const handleCreateRequest = async (collectionId: string) => {
		if (createRequestMutation.isPending) return;

		if (!expandedCollectionIds.has(collectionId)) {
			toggleCollectionExpanded(collectionId);
		}

		const request = await createRequestMutation.mutateAsync({
			collectionId: collectionId,
			name: DEFAULT_REQUEST_NAME,
			method: "GET",
			url: "",
		});

		if (request) {
			navigateToRequest(collectionId, request.id);
		}
	};

	const handleRenameCollection = (collection: Collection) => {
		setRenamingId(collection.id);
		setRenameValue(collection.name);
	};

	const handleRenameSubmit = async (collectionId: string) => {
		if (!renameValue.trim()) {
			setRenamingId(null);
			setRenameValue("");
			return;
		}

		startSaving();
		try {
			await updateCollectionMutation.mutateAsync({
				id: collectionId,
				name: renameValue.trim(),
			});
			completeSave();
			// Reset to idle after showing "saved" status
			setTimeout(() => setStatus("idle"), TIMING.STATUS_RESET_MS);
		} catch (error) {
			failSave(error instanceof Error ? error.message : "Failed to rename collection");
		}

		setRenamingId(null);
		setRenameValue("");
	};

	/**
	 * Duplicate a request, contents and all — method, URL, params, headers,
	 * body, auth and both scripts. Collections deliberately have no equivalent:
	 * copying one means recursing through nested folders and issuing a create
	 * per request, which is its own feature. The previous collection "Duplicate"
	 * only created an empty folder named "(Copy)", which read as a working clone
	 * and was not one, so it was removed rather than left misleading.
	 */
	const handleDuplicateRequest = useCallback(
		async (request: Request) => {
			if (createRequestMutation.isPending) return;
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
			});
			openTab({ type: "request", entityId: copy.id });
		},
		[createRequestMutation, openTab]
	);

	/**
	 * Actions for a collection's "⋯" menu. Defined here, where the handlers and
	 * state live, and rendered by the shared RowActionsMenu — the same component
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
					if (!expandedCollectionIds.has(collection.id)) {
						toggleCollectionExpanded(collection.id);
					}
					setCreatingSubfolder(collection.id);
				},
			},
			{
				label: "Delete",
				icon: Trash2,
				destructive: true,
				onSelect: () =>
					setDeleteConfirm({
						type: "collection",
						id: collection.id,
						name: collection.name,
					}),
			},
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[expandedCollectionIds, toggleCollectionExpanded]
	);

	const handleDeleteCollection = useCallback(
		async (collectionId: string) => {
			setDeletingCollectionId(collectionId);
			setDeleteConfirm(null);
			// Gather the collection, its descendant folders, and every request they
			// contain: deleting a collection cascades, so all their tabs go stale.
			const affected = new Set<string>([collectionId]);
			const stack = [collectionId];
			while (stack.length > 0) {
				const current = stack.pop()!;
				for (const req of getRequestsByCollection(current)) affected.add(req.id);
				for (const child of collections) {
					if (child.parentId === current) {
						affected.add(child.id);
						stack.push(child.id);
					}
				}
			}
			try {
				await deleteCollectionMutation.mutateAsync(collectionId);
				closeTabsForEntities(affected);
			} finally {
				setDeletingCollectionId(null);
			}
		},
		[deleteCollectionMutation, closeTabsForEntities, collections, getRequestsByCollection]
	);

	const handleDeleteRequest = useCallback(
		async (requestId: string) => {
			setDeletingRequestId(requestId);
			setDeleteConfirm(null);
			try {
				await deleteRequestMutation.mutateAsync(requestId);
				// Close any open tab pointing at the now-deleted request.
				closeTabsForEntities([requestId]);
			} finally {
				setDeletingRequestId(null);
			}
		},
		[deleteRequestMutation, closeTabsForEntities]
	);

	const handleRequestDeleteClick = useCallback((requestId: string, requestName: string) => {
		setDeleteConfirm({ type: "request", id: requestId, name: requestName });
	}, []);

	const handleConfirmDelete = useCallback(() => {
		if (!deleteConfirm) return;
		if (deleteConfirm.type === "collection") {
			handleDeleteCollection(deleteConfirm.id);
		} else {
			handleDeleteRequest(deleteConfirm.id);
		}
	}, [deleteConfirm, handleDeleteCollection, handleDeleteRequest]);

	const handleStartRequestRename = (request: Request) => {
		setRenamingRequestId(request.id);
		setRenameRequestValue(request.name);
	};

	const handleRequestRenameSubmit = async (requestId: string) => {
		const trimmedValue = renameRequestValue.trim();

		// Validate: name cannot be empty
		if (!trimmedValue) {
			setRenamingRequestId(null);
			setRenameRequestValue("");
			return;
		}

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

		// Skip save if name hasn't actually changed
		if (originalRequest && originalRequest.name === trimmedValue) {
			setRenamingRequestId(null);
			setRenameRequestValue("");
			return;
		}

		startSaving();
		try {
			await updateRequestMutation.mutateAsync({
				id: requestId,
				name: trimmedValue,
			});
			completeSave();
			// Reset to idle after showing "saved" status
			setTimeout(() => setStatus("idle"), TIMING.STATUS_RESET_MS);
		} catch (error) {
			failSave(error instanceof Error ? error.message : "Failed to rename request");
		}

		setRenamingRequestId(null);
		setRenameRequestValue("");
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
					<TooltipProvider>
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
					</TooltipProvider>
				</>
			}
		>
			<div ref={treeRef} className="flex h-full flex-col">
				{/* New Collection Form */}
				{creatingCollection && (
					<div className="flex gap-2 mb-2">
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

				{/* Zero collections empty state */}
				{!isLoadingCollections && collections.length === 0 && !creatingCollection && (
					<EmptyState
						icon={Folder}
						title="No collections yet"
						description="Collections group related requests — make one to get started."
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

				{/* Root-level collections (no parentId) - sorted by order, scrollable.
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
							{rootCollections.map((collection) => (
								<CollectionItem
									key={collection.id}
									collection={collection}
									allCollections={collections}
									depth={0}
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
									onDuplicateRequest={handleDuplicateRequest}
								/>
							))}
						</div>
					</div>
				)}

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
