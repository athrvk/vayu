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
 *
 * Keyboard behaviour is deliberate. `DialogContent` renders a close "X" as its
 * first focusable child, so Radix's default open-focus lands there and neither
 * button appears focused — which matters most when the dialog was opened *by*
 * keyboard (Delete on a tree row). Focus is redirected to Cancel instead: the
 * safe action, so a reflexive Enter cancels rather than deletes. Left/Right move
 * between the actions the way native confirmation dialogs behave.
 */

import { useRef } from "react";
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
	/**
	 * Word on the confirming button. Defaults to "Delete".
	 *
	 * Not every irreversible action is a deletion — "Reset to defaults" is the
	 * case that forced this. Before it existed the only in-app confirm said
	 * "Delete", so a reset either lied about what it was doing or fell back to
	 * `window.confirm`, which ignores the theme, the accent and the roundedness
	 * that the very panel it appears over exists to configure.
	 */
	confirmLabel?: string;
	/**
	 * `destructive` (default) for anything that removes data. `primary` for an
	 * irreversible-but-not-destructive action, where a red button overstates it.
	 */
	confirmVariant?: "destructive" | "default";
}

export function DeleteConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	onConfirm,
	isDeleting = false,
	confirmLabel = "Delete",
	confirmVariant = "destructive",
}: DeleteConfirmDialogProps) {
	const cancelRef = useRef<HTMLButtonElement>(null);

	const handleOpenChange = (next: boolean) => {
		if (!next) onOpenChange(false);
	};

	/**
	 * Roving Left/Right across whatever actions the footer holds, so this keeps
	 * working if a third button is ever added. Wraps at both ends.
	 */
	const handleFooterKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		const buttons = Array.from(
			e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")
		);
		if (buttons.length < 2) return;
		e.preventDefault();
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const delta = e.key === "ArrowRight" ? 1 : -1;
		// From an unfocused state, Right starts at the first action and Left at the last.
		const next = current === -1 ? (delta === 1 ? 0 : buttons.length - 1) : current + delta;
		buttons[(next + buttons.length) % buttons.length]?.focus();
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				className="sm:max-w-md"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					cancelRef.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter onKeyDown={handleFooterKeyDown} className="gap-2 sm:gap-0">
					<Button
						ref={cancelRef}
						variant="secondary"
						onClick={() => onOpenChange(false)}
						disabled={isDeleting}
					>
						Cancel
					</Button>
					<Button variant={confirmVariant} onClick={onConfirm} disabled={isDeleting}>
						{isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
