/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const labelVariants = cva(
	// `block`, not the bare `<label>` element's own default `inline`: a
	// label describing the field below it (`space-y-*` above the control,
	// the majority shape in the app) needs its own line regardless of what
	// follows - `Input`/`Textarea` are `w-full` and force one anyway, but
	// `ToggleGroup`'s track is `inline-flex` with no `w-full` and stayed on
	// the label's own inline line instead, e.g. the load test dialog's
	// "Response format" and the client-certificate form's "Format" both
	// rendered their segmented control beside the label rather than under
	// it. A flex- or grid-item Label is unaffected: the browser blockifies
	// an inline box the moment its parent formatting context makes it one.
	"block text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
);

function Label({
	className,
	...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>) {
	return (
		<LabelPrimitive.Root
			data-slot="label"
			className={cn(labelVariants(), className)}
			{...props}
		/>
	);
}

export { Label };
