/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The response status chip.
 *
 * This existed twice - `ResponseViewer/ResponseHeader.tsx` and
 * `shared/response-viewer/UnifiedResponseViewer.tsx` - as the same twelve lines
 * with one difference: the copy had lost the `status === 0` branch, so a
 * connection failure rendered as a literal `0` chip instead of `ERR`. The
 * duplication was the defect, so there is one component now.
 *
 * `variant="chip"`, not the default: every other Badge variant pairs `bg-x`
 * with `hover:bg-x/80`, and `cn()` is tailwind-merge, which replaces `bg-*` but
 * files `hover:bg-*` under a different key. The fill below would win at rest
 * and the variant's hover would win under the pointer, repainting a green 200
 * with the user's accent. Nothing here is clickable.
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
	 * `no-response` shows its label alone.
	 *
	 * Everywhere else the two halves say different things - "404" and "Not
	 * Found" - so the reason phrase earns its place. When nothing came back
	 * there is no code to pair with, `statusCodeLabel` already says "ERR", and
	 * the engine fills `statusText` with "Error", so the chip read "ERR Error".
	 * Two words for one fact, and the second is the vaguer of them.
	 */
	const reason = cls === "no-response" ? null : statusText;

	return (
		<Badge
			variant="chip"
			className={cn("font-mono shadow text-primary-foreground", style.fill, className)}
		>
			{statusCodeLabel(status)}
			{reason ? ` ${reason}` : ""}
		</Badge>
	);
}
