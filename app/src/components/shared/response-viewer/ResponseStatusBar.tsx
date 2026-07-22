/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bar above a response: status chip, elapsed time, payload size.
 *
 * This existed twice - `ResponseViewer/ResponseHeader.tsx` in the request
 * builder and a local `ResponseStatusBar` at the bottom of
 * `UnifiedResponseViewer` - as the same wrapper and the same three children,
 * class for class. The only difference was that the history copy made time and
 * size optional, so this takes the superset.
 *
 * It is the same duplication that produced the `status === 0` drift in
 * `StatusCodeBadge` (one copy lost the branch and rendered a literal `0`), and
 * the reason the invisible-divider fix had to be applied to this bar twice.
 */

import { Clock, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatResponseTime, formatSize } from "./utils";
import { StatusCodeBadge } from "./StatusCodeBadge";

export interface ResponseStatusBarProps {
	status: number;
	statusText?: string;
	/** Omitted by callers that have no timing - a stored run without a trace. */
	time?: number;
	/** Omitted by callers that have no size. */
	size?: number;
	className?: string;
}

export function ResponseStatusBar({
	status,
	statusText,
	time,
	size,
	className,
}: ResponseStatusBarProps) {
	return (
		/*
		 * `border-rule`: this bar sits inside the response pane's `surface-card`,
		 * which declares what the rule resolves to. Hardcoding a border token here
		 * is what made it invisible in dark - `--border` is the same colour as
		 * `--card`, 1.003. See index.css, "Surfaces, and the rule colour that
		 * reads on each".
		 */
		<div
			className={cn(
				"flex items-center gap-4 px-4 py-3 border-b border-rule bg-muted/30",
				className
			)}
		>
			<StatusCodeBadge status={status} statusText={statusText} />

			{time !== undefined && (
				<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<Clock className="w-4 h-4" />
					<span>{formatResponseTime(time)}</span>
				</div>
			)}

			{size !== undefined && (
				<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<FileText className="w-4 h-4" />
					<span>{formatSize(size)}</span>
				</div>
			)}
		</div>
	);
}

export default ResponseStatusBar;
