/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

"use client";

import type { ComponentProps } from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

import { cn } from "@/lib/utils";

const Collapsible = CollapsiblePrimitive.Root;

const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;

/**
 * The height animation is `tw-animate-css`'s `collapsible-down`/`-up` keyed off Radix's
 * `data-state`, as Radix measures the open height into `--radix-collapsible-content-height`, which
 * those keyframes read. Only the curve is borrowed, in Toast's file-local spelling: the generated
 * `--animate-collapsible-*` reads `--tw-ease` before its `ease-out` default, so the pair below
 * gives the decelerate-in / accelerate-out asymmetry without touching `index.css`. The duration
 * stays 200ms; no tier token covers inline content.
 *
 * `overflow-hidden` makes the animation clip rather than squash, and stays while open, so this
 * clips an outset focus ring. Not `.panel-clip`: the same `Input`, `Switch` or row checkbox renders
 * inside and outside a disclosure, and tucking the ring here would give it two looks (the
 * clearance-over-tucking rule, `docs/design-system/focus-states.md`, guarded for the checkbox by
 * `key-value-parity.test.tsx`). A control flush with this edge adds its own clearance, as the
 * load-test dialog's disclosures do with `px-3 py-3`.
 */
function CollapsibleContent({
	className,
	...props
}: ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
	return (
		<CollapsiblePrimitive.CollapsibleContent
			data-slot="collapsible-content"
			className={cn(
				"overflow-hidden [--tw-ease:var(--ease-enter)] data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up data-[state=closed]:[--tw-ease:var(--ease-exit)]",
				className
			)}
			{...props}
		/>
	);
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
