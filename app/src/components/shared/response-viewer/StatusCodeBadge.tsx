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
	const style = STATUS_CLASS_STYLE[httpStatusClass(status)];

	return (
		<Badge
			variant="chip"
			className={cn("font-mono shadow text-primary-foreground", style.fill, className)}
		>
			{statusCodeLabel(status)}
			{statusText ? ` ${statusText}` : ""}
		</Badge>
	);
}
