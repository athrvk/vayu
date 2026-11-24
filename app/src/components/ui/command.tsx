/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

"use client";

import * as React from "react";
import { type DialogProps } from "@radix-ui/react-dialog";
import { Command as CommandPrimitive, useCommandState } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Eyebrow } from "@/components/ui/eyebrow";

/**
 * The surface every command list sits on, `card` rather than `popover`: a divider in this tree (the
 * input's, the footer's, a section separator) must say `border-rule` to read on both themes, which
 * resolves through the nearest declared surface. `--popover` has no surface class, and a
 * `surface-popover` copying `surface-card` would be a second definition with nothing behind it, as
 * `--popover` and `--card` (and their foregrounds) are the same numbers in both themes. The pair
 * `bg-card surface-card`, not the surface alone, per `app/CLAUDE.md`: this element had a background
 * utility, and a surface class alone loses that cascade.
 */
const COMMAND_SURFACE = "bg-card surface-card text-card-foreground";

/**
 * The highlight cmdk gets when it must have none: a controlled `value` matching no row selects
 * none, and it must be non-empty, as cmdk reads empty as "nothing chosen" and highlights the first
 * row. `\u0001` survives cmdk's `.trim()`, and no row's text starts with it.
 */
export const NO_HIGHLIGHT = "\u0001no-highlight";

/** The ids an outside control needs to name this list and its highlighted row. */
export interface CommandListboxState {
	/** The `role="listbox"` element's id, for `aria-controls`. */
	listboxId?: string;
	/** The highlighted `role="option"`'s id, for `aria-activedescendant`. */
	activeOptionId?: string;
}

/**
 * Reports those ids to a control outside the list. `cmdk` mints both and writes `id` after the
 * props, so neither can be passed in, and a combobox steering the list from outside must name them:
 * in `VariableInput` the field is two components up and the list never focused, so without them a
 * screen reader hears nothing of the highlight the arrows move (#1215). Read from `cmdk`'s store,
 * not watched on the DOM, because a highlight cmdk moves itself (the pointer over rows) re-renders
 * only this list. Render inside a `CommandList`; `onChange` must be stable.
 */
export function CommandListboxProbe({ onChange }: { onChange: (s: CommandListboxState) => void }) {
	/*
	 * Subscribed to the highlight, not `state.selectedItemId`, which cmdk maintains only for a list
	 * it highlights itself: a controlled `value` is written straight to the store, so the cached id
	 * stays undefined for exactly this probe's case. The highlight is always current, and its row
	 * is one query away, scoped to this list.
	 */
	const highlight = useCommandState((state) => state.value);
	const ref = React.useRef<HTMLSpanElement>(null);

	React.useEffect(() => {
		const list = ref.current?.closest<HTMLElement>("[cmdk-list]");
		/*
		 * Matched on `data-value`, not the rendered `aria-selected`, which lags: a row learns its
		 * value in a layout effect without re-rendering, so on first paint the highlight is on
		 * nothing. That effect writes `data-value`, and a passive effect runs after all of them.
		 */
		const rows = list ? Array.from(list.querySelectorAll<HTMLElement>("[cmdk-item]")) : [];
		onChange({
			listboxId: list?.id,
			activeOptionId: rows.find((row) => row.getAttribute("data-value") === highlight)?.id,
		});
	}, [onChange, highlight]);

	// `hidden`: out of the accessibility tree, not an extra child of a listbox meant for options.
	return <span ref={ref} hidden />;
}

/**
 * Scrolls the highlighted row into view for a list steered from outside. cmdk scrolls only on its
 * own state path (`setState("value", ...)`, which its `Command.Input` arrows take); a highlight
 * through the controlled `value` *prop* lands in a layout effect that assigns and emits with no
 * scroll and no `selectedItemId`. So such a list moves `[data-selected]` to a row it never shows,
 * below `CommandList`'s `max-h-[300px] overflow-y-auto` fold past the eighth entry (#1333). Read
 * from cmdk's store, so pointer and arrow highlights share one path: cmdk opts its pointer handler
 * out of scrolling, and `block: "nearest"` makes that free, as a row already on screen does not
 * move. The group heading rides along, as cmdk does for a group's first row: here the headings tell
 * a generator from a stored variable. Render inside a `CommandList`; anything driving a `Command`
 * from a controlled `value` wants it, so it lives beside the primitive.
 */
export function CommandScrollIntoView() {
	const highlight = useCommandState((state) => state.value);
	const ref = React.useRef<HTMLSpanElement>(null);

	React.useEffect(() => {
		const list = ref.current?.closest<HTMLElement>("[cmdk-list]");
		/*
		 * Scoped to this list: the app mounts several, and this highlight is this one's. On
		 * `aria-selected`, where the probe reads `data-value`: the probe must name a row on first
		 * paint, when `aria-selected` lags, while this has nothing to do before a scroll, so it
		 * uses the selector cmdk uses for the scroll it stands in for.
		 */
		const row = list?.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]');
		if (!row) return;
		if (row.parentElement?.firstChild === row) {
			row.closest("[cmdk-group]")
				?.querySelector<HTMLElement>("[cmdk-group-heading]")
				?.scrollIntoView({ block: "nearest" });
		}
		row.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	return <span ref={ref} hidden />;
}

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
	 * Names the dialog for assistive tech: Radix requires a `DialogTitle`, and a palette has no
	 * visible heading (its search field is the header), so it is `sr-only`, not omitted.
	 */
	title: string;
	/** One line saying what typing here does, also `sr-only`. */
	description: string;
	className?: string;
	/**
	 * Forwarded to the inner `Command`, so a caller ranking its own results stops cmdk scoring them
	 * again, the hatch `SuggestionList` and `VariableAutocomplete` take on a bare `Command`.
	 */
	shouldFilter?: boolean;
	/**
	 * Forwarded to the inner `Command`, which otherwise never sees them (the rest go to `Dialog`).
	 * A caller controlling the highlight (the palette withholds it until the user moves it) needs
	 * `value`, and the handlers tell it the user did.
	 */
	value?: string;
	onValueChange?: (value: string) => void;
	onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
	onPointerMove?: React.PointerEventHandler<HTMLDivElement>;
}

const CommandDialog = ({
	children,
	title,
	description,
	className,
	shouldFilter,
	value,
	onValueChange,
	onKeyDown,
	onPointerMove,
	...props
}: CommandDialogProps) => {
	return (
		<Dialog {...props}>
			{/*
			 * No corner close button: it would sit on the search field, and Escape or a click
			 * outside dismisses a palette. No `DialogBody` (#773): a palette is its input,
			 * `CommandList` and a hint footer, and the list caps and scrolls itself, so the band
			 * claiming leftover height exists one level in and the two around it are `shrink-0`.
			 * The panel's cap still applies, and `overflow-hidden` keeps the list's scroll the only
			 * one.
			 */}
			<DialogContent showClose={false} className={cn("overflow-hidden p-0", className)}>
				<DialogTitle className="sr-only">{title}</DialogTitle>
				<DialogDescription className="sr-only">{description}</DialogDescription>
				<Command
					shouldFilter={shouldFilter}
					value={value}
					onValueChange={onValueChange}
					onKeyDown={onKeyDown}
					onPointerMove={onPointerMove}
					/*
					 * No row overrides here (#1177): `CommandItem`'s `px-2 py-1.5` is the
					 * single-line row drawn everywhere else and the launcher metric, 30.0px in
					 * Chromium against the built stylesheet (`abc2bd2`;
					 * `docs/app/COMPONENTS/palette.md` records it with the eleven-row count resting
					 * on it, #1260). A forced `px-2 py-3` made it 44px, about six in a 300px list,
					 * hiding everything past the second section. No icon sizes either:
					 * `[&_[cmdk-item]_svg]:h-5` outranks a row's own `size-icon-sm`, drawing 20px
					 * icons beside the `h-icon-sm` rail. The list's cap belongs to whoever renders
					 * it; group headings carry no typography here (`CommandGroup` draws them with
					 * `Eyebrow`).
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
	/*
	 * The ring is on the wrapper, not the input: the input sits flush in a full-bleed row, so its
	 * ring would trace a box the row lacks. `ring-inset` because `CommandDialog` clips
	 * (`overflow-hidden`), as `TabsTrigger` does (docs/design-system/focus-states.md); without it
	 * the `outline-none` below left the palette's one focusable element with no indicator (#1216).
	 * `rounded-t-lg` matches the root's `rounded-lg`: this is its first child, flush with its top,
	 * and the root clips, so square corners would cut off the inset ring's top corners.
	 * `CommandGroup` has its own `p-1`; this is the one child flush enough to need it.
	 */
	return (
		<div
			className="flex items-center rounded-t-lg border-b border-rule px-3 focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring"
			cmdk-input-wrapper=""
		>
			<Search className="mr-2 size-icon shrink-0 opacity-50" />
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
			className={cn(
				"max-h-[300px] overflow-y-auto overflow-x-hidden [scrollbar-gutter:auto]",
				className
			)}
			{...props}
		/>
	);
}

/**
 * The band under the list, for keyboard hints, outside `CommandList` on purpose: the list is the
 * one thing that scrolls (#773), so hints inside would scroll away, as `DialogFooter` sits outside
 * `DialogBody` elsewhere. `shrink-0` keeps it a band, not the first thing a full panel squashes.
 * `border-rule`, resolved by the root's `surface-card`, like the input's divider and the section
 * separators; under no declared surface it falls back to the invisible default.
 */
function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="command-footer"
			className={cn(
				"flex shrink-0 items-center gap-3 border-t border-rule px-3 py-2 text-micro text-muted-foreground",
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
			 * A section label is an `Eyebrow`, as everywhere, not a third spelling of the eleven
			 * pixels (that string was hand-typed in about a dozen components and two had drifted).
			 * Wrapped only for a text heading: a caller's node owns its typography, and a block
			 * element in `Eyebrow`'s `<p>` is invalid. cmdk still renders the wrapper it labels the
			 * group by, so what tests and `aria-labelledby` reach for is unchanged.
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
			// `border-t border-rule`, not a 1px `bg-border` slab: on a card `--border` is the
			// card's background in dark, so the slab drew nothing there.
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
				"relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-icon [&_svg]:shrink-0",
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
