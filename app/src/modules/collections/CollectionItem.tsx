/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef, useEffect } from "react";
import { ChevronRight, ChevronDown, Folder, Loader2 } from "lucide-react";
import RequestItem from "./RequestItem";
import type { Collection, Request } from "@/types";
import { compareCollectionOrder } from "@/types";
import { Button, Input } from "@/components/ui";
import { RowActionsMenu, TruncatedText, type RowAction } from "@/components/shared";
import { cn } from "@/lib/utils";
import { TIMING } from "@/config/timing";
import { INDENT_STEP } from "@/constants/layout";

export interface CollectionItemProps {
	collection: Collection;
	allCollections: Collection[];
	depth: number;
	expandedCollectionIds: Set<string>;
	selectedCollectionId: string | null;
	selectedRequestId: string | null;
	renamingId: string | null;
	renameValue: string;
	deletingCollectionId: string | null;
	deletingRequestId: string | null;
	creatingSubfolder: string | null;
	newSubCollectionName: string;
	isCreatingSubfolder: boolean;
	renamingRequestId: string | null;
	renameRequestValue: string;
	getRequestsByCollection: (collectionId: string) => Request[];
	onCollectionClick: (collection: Collection) => void;
	onRequestClick: (collectionId: string, requestId: string) => void;
	onCollectionToggle: (collection: Collection) => void;
	/** Actions for this collection's ⋯ menu; built by CollectionTree. */
	getCollectionActions: (collection: Collection) => RowAction[];
	onRenameChange: (value: string) => void;
	onRenameSubmit: (collectionId: string) => void;
	onRenameCancel: () => void;
	onStartRename: (collection: Collection) => void;
	onDeleteRequest: (requestId: string) => Promise<void>;
	onRequestDeleteClick?: (requestId: string, requestName: string) => void;
	onDuplicateRequest?: (request: Request) => void;
	onSubCollectionNameChange: (value: string) => void;
	onCreateSubfolder: (parentId: string) => void;
	onCancelSubfolder: () => void;
	onRequestRenameChange: (value: string) => void;
	onRequestRenameSubmit: (requestId: string) => void;
	onRequestRenameCancel: () => void;
	onStartRequestRename: (request: Request) => void;
}

export default function CollectionItem({
	collection,
	allCollections,
	depth,
	expandedCollectionIds,
	selectedCollectionId,
	selectedRequestId,
	renamingId,
	renameValue,
	deletingCollectionId,
	deletingRequestId,
	creatingSubfolder,
	newSubCollectionName,
	isCreatingSubfolder,
	renamingRequestId,
	renameRequestValue,
	getRequestsByCollection,
	onCollectionClick,
	onRequestClick,
	onCollectionToggle,
	getCollectionActions,
	onRenameChange,
	onRenameSubmit,
	onRenameCancel,
	onStartRename,
	onDeleteRequest,
	onRequestDeleteClick,
	onDuplicateRequest,
	onSubCollectionNameChange,
	onCreateSubfolder,
	onCancelSubfolder,
	onRequestRenameChange,
	onRequestRenameSubmit,
	onRequestRenameCancel,
	onStartRequestRename,
}: CollectionItemProps) {
	const isExpanded = expandedCollectionIds.has(collection.id);
	const isSelected = selectedCollectionId === collection.id;
	const requests = getRequestsByCollection(collection.id);
	const isRenaming = renamingId === collection.id;
	const isDeleting = deletingCollectionId === collection.id;
	const childCollections = allCollections
		.filter((c) => c.parentId === collection.id)
		.sort(compareCollectionOrder);

	const expandTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const CLICK_DELAY_MS = TIMING.TREE_CLICK_DELAY_MS;

	useEffect(
		() => () => {
			if (expandTimeoutRef.current) clearTimeout(expandTimeoutRef.current);
		},
		[]
	);

	const handleClick = (e: React.MouseEvent) => {
		if (isDeleting || isRenaming) return;
		// Second click of a double-click: ignore (double-click handler will run rename only)
		if (e.detail === 2) return;

		if (expandTimeoutRef.current) {
			clearTimeout(expandTimeoutRef.current);
			expandTimeoutRef.current = null;
		}

		expandTimeoutRef.current = setTimeout(() => {
			expandTimeoutRef.current = null;
			onCollectionClick(collection);
		}, CLICK_DELAY_MS);
	};

	const handleDoubleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (isDeleting || isRenaming) return;

		if (expandTimeoutRef.current) {
			clearTimeout(expandTimeoutRef.current);
			expandTimeoutRef.current = null;
		}

		onStartRename(collection);
	};

	const handleToggleClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (isDeleting || isRenaming) return;
		onCollectionToggle(collection);
	};

	/**
	 * Indentation is padding *inside* the row, never margin around it. A margin
	 * would push the row's background in too, so a nested row's hover and
	 * selection fill would stop short of the panel edge while a top-level row's
	 * reached it. Depth is shown by where the content sits, not where the row
	 * starts.
	 */
	const indentPx = 8 + depth * INDENT_STEP;

	return (
		<div className={cn("select-none", isDeleting && "opacity-50")}>
			{/* Collection Header */}
			{/* The row is the treeitem: one tab stop for the whole tree, arrows
			    move between rows (useRovingTreeFocus). tabIndex starts at -1; the
			    hook promotes exactly one row to 0. */}
			<div
				role="treeitem"
				tabIndex={-1}
				aria-expanded={isExpanded}
				aria-selected={isSelected}
				className={cn(
					// focus-row: this row is the perceived target, not the narrower
					// label button inside it - it paints the keyboard focus ring.
					// The transition deliberately omits outline-color (which
					// `transition-colors` includes in Tailwind v4): a focus ring must
					// appear instantly, otherwise it visibly fades between rows as
					// Tab moves. Hover may ease; focus may not.
					// h-8: the shared drawer row height. Row height used to be an
					// accident of content - the 28px chevron set it here, padding set
					// it elsewhere - so sibling drawer views ran 34/36/38/40px and the
					// rhythm shifted every time you switched view.
					"focus-row flex h-8 items-center gap-1 pr-2 group transition-[color,background-color,border-color] cursor-pointer",
					isSelected
						? "bg-primary/10 hover:bg-primary/15 ring-1 ring-inset ring-primary/20"
						: "hover:bg-accent"
				)}
				style={{ paddingLeft: indentPx }}
			>
				<button
					onClick={handleToggleClick}
					tabIndex={-1}
					data-tree-toggle
					className={cn(
						// focus-self: this toggles expansion rather than opening the
						// collection, so it keeps its own ring instead of lighting
						// up the whole row.
						// w-6 h-6 (24px) so the chevron fits the 32px row. Still an
						// adequate pointer target, and the row itself remains clickable.
						"focus-self flex items-center justify-center w-6 h-6 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
						isSelected
							? "text-primary/90 hover:text-primary"
							: "text-muted-foreground hover:text-foreground"
					)}
					disabled={isDeleting || isRenaming}
					aria-label={isExpanded ? "Collapse collection" : "Expand collection"}
				>
					{isDeleting ? (
						<Loader2 className="w-[18px] h-[18px] animate-spin" />
					) : isExpanded ? (
						<ChevronDown className="w-[18px] h-[18px]" />
					) : (
						<ChevronRight className="w-[18px] h-[18px]" />
					)}
				</button>
				<button
					onClick={handleClick}
					onDoubleClick={handleDoubleClick}
					tabIndex={-1}
					data-tree-activate
					className="flex min-w-0 items-center gap-2 flex-1 text-left cursor-pointer"
					disabled={isDeleting || isRenaming}
				>
					<Folder
						className={cn(
							"w-4 h-4 shrink-0",
							depth === 0 ? "text-primary" : "text-primary/70"
						)}
					/>
					{isRenaming ? (
						<Input
							type="text"
							value={renameValue}
							onChange={(e) => onRenameChange(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									onRenameSubmit(collection.id);
								} else if (e.key === "Escape") {
									onRenameCancel();
								}
							}}
							onBlur={() => onRenameSubmit(collection.id)}
							className="flex-1 h-6 text-sm"
							autoFocus
							onClick={(e) => e.stopPropagation()}
						/>
					) : (
						<>
							{/*
							 * truncate + min-w-0 on the button: a flex item won't
							 * shrink below its content by default, so without both a
							 * long name widens the row and scrolls the whole panel
							 * sideways instead of ellipsing.
							 */}
							<TruncatedText
								className={cn(
									"text-sm text-foreground cursor-pointer",
									depth === 0 && "font-medium"
								)}
							>
								{collection.name}
							</TruncatedText>
							{/* shrink-0: the count is short and load-bearing - the name
							    yields first. */}
							<span className="shrink-0 text-xs text-muted-foreground">
								({requests.length + childCollections.length})
							</span>
						</>
					)}
				</button>

				{/* Same ⋯ menu component as request and environment rows. Revealed on
				    keyboard focus as well as hover, so a keyboard user never lands on
				    an invisible control. */}
				{!isRenaming && (
					<RowActionsMenu
						label={`More actions for ${collection.name}`}
						className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
						actions={getCollectionActions(collection)}
					/>
				)}
			</div>

			{/* Children (Subfolders + Requests) - indented by depth */}
			{isExpanded && (
				<div className="mt-1 space-y-0.5">
					{/* Subfolder Creation Form */}
					{creatingSubfolder === collection.id && (
						<div className="flex gap-2 py-1 px-2">
							<Input
								type="text"
								value={newSubCollectionName}
								onChange={(e) => onSubCollectionNameChange(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") onCreateSubfolder(collection.id);
									if (e.key === "Escape") onCancelSubfolder();
								}}
								placeholder="Folder name"
								className="flex-1 h-7 text-sm"
								disabled={isCreatingSubfolder}
								autoFocus
							/>
							<Button
								size="sm"
								onClick={() => onCreateSubfolder(collection.id)}
								disabled={isCreatingSubfolder}
								className="h-7 text-xs"
							>
								{isCreatingSubfolder && (
									<Loader2 className="w-3 h-3 animate-spin mr-1" />
								)}
								Add
							</Button>
							<Button
								variant="secondary"
								size="sm"
								onClick={onCancelSubfolder}
								disabled={isCreatingSubfolder}
								className="h-7 text-xs"
							>
								Cancel
							</Button>
						</div>
					)}

					{/* Child Collections (Subfolders) - Recursive */}
					{childCollections.map((childCollection) => (
						<CollectionItem
							key={childCollection.id}
							collection={childCollection}
							allCollections={allCollections}
							depth={depth + 1}
							expandedCollectionIds={expandedCollectionIds}
							selectedCollectionId={selectedCollectionId}
							selectedRequestId={selectedRequestId}
							renamingId={renamingId}
							renameValue={renameValue}
							deletingCollectionId={deletingCollectionId}
							deletingRequestId={deletingRequestId}
							creatingSubfolder={creatingSubfolder}
							newSubCollectionName={newSubCollectionName}
							isCreatingSubfolder={isCreatingSubfolder}
							getRequestsByCollection={getRequestsByCollection}
							onCollectionClick={onCollectionClick}
							onCollectionToggle={onCollectionToggle}
							onRequestClick={onRequestClick}
							getCollectionActions={getCollectionActions}
							onRenameChange={onRenameChange}
							onRenameSubmit={onRenameSubmit}
							onRenameCancel={onRenameCancel}
							onStartRename={onStartRename}
							onDeleteRequest={onDeleteRequest}
							onRequestDeleteClick={onRequestDeleteClick}
							onDuplicateRequest={onDuplicateRequest}
							onSubCollectionNameChange={onSubCollectionNameChange}
							onCreateSubfolder={onCreateSubfolder}
							onCancelSubfolder={onCancelSubfolder}
							onRequestRenameChange={onRequestRenameChange}
							onRequestRenameSubmit={onRequestRenameSubmit}
							onRequestRenameCancel={onRequestRenameCancel}
							onStartRequestRename={onStartRequestRename}
							renamingRequestId={renamingRequestId}
							renameRequestValue={renameRequestValue}
						/>
					))}

					{/* Requests */}
					{requests.length === 0 &&
						childCollections.length === 0 &&
						creatingSubfolder !== collection.id && (
							<div className="py-2 px-3 text-xs text-muted-foreground">
								Empty folder
							</div>
						)}
					{requests.map((request) => (
						<RequestItem
							key={request.id}
							request={request}
							collectionId={collection.id}
							depth={depth + 1}
							onSelect={onRequestClick}
							onDelete={onDeleteRequest}
							onBeforeDelete={onRequestDeleteClick}
							isDeleting={deletingRequestId === request.id}
							isSelected={selectedRequestId === request.id}
							isRenaming={renamingRequestId === request.id}
							renameValue={renameRequestValue}
							onRenameChange={onRequestRenameChange}
							onRenameSubmit={onRequestRenameSubmit}
							onRenameCancel={onRequestRenameCancel}
							onStartRename={onStartRequestRename}
							onDuplicate={onDuplicateRequest}
						/>
					))}
				</div>
			)}
		</div>
	);
}
