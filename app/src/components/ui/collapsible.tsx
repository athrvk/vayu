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
 * The height animation is `tw-animate-css`'s stock `collapsible-down`/`-up`
 * keyed off Radix's `data-state`, not a hand-rolled pair: Radix measures the
 * open height into `--radix-collapsible-content-height`, which those keyframes
 * already read. Only the curve is borrowed from the motion vocabulary, in the
 * same file-local spelling Toast uses - `--tw-ease` is what the generated
 * `--animate-collapsible-*` value reads ahead of its own `ease-out` default,
 * so the pair below gives this the decelerate-in / accelerate-out asymmetry
 * every other surface has without touching `index.css`. The duration stays
 * tw-animate-css's 200ms; no tier token covers inline content.
 *
 * `overflow-hidden` is what makes a height animation clip rather than squash,
 * and it is permanent while open, so this box does clip an outset focus ring.
 * It deliberately does not carry `.panel-clip`: the same `Input`, `Switch` or
 * row-enable checkbox renders both inside a disclosure and outside one, and
 * tucking the ring inward here would give one control two looks depending on
 * where it sits - the clearance-over-tucking rule in `docs/design-system.md`,
 * guarded for the checkbox by `key-value-parity.test.tsx`. A consumer whose
 * control sits flush against this box's edge adds its own clearance, the way
 * the load-test dialog's disclosures do with `px-3 py-3`.
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
