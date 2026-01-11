import { useState, useRef, useEffect } from "react";
import {
	Folder,
	Plus,
	Trash2,
	Edit2,
	Copy,
	FolderPlus,
	Loader2,
} from "lucide-react";
import { useAppStore, useCollectionsStore } from "@/stores";
import {
	useCollectionsQuery,
	useMultipleCollectionRequests,
	useCreateCollectionMutation,
	useUpdateCollectionMutation,
	useDeleteCollectionMutation,
	useCreateRequestMutation,
	useDeleteRequestMutation,
} from "@/queries";
import {
	Button,
	Input,
	Separator,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	TooltipProvider,
} from "@/components/ui";
import CollectionItem from "./CollectionItem";
import type { Collection, Request } from "@/types";

export default function CollectionTree() {
	const { navigateToRequest, navigateToWelcome, selectedCollectionId, setSelectedCollectionId, selectedRequestId } = useAppStore();
	const {
		expandedCollectionIds,
		toggleCollectionExpanded,
	} = useCollectionsStore();

	// TanStack Query hooks
	const { data: collections = [] } = useCollectionsQuery();

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

	// Helper to get requests for a collection
	const getRequestsByCollection = (collectionId: string): Request[] => {
		return requestsByCollection.get(collectionId) ?? [];
	};
	const [creatingCollection, setCreatingCollection] = useState(false);
	const [creatingSubfolder, setCreatingSubfolder] = useState<string | null>(null); // parent collection ID
	const [newCollectionName, setNewCollectionName] = useState("New Collection");
	const [newSubfolderName, setNewSubfolderName] = useState("New Folder");
	const [contextMenu, setContextMenu] = useState<{
		collectionId: string;
		x: number;
		y: number;
	} | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [deletingCollectionId, setDeletingCollectionId] = useState<string | null>(null);
	const [deletingRequestId, setDeletingRequestId] = useState<string | null>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);

	// Close context menu on outside click
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (
				contextMenuRef.current &&
				!contextMenuRef.current.contains(e.target as Node)
			) {
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

	const handleCollectionClick = async (collection: Collection) => {
		// Set this collection as selected (this will trigger useRequestsQuery to load)
		setSelectedCollectionId(collection.id);
		toggleCollectionExpanded(collection.id);
	};

	// Handle "New Request" button click - use selected collection or first one
	const handleNewRequestClick = () => {
		if (collections.length === 0) {
			// No collections - prompt to create one first
			setCreatingCollection(true);
			return;
		}

		// Use selected collection if available, otherwise use first collection
		const targetCollection = selectedCollectionId || collections[0].id;
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
		if (!newSubfolderName.trim() || createCollectionMutation.isPending) return;

		// Ensure parent collection is expanded
		if (!expandedCollectionIds.has(parentId)) {
			toggleCollectionExpanded(parentId);
		}

		await createCollectionMutation.mutateAsync({
			name: newSubfolderName.trim(),
			parent_id: parentId,
		});
		setNewSubfolderName("New Folder");
		setCreatingSubfolder(null);
	};

	const handleCreateRequest = async (collectionId: string) => {
		if (createRequestMutation.isPending) return;

		console.log("Creating request for collection:", collectionId);
		console.log("Collection expanded before:", expandedCollectionIds.has(collectionId));
		
		// Ensure collection is expanded
		if (!expandedCollectionIds.has(collectionId)) {
			console.log("Expanding collection:", collectionId);
			toggleCollectionExpanded(collectionId);
		}

		const request = await createRequestMutation.mutateAsync({
			collection_id: collectionId,
			name: "New Request",
			method: "GET",
			url: "https://api.example.com",
		});

		console.log("Request created, navigating to:", request?.id);
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
		if (!renameValue.trim()) return;

		await updateCollectionMutation.mutateAsync({
			id: collectionId,
			name: renameValue.trim(),
		});

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

	const handleShowContextMenu = (e: React.MouseEvent, collectionId: string) => {
		e.preventDefault();
		e.stopPropagation();
		setContextMenu({
			collectionId,
			x: e.clientX,
			y: e.clientY,
		});
	};

	const handleDeleteCollection = async (collectionId: string) => {
		setDeletingCollectionId(collectionId);
		setContextMenu(null);
		try {
			await deleteCollectionMutation.mutateAsync(collectionId);
			// If the deleted collection was selected, navigate to welcome
			if (selectedCollectionId === collectionId) {
				navigateToWelcome();
			}
		} finally {
			setDeletingCollectionId(null);
		}
	};

	const handleDeleteRequest = async (requestId: string) => {
		setDeletingRequestId(requestId);
		try {
			await deleteRequestMutation.mutateAsync(requestId);
			// If the deleted request was selected, navigate to welcome
			if (selectedRequestId === requestId) {
				navigateToWelcome();
			}
		} finally {
			setDeletingRequestId(null);
		}
	};

	return (
		<div className="p-4 space-y-2">
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
									onClick={() => setCreatingCollection(true)}
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
							<TooltipContent>New Collection</TooltipContent>
						</Tooltip>
					</TooltipProvider>

					<TooltipProvider>
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
									? `New Request in ${collections.find(c => c.id === selectedCollectionId)?.name || 'selected collection'}`
									: "New Request"}
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
						onKeyDown={(e) => e.key === "Enter" && handleCreateCollection()}
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
						{createCollectionMutation.isPending && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
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

			{/* Collections List */}
			{collections.length === 0 && !creatingCollection && (
				<div className="text-center py-8 text-sm text-muted-foreground">
					<Folder className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
					<p>No collections yet</p>
					<Button
						variant="link"
						onClick={() => setCreatingCollection(true)}
						className="mt-3 text-primary"
					>
						Create your first collection
					</Button>
				</div>
			)}

			{/* Root-level collections (no parent_id) - sorted by order */}
			{collections
				.filter((c) => !c.parent_id)
				.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
				.map((collection) => (
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
						newSubfolderName={newSubfolderName}
						isCreatingSubfolder={createCollectionMutation.isPending}
						getRequestsByCollection={getRequestsByCollection}
						onCollectionClick={handleCollectionClick}
						onRequestClick={handleRequestClick}
						onShowContextMenu={handleShowContextMenu}
						onRenameChange={setRenameValue}
						onRenameSubmit={handleRenameSubmit}
						onRenameCancel={() => {
							setRenamingId(null);
							setRenameValue("");
					}}
						onDeleteRequest={handleDeleteRequest}
						onSubfolderNameChange={setNewSubfolderName}
						onCreateSubfolder={handleCreateSubfolder}
						onCancelSubfolder={() => {
							setCreatingSubfolder(null);
							setNewSubfolderName("New Folder");
						}}
					/>
				))}

			{/* Context Menu */}
			{contextMenu && (
				<div
					ref={contextMenuRef}
					className="fixed bg-popover border rounded-md shadow-md py-1 z-50 min-w-[180px]"
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
						<Edit2 className="w-4 h-4 mr-2" />
						<span>Rename</span>
					</button>
					<button
						className="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
						onClick={() => handleDuplicateCollection(contextMenu.collectionId)}
					>
						<Copy className="w-4 h-4 mr-2" />
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
						<Plus className="w-4 h-4 mr-2" />
						<span>Add Request</span>
					</button>
					<button
						className="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
						onClick={() => {
							const parentId = contextMenu.collectionId;
							setContextMenu(null);
							// Expand parent collection if not already
							if (!expandedCollectionIds.has(parentId)) {
								toggleCollectionExpanded(parentId);
							}
							setCreatingSubfolder(parentId);
						}}
					>
						<FolderPlus className="w-4 h-4 mr-2" />
						<span>Add Folder</span>
					</button>
					<Separator className="my-1" />
					<button
						className="flex items-center w-full px-2 py-1.5 text-sm text-destructive hover:bg-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						onClick={() => handleDeleteCollection(contextMenu.collectionId)}
						disabled={deletingCollectionId === contextMenu.collectionId}
					>
						{deletingCollectionId === contextMenu.collectionId ? (
							<Loader2 className="w-4 h-4 mr-2 animate-spin" />
						) : (
								<Trash2 className="w-4 h-4 mr-2" />
						)}
						<span>{deletingCollectionId === contextMenu.collectionId ? 'Deleting...' : 'Delete'}</span>
					</button>
				</div>
			)}
		</div>
	);
}
