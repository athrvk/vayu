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
import { Eyebrow } from "@/components/ui/eyebrow";

/**
 * The surface every command list sits on, and the reason it is `card` rather
 * than `popover`.
 *
 * A divider inside this tree - the input's, the footer's, the separator between
 * two sections - has to say `border-rule` to read on both themes, and
 * `border-rule` resolves through the nearest declared surface. `--popover` had
 * no surface class to declare, and adding a `surface-popover` that duplicated
 * `surface-card` would be a second definition with nothing behind it:
 * `--popover` and `--card` are the same three numbers in both themes, as are
 * their foregrounds. So this root declares the surface it already painted, and
 * every divider below it inherits the rule that reads on it.
 *
 * The pair `bg-card surface-card` rather than `surface-card` alone, per the
 * rule in `app/CLAUDE.md`: this element already carried a background utility,
 * and a surface class alone loses that cascade.
 */
const COMMAND_SURFACE = "bg-card surface-card text-card-foreground";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			data-slot="command"
			className={cn(
				"flex h-full w-full flex-col overflow-hidden rounded-lg",
				COMMAND_SURFACE,
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
	/**
	 * Forwarded to the inner `Command`, so a caller that ranks its own results
	 * can stop cmdk scoring them a second time - the same escape hatch
	 * `SuggestionList` and `VariableAutocomplete` take on a bare `Command`.
	 */
	shouldFilter?: boolean;
}

const CommandDialog = ({
	children,
	title,
	description,
	className,
	shouldFilter,
	...props
}: CommandDialogProps) => {
	return (
		<Dialog {...props}>
			{/* No corner close button: it would land on top of the search field,
			    and Escape or a click outside is how a palette is dismissed.

			    No `DialogBody` either (issue #773): a palette is its input,
			    `CommandList` and a footer of hints, and the list caps and
			    scrolls itself - so the band that would claim the leftover
			    height already exists one level in, and the two around it are
			    `shrink-0` rather than growing. The panel's cap still applies,
			    and `overflow-hidden` keeps the list's own scroll the only
			    one. */}
			<DialogContent showClose={false} className={cn("overflow-hidden p-0", className)}>
				<DialogTitle className="sr-only">{title}</DialogTitle>
				<DialogDescription className="sr-only">{description}</DialogDescription>
				<Command
					shouldFilter={shouldFilter}
					/*
					 * No row overrides here at all any more (#1177). This
					 * string used to force `px-2 py-3` and 20px icons onto every
					 * row, which made a 32px row a 44px one - about six of them
					 * in a 300px list, so anything past the second section was
					 * below the fold with nothing on screen saying it existed.
					 * `CommandItem`'s own `px-2 py-1.5` is the 32px single-line
					 * row this app draws everywhere else, which is also the
					 * launcher metric, so the fix is to stop overriding it.
					 *
					 * The icon sizes went the same way and were never doing what
					 * they said: `[&_[cmdk-item]_svg]:h-5` outranks the `h-3.5`
					 * a row writes on its own icon - one class, one attribute
					 * and a type against one class - so every palette row drew a
					 * 20px icon beside the 14px rail meant to match it.
					 *
					 * The list's cap is the other half of the density and
					 * belongs to whoever renders the list. Group headings carry
					 * no typography here either - `CommandGroup` draws them with
					 * `Eyebrow`.
					 */
					className="[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12"
				>
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
		<div className="flex items-center border-b border-rule px-3" cmdk-input-wrapper="">
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

/**
 * The band under the list, for keyboard hints.
 *
 * Outside `CommandList` on purpose, and that is the whole rule: the list is the
 * one thing that scrolls here (issue #773), so hints placed inside it would
 * scroll away with the results they describe - the same reason `DialogFooter`
 * sits outside `DialogBody` in every other dialog. `shrink-0` keeps it a band
 * rather than the first thing a full panel squashes.
 *
 * `border-rule`, which the `Command` root's `surface-card` resolves - the same
 * token the input's divider one band up and the separators between sections
 * now use. It read `border-t` alone while nothing in this tree declared a
 * surface, since `border-rule` under none falls back to the invisible default.
 */
function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="command-footer"
			className={cn(
				"flex shrink-0 items-center gap-3 border-t border-rule px-3 py-2 text-[10px] text-muted-foreground",
				className
			)}
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
	heading,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group
			data-slot="command-group"
			/*
			 * A section label is an `Eyebrow` here as it is everywhere else in
			 * the app, rather than a third spelling of the same eleven pixels -
			 * the primitive exists because that string was hand-typed in about a
			 * dozen components and two of them had already drifted.
			 *
			 * Wrapped only when the heading is text: a caller passing its own
			 * node owns its typography, and a block element inside `Eyebrow`'s
			 * `<p>` would be invalid markup. cmdk still renders the wrapper it
			 * labels the group by, so the element every test and every
			 * `aria-labelledby` reaches for is unchanged.
			 */
			heading={typeof heading === "string" ? <Eyebrow>{heading}</Eyebrow> : heading}
			className={cn(
				"overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5",
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
			// `border-t border-rule`, not a 1px `bg-border` slab: the same one
			// pixel, in the colour the `Command` root's surface declares. On a
			// card `--border` is the card's own background in dark, so the old
			// version drew a divider that was simply absent there.
			className={cn("-mx-1 border-t border-rule", className)}
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

export {
	Command,
	CommandDialog,
	CommandInput,
	CommandList,
	CommandFooter,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandSeparator,
};
