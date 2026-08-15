/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useMemo, useState } from "react";
import { Plus, Trash2, Edit2, FileJson, FolderPlus, Play } from "lucide-react";
import { useTabsStore, useSaveStore } from "@/stores";
import { useCollectionsStore } from "@/modules/collections/collections-store";
import {
	useCreateCollectionMutation,
	useUpdateCollectionMutation,
	useDeleteCollectionMutation,
	useCreateRequestMutation,
	useDeleteRequestMutation,
	useUpdateRequestMutation,
} from "@/queries";
import { collectDescendantEntityIds } from "./tree-utils";
import type { CollectionTreeCrudSlice } from "./context/CollectionTreeContext";
import type { RowAction } from "@/components/shared";
import type { Collection, Request } from "@/types";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { DEFAULT_COLLECTION_NAME, DEFAULT_FOLDER_NAME } from "@/constants/collection";

export interface TreeCrudOptions {
	collections: Collection[];
	/** Sorted roots, so "New request" with nothing selected has a target. */
	rootCollections: Collection[];
	selectedCollectionId: string | null;
	requestsByCollection: Map<string, Request[]>;
	getRequestsByCollection: (collectionId: string) => Request[];
}

/** What the tree's own chrome renders: the create form, the toolbar, the dialog. */
export interface TreeCrudPanel {
	creatingCollection: boolean;
	newCollectionName: string;
	setNewCollectionName: (value: string) => void;
	openNewCollectionForm: () => void;
	cancelNewCollectionForm: () => void;
	createCollection: () => void;
	/** "New request": into the selected collection, else the first root. */
	createRequestFromToolbar: () => void;
	isCreatingCollection: boolean;
	isCreatingRequest: boolean;
	deleteConfirm: DeleteConfirmTarget | null;
	dismissDeleteConfirm: () => void;
	confirmDelete: () => void;
	/** The confirm dialog's own delete is in flight - its button spins. */
	isDeleteInFlight: boolean;
	/**
	 * The collection the run dialog is pointed at, or null when it is closed.
	 * The whole collection and not just its id: the dialog names it, and the
	 * row that opened it already has the object.
	 */
	runTarget: Collection | null;
	dismissRunDialog: () => void;
	/**
	 * The collection the OpenAPI export dialog is pointed at, or null when it is
	 * closed - the whole object for the same reason `runTarget` is (issue #630).
	 */
	exportTarget: Collection | null;
	dismissExportDialog: () => void;
}

export interface DeleteConfirmTarget {
	type: "collection" | "request";
	id: string;
	name: string;
}

export interface TreeCrud {
	panel: TreeCrudPanel;
	/** The slice every row reads, shaped for the tree context. */
	rows: CollectionTreeCrudSlice;
}

/**
 * Create, rename, duplicate and delete for the collection tree, with the inline
 * form state each one drives. Lifted out of `CollectionTree` so that component
 * is layout: eleven `useState` atoms and their handlers were ~360 of its lines,
 * and the rows only ever saw the result.
 */
export function useTreeCrud({
	collections,
	rootCollections,
	selectedCollectionId,
	requestsByCollection,
	getRequestsByCollection,
}: TreeCrudOptions): TreeCrud {
	const { openTab, closeTabsForEntities } = useTabsStore();
	const { expandCollection, toggleCollectionExpanded } = useCollectionsStore();
	const { startSaving, completeSaveThenIdle, failSave } = useSaveStore();

	const createCollectionMutation = useCreateCollectionMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();
	const deleteCollectionMutation = useDeleteCollectionMutation();
	const createRequestMutation = useCreateRequestMutation();
	const deleteRequestMutation = useDeleteRequestMutation();
	const updateRequestMutation = useUpdateRequestMutation();

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
	const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmTarget | null>(null);
	const [runTarget, setRunTarget] = useState<Collection | null>(null);
	const [exportTarget, setExportTarget] = useState<Collection | null>(null);

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

	const handleRequestClick = useCallback(
		(collectionId: string, requestId: string) => {
			navigateToRequest(collectionId, requestId);
		},
		[navigateToRequest]
	);

	const handleOpenNewCollectionForm = useCallback(() => {
		setNewCollectionName(DEFAULT_COLLECTION_NAME);
		setCreatingCollection(true);
	}, []);

	// Escape and Cancel are the same dismissal; named so they cannot drift.
	const handleCancelNewCollectionForm = useCallback(() => {
		setCreatingCollection(false);
		setNewCollectionName("");
	}, []);

	const handleCreateCollection = useCallback(async () => {
		if (!newCollectionName.trim() || createCollectionMutation.isPending) return;

		try {
			await createCollectionMutation.mutateAsync({ name: newCollectionName.trim() });
		} catch (error) {
			reportFailure(error, "Failed to create collection");
			return; // Keep the form open with the typed name so it can be retried.
		}
		handleCancelNewCollectionForm();
	}, [newCollectionName, createCollectionMutation, reportFailure, handleCancelNewCollectionForm]);

	const handleCancelSubfolder = useCallback(() => {
		setCreatingSubfolder(null);
		setNewSubCollectionName(DEFAULT_FOLDER_NAME);
	}, []);

	const handleCreateSubfolder = useCallback(
		async (parentId: string) => {
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
		},
		[
			newSubCollectionName,
			createCollectionMutation,
			expandCollection,
			reportFailure,
			handleCancelSubfolder,
		]
	);

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

	// Handle "New Request" button click - use selected collection or first root
	const handleNewRequestClick = useCallback(() => {
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
		void handleCreateRequest(targetCollection);
	}, [
		rootCollections,
		selectedCollectionId,
		collections,
		handleOpenNewCollectionForm,
		handleCreateRequest,
	]);

	const handleRenameCollection = useCallback((collection: Collection) => {
		setRenamingId(collection.id);
		setRenameValue(collection.name);
	}, []);

	const handleRenameCancel = useCallback(() => {
		setRenamingId(null);
		setRenameValue("");
	}, []);

	const handleRenameSubmit = useCallback(
		async (collectionId: string) => {
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
		},
		[
			renameValue,
			collections,
			startSaving,
			updateCollectionMutation,
			completeSaveThenIdle,
			failSave,
		]
	);

	const handleStartRequestRename = useCallback((request: Request) => {
		setRenamingRequestId(request.id);
		setRenameRequestValue(request.name);
	}, []);

	const handleRequestRenameCancel = useCallback(() => {
		setRenamingRequestId(null);
		setRenameRequestValue("");
	}, []);

	const handleRequestRenameSubmit = useCallback(
		async (requestId: string) => {
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
		},
		[
			renameRequestValue,
			requestsByCollection,
			startSaving,
			updateRequestMutation,
			completeSaveThenIdle,
			failSave,
		]
	);

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

	// Named, so the ⋯ menu's Delete and the row's hidden `data-tree-delete`
	// control (the Delete key's target) open the very same dialog rather than
	// being two copies of one object literal that can drift apart.
	const handleCollectionDeleteClick = useCallback((id: string, name: string) => {
		setDeleteConfirm({ type: "collection", id, name });
	}, []);

	const handleRequestDeleteClick = useCallback((requestId: string, requestName: string) => {
		setDeleteConfirm({ type: "request", id: requestId, name: requestName });
	}, []);

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

	const handleConfirmDelete = useCallback(() => {
		if (!deleteConfirm) return;
		// The dialog now stays open while the delete runs, so its confirm button
		// survives long enough to be clicked twice. `isDeleting` disables it from
		// the next render on; this covers the frame before that.
		if (deletingCollectionId || deletingRequestId) return;
		if (deleteConfirm.type === "collection") {
			void handleDeleteCollection(deleteConfirm.id);
		} else {
			void handleDeleteRequest(deleteConfirm.id);
		}
	}, [
		deleteConfirm,
		deletingCollectionId,
		deletingRequestId,
		handleDeleteCollection,
		handleDeleteRequest,
	]);

	const dismissDeleteConfirm = useCallback(() => setDeleteConfirm(null), []);
	const dismissRunDialog = useCallback(() => setRunTarget(null), []);
	const dismissExportDialog = useCallback(() => setExportTarget(null), []);

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
				// First, and above the edit actions: it is the only one here that
				// acts on the folder's contents rather than on the folder.
				label: "Run collection",
				icon: Play,
				onSelect: () => setRunTarget(collection),
			},
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
				// Below the edit actions and above Delete: it reads the folder
				// rather than changing it, and it is offered for every collection
				// - a bound one exports its own document, a free-form one a
				// skeleton (issue #630).
				label: "Export as OpenAPI",
				icon: FileJson,
				onSelect: () => setExportTarget(collection),
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

	const isCreatingCollection = createCollectionMutation.isPending;
	const isCreatingRequest = createRequestMutation.isPending;

	const panel = useMemo<TreeCrudPanel>(
		() => ({
			creatingCollection,
			newCollectionName,
			setNewCollectionName,
			openNewCollectionForm: handleOpenNewCollectionForm,
			cancelNewCollectionForm: handleCancelNewCollectionForm,
			createCollection: () => void handleCreateCollection(),
			createRequestFromToolbar: handleNewRequestClick,
			isCreatingCollection,
			isCreatingRequest,
			deleteConfirm,
			dismissDeleteConfirm,
			confirmDelete: handleConfirmDelete,
			isDeleteInFlight:
				(deleteConfirm?.type === "collection" &&
					deletingCollectionId === deleteConfirm.id) ||
				(deleteConfirm?.type === "request" && deletingRequestId === deleteConfirm.id),
			runTarget,
			dismissRunDialog,
			exportTarget,
			dismissExportDialog,
		}),
		[
			creatingCollection,
			newCollectionName,
			handleOpenNewCollectionForm,
			handleCancelNewCollectionForm,
			handleCreateCollection,
			handleNewRequestClick,
			isCreatingCollection,
			isCreatingRequest,
			deleteConfirm,
			dismissDeleteConfirm,
			handleConfirmDelete,
			deletingCollectionId,
			deletingRequestId,
			runTarget,
			dismissRunDialog,
			exportTarget,
			dismissExportDialog,
		]
	);

	const rows = useMemo<CollectionTreeCrudSlice>(
		() => ({
			renamingId,
			renameValue,
			renamingRequestId,
			renameRequestValue,
			deletingCollectionId,
			deletingRequestId,
			creatingSubfolder,
			newSubCollectionName,
			isCreatingSubfolder: isCreatingCollection,
			onCollectionClick: handleCollectionClick,
			onCollectionToggle: handleCollectionToggle,
			onRequestClick: handleRequestClick,
			getCollectionActions,
			onRenameChange: setRenameValue,
			onRenameSubmit: handleRenameSubmit,
			onRenameCancel: handleRenameCancel,
			onStartRename: handleRenameCollection,
			onRequestRenameChange: setRenameRequestValue,
			onRequestRenameSubmit: handleRequestRenameSubmit,
			onRequestRenameCancel: handleRequestRenameCancel,
			onStartRequestRename: handleStartRequestRename,
			onCollectionDeleteClick: handleCollectionDeleteClick,
			onRequestDeleteClick: handleRequestDeleteClick,
			onDuplicateRequest: handleDuplicateRequest,
			onSubCollectionNameChange: setNewSubCollectionName,
			onCreateSubfolder: handleCreateSubfolder,
			onCancelSubfolder: handleCancelSubfolder,
		}),
		[
			renamingId,
			renameValue,
			renamingRequestId,
			renameRequestValue,
			deletingCollectionId,
			deletingRequestId,
			creatingSubfolder,
			newSubCollectionName,
			isCreatingCollection,
			handleCollectionClick,
			handleCollectionToggle,
			handleRequestClick,
			getCollectionActions,
			handleRenameSubmit,
			handleRenameCancel,
			handleRenameCollection,
			handleRequestRenameSubmit,
			handleRequestRenameCancel,
			handleStartRequestRename,
			handleCollectionDeleteClick,
			handleRequestDeleteClick,
			handleDuplicateRequest,
			handleCreateSubfolder,
			handleCancelSubfolder,
		]
	);

	return { panel, rows };
}
