/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef } from "react";
import { Loader2, Trash2, Edit2, Copy } from "lucide-react";
import type { Request } from "@/types";
import { Input } from "@/components/ui";
import { RowActionsMenu, MethodBadge, TruncatedText } from "@/components/shared";
import { cn } from "@/lib/utils";
import { TIMING } from "@/config/timing";
import { INDENT_STEP } from "@/constants/layout";

export interface RequestItemProps {
	request: Request;
	collectionId: string;
	/** Tree depth, so the row can indent itself and still span full width. */
	depth?: number;
	onSelect: (collectionId: string, requestId: string) => void;
	onDelete: (requestId: string) => Promise<void>;
	onBeforeDelete?: (requestId: string, requestName: string) => void;
	isDeleting?: boolean;
	isSelected?: boolean;
	isRenaming?: boolean;
	renameValue?: string;
	onRenameChange?: (value: string) => void;
	onRenameSubmit?: (requestId: string) => void;
	onRenameCancel?: () => void;
	onStartRename?: (request: Request) => void;
	onDuplicate?: (request: Request) => void;
}

export default function RequestItem({
	request,
	collectionId,
	depth = 1,
	onSelect,
	onDelete,
	onBeforeDelete,
	isDeleting,
	isSelected,
	isRenaming,
	renameValue,
	onRenameChange,
	onRenameSubmit,
	onRenameCancel,
	onStartRename,
	onDuplicate,
}: RequestItemProps) {
	const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);

	const CLICK_DELAY_MS = TIMING.TREE_CLICK_DELAY_MS;

	const handleClick = () => {
		if (isDeleting || isRenaming) return;

		// Clear any existing timeout
		if (clickTimeoutRef.current) {
			clearTimeout(clickTimeoutRef.current);
			clickTimeoutRef.current = null;
			// This was a double-click, don't trigger single click
			return;
		}

		// Set timeout for single click
		clickTimeoutRef.current = setTimeout(() => {
			onSelect(collectionId, request.id);
			clickTimeoutRef.current = null;
		}, CLICK_DELAY_MS); // 80ms delay to detect double-click
	};

	const handleDoubleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (isDeleting || isRenaming) return;

		// Clear single click timeout
		if (clickTimeoutRef.current) {
			clearTimeout(clickTimeoutRef.current);
			clickTimeoutRef.current = null;
		}

		onStartRename?.(request);
	};

	// Prefer the confirmation flow when the tree supplies one.
	const handleDelete = () => {
		if (isDeleting) return;
		if (onBeforeDelete) onBeforeDelete(request.id, request.name);
		else void onDelete(request.id);
	};

	return (
		<div
			data-request-id={request.id}
			role="treeitem"
			tabIndex={-1}
			aria-selected={isSelected}
			// Indent inside the row (see CollectionItem) so the fill still
			// reaches both panel edges.
			style={{ paddingLeft: 8 + depth * INDENT_STEP }}
			className={cn(
				// focus-row: this row is the perceived target, not the narrower
				// label button inside it — it paints the keyboard focus ring.
				// The transition omits outline-color (see CollectionItem) so the
				// focus ring appears instantly instead of fading between rows.
				// h-8: shared drawer row height (see CollectionItem).
				"focus-row flex h-8 items-center gap-2 pr-3 group cursor-pointer transition-[color,background-color,border-color]",
				isDeleting && "opacity-50",
				isSelected
					? "bg-primary/10 ring-1 ring-inset ring-primary/20 hover:bg-primary/15"
					: "hover:bg-accent"
			)}
		>
			<button
				onClick={handleClick}
				onDoubleClick={handleDoubleClick}
				tabIndex={-1}
				data-tree-activate
				className="flex min-w-0 items-center gap-2 flex-1 text-left cursor-pointer"
				disabled={isDeleting || isRenaming}
			>
				<MethodBadge method={request.method} size="md" />
				{isRenaming ? (
					<Input
						type="text"
						value={renameValue ?? ""}
						onChange={(e) => onRenameChange?.(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								onRenameSubmit?.(request.id);
							} else if (e.key === "Escape") {
								onRenameCancel?.();
							}
						}}
						onBlur={() => onRenameSubmit?.(request.id)}
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
			 * Delete moved into the ⋯ menu, but the Delete key still targets a
			 * data-tree-delete element (see useRovingTreeFocus). This is that
			 * target: never shown, never announced — a keyboard path only.
			 */}
			<button
				type="button"
				className="hidden"
				aria-hidden="true"
				tabIndex={-1}
				data-tree-delete
				onClick={handleDelete}
			/>

			{!isRenaming && !isDeleting && (
				<RowActionsMenu
					label={`More actions for request ${request.name}`}
					className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
					actions={[
						{
							label: "Rename",
							icon: Edit2,
							onSelect: () => onStartRename?.(request),
							disabled: !onStartRename,
						},
						{
							label: "Duplicate",
							icon: Copy,
							onSelect: () => onDuplicate?.(request),
							disabled: !onDuplicate,
						},
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
