/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A confirmation dialog for destructive actions. `DialogContent` renders its close "X" first, so
 * Radix's open-focus would land there with neither button focused, which matters most when opened
 * by keyboard (Delete on a tree row). Focus goes to Cancel instead, the safe action, so a reflexive
 * Enter cancels. Left/Right move between the actions, as native confirmations do. With `name`, the
 * sentence is `deleteConfirmCopy`'s (sibling module), replacing the call sites' "permanently
 * removed", "removed for good" and "will be deleted"; `delete-confirm-dialog.test.tsx` holds the
 * generated sentence clear of all three.
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
import { DialogCancelButton } from "./dialog-cancel-button";
import { deleteConfirmCopy } from "./delete-confirm-copy";

export interface DeleteConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Omit when `name` is given: `deleteConfirmCopy` builds it. */
	title?: string;
	/**
	 * Omit when `name` is given (`deleteConfirmCopy` builds it); pass it for prose the template
	 * lacks (a count, a conditional clause). Always wins over `name`.
	 */
	description?: React.ReactNode;
	/** The entity's name, quoted into the generated sentence; ignored with `description`. */
	name?: string;
	/**
	 * A failed delete's refusal, between the description and the actions (a
	 * `Callout severity="blocking"`). Its own slot: `DialogDescription` is a `<p>` and a `Callout`
	 * a `<div>`, so nesting is invalid HTML.
	 */
	error?: React.ReactNode;
	onConfirm: () => void | Promise<void>;
	isDeleting?: boolean;
	/**
	 * The confirming button's word, "Delete" by default. Not every irreversible action deletes
	 * ("Reset to defaults"), and without this such a confirm would either say "Delete" or fall back
	 * to `window.confirm`, which ignores the theme, accent and roundedness the panel configures.
	 */
	confirmLabel?: string;
	/**
	 * The declining button's word, "Cancel" by default: right when the dialog interrupts something
	 * the user started, ambiguous for a question they did not ask (declining to keep the machine
	 * awake cancels nothing, so that caller says "Allow sleep"). The button keeps its role: focus
	 * opens on it.
	 */
	cancelLabel?: string;
	/**
	 * `destructive` (the default) for anything removing data; `default` for an irreversible but not
	 * destructive action, where red overstates it.
	 */
	confirmVariant?: "destructive" | "default";
	/**
	 * Where focus goes on close. Radix restores it to its pre-open holder, right for Cancel and
	 * wrong for a confirmed delete: the opener was usually inside what was deleted, so focus lands
	 * on `<body>` (#1218). A caller knowing what survives passes a handler and calls
	 * `preventDefault`.
	 */
	onCloseAutoFocus?: (event: Event) => void;
}

export function DeleteConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	name,
	error,
	onConfirm,
	isDeleting = false,
	confirmLabel = "Delete",
	cancelLabel = "Cancel",
	confirmVariant = "destructive",
	onCloseAutoFocus,
}: DeleteConfirmDialogProps) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const generated = name !== undefined ? deleteConfirmCopy(name) : undefined;
	const resolvedTitle = title ?? generated?.title ?? "Delete?";
	const resolvedDescription = description ?? generated?.description;

	const handleOpenChange = (next: boolean) => {
		if (!next) onOpenChange(false);
	};

	/** Roving Left/Right across the footer's actions, however many, wrapping at both ends. */
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
				className="sm:max-w-lg"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					cancelRef.current?.focus();
				}}
				onCloseAutoFocus={onCloseAutoFocus}
			>
				<DialogHeader>
					<DialogTitle>{resolvedTitle}</DialogTitle>
					<DialogDescription>{resolvedDescription}</DialogDescription>
				</DialogHeader>
				{error}
				<DialogFooter onKeyDown={handleFooterKeyDown} className="gap-2 sm:gap-0">
					<DialogCancelButton
						ref={cancelRef}
						label={cancelLabel}
						onClick={() => onOpenChange(false)}
						disabled={isDeleting}
					/>
					<Button
						variant={confirmVariant}
						onClick={onConfirm}
						disabled={isDeleting}
						aria-busy={isDeleting}
					>
						{isDeleting && (
							<Loader2 className="size-icon animate-spin" aria-hidden="true" />
						)}
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
