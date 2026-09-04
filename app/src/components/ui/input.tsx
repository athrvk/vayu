/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				// `text-sm` unconditionally, where stock shadcn writes
				// `text-base md:text-sm`: that pair is the web workaround for iOS
				// zooming a focused field under 16px, and Vayu is a desktop window.
				// The responsive form rendered every input at 16px whenever the
				// window was narrower than `md` - a split window, a narrow pane -
				// which is the one size the type scale does not contain.
				"flex h-9 w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
				className
			)}
			{...props}
		/>
	);
}

export { Input };
