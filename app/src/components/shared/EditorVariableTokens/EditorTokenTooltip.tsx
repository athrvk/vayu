/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";
// The primitive's own module, not the `components/ui` barrel: `CodeEditor` is in
// that barrel and draws this tooltip, so the barrel here would be a cycle.
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TokenAnchorRect } from "./context";

/**
 * The app's tooltip over a span of Monaco text that has no DOM node of its
 * own - a `{{token}}` (`TokenHoverCard`, issue #1320) or a time
 * (`TimeTokenCard`, issue #1786). One shell, so both cards sit over their text
 * the same way and a fix to one reaches the other.
 */
export function EditorTokenTooltip({
	rect,
	label,
	children,
}: {
	/** Where the span is, measured by the editor in viewport coordinates. */
	rect: TokenAnchorRect;
	/** The span's own text, so the trigger Radix describes is named. */
	label: string;
	children: ReactNode;
}) {
	return (
		<div
			// Fixed and inert, for the same reason the popover's anchor is: the
			// rectangle came from `getBoundingClientRect` on the editor, and a box
			// over Monaco's canvas that took the pointer would end the hover it was
			// drawn for - and swallow the click meant for the editor beneath.
			style={{
				position: "fixed",
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height,
				pointerEvents: "none",
			}}
		>
			{/*
			 * Open because it is mounted: the editor owns the timing (it holds the
			 * pointer), so this component exists only while the tooltip should be
			 * up. Radix's own open delay would run a second timer after that one.
			 */}
			<Tooltip open>
				<TooltipTrigger asChild>
					{/*
					 * Never a Tab stop - it is a measurement over painted text, and the
					 * keyboard reads a `{{token}}` by opening its popover (⇧⌘D). It
					 * still carries the span's text, so the tooltip Radix points at it
					 * with `aria-describedby` describes something named.
					 */}
					<span className="block h-full w-full" tabIndex={-1}>
						<span className="sr-only">{label}</span>
					</span>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="max-w-xs">
					{children}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
