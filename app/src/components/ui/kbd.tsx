/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Kbd — keyboard key-cap component.
 *
 * Use one <Kbd> per key for a Linear/Raycast-style multi-key indicator:
 *
 *   <Kbd>⌘</Kbd> <Kbd>↵</Kbd>          // chord
 *   <Kbd size="sm">⌘K</Kbd>            // dense menu shortcut
 *
 * For shortcuts that read top-down ("Press X or click Y"), prefer the chord
 * form (one Kbd per key) so each cap has a visible separator.
 *
 * Two sizes:
 *   - default — main UI (empty states, modal hints). 24×24 cap, 12px glyph.
 *   - sm      — menus / inline dense rows. 18×18 cap, 10px glyph.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

export interface KbdProps extends React.ComponentProps<"kbd"> {
	size?: "default" | "sm";
}

function Kbd({ className, size = "default", ...props }: KbdProps) {
	return (
		<kbd
			data-slot="kbd"
			className={cn(
				"inline-flex items-center justify-center font-mono font-semibold text-foreground bg-card border border-border border-b-[2px] rounded-md shadow-sm leading-none align-middle",
				size === "default" && "h-6 min-w-[24px] px-1.5 text-[12px]",
				size === "sm" && "h-[18px] min-w-[18px] px-1 text-[10px]",
				className
			)}
			{...props}
		/>
	);
}

export { Kbd };
