/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

function DialogOverlay({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
	return (
		<DialogPrimitive.Overlay
			data-slot="dialog-overlay"
			className={cn(
				// dialog-overlay: see index.css. Shares its duration and curve
				// with the panel so the two land as one event.
				"dialog-overlay fixed inset-0 z-50 bg-black/80",
				className
			)}
			{...props}
		/>
	);
}

interface DialogContentProps extends React.ComponentProps<typeof DialogPrimitive.Content> {
	/**
	 * Draw the corner close button. On by default, and off for exactly one
	 * shape: a command palette, whose top-right corner is occupied by its own
	 * search field and which closes on Escape or a click outside like the
	 * overlay it is. A dialog with a form or a decision keeps it - the button is
	 * the discoverable way out.
	 */
	showClose?: boolean;
}

function DialogContent({ className, children, showClose = true, ...props }: DialogContentProps) {
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Content
				data-slot="dialog-content"
				className={cn(
					// dialog-panel: see index.css. Keep the translate utilities -
					// they centre the panel via the standalone `translate`
					// property, which the scale-only keyframes compose with
					// rather than fight.
					//
					// `flex flex-col` carries two jobs, and both are
					// load-bearing.
					//
					// **Width** (issue #701). This was `grid grid-cols-1` -
					// `repeat(1, minmax(0, 1fr))` - because an implicit grid
					// track is `auto`, whose minimum is its items' min-content,
					// so one wide descendant - a data-file preview table, a long
					// unbroken URL - grew the track past this panel's own
					// `max-w`, which cannot follow it. The panel stayed the
					// painted width while every row inside laid out at the
					// track's, so right-aligned controls and the footer ended up
					// over the backdrop. A column flex container refuses the same
					// thing for a different reason: `min-width: auto` does not
					// apply on the cross axis, so an item stretches to the line -
					// this panel's own content width - and a wide descendant
					// overflows *inside* it rather than widening it. Measured in
					// Chromium against the seven-column shape from #701: an
					// `auto` track put the footer 580px past the painted edge,
					// and `grid-cols-1` and this flex column both put it 25px
					// inside it, to the pixel.
					//
					// **Height** (issue #773). `max-h-[85vh]` plus a
					// `DialogBody`, which is the band that scrolls. Without the
					// cap a panel taller than the viewport is centred on a box it
					// does not fit and clipped at *both* ends, with nothing to
					// scroll because it is `fixed` - an eighteen-row dialog at a
					// 613px viewport left its Run button 198px below the screen,
					// reachable by Tab and not by pointer.
					//
					// `overflow-y-auto` here is the fallback for a dialog with no
					// `DialogBody`: nothing claims the leftover height, so the
					// panel scrolls itself and the footer stays reachable. It
					// takes the corner close button with it, which is exactly why
					// a dialog that can grow should take the band instead - with
					// one present the panel never scrolls at all and the button
					// stays pinned.
					//
					// Two widths, not eleven. A dialog is either a form or a
					// decision, which is `sm:max-w-lg` (512px), or it holds
					// something with a shape of its own - a table, a diff, a
					// preview, a dense config - which is `max-w-xl` (576px) and
					// the default here. They were spread across five values
					// including two one-off pixel widths, so the same kind of
					// dialog came out a different size depending on who wrote it.
					// See docs/design-system.md; go wider only with content that
					// earns it, since a dialog is a focus device before it is a
					// container.
					"dialog-panel fixed left-[50%] top-[50%] z-50 flex max-h-[85vh] w-full max-w-xl translate-x-[-50%] translate-y-[-50%] flex-col gap-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg",
					className
				)}
				{...props}
			>
				{children}
				{showClose && (
					<DialogPrimitive.Close className="absolute right-4 top-4 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
						<X className="h-4 w-4" />
						<span className="sr-only">Close</span>
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Content>
		</DialogPortal>
	);
}

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		data-slot="dialog-header"
		className={cn("flex shrink-0 flex-col space-y-1.5 text-center sm:text-left", className)}
		{...props}
	/>
);

/**
 * The band that scrolls (issue #773).
 *
 * A dialog that can grow past the viewport puts everything between its header
 * and its footer in here: `flex-auto` claims the height the two fixed bands
 * leave, and once that is less than the content asks for, this box scrolls -
 * so the title stays readable, the primary action stays on screen, and the
 * corner close button, which is positioned against the panel rather than
 * against this box, does not scroll away with the content.
 *
 * `min-h-0` is what allows the shrink at all: a flex item's automatic minimum
 * size on the main axis is its content, so without it this band refuses to be
 * shorter than its content and the overflow moves back out to the panel. It is
 * the vertical case of the `min-w-0` rule in docs/design-system.md.
 *
 * `flex-auto` and not `flex-1`: `flex-1` bases the item at `0%`, which asks a
 * short dialog to stretch its one band over the whole cap. Basis `auto` grows
 * only into height that is actually free and shrinks only when there is none.
 *
 * A short dialog does not need one - a confirm, a rename, a three-field form.
 * The panel keeps its own `overflow-y-auto` for those.
 */
const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		data-slot="dialog-body"
		className={cn("min-h-0 min-w-0 flex-auto overflow-y-auto", className)}
		{...props}
	/>
);

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		data-slot="dialog-footer"
		className={cn(
			"flex shrink-0 flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
			className
		)}
		{...props}
	/>
);

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("text-lg font-semibold leading-none tracking-tight", className)}
			{...props}
		/>
	);
}

function DialogDescription({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn("text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogPortal,
	DialogOverlay,
	DialogTrigger,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogBody,
	DialogFooter,
	DialogTitle,
	DialogDescription,
};
