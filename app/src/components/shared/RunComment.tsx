/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The line a user wrote about a run when they started it (#2270), under the
 * run's title, labelled "Comment". Drawn by the History run header and the live
 * dashboard's header, so a run's comment reads the same on both and the label
 * is spelled once.
 *
 * Renders nothing for an empty comment, so a caller need not gate it.
 */

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function RunComment({
	comment,
	className,
	...rest
}: { comment: string | undefined } & Omit<ComponentProps<"p">, "children">) {
	if (!comment) return null;
	return (
		<p className={cn("text-xs text-foreground/90", className)} {...rest}>
			<span className="text-muted-foreground">Comment</span> {comment}
		</p>
	);
}
