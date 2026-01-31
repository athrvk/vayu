/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DeleteConfirmDialog
 *
 * Reusable confirmation dialog for destructive delete actions.
 * Matches the pattern used in collections and history sidebars.
 */

import { Loader2 } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
} from "./dialog";
import { Button } from "./button";

export interface DeleteConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: React.ReactNode;
	onConfirm: () => void | Promise<void>;
	isDeleting?: boolean;
}

export function DeleteConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	onConfirm,
	isDeleting = false,
}: DeleteConfirmDialogProps) {
	const handleOpenChange = (next: boolean) => {
		if (!next) onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter className="gap-2 sm:gap-0">
					<Button
						variant="secondary"
						onClick={() => onOpenChange(false)}
						disabled={isDeleting}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={onConfirm}
						disabled={isDeleting}
					>
						{isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
