
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Folder, Plus, Trash2, Edit2, Copy, FolderPlus, Loader2 } from "lucide-react";
import { useNavigationStore, useCollectionsStore, useSaveStore } from "@/stores";
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
	Separator,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	TooltipProvider,
	DeleteConfirmDialog,
	ScrollArea,
	Skeleton,
} from "@/components/ui";
import CollectionItem from "./CollectionItem";
import type { Collection, Request } from "@/types";
import { compareCollectionOrder } from "@/types";

export default function CollectionTree() {
	const {
		navigateToRequest,
		navigateToWelcome,
		selectedCollectionId,
		setSelectedCollectionId,
		selectedRequestId,
	} = useNavigationStore();
	const { expandedCollectionIds, toggleCollectionExpanded } = useCollectionsStore();
	const { startSaving, completeSave, failSave, setStatus } = useSaveStore();

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
	const [creatingCollection, setCreatingCollection] = useState(false);
	const [creatingSubfolder, setCreatingSubfolder] = useState<string | null>(null); // parent collection ID
	const [newCollectionName, setNewCollectionName] = useState("New Collection");
	const [newSubCollectionName, setNewSubCollectionName] = useState("New Folder");
	const [contextMenu, setContextMenu] = useState<{
		collectionId: string;
		x: number;
		y: number;
	} | null>(null);
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
	const contextMenuRef = useRef<HTMLDivElement>(null);

	// Close context menu on outside click
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
				setContextMenu(null);
			}
		};

		if (contextMenu) {
			document.addEventListener("mousedown", handleClickOutside);
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [contextMenu]);

	const handleRenameCancel = useCallback(() => {
		setRenamingId(null);
		setRenameValue("");
	}, []);

	const handleCancelSubfolder = useCallback(() => {
		setCreatingSubfolder(null);
		setNewSubCollectionName("New Folder");
	}, []);

	const handleCollectionClick = useCallback(
		(collection: Collection) => {
			setSelectedCollectionId(collection.id);
			toggleCollectionExpanded(collection.id);
		},
		[setSelectedCollectionId, toggleCollectionExpanded]
	);

	const handleOpenNewCollectionForm = useCallback(() => {
		setNewCollectionName("New Collection");
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
			selectedCollectionId &&
			collections.some((c) => c.id === selectedCollectionId);
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
			name: "New Request",
			method: "GET",
			url: "https://api.example.com",
		});

		if (request) {
			navigateToRequest(collectionId, request.id);
		}
	};

	const handleRenameCollection = (collection: Collection) => {
		setRenamingId(collection.id);
		setRenameValue(collection.name);
		setContextMenu(null);
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
			setTimeout(() => setStatus("idle"), 2000);
		} catch (error) {
			failSave(error instanceof Error ? error.message : "Failed to rename collection");
		}

		setRenamingId(null);
		setRenameValue("");
	};

	const handleDuplicateCollection = async (collectionId: string) => {
		if (createCollectionMutation.isPending) return;

		const collection = collections.find((c) => c.id === collectionId);
		if (!collection) return;

		await createCollectionMutation.mutateAsync({ name: `${collection.name} (Copy)` });
		setContextMenu(null);
	};

	const MENU_WIDTH = 180;
	const MENU_HEIGHT = 260;

	const handleShowContextMenu = (e: React.MouseEvent, collectionId: string) => {
		e.preventDefault();
		e.stopPropagation();
		const x = Math.max(0, Math.min(e.clientX, window.innerWidth - MENU_WIDTH));
		const y = Math.max(0, Math.min(e.clientY, window.innerHeight - MENU_HEIGHT));
		setContextMenu({
			collectionId,
			x,
			y,
		});
	};

	const handleDeleteCollection = async (collectionId: string) => {
		setDeletingCollectionId(collectionId);
		setDeleteConfirm(null);
		try {
			await deleteCollectionMutation.mutateAsync(collectionId);
			if (selectedCollectionId === collectionId) {
				navigateToWelcome();
			}
		} finally {
			setDeletingCollectionId(null);
		}
	};

	const handleDeleteRequest = async (requestId: string) => {
		setDeletingRequestId(requestId);
		setDeleteConfirm(null);
		try {
			await deleteRequestMutation.mutateAsync(requestId);
			if (selectedRequestId === requestId) {
				navigateToWelcome();
			}
		} finally {
			setDeletingRequestId(null);
		}
	};

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
	}, [deleteConfirm]);

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
			setTimeout(() => setStatus("idle"), 2000);
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
		<div className="flex flex-col h-full w-full p-4 space-y-2">
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<h2 className="text-sm font-semibold text-foreground">Collections</h2>
				<div className="flex items-center gap-1">
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									onClick={handleOpenNewCollectionForm}
									disabled={createCollectionMutation.isPending}
									className="h-8 w-8"
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
					</TooltipProvider>
				</div>
			</div>

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
			{isLoadingCollections && (
				<div className="space-y-2 py-2">
					{[1, 2, 3].map((i) => (
						<div key={i} className="flex items-center gap-2 px-2 py-1.5">
							<Skeleton className="h-4 w-4 rounded" />
							<Skeleton className="h-4 w-5 flex-shrink-0 rounded" />
							<Skeleton className="h-4 flex-1 rounded" />
						</div>
					))}
				</div>
			)}

			{/* Zero collections empty state */}
			{!isLoadingCollections && collections.length === 0 && !creatingCollection && (
				<div className="text-center py-8 text-sm text-muted-foreground">
					<Folder className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
					<p className="font-medium text-foreground">No collections yet</p>
					<p className="mt-1 text-muted-foreground">
						Collections help you group and organize your requests.
					</p>
					<Button
						variant="link"
						onClick={handleOpenNewCollectionForm}
						className="mt-3 text-primary"
					>
						Add your first collection
					</Button>
				</div>
			)}

			{/* Root-level collections (no parentId) - sorted by order, scrollable */}
			{!isLoadingCollections && rootCollections.length > 0 && (
				<ScrollArea className="flex-1 min-h-0 -mx-1 px-1">
					<div className="space-y-0.5 pr-2">
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
						onRequestClick={handleRequestClick}
						onShowContextMenu={handleShowContextMenu}
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
					/>
				))}
					</div>
				</ScrollArea>
			)}

			{/* Context Menu */}
			{contextMenu && (
				<div
					ref={contextMenuRef}
					className="fixed bg-popover border shadow-md py-1 z-50 min-w-[180px]"
					style={{
						top: contextMenu.y,
						left: contextMenu.x,
					}}
				>
					<button
						className="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
						onClick={() => {
							const collection = collections.find(
								(c) => c.id === contextMenu.collectionId
							);
							if (collection) handleRenameCollection(collection);
						}}
					>
						<Edit2 className="w-4 h-4 mr-2 flex-shrink-0" />
						<span>Rename</span>
					</button>
					<button
						className="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
						onClick={() => handleDuplicateCollection(contextMenu.collectionId)}
					>
						<Copy className="w-4 h-4 mr-2 flex-shrink-0" />
						<span>Duplicate</span>
					</button>
					<button
						className="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
						onClick={async (e) => {
							e.stopPropagation();
							const collectionId = contextMenu.collectionId;
							setContextMenu(null);
							await handleCreateRequest(collectionId);
						}}
					>
						<Plus className="w-4 h-4 mr-2 flex-shrink-0" />
						<span>Add Request</span>
					</button>
					<button
						className="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
						onClick={() => {
							const parentId = contextMenu.collectionId;
							setContextMenu(null);
							if (!expandedCollectionIds.has(parentId)) {
								toggleCollectionExpanded(parentId);
							}
							setCreatingSubfolder(parentId);
						}}
					>
						<FolderPlus className="w-4 h-4 mr-2 flex-shrink-0" />
						<span>Add Folder</span>
					</button>
					<Separator className="my-1" />
					<button
						className="flex items-center w-full px-2 py-1.5 text-sm text-destructive hover:bg-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						onClick={() => {
							const collection = collections.find((c) => c.id === contextMenu.collectionId);
							setDeleteConfirm({
								type: "collection",
								id: contextMenu.collectionId,
								name: collection?.name ?? "Collection",
							});
							setContextMenu(null);
						}}
					>
						<Trash2 className="w-4 h-4 mr-2 flex-shrink-0" />
						<span>Delete</span>
					</button>
				</div>
			)}

			<DeleteConfirmDialog
				open={!!deleteConfirm}
				onOpenChange={(open) => !open && setDeleteConfirm(null)}
				title={deleteConfirm?.type === "collection" ? "Delete collection?" : "Delete request?"}
				description={
					deleteConfirm?.type === "collection"
						? `"${deleteConfirm?.name}" and all its requests will be permanently removed. This cannot be undone.`
						: `"${deleteConfirm?.name}" will be permanently removed. This cannot be undone.`
				}
				onConfirm={handleConfirmDelete}
				isDeleting={
					(deleteConfirm?.type === "collection" && deletingCollectionId === deleteConfirm?.id) ||
					(deleteConfirm?.type === "request" && deletingRequestId === deleteConfirm?.id)
				}
			/>
		</div>
	);
}
