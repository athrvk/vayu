import { useState, useRef, useEffect } from "react";
import {
	ChevronRight,
	ChevronDown,
	Folder,
	File,
	Plus,
	Trash2,
	MoreVertical,
	Edit2,
	Copy,
	FolderPlus,
	Loader2,
} from "lucide-react";
import { useAppStore, useCollectionsStore } from "@/stores";
import { useCollections } from "@/hooks";
import { getMethodColor } from "@/utils";
import type { Collection, Request } from "@/types";

export default function CollectionTree() {
	const { navigateToRequest, selectedCollectionId, setSelectedCollectionId, selectedRequestId } = useAppStore();
	const {
		collections,
		expandedCollectionIds,
		toggleCollectionExpanded,
		getRequestsByCollection,
		isSavingCollection,
		isSavingRequest,
	} = useCollectionsStore();
	const {
		loadRequestsForCollection,
		deleteCollection,
		deleteRequest,
		createCollection,
		createRequest,
		updateCollection,
	} = useCollections();
	const [creatingCollection, setCreatingCollection] = useState(false);
	const [newCollectionName, setNewCollectionName] = useState("New Collection");
	const [contextMenu, setContextMenu] = useState<{
		collectionId: string;
		x: number;
		y: number;
	} | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [showCollectionPicker, setShowCollectionPicker] = useState(false);
	const [deletingCollectionId, setDeletingCollectionId] = useState<string | null>(null);
	const [deletingRequestId, setDeletingRequestId] = useState<string | null>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);
	const collectionPickerRef = useRef<HTMLDivElement>(null);

	// Close context menu and collection picker on outside click
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (
				contextMenuRef.current &&
				!contextMenuRef.current.contains(e.target as Node)
			) {
				setContextMenu(null);
			}
			if (
				collectionPickerRef.current &&
				!collectionPickerRef.current.contains(e.target as Node)
			) {
				setShowCollectionPicker(false);
			}
		};

		if (contextMenu || showCollectionPicker) {
			document.addEventListener("mousedown", handleClickOutside);
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [contextMenu, showCollectionPicker]);

	const handleCollectionClick = async (collection: Collection) => {
		// Set this collection as selected
		setSelectedCollectionId(collection.id);
		toggleCollectionExpanded(collection.id);

		// Load requests if expanding and not already loaded
		if (!expandedCollectionIds.has(collection.id)) {
			await loadRequestsForCollection(collection.id);
		}
	};

	// Handle "New Request" button click with smart collection selection
	const handleNewRequestClick = () => {
		if (collections.length === 0) {
			// No collections - prompt to create one first
			setCreatingCollection(true);
			return;
		}

		if (selectedCollectionId) {
			// A collection is already selected - add request there
			handleCreateRequest(selectedCollectionId);
		} else if (collections.length === 1) {
			// Only one collection exists - use it directly
			handleCreateRequest(collections[0].id);
		} else {
			// Multiple collections, none selected - show picker
			setShowCollectionPicker(true);
		}
	};

	// Pick a collection and create request in it
	const handlePickCollectionForRequest = (collectionId: string) => {
		setShowCollectionPicker(false);
		setSelectedCollectionId(collectionId);
		handleCreateRequest(collectionId);
	};

	const handleRequestClick = (collectionId: string, requestId: string) => {
		navigateToRequest(collectionId, requestId);
	};

	const handleCreateCollection = async () => {
		if (!newCollectionName.trim() || isSavingCollection) return;

		await createCollection({ name: newCollectionName.trim() });
		setNewCollectionName("");
		setCreatingCollection(false);
	};

	const handleCreateRequest = async (collectionId: string) => {
		if (isSavingRequest) return;

		console.log("Creating request for collection:", collectionId);
		console.log("Collection expanded before:", expandedCollectionIds.has(collectionId));
		
		// Ensure collection is expanded
		if (!expandedCollectionIds.has(collectionId)) {
			console.log("Expanding collection:", collectionId);
			toggleCollectionExpanded(collectionId);
		}

		const request = await createRequest({
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

		const success = await updateCollection(collectionId, {
			name: renameValue.trim(),
		});

		if (success) {
			setRenamingId(null);
			setRenameValue("");
		}
	};

	const handleDuplicateCollection = async (collectionId: string) => {
		if (isSavingCollection) return;

		const collection = collections.find((c) => c.id === collectionId);
		if (!collection) return;

		await createCollection({ name: `${collection.name} (Copy)` });
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
			await deleteCollection(collectionId);
		} finally {
			setDeletingCollectionId(null);
		}
	};

	const handleDeleteRequest = async (requestId: string) => {
		setDeletingRequestId(requestId);
		try {
			await deleteRequest(requestId);
		} finally {
			setDeletingRequestId(null);
		}
	};

	return (
		<div className="p-4 space-y-2">
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<h2 className="text-sm font-semibold text-gray-700">Collections</h2>
				<div className="flex items-center gap-1">
					<button
						onClick={() => setCreatingCollection(true)}
						disabled={isSavingCollection}
						className="p-1.5 hover:bg-gray-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						title="New Collection"
					>
						{isSavingCollection ? (
							<Loader2 className="w-4 h-4 text-gray-600 animate-spin" />
						) : (
							<FolderPlus className="w-4 h-4 text-gray-600" />
						)}
					</button>
					<div className="relative">
						<button
							onClick={handleNewRequestClick}
							disabled={isSavingRequest}
							className="p-1.5 hover:bg-gray-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							title={selectedCollectionId
								? `New Request in ${collections.find(c => c.id === selectedCollectionId)?.name || 'selected collection'}`
								: "New Request"}
						>
							{isSavingRequest ? (
								<Loader2 className="w-4 h-4 text-gray-600 animate-spin" />
							) : (
									<Plus className="w-4 h-4 text-gray-600" />
							)}
						</button>

						{/* Collection Picker Dropdown */}
						{showCollectionPicker && (
							<div
								ref={collectionPickerRef}
								className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-[200px]"
							>
								<div className="px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-100">
									Select a collection for the new request
								</div>
								{collections.map((collection) => (
									<button
										key={collection.id}
										onClick={() => handlePickCollectionForRequest(collection.id)}
										className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2"
									>
										<Folder className="w-4 h-4 text-primary-500" />
										<span>{collection.name}</span>
									</button>
								))}
							</div>
						)}
					</div>
				</div>
			</div>

			{/* New Collection Form */}
			{creatingCollection && (
				<div className="flex gap-2 mb-2">
					<input
						type="text"
						value={newCollectionName}
						onChange={(e) => setNewCollectionName(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && handleCreateCollection()}
						placeholder="Collection name"
						className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50"
						disabled={isSavingCollection}
						autoFocus
					/>
					<button
						onClick={handleCreateCollection}
						disabled={isSavingCollection}
						className="px-3 py-1 text-sm bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
					>
						{isSavingCollection && <Loader2 className="w-3 h-3 animate-spin" />}
						Add
					</button>
					<button
						onClick={() => {
							setCreatingCollection(false);
							setNewCollectionName("");
						}}
						disabled={isSavingCollection}
						className="px-3 py-1 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Cancel
					</button>
				</div>
			)}

			{/* Collections List */}
			{collections.length === 0 && !creatingCollection && (
				<div className="text-center py-8 text-sm text-gray-500">
					<Folder className="w-12 h-12 mx-auto mb-3 text-gray-300" />
					<p>No collections yet</p>
					<button
						onClick={() => setCreatingCollection(true)}
						className="mt-3 text-primary-600 hover:text-primary-700 font-medium"
					>
						Create your first collection
					</button>
				</div>
			)}

			{collections.map((collection) => {
				const isExpanded = expandedCollectionIds.has(collection.id);
				const requests = getRequestsByCollection(collection.id);
				const isRenaming = renamingId === collection.id;

				return (
					<div key={collection.id} className="select-none">
						{/* Collection Header */}
						<div className={`flex items-center gap-1 px-2 py-1.5 rounded group transition-colors ${selectedCollectionId === collection.id
								? 'bg-primary-50 hover:bg-primary-100 ring-1 ring-primary-200'
								: 'hover:bg-gray-100'
							}`}>
							<button
								onClick={() => handleCollectionClick(collection)}
								className="flex items-center gap-2 flex-1 text-left"
							>
								{isExpanded ? (
									<ChevronDown className="w-4 h-4 text-gray-500" />
								) : (
									<ChevronRight className="w-4 h-4 text-gray-500" />
								)}
								<Folder className="w-4 h-4 text-primary-500" />
								{isRenaming ? (
									<input
										type="text"
										value={renameValue}
										onChange={(e) => setRenameValue(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												handleRenameSubmit(collection.id);
											} else if (e.key === "Escape") {
												setRenamingId(null);
												setRenameValue("");
											}
										}}
										onBlur={() => handleRenameSubmit(collection.id)}
										className="flex-1 px-2 py-0.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
										autoFocus
										onClick={(e) => e.stopPropagation()}
									/>
								) : (
									<>
										<span className="text-sm font-medium text-gray-700">
											{collection.name}
										</span>
										<span className="text-xs text-gray-400">
											({requests.length})
										</span>
									</>
								)}
							</button>

							{!isRenaming && (
								<div className="hidden group-hover:flex items-center gap-1">
									<button
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											handleShowContextMenu(e, collection.id);
										}}
										className="p-1 hover:bg-gray-200 rounded"
										title="More actions"
									>
										<MoreVertical className="w-3 h-3 text-gray-600" />
									</button>
								</div>
							)}
						</div>

						{/* Requests List */}
						{isExpanded && (
							<div className="ml-6 mt-1 space-y-0.5">
								{requests.length === 0 && (
									<div className="py-2 px-3 text-xs text-gray-400">
										No requests yet
									</div>
								)}
								{requests.map((request) => (
									<RequestItem
										key={request.id}
										request={request}
										collectionId={collection.id}
										onSelect={handleRequestClick}
										onDelete={handleDeleteRequest}
										isDeleting={deletingRequestId === request.id}
										isSelected={selectedCollectionId === collection.id && selectedRequestId === request.id}
									/>
								))}
							</div>
						)}
					</div>
				);
			})}

			{/* Context Menu */}
			{contextMenu && (
				<div
					ref={contextMenuRef}
					className="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-[180px]"
					style={{
						top: contextMenu.y,
						left: contextMenu.x,
					}}
				>
					<button
						onClick={() => {
							const collection = collections.find(
								(c) => c.id === contextMenu.collectionId
							);
							if (collection) handleRenameCollection(collection);
						}}
						className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-3"
					>
						<Edit2 className="w-4 h-4 text-gray-600" />
						<span>Rename</span>
					</button>
					<button
						onClick={() => handleDuplicateCollection(contextMenu.collectionId)}
						className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-3"
					>
						<Copy className="w-4 h-4 text-gray-600" />
						<span>Duplicate</span>
					</button>
					<button
						onClick={async (e) => {
							e.stopPropagation();
							const collectionId = contextMenu.collectionId;
							setContextMenu(null);
							await handleCreateRequest(collectionId);
						}}
						className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-3"
					>
						<Plus className="w-4 h-4 text-gray-600" />
						<span>Add Request</span>
					</button>
					<button
						onClick={() => {
							// TODO: Add subfolder creation
							console.log("Add folder");
							setContextMenu(null);
						}}
						className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-3"
					>
						<FolderPlus className="w-4 h-4 text-gray-600" />
						<span>Add Folder</span>
					</button>
					<div className="border-t border-gray-200 my-1" />
					<button
						onClick={() => handleDeleteCollection(contextMenu.collectionId)}
						disabled={deletingCollectionId === contextMenu.collectionId}
						className="w-full px-4 py-2 text-left text-sm hover:bg-red-50 flex items-center gap-3 text-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{deletingCollectionId === contextMenu.collectionId ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
								<Trash2 className="w-4 h-4" />
						)}
						<span>{deletingCollectionId === contextMenu.collectionId ? 'Deleting...' : 'Delete'}</span>
					</button>
				</div>
			)}
		</div>
	);
}

interface RequestItemProps {
	request: Request;
	collectionId: string;
	onSelect: (collectionId: string, requestId: string) => void;
	onDelete: (requestId: string) => Promise<void>;
	isDeleting?: boolean;
	isSelected?: boolean;
}

function RequestItem({
	request,
	collectionId,
	onSelect,
	onDelete,
	isDeleting,
	isSelected,
}: RequestItemProps) {
	return (
		<div className={`flex items-center gap-2 px-3 py-1.5 rounded group cursor-pointer transition-colors ${isDeleting
				? 'opacity-50'
				: isSelected
					? 'bg-primary-50 ring-1 ring-primary-200 hover:bg-primary-100'
					: 'hover:bg-gray-100'
			}`}>
			<button
				onClick={() => onSelect(collectionId, request.id)}
				className="flex items-center gap-2 flex-1 text-left"
				disabled={isDeleting}
			>
				{/* <File className="w-3.5 h-3.5 text-gray-400" /> */}
				<span
					className={`text-xs font-mono font-semibold px-1.5 py-0.5 rounded ${getMethodColor(
						request.method
					)}`}
				>
					{request.method}
				</span>
				<span className="text-sm text-gray-700 truncate">{request.name}</span>
			</button>

			<button
				onClick={() => onDelete(request.id)}
				disabled={isDeleting}
				className={`p-1 hover:bg-red-100 rounded ${isDeleting ? 'block' : 'hidden group-hover:block'}`}
				title="Delete Request"
			>
				{isDeleting ? (
					<Loader2 className="w-3 h-3 text-red-600 animate-spin" />
				) : (
						<Trash2 className="w-3 h-3 text-red-600" />
				)}
			</button>
		</div>
	);
}
