
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { getMethodColor } from "@/utils";
import type { Request } from "@/types";
import { Button, Badge, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface RequestItemProps {
	request: Request;
	collectionId: string;
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
}

export default function RequestItem({
	request,
	collectionId,
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
}: RequestItemProps) {
	const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
		}, 200); // 200ms delay to detect double-click
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

	return (
		<div
			className={cn(
				"flex items-center gap-2 px-3 py-1.5 rounded group cursor-pointer transition-colors",
				isDeleting && "opacity-50",
				isSelected
					? "bg-primary/10 ring-1 ring-inset ring-primary/20 hover:bg-primary/15"
					: "hover:bg-accent"
			)}
		>
			<button
				onClick={handleClick}
				onDoubleClick={handleDoubleClick}
				className="flex items-center gap-2 flex-1 text-left cursor-pointer"
				disabled={isDeleting || isRenaming}
			>
				<Badge
					variant="outline"
					className={cn(
						"text-xs font-mono font-semibold px-1.5 py-0.5",
						getMethodColor(request.method)
					)}
				>
					{request.method}
				</Badge>
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
					<span className="text-sm text-foreground truncate cursor-pointer">
						{request.name}
					</span>
				)}
			</button>

			{!isRenaming && (
				<Button
					variant="ghost"
					size="icon"
					onClick={() =>
						onBeforeDelete
							? onBeforeDelete(request.id, request.name)
							: onDelete(request.id)
					}
					disabled={isDeleting}
					className={cn(
						"h-6 w-6 hover:bg-destructive/10 hover:text-destructive transition-opacity",
						isDeleting ? "opacity-100" : "opacity-0 group-hover:opacity-100"
					)}
				>
					{isDeleting ? (
						<Loader2 className="w-3 h-3 animate-spin" />
					) : (
						<Trash2 className="w-3 h-3" />
					)}
				</Button>
			)}
		</div>
	);
}
