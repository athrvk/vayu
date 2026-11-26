/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { INPUT_HEIGHT } from "./input-size";

/**
 * An input states its size, never its height (#1830): the sizes are the `control` / `control-sm` /
 * `control-xs` floor tokens, so Comfortable follows; a numeric `h-*` in `className` would be a
 * fourth height, and `chrome-floors.test.ts` fails it. Not exported, so the module stays
 * hot-reloadable (`react-refresh/only-export-components`).
 */
const inputVariants = cva(
	// `text-sm` always, not shadcn's `text-base md:text-sm`, the web workaround for iOS zooming a
	// focused field under 16px; Vayu is a desktop window, and that form drew 16px below `md` (a
	// split window, a narrow pane), a size the type scale lacks.
	"flex border border-input bg-transparent text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
	{
		variants: {
			size: {
				// `h-control` (#1679, 28px), not `h-9` (27px under the 3px rhythm). `px-3`, not
				// `px-2`, as `Textarea` and `SelectTrigger` carry: at `px-2` Input read tighter
				// than its siblings, and a short value (`NumberField`'s "5") reads as clipped by
				// the border once Roundedness curves the corner.
				default: `${INPUT_HEIGHT.default} w-full rounded-md px-3 py-1 focus-visible:ring-1 focus-visible:ring-ring`,
				sm: `${INPUT_HEIGHT.sm} w-full rounded-md px-3 py-1 focus-visible:ring-1 focus-visible:ring-ring`,
				// The inline rename field, replacing a row's label in place. The label sits `gap-2`
				// from its icon or badge, so the field is pulled back by its padding plus its 1px
				// border (outside the padding) to land its text on the label's x, leaving the
				// border a step clear of the icon; the width gives the offset back on the right.
				// Every rename site writes `size="xs"` and nothing else (`chrome-floors.test.ts`
				// fails a `px-`, `-ml-` or `w-` beside it; `input.test.tsx` keeps margin, width and
				// padding in step). The border takes the focus colour instead of a ring, as the row
				// cannot spare the outset.
				xs: `${INPUT_HEIGHT.xs} w-[calc(100%+var(--spacing)*1+1px)] -ml-[calc(var(--spacing)*1+1px)] rounded-sm px-1 py-0 focus-visible:border-ring focus-visible:ring-0`,
			},
		},
		defaultVariants: { size: "default" },
	}
);

type InputProps = Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>;

function Input({ className, type, size, ...props }: InputProps) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(inputVariants({ size }), className)}
			{...props}
		/>
	);
}

export { Input };
export type { InputProps };
