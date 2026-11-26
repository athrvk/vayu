/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The data table the response pane shows headers and cookies in. **`text-xs`, not `text-sm`, for
 * density**: every other surface in the pane (tab strip, toolbar, console slabs, timing stats) is
 * 12px or 11px, and a real response carries fifteen or twenty headers, so this tab is where height
 * becomes information. At `text-xs` with `py-1.5` a row is ~26px against `text-sm` `py-2`'s ~36px,
 * about seven more headers at the same height. `border-rule`, not a border token: the pane declares
 * `surface-card`, where `--border` is `--card`'s colour in dark, running the cookie list together.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
	return <table data-slot="table" className={cn("w-full text-xs", className)} {...props} />;
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
	return <thead data-slot="table-header" className={className} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
	return <tbody data-slot="table-body" className={className} {...props} />;
}

/**
 * A body row, and the head row too: it takes its rule from the same place, as "one step lighter for
 * the header" is invisible on this surface; the head is told apart by its cell styling.
 */
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
	return (
		<tr
			data-slot="table-row"
			className={cn("border-b border-rule transition-colors hover:bg-muted/50", className)}
			{...props}
		/>
	);
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
	return (
		<th
			data-slot="table-head"
			className={cn(
				"py-1.5 px-3 text-left font-medium text-muted-foreground whitespace-nowrap",
				className
			)}
			{...props}
		/>
	);
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
	return (
		<td data-slot="table-cell" className={cn("py-1.5 px-3 align-top", className)} {...props} />
	);
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
