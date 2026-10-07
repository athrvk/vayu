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
 * An input states its size, never its height (#1830): the three sizes are the
 * `control` / `control-sm` / `control-xs` floor tokens, so a caller picks a
 * step and Comfortable follows. A numeric `h-*` in a caller's `className`
 * would be a fourth height the row never agreed to, and `chrome-floors.test.ts`
 * fails the tag that carries one.
 *
 * Not exported: only `Input` is, so this module stays hot-reloadable
 * (`react-refresh/only-export-components`).
 */
const inputVariants = cva(
	// `text-sm` unconditionally, where stock shadcn writes
	// `text-base md:text-sm`: that pair is the web workaround for iOS
	// zooming a focused field under 16px, and Vayu is a desktop window.
	// The responsive form rendered every input at 16px whenever the
	// window was narrower than `md` - a split window, a narrow pane -
	// which is the one size the type scale does not contain.
	"flex border border-input bg-transparent text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
	{
		variants: {
			size: {
				// `h-control` (issue #1679, 28px), not `h-9` - was 27px under the
				// 3px spacing rhythm, one of the "the whole scale is a mistake"
				// pixel drifts this issue exists to stop.
				//
				// `px-3`, not `px-2`: `Textarea` and `SelectTrigger` already carry
				// `px-3`, and `Input` was the one text-entry primitive reading
				// tighter than its siblings - visible on a short numeric value
				// (`NumberField`'s "5"), which sits close enough to the border to
				// read as clipped by it once Roundedness curves the corner.
				default: `${INPUT_HEIGHT.default} w-full rounded-md px-3 py-1 focus-visible:ring-1 focus-visible:ring-ring`,
				sm: `${INPUT_HEIGHT.sm} w-full rounded-md px-3 py-1 focus-visible:ring-1 focus-visible:ring-ring`,
				// The inline rename field: replaces a row's label in place. The
				// label sits a `gap-2` from the icon or badge before it, so the
				// field is pulled back by its padding plus its 1px border (the
				// border sits outside the padding) and its text lands on the
				// label's x; that leaves the border one step clear of the icon.
				// The width gives the same offset back on the right. Every rename
				// site writes `size="xs"` and nothing else (`chrome-floors.test.ts`
				// fails a `px-`, `-ml-` or `w-` beside it, and `input.test.tsx`
				// keeps the margin, the width and the padding in step). The border
				// takes the focus colour in place of the ring, so one edge draws
				// instead of a ring stacked on a border inside a row that cannot
				// spare the outset.
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
