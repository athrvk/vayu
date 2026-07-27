/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The data table the response pane reads its headers and cookies out of.
 *
 * `HeadersViewer` and `ResponseCookies` had the chrome written out twice and
 * identically - `w-full text-sm`, a `border-b border-rule` head row,
 * `border-b border-rule hover:bg-muted/50` body rows, `py-2 px-3` cells. Two
 * columns in one and three in the other; everything around them the same.
 *
 * **Density is the reason this is `text-xs` and not `text-sm`.** Both tables
 * rendered at 14px with `py-2`, which is a ~36px row, while every other surface
 * in this pane - the tab strip, the toolbar, the console slabs, the timing
 * stats - is 12px or 11px. A response to a real request carries fifteen or
 * twenty headers, so the one tab where vertical space converts directly into
 * information was the loosest thing in the pane. At `text-xs` with `py-1.5` a
 * row is ~26px, which is about seven more headers on screen at the same height.
 *
 * `border-rule`, not a border token: these sit inside the response pane, which
 * declares `surface-card`. `--border` there is the same colour as `--card` in
 * dark, which is why the cookie list used to run together as one block.
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
 * A body row. The head row is a `TableRow` too - it takes its rule from the
 * same place, because at this surface "one step lighter for the header" lands
 * back at invisible. The head is distinguished by its cell styling instead.
 */
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
	return (
		<tr
			data-slot="table-row"
			className={cn("border-b border-rule hover:bg-muted/50", className)}
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
