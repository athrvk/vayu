/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The response status chip, one component, as a duplicate had lost the `status === 0` branch and
 * drew a connection failure as a literal `0`, not `ERR`. `variant="chip"`, not the default: other
 * Badge variants pair `bg-x` with `hover:bg-x/80`, and `cn()`'s tailwind-merge replaces `bg-*` but
 * files `hover:bg-*` apart, so the variant's hover would repaint a green 200 with the user's
 * accent. Nothing here is clickable.
 */

import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { httpStatusClass, statusCodeLabel, STATUS_CLASS_STYLE } from "@/constants/http-status";

export interface StatusCodeBadgeProps {
	status: number;
	statusText?: string;
	className?: string;
}

export function StatusCodeBadge({ status, statusText, className }: StatusCodeBadgeProps) {
	const cls = httpStatusClass(status);
	const style = STATUS_CLASS_STYLE[cls];

	/*
	 * `no-response` shows its label alone. Elsewhere "404" and "Not Found" say different things, so
	 * the phrase earns its place; with nothing back there is no code to pair, `statusCodeLabel`
	 * says "ERR" and the engine's `statusText` is "Error", so "ERR Error" would be two words for
	 * one fact.
	 */
	const reason = cls === "no-response" ? null : statusText;

	return (
		<Badge
			variant="chip"
			className={cn(
				"shrink-0 whitespace-nowrap font-mono shadow text-primary-foreground",
				style.fill,
				className
			)}
		>
			{statusCodeLabel(status)}
			{reason ? ` ${reason}` : ""}
		</Badge>
	);
}
