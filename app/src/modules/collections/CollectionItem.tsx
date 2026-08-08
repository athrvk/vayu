/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useRef } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, Loader2 } from "lucide-react";
import RequestItem from "./RequestItem";
import type { Collection, Request } from "@/types";
import { compareTreeOrder } from "@/types";
import { Button, Input } from "@/components/ui";
import { RowActionsMenu, TruncatedText, type RowAction } from "@/components/shared";
import { cn } from "@/lib/utils";
import { INDENT_STEP } from "@/constants/layout";

export interface CollectionItemProps {
	collection: Collection;
	allCollections: Collection[];
	depth: number;
	/**
	 * 1-based position among the rows this one shares a parent with, and how
	 * many there are - child folders and requests together, since a screen
	 * reader sees one set of treeitems per group. Required rather than
	 * defaulted: only the renderer that maps the siblings knows them, and a
	 * default would announce a plausible lie ("1 of 1") rather than fail.
	 */
	posInSet: number;
	setSize: number;
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
	/** Opens the confirm dialog for this collection - the Delete key's target. */
	onCollectionDeleteClick?: (collectionId: string, collectionName: string) => void;
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
	posInSet,
	setSize,
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
	onCollectionDeleteClick,
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
	// Open-folder glyph while expanded, so the folder itself echoes the chevron.
	const FolderIcon = isExpanded ? FolderOpen : Folder;
	const isSelected = selectedCollectionId === collection.id;
	const requests = getRequestsByCollection(collection.id);
	const isRenaming = renamingId === collection.id;
	const isDeleting = deletingCollectionId === collection.id;
	const childCollections = allCollections
		.filter((c) => c.parentId === collection.id)
		.sort(compareTreeOrder);
	// Folders and requests are one set of treeitems inside one group, so the
	// requests continue the folders' numbering rather than restarting it.
	const childSetSize = childCollections.length + requests.length;
	// Ties the children's group back to this row for assistive tech - see the
	// `aria-owns` note on the row itself.
	const childrenId = `tree-group-${collection.id}`;

	const rowRef = useRef<HTMLDivElement>(null);
	/**
	 * Set when the rename field is about to be closed *from the keyboard*, so
	 * focus can be put back on the row once React has unmounted the field.
	 *
	 * Without it F2, Escape drops the user out of the tree entirely: the field
	 * disappears, focus falls to `<body>`, and the next Tab starts from the top
	 * of the document. Blur deliberately does not set it - a blur means focus has
	 * already gone somewhere the user chose, and yanking it back would be worse
	 * than the bug.
	 */
	const returnFocusToRow = useRef(false);

	useEffect(() => {
		if (isRenaming || !returnFocusToRow.current) return;
		returnFocusToRow.current = false;
		rowRef.current?.focus();
	}, [isRenaming]);

	const handleClick = (e: React.MouseEvent) => {
		if (isDeleting || isRenaming) return;
		// The second click of a double-click also fires `click`; ignore it so the
		// double-click starts a rename. The first click already opened the
		// collection (opening is idempotent), so there is nothing to defer - and
		// none of the 80ms delay that made a single click to open feel laggy.
		if (e.detail > 1) return;
		onCollectionClick(collection);
	};

	const handleDoubleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (isDeleting || isRenaming) return;
		onStartRename(collection);
	};

	const handleToggleClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (isDeleting || isRenaming) return;
		onCollectionToggle(collection);
	};

	/**
	 * The row's own box delegates to the label button - see RequestItem for the
	 * rule and why the check is what it is. This is the row where the indent
	 * *cannot* move onto that button even in principle: the chevron sits between
	 * them, so padding on the button would push the label away from the chevron
	 * rather than indent the row.
	 */
	const isRowSurface = (e: React.MouseEvent) => e.target === e.currentTarget;

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
				ref={rowRef}
				role="treeitem"
				tabIndex={-1}
				// Lets the tree scroll a selected collection into view, the way
				// `data-request-id` on RequestItem already does for a request.
				data-collection-id={collection.id}
				data-tree-label={collection.name}
				aria-expanded={isExpanded}
				aria-selected={isSelected}
				// The hierarchy a screen reader announces. Without these the whole
				// tree reads as a flat list: level is 1-based, so a root row is 1.
				aria-level={depth + 1}
				aria-posinset={posInSet}
				aria-setsize={setSize}
				// A row's children are rendered as its *sibling*, not inside it (see
				// useRovingTreeFocus for why the DOM is that shape), so nothing
				// connects the group to this row. `aria-owns` is the attribute-only
				// way to say "that group belongs to me" without restructuring the
				// DOM the roving-focus walk and the hit-area rules depend on.
				aria-owns={isExpanded ? childrenId : undefined}
				onClick={(e) => isRowSurface(e) && handleClick(e)}
				onDoubleClick={(e) => isRowSurface(e) && handleDoubleClick(e)}
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
					// self-stretch: see RequestItem. The row is `items-center`, so
					// this button - the only thing wired to onCollectionClick - was
					// as tall as its 18px label inside a 32px row, leaving ~7px of
					// dead space above and below that still showed the hover fill
					// and the pointer cursor.
					className="flex min-w-0 self-stretch items-center gap-2 flex-1 text-left cursor-pointer"
					disabled={isDeleting || isRenaming}
				>
					<FolderIcon
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
									returnFocusToRow.current = true;
									onRenameSubmit(collection.id);
								} else if (e.key === "Escape") {
									returnFocusToRow.current = true;
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
				{/* Keyboard-only rename and delete targets: F2 and Delete click them
				    (see useRovingTreeFocus). Never shown; the same actions live in
				    the row's menu. The delete one used to exist on request rows
				    only, so Delete on a folder was swallowed silently - the hook
				    preventDefaults the key either way. It opens the same confirm
				    dialog the menu does: a cascade delete is never one keystroke. */}
				<button
					type="button"
					className="hidden"
					aria-hidden="true"
					tabIndex={-1}
					data-tree-rename
					onClick={() => onStartRename(collection)}
				/>
				<button
					type="button"
					className="hidden"
					aria-hidden="true"
					tabIndex={-1}
					data-tree-delete
					onClick={() => {
						if (isDeleting) return;
						onCollectionDeleteClick?.(collection.id, collection.name);
					}}
				/>
			</div>

			{/* Children (Subfolders + Requests) - indented by depth */}
			{isExpanded && (
				<div id={childrenId} role="group" className="mt-1 space-y-0.5">
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
					{childCollections.map((childCollection, index) => (
						<CollectionItem
							key={childCollection.id}
							collection={childCollection}
							allCollections={allCollections}
							depth={depth + 1}
							posInSet={index + 1}
							setSize={childSetSize}
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
							onCollectionDeleteClick={onCollectionDeleteClick}
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
					{requests.map((request, index) => (
						<RequestItem
							key={request.id}
							request={request}
							collectionId={collection.id}
							depth={depth + 1}
							posInSet={childCollections.length + index + 1}
							setSize={childSetSize}
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
