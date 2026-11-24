/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A keyboard key cap. One `<Kbd>` per key, for a Linear/Raycast-style indicator:
 *
 *   <Kbd>⌘</Kbd> <Kbd>↵</Kbd>          // chord
 *   <Kbd size="sm">⌘K</Kbd>            // dense menu shortcut
 *
 * Prefer the chord form (one per key) for shortcuts read top-down ("Press X or click Y"), so each
 * cap has a visible separator. Sizes: `default` (main UI: empty states, modal hints), 24×24 cap,
 * 12px glyph; `sm` (menus, dense rows), 18×18 cap, 10px glyph.
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
				"inline-flex items-center justify-center font-mono font-semibold text-foreground bg-muted border border-border-strong border-b-[2px] rounded-md shadow-sm leading-none align-middle",
				// `h-target min-w-target` (#1679), not `h-6 min-w-[24px]`: `h-6` is 18px under the
				// 3px `--spacing` (#1670), so both sides of the 24px cap read one floor.
				size === "default" && "h-target min-w-target px-1.5 text-xs",
				size === "sm" && "h-[18px] min-w-[18px] px-1 text-micro",
				className
			)}
			{...props}
		/>
	);
}

export { Kbd };
