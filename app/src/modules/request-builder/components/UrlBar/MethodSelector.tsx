/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MethodSelector Component
 *
 * HTTP method dropdown, colour-coded, living *inside* the URL field.
 *
 * It used to be a separate bordered control at a fixed `w-[76px]` - a width
 * sized for OPTIONS, so GET wasted about 40px of it on every request, and the
 * row paid for a second border and a second gap on top. Since the two are one
 * thought ("this request"), it now sits in the URL field's own border, the way
 * a browser's protocol chip does, and sizes to its label.
 *
 * It stays a real dropdown rather than becoming a coloured rail with a text
 * label: the method is changed often, and dropping the caret would make a
 * control look like a status.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useRequestBuilderContext } from "../../context";
import { HTTP_METHODS } from "@/constants/http";
import { getMethodColor } from "@/utils";
import type { HttpMethod } from "@/types";

export default function MethodSelector() {
	const { request, updateField } = useRequestBuilderContext();

	return (
		<Select
			value={request.method}
			onValueChange={(value) => updateField("method", value as HttpMethod)}
		>
			<SelectTrigger
				aria-label="HTTP method"
				className={cn(
					// Borderless and transparent: the field around it draws the box.
					// `w-auto` so the trigger is as wide as its verb.
					"h-full w-auto shrink-0 gap-1.5 border-0 bg-transparent px-3 py-0 shadow-none",
					"font-mono text-[11px] font-bold",
					/*
					 * It had no hover state at all after moving in here - the old
					 * standalone control got its affordance from a `bg-accent` box,
					 * and going transparent inside the field took that away without
					 * putting anything back. A dropdown that does not respond to the
					 * pointer does not look like a dropdown.
					 *
					 * `data-[state=open]` holds the wash while the menu is up, so the
					 * trigger stays visibly the thing the list belongs to.
					 */
					"transition-colors hover:bg-accent data-[state=open]:bg-accent",
					/*
					 * Rounded on the left only, matching the field's own corner, so
					 * the hover wash follows the curve instead of squaring off
					 * against it. `rounded-l-md` rather than a pixel value: the app
					 * has a user-facing Roundedness setting and a hardcoded radius
					 * would ignore it. The field cannot use `overflow-hidden` to do
					 * this clipping for us - it would also clip the URL input's
					 * variable-autocomplete popover, which is positioned inside it.
					 */
					"rounded-l-md rounded-r-none",
					// The field owns the focus ring; a second one inside it reads as
					// two controls, which is exactly what this stopped being.
					"focus:ring-0 focus:ring-offset-0",
					"[&>svg]:h-3 [&>svg]:w-3"
				)}
				// Inline `hsl()` from `getMethodColor`, matching `MethodBadge` - the
				// one way method colour is applied in this app. This file used to
				// carry its own `METHOD_COLORS` map of `.method-*` utility classes,
				// a second source of truth for the same seven colours, and the kind
				// that quietly stops matching.
				style={{ color: `hsl(${getMethodColor(request.method)})` }}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{HTTP_METHODS.map((method) => (
					<SelectItem
						key={method}
						value={method}
						className="font-mono font-semibold"
						style={{ color: `hsl(${getMethodColor(method)})` }}
					>
						{method}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
