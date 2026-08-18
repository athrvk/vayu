/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

"use client";

import * as React from "react";
import { type DialogProps } from "@radix-ui/react-dialog";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			data-slot="command"
			className={cn(
				"flex h-full w-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground",
				className
			)}
			{...props}
		/>
	);
}

interface CommandDialogProps extends DialogProps {
	/**
	 * Names the dialog for assistive tech. Radix requires a `DialogTitle`, and
	 * a palette has no visible heading - its search field is the whole header -
	 * so the title is rendered `sr-only` rather than omitted.
	 */
	title: string;
	/** One line saying what typing here does, also `sr-only`. */
	description: string;
	className?: string;
}

const CommandDialog = ({
	children,
	title,
	description,
	className,
	...props
}: CommandDialogProps) => {
	return (
		<Dialog {...props}>
			{/* No corner close button: it would land on top of the search field,
			    and Escape or a click outside is how a palette is dismissed.

			    No `DialogBody` either (issue #773): a palette is its input plus
			    `CommandList`, which caps and scrolls itself, so the band that
			    would claim the leftover height already exists one level in. The
			    panel's cap still applies, and `overflow-hidden` keeps the list's
			    own scroll the only one. */}
			<DialogContent showClose={false} className={cn("overflow-hidden p-0", className)}>
				<DialogTitle className="sr-only">{title}</DialogTitle>
				<DialogDescription className="sr-only">{description}</DialogDescription>
				<Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
					{children}
				</Command>
			</DialogContent>
		</Dialog>
	);
};

function CommandInput({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
	return (
		<div className="flex items-center border-b px-3" cmdk-input-wrapper="">
			<Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
			<CommandPrimitive.Input
				data-slot="command-input"
				className={cn(
					"flex h-10 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
					className
				)}
				{...props}
			/>
		</div>
	);
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
	return (
		<CommandPrimitive.List
			data-slot="command-list"
			className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className)}
			{...props}
		/>
	);
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
	return (
		<CommandPrimitive.Empty
			data-slot="command-empty"
			className="py-6 text-center text-sm"
			{...props}
		/>
	);
}

function CommandGroup({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group
			data-slot="command-group"
			className={cn(
				"overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
				className
			)}
			{...props}
		/>
	);
}

function CommandSeparator({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
	return (
		<CommandPrimitive.Separator
			data-slot="command-separator"
			className={cn("-mx-1 h-px bg-border", className)}
			{...props}
		/>
	);
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			data-slot="command-item"
			className={cn(
				"relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
				className
			)}
			{...props}
		/>
	);
}

// CommandShortcut wraps children in an `ml-auto` span and key-caps any bare
// children for a Linear/Raycast feel. Pass either a string ("⌘K" → two caps),
// an array of single keys, or a fully composed <Kbd> tree.
const CommandShortcut = ({
	className,
	children,
	...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
	const keys = renderShortcutKeys(children);
	return (
		<span
			data-slot="command-shortcut"
			className={cn("ml-auto flex items-center gap-1", className)}
			{...props}
		>
			{keys}
		</span>
	);
};

function renderShortcutKeys(children: React.ReactNode): React.ReactNode {
	if (typeof children !== "string") return children;
	// Split "⌘K" or "⌘ K" or "Ctrl+Enter" into individual key tokens.
	const tokens = children
		.replace(/\s+/g, "")
		.split(/[+\s]+/)
		.flatMap((tok) => (tok.length > 1 ? splitGlyphs(tok) : [tok]))
		.filter(Boolean);
	return tokens.map((t, i) => (
		<Kbd key={i} size="sm">
			{t}
		</Kbd>
	));
}

// Split a glyph string like "⌘K" into ["⌘", "K"]. Single Latin words like
// "Cmd" or "Enter" stay whole.
function splitGlyphs(s: string): string[] {
	if (/^[A-Za-z]+$/.test(s)) return [s];
	return Array.from(s);
}

export {
	Command,
	CommandDialog,
	CommandInput,
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandShortcut,
	CommandSeparator,
};
