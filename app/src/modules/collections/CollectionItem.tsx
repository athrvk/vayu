/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { memo, useMemo, useRef } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, Loader2 } from "lucide-react";
import { useCollectionTreeHandlers, useCollectionTreeState } from "./context/CollectionTreeContext";
import { RowDropIndicator, RowMoveControls } from "./TreeRowDnd";
import { rowDndClasses, useRowDnd } from "./tree-row-dnd";
import { collectionEntity } from "./tree-rows";
import { treeGuideStyle } from "./tree-guide-style";
import { collectionRowMenu } from "./tree-row-menu";
import { countSubtreeRequests } from "./tree-utils";
import type { Collection } from "@/types";
import { IconSwap, Input } from "@/components/ui";
import { RowActionsMenu, TruncatedText, DrawerSectionCount } from "@/components/shared";
import { contextProps } from "@/lib/context-menu";
import { cn } from "@/lib/utils";
import { useInlineRename } from "@/hooks/useInlineRename";
import { rowInsetPx } from "@/constants/layout";

/**
 * What differs per row. Everything shared - the expanded set, the selection,
 * the rename and delete state, every handler - comes from the collection tree
 * contexts. The row renders itself only: its children are rows of their own in
 * the tree's flat list (`flattenVisibleRows`).
 *
 * Every prop is a primitive or an object from the query cache, so the `memo`
 * below skips a row whose entity did not change (#2543).
 */
export interface CollectionItemProps {
	collection: Collection;
	depth: number;
	/**
	 * 1-based position among the rows this one shares a parent with, and how
	 * many there are - child folders and requests together, one set of
	 * treeitems per parent. Required rather than defaulted: only the flattening
	 * that lists the siblings knows them, and a default would announce a
	 * plausible lie ("1 of 1") rather than fail.
	 */
	posInSet: number;
	setSize: number;
	/**
	 * The "Empty collection" line below an expanded, empty folder. The line is
	 * not a treeitem, so a screen reader walking the tree never reaches it and
	 * the emptiness would be silent; the row names it in `aria-describedby`, so
	 * it is said the moment the row is focused.
	 */
	emptyPlaceholderId?: string | null;
	/** The row's `activeGuideLevel`: which indent guide is drawn in the accent. */
	activeGuideLevel?: number | null;
}

function CollectionItemRow({
	collection,
	depth,
	posInSet,
	setSize,
	emptyPlaceholderId,
	activeGuideLevel = null,
}: CollectionItemProps) {
	const {
		allCollections,
		expandedCollectionIds,
		selectedCollectionId,
		renamingId,
		deletingCollectionId,
		getRequestsByCollection,
	} = useCollectionTreeState();
	const {
		getCollectionActions,
		onCollectionClick,
		onCollectionToggle,
		onRenameSubmit,
		onRenameCancel,
		onStartRename,
		onCollectionDeleteClick,
	} = useCollectionTreeHandlers();

	const isExpanded = expandedCollectionIds.has(collection.id);
	const isSelected = selectedCollectionId === collection.id;
	const folderIconClass = cn(
		"size-icon shrink-0",
		depth === 0 ? "text-primary" : "text-primary/70"
	);
	const requests = getRequestsByCollection(collection.id);
	const isRenaming = renamingId === collection.id;
	const isDeleting = deletingCollectionId === collection.id;

	const entity = useMemo(() => collectionEntity(collection), [collection]);
	const dnd = useRowDnd(entity);
	const childFolderCount = useMemo(
		() => allCollections.filter((c) => c.parentId === collection.id).length,
		[allCollections, collection.id]
	);
	// A root counts every request beneath it (what an import preview reports);
	// a nested folder counts its direct children. See `DrawerSectionCount`.
	const subtreeRequestCount = useMemo(
		() =>
			depth === 0
				? countSubtreeRequests(
						collection.id,
						allCollections,
						(id) => getRequestsByCollection(id).length
					)
				: 0,
		[depth, collection.id, allCollections, getRequestsByCollection]
	);
	const badgeCount = depth === 0 ? subtreeRequestCount : requests.length + childFolderCount;

	const rowRef = useRef<HTMLDivElement>(null);

	/** The rename contract, including the focus return - see `useInlineRename`. */
	const rename = useInlineRename({
		active: isRenaming,
		initialValue: collection.name,
		onCommit: (name) => onRenameSubmit(collection.id, name),
		onCancel: onRenameCancel,
		getRowElement: () => rowRef.current,
	});

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
	const indentPx = rowInsetPx(depth);

	// One list, three ways in: the ⋯ button, the tree's Shift+F10 / Menu /
	// Shift+Enter keys, and right-click, which the tree's one menu opens over
	// this row from the same builder (#1360, #2543).
	const menu = collectionRowMenu(collection, getCollectionActions, dnd.moveActions);
	// What says the tree draws its own menu here; off while the row is not a
	// row (renaming, deleting), so the rename field gets Cut/Copy/Paste.
	const hasMenu = !isRenaming && !isDeleting && menu.actions.length > 0;

	// The row is the treeitem: one tab stop for the whole tree, arrows move
	// between rows (useRovingTreeFocus). tabIndex starts at -1; the hook promotes
	// exactly one row to 0.
	return (
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events -- Enter and Space reach this row through useRovingTreeFocus.ts:206-214, which clicks its `[data-tree-activate]` button; the tree's onKeyDown is on the `role="tree"` ancestor
		<div
			ref={rowRef}
			role="treeitem"
			tabIndex={-1}
			// Lets the tree scroll a selected collection into view, the way
			// `data-request-id` on RequestItem already does for a request.
			data-collection-id={collection.id}
			data-tree-label={collection.name}
			{...(hasMenu ? contextProps("own-menu") : {})}
			aria-expanded={isExpanded}
			aria-selected={isSelected}
			// The hierarchy a screen reader announces. Every row is a sibling
			// in one flat list, so these are the whole of it: level is
			// 1-based, so a root row is 1.
			aria-level={depth + 1}
			aria-posinset={posInSet}
			aria-setsize={setSize}
			aria-describedby={emptyPlaceholderId ?? undefined}
			onClick={(e) => isRowSurface(e) && handleClick(e)}
			onDoubleClick={(e) => isRowSurface(e) && handleDoubleClick(e)}
			data-drop-blocked={dnd.isBlocked || undefined}
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
				// The rows inside a folder being deleted are dimmed by the
				// list (`CollectionTreeRows`), which knows which they are.
				isDeleting && "opacity-50",
				isSelected
					? "bg-primary/10 hover:bg-primary/15 ring-1 ring-inset ring-primary/20"
					: "hover:bg-accent",
				// Last, so a drop target's ring wins over the selected row's -
				// same colour, and the drop is the transient one.
				rowDndClasses(dnd)
			)}
			style={{ paddingLeft: indentPx, ...treeGuideStyle(depth, activeGuideLevel) }}
		>
			<RowDropIndicator edge={dnd.dropEdge} indentPx={indentPx} />
			<button
				onClick={handleToggleClick}
				tabIndex={-1}
				data-tree-toggle
				className={cn(
					// focus-self: this toggles expansion rather than opening the
					// collection, so it keeps its own ring instead of lighting
					// up the whole row.
					// size-target (24px at Default) so the chevron fits the row. Still an
					// adequate pointer target, and the row itself remains clickable.
					"focus-self flex items-center justify-center size-target rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
					isSelected
						? "text-primary/90 hover:text-primary"
						: "text-muted-foreground hover:text-foreground"
				)}
				disabled={isDeleting || isRenaming}
				aria-label={isExpanded ? "Collapse collection" : "Expand collection"}
			>
				{isDeleting ? (
					<Loader2 className="size-icon animate-spin" />
				) : isExpanded ? (
					<ChevronDown className="size-icon" />
				) : (
					<ChevronRight className="size-icon" />
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
				{/* Open-folder glyph while expanded, so the folder itself
						    echoes the chevron - crossfaded, since a tree row's
						    expand is the one state change the eye is following. */}
				<IconSwap
					state={isExpanded ? "open" : "closed"}
					icons={{
						closed: <Folder className={folderIconClass} />,
						open: <FolderOpen className={folderIconClass} />,
					}}
				/>
				{isRenaming ? (
					<Input
						type="text"
						{...rename.inputProps}
						size="xs"
						className="flex-1 text-sm"
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
								"cap-centred text-sm text-foreground cursor-pointer",
								depth === 0 && "font-medium"
							)}
						>
							{collection.name}
						</TruncatedText>
						{/* The drawer's one count idiom, shared with the section
								    headers in Services and Variables so a row and its
								    section cannot drift into two idioms again (issue
								    #1688 - Variables drew the same fact as a filled
								    Badge one click away from this). */}
						<DrawerSectionCount value={badgeCount} />
					</>
				)}
			</button>

			{/* Same ⋯ menu component as request and environment rows. Revealed on
				    keyboard focus as well as hover, so a keyboard user never lands on
				    an invisible control. */}
			{!isRenaming && (
				<RowActionsMenu
					label={menu.label}
					// The tree is one tab stop: the row holds it, and Shift+F10 /
					// Menu / Shift+Enter are the way in from here.
					tabIndex={-1}
					className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
					actions={menu.actions}
				/>
			)}
			{/* Keyboard-only rename and delete targets: F2 and Delete click them
				    (see useRovingTreeFocus). Never shown; the same actions live in
				    the row's menu. The delete one used to exist on request rows
				    only, so Delete on a folder was swallowed silently - the hook
				    preventDefaults the key either way. It is the same delete the
				    menu starts, dialog or no dialog. */}
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
					onCollectionDeleteClick(collection.id, collection.name);
				}}
			/>
			<RowMoveControls entity={entity} />
		</div>
	);
}

const CollectionItem = memo(CollectionItemRow);
export default CollectionItem;
