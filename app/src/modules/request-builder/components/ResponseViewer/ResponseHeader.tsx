/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseHeader Component
 *
 * Displays response status, time, and size information.
 */

import { Clock, FileText } from "lucide-react";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatResponseTime, formatSize } from "@/components/shared/response-viewer/utils";

export interface ResponseHeaderProps {
	response: {
		status: number;
		statusText: string;
		time: number;
		size: number;
	};
}

export default function ResponseHeader({ response }: ResponseHeaderProps) {
	const statusColor =
		response.status === 0
			? "bg-status-error-fill" // Client-side error (no server response)
			: response.status >= 200 && response.status < 300
				? "bg-status-success-fill"
				: response.status >= 300 && response.status < 400
					? "bg-status-warning-fill"
					: response.status >= 400 && response.status < 500
						? "bg-status-stopped-fill"
						: "bg-status-error-fill";

	return (
		<div className="flex items-center gap-4 px-4 py-3 border-b border-border bg-muted/30">
			{/* Status */}
			{/* `chip`, not the default variant: the default carries
			    `hover:bg-primary-fill/80`, which survives tailwind-merge even
			    though the fill below replaces its background — so this chip
			    faded to the user's accent on hover. It is not clickable. */}
			<Badge
				variant="chip"
				className={cn("font-mono shadow text-primary-foreground", statusColor)}
			>
				{response.status === 0 ? "ERR" : response.status} {response.statusText}
			</Badge>

			{/* Time */}
			<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
				<Clock className="w-4 h-4" />
				<span>{formatResponseTime(response.time)}</span>
			</div>

			{/* Size */}
			<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
				<FileText className="w-4 h-4" />
				<span>{formatSize(response.size)}</span>
			</div>
		</div>
	);
}
