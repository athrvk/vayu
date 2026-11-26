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
import { HeadingSection } from "./heading";

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
				// dialog-overlay (index.css): shares the panel's duration and curve, so both land
				// as one.
				"dialog-overlay fixed inset-0 z-50 bg-black/80",
				className
			)}
			{...props}
		/>
	);
}

interface DialogContentProps extends React.ComponentProps<typeof DialogPrimitive.Content> {
	/**
	 * The corner close button, on by default and off for one shape: a command palette, whose corner
	 * is its search field and which closes on Escape or a click outside. A form or decision dialog
	 * keeps it: it is the discoverable way out.
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
					// dialog-panel (index.css). Keep the translate utilities: they centre the panel
					// via the standalone `translate` property, which the scale-only keyframes
					// compose with.
					//
					// `flex flex-col` does two load-bearing jobs.
					//
					// **Width** (#701). An implicit grid track is `auto`, its minimum the items'
					// min-content, so one wide descendant (a data-file preview, a long URL) grew it
					// past the panel's `max-w` and right-aligned controls and the footer laid out
					// over the backdrop. A column flex container applies no `min-width: auto` on
					// the cross axis, so an item stretches to the panel's content width and a wide
					// descendant overflows *inside* it. Measured in Chromium on #701's seven-column
					// shape: an `auto` track put the footer 580px past the painted edge;
					// `grid-cols-1` and this both put it 25px inside.
					//
					// **Height** (#773). `max-h-[85vh]` plus a `DialogBody`, the band that scrolls.
					// Without the cap a panel taller than the viewport is centred and clipped at
					// *both* ends with nothing to scroll (it is `fixed`): an eighteen-row dialog at
					// 613px left its Run button 198px off screen, reachable by Tab, not pointer.
					// `overflow-y-auto` is the fallback for a dialog with no `DialogBody`: the
					// panel scrolls itself and the footer stays reachable, taking the close button
					// along, which is why a dialog that can grow takes the band; with one present
					// the panel never scrolls and the button stays.
					//
					// Four widths: a form or decision is `sm:max-w-lg` (512px); content with a
					// shape of its own (a table, a diff, a preview, a dense config) `max-w-xl`
					// (576px, the default); a *browser*, where reading a grid is the task,
					// `sm:max-w-2xl` (672px, the data-row picker, #892: seven CSV columns at 576px
					// leave ~60px each); a dense config of two independent groups
					// `max-w-xl lg:max-w-4xl` (896px from `lg`, one column below), in two panes
					// (#2231).
					//
					// A dialog is a focus device before a container: widen the scale only for
					// content that earns it, in `dialog-width-scale.test.tsx` and
					// docs/design-system/dialogs.md with the reason, never at a call site.
					"dialog-panel fixed left-[50%] top-[50%] z-50 flex max-h-[85vh] w-full max-w-xl translate-x-[-50%] translate-y-[-50%] flex-col gap-3 overflow-y-auto [scrollbar-gutter:auto] rounded-lg border bg-background p-5 shadow-lg",
					className
				)}
				{...props}
			>
				{/*
				 * Its own outline under its `h2` title: context crosses the portal, so a dialog
				 * opened from a tab would inherit its level and a card or empty state inside could
				 * be a second `h1` (#3498).
				 */}
				<HeadingSection level={3}>{children}</HeadingSection>
				{showClose && (
					// `size-target` (#1679, 24px): the bare 16px icon alone was under WCAG 2.2 SC
					// 2.5.8's floor.
					<DialogPrimitive.Close className="absolute right-4 top-4 flex size-target items-center justify-center rounded-md opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
						<X className="size-icon" />
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
 * The band that scrolls (#773). A dialog that can grow past the viewport puts everything between
 * header and footer here: `flex-auto` claims the height the fixed bands leave and scrolls past it,
 * so the title stays readable, the primary action on screen, and the close button (positioned
 * against the panel) does not scroll away. `min-h-0` allows the shrink: a flex item's automatic
 * main-axis minimum is its content, so without it the overflow moves back to the panel (the
 * vertical `min-w-0` rule, docs/design-system/overflow-and-shrink.md). `flex-auto`, not `flex-1`,
 * whose `0%` basis stretches a short dialog's band over the whole cap; basis `auto` grows only into
 * free height. A short dialog (a confirm, a rename, a three-field form) needs none; the panel's
 * `overflow-y-auto` covers it. `overflow-y-auto` makes `overflow-x` `auto` too, clipping all sides:
 * a focused field's outset ring loses its edges, and the first and last rows theirs at the scroll
 * ends (#1627). `-mx-1 px-1 -my-px py-px` folds 4px and 1px of clearance back with negative
 * margins, so no call site shifts or needs its own copy.
 */
const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		data-slot="dialog-body"
		className={cn(
			"min-h-0 min-w-0 flex-auto overflow-y-auto [scrollbar-gutter:auto] -mx-1 px-1 -my-px py-px",
			className
		)}
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
			// 15px, the scale's title step, not shadcn's 18px: a dialog title is chrome and read
			// three steps above body in a dense tool (#1202).
			className={cn("text-md font-semibold leading-none tracking-tight", className)}
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
