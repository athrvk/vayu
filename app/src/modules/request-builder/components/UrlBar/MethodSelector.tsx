/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The colour-coded HTTP method dropdown, *inside* the URL field: method and URL are one thought, so
 * it sits in the field's border like a browser's protocol chip and sizes to its label. A real
 * dropdown, not a coloured rail: the method changes often, and without the caret the control would
 * look like a status.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useRequestBuilderContext } from "../../context";
import { HTTP_METHODS } from "@/constants/http";
import { getMethodColor } from "@/lib/method-display";
import type { HttpMethod } from "@/types";

export default function MethodSelector() {
	const { request, setRequest } = useRequestBuilderContext();

	return (
		<Select
			value={request.method}
			onValueChange={(value) =>
				// Both fields in one call: a hand-picked method is no longer GraphQL's, as retyping
				// a marked header clears its `source` (`graphql-method.ts`, #1505).
				setRequest({ method: value as HttpMethod, methodSource: undefined })
			}
		>
			<SelectTrigger
				aria-label="HTTP method"
				className={cn(
					// Borderless and transparent, as the field draws the box; `w-auto` so it is as
					// wide as its verb.
					"h-full w-auto shrink-0 gap-1.5 border-0 bg-transparent px-3 py-0 shadow-none",
					// Semibold, not bold: 600 is the heaviest JetBrains Mono face `fonts.css`
					// bundles, so `font-bold` would be a synthesised 700.
					"font-mono text-label font-semibold",
					/*
					 * A hover wash: transparent inside the field, a dropdown that does not respond
					 * to the pointer does not look like one. `data-[state=open]` holds the wash
					 * while the menu is up, marking what the list belongs to.
					 */
					"transition-colors hover:bg-accent data-[state=open]:bg-accent",
					/*
					 * Rounded on the left only, the field's own corner, so the wash follows the
					 * curve. `rounded-l-md`, not pixels: the Roundedness setting must apply. The
					 * field cannot clip with `overflow-hidden`: it would clip the URL input's
					 * variable-autocomplete popover, positioned inside it.
					 */
					"rounded-l-md rounded-r-none",
					// The field owns the focus ring; a second inside it would read as two controls.
					"focus:ring-0 focus:ring-offset-0",
					// `size-icon-sm` (#1679), the app's small-icon step for every 12px glyph.
					"[&>svg]:size-icon-sm"
				)}
				// Inline `hsl()` from `getMethodColor`, as `MethodBadge` does: the app's one way to
				// apply method colour.
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
