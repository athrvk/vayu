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
	// `block`, not `<label>`'s `inline`: a label above its field (`space-y-*`, the usual shape)
	// needs its own line. `Input`/`Textarea` are `w-full` and force one, but `ToggleGroup`'s
	// `inline-flex` track is not and sat beside the label (the load-test dialog's "Response
	// format", the client-certificate form's "Format"). A flex or grid item Label is unaffected, as
	// its parent blockifies it.
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
