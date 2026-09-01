/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useMemo, useRef } from "react";
import { Loader2, Trash2, Edit2, Copy } from "lucide-react";
import { useCollectionTreeContext } from "./context/CollectionTreeContext";
import { RowDropIndicator, RowMoveControls } from "./TreeRowDnd";
import { rowDndClasses, useRowDnd } from "./tree-row-dnd";
import type { TreeEntity } from "./drop-position";
import type { Request } from "@/types";
import { Input } from "@/components/ui";
import { RowActionsMenu, MethodBadge, TruncatedText } from "@/components/shared";
import { cn } from "@/lib/utils";
import { INDENT_STEP } from "@/constants/layout";

/**
 * What differs per row. The selection, the rename and delete state and every
 * handler come from `CollectionTreeContext` - the same source `CollectionItem`
 * reads, so a row's behaviour cannot drift from its parent folder's.
 */
export interface RequestItemProps {
	request: Request;
	collectionId: string;
	/** Tree depth, so the row can indent itself and still span full width. */
	depth?: number;
	/**
	 * 1-based position among the rows this one shares a parent with, and how
	 * many there are. Required rather than defaulted: only the renderer that
	 * maps the siblings knows them, and a default would announce a plausible
	 * lie ("1 of 1") to a screen reader rather than fail.
	 */
	posInSet: number;
	setSize: number;
}

export default function RequestItem({
	request,
	collectionId,
	depth = 1,
	posInSet,
	setSize,
}: RequestItemProps) {
	const {
		selectedRequestId,
		deletingRequestId,
		renamingRequestId,
		renameRequestValue,
		onRequestClick,
		onRequestRenameChange,
		onRequestRenameSubmit,
		onRequestRenameCancel,
		onStartRequestRename,
		onRequestDeleteClick,
		onDuplicateRequest,
	} = useCollectionTreeContext();

	const isSelected = selectedRequestId === request.id;
	const isDeleting = deletingRequestId === request.id;
	const isRenaming = renamingRequestId === request.id;

	const entity = useMemo<TreeEntity>(
		() => ({ kind: "request", id: request.id, name: request.name, collectionId }),
		[request.id, request.name, collectionId]
	);
	const dnd = useRowDnd(entity);

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
		// double-click starts a rename. The first click already opened the request
		// (opening is idempotent), so there is nothing to defer - and none of the
		// 80ms delay that made a single click to open feel laggy.
		if (e.detail > 1) return;
		onRequestClick(collectionId, request.id);
	};

	const handleDoubleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (isDeleting || isRenaming) return;
		onStartRequestRename(request);
	};

	/**
	 * The row's own box - the indent, the flex gap, `pr-3` - belongs to no child,
	 * so a click there has nowhere to go. `self-stretch` on the label button
	 * recovered the height; it cannot recover the indent, because the indent is
	 * padding on the row (deliberately, so the fill reaches the panel edge) and on
	 * a collection row the chevron sits between it and the button.
	 *
	 * So the row delegates. `target === currentTarget` is exactly "the pointer
	 * landed on the row itself, not on anything inside it", which excludes the
	 * label button, the ⋯ menu and the chevron without naming any of them - and
	 * without double-firing when a click on the button bubbles through here.
	 */
	const isRowSurface = (e: React.MouseEvent) => e.target === e.currentTarget;

	// Always the confirm dialog, never a bare delete: the ⋯ menu and the hidden
	// `data-tree-delete` control the Delete key clicks are the same one action.
	const handleDelete = () => {
		if (isDeleting) return;
		onRequestDeleteClick(request.id, request.name);
	};

	return (
		<div
			ref={rowRef}
			data-request-id={request.id}
			// The collection this row's requests block belongs to. Read by the drag
			// hit test, which has the element and no way to derive its owner: a
			// request is not in the loaded collections list.
			data-owner-id={collectionId}
			data-tree-label={request.name}
			role="treeitem"
			tabIndex={-1}
			aria-selected={isSelected}
			// The hierarchy a screen reader announces. Without these every row in
			// the tree reads as a flat list item: the group wrapper that nests a
			// folder's children is not a treeitem, so depth is invisible unless
			// each row states it. Level is 1-based, so a root row is level 1.
			aria-level={depth + 1}
			aria-posinset={posInSet}
			aria-setsize={setSize}
			onClick={(e) => isRowSurface(e) && handleClick(e)}
			onDoubleClick={(e) => isRowSurface(e) && handleDoubleClick(e)}
			// The drag is captured on the row, so the whole row is the handle -
			// there is no grip icon to hunt for, and below the movement threshold
			// every click affordance above is untouched.
			{...dnd.handlers}
			data-drop-blocked={dnd.isBlocked || undefined}
			// Indent inside the row (see CollectionItem) so the fill still
			// reaches both panel edges.
			style={{ paddingLeft: 8 + depth * INDENT_STEP }}
			className={cn(
				// focus-row: this row is the perceived target, not the narrower
				// label button inside it - it paints the keyboard focus ring.
				// The transition omits outline-color (see CollectionItem) so the
				// focus ring appears instantly instead of fading between rows.
				// h-8: shared drawer row height (see CollectionItem).
				"focus-row flex h-8 items-center gap-2 pr-3 group cursor-pointer transition-[color,background-color,border-color]",
				isDeleting && "opacity-50",
				isSelected
					? "bg-primary/10 ring-1 ring-inset ring-primary/20 hover:bg-primary/15"
					: "hover:bg-accent",
				// Last, so a drop target's ring wins over the selected row's - the
				// two are the same colour and the drop is the transient one.
				rowDndClasses(dnd)
			)}
		>
			<RowDropIndicator edge={dnd.dropEdge} indentPx={8 + depth * INDENT_STEP} />
			<button
				onClick={handleClick}
				onDoubleClick={handleDoubleClick}
				tabIndex={-1}
				data-tree-activate
				// self-stretch: the row is `items-center`, which makes every child
				// content-height - so this button, the only thing wired to the open
				// handler, was ~22px tall inside a 32px row that paints a full-height
				// hover fill and `cursor-pointer`. The top and bottom ~5px of the row
				// looked clickable and were not. Stretching to the row's height
				// costs nothing (the button's own `items-center` still centres the
				// badge and label) and `focus-row` keeps painting the ring.
				className="flex min-w-0 self-stretch items-center gap-2 flex-1 text-left cursor-pointer"
				disabled={isDeleting || isRenaming}
			>
				<MethodBadge method={request.method} size="md" />
				{isRenaming ? (
					<Input
						type="text"
						value={renameRequestValue}
						onChange={(e) => onRequestRenameChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								returnFocusToRow.current = true;
								onRequestRenameSubmit(request.id);
							} else if (e.key === "Escape") {
								returnFocusToRow.current = true;
								onRequestRenameCancel();
							}
						}}
						onBlur={() => onRequestRenameSubmit(request.id)}
						className="flex-1 h-6 text-sm"
						autoFocus
						onClick={(e) => e.stopPropagation()}
					/>
				) : (
					<TruncatedText className="text-sm text-foreground cursor-pointer">
						{request.name}
					</TruncatedText>
				)}
			</button>

			{isDeleting && (
				<Loader2 className="w-3 h-3 shrink-0 animate-spin text-destructive-text" />
			)}

			{/*
			 * Keyboard-only targets for the roving tree (see useRovingTreeFocus):
			 * F2 clicks data-tree-rename, Delete clicks data-tree-delete. Never
			 * shown, never announced - the same actions live in the ⋯ menu.
			 */}
			<button
				type="button"
				className="hidden"
				aria-hidden="true"
				tabIndex={-1}
				data-tree-rename
				onClick={() => onStartRequestRename(request)}
			/>
			<button
				type="button"
				className="hidden"
				aria-hidden="true"
				tabIndex={-1}
				data-tree-delete
				onClick={handleDelete}
			/>
			<RowMoveControls entity={entity} />

			{!isRenaming && !isDeleting && (
				<RowActionsMenu
					label={`More actions for request ${request.name}`}
					// The tree is one tab stop: the row holds it, and Shift+F10 /
					// Menu / Shift+Enter are the way in from here.
					tabIndex={-1}
					className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
					actions={[
						{
							label: "Rename",
							icon: Edit2,
							onSelect: () => onStartRequestRename(request),
						},
						{
							label: "Duplicate",
							icon: Copy,
							onSelect: () => onDuplicateRequest(request),
						},
						...(dnd.moveAction ? [dnd.moveAction] : []),
						{
							label: "Delete",
							icon: Trash2,
							onSelect: handleDelete,
							destructive: true,
						},
					]}
				/>
			)}
		</div>
	);
}
