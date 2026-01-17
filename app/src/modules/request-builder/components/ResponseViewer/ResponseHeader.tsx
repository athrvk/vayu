
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
		response.status >= 200 && response.status < 300
			? "bg-green-500"
			: response.status >= 300 && response.status < 400
				? "bg-yellow-500"
				: response.status >= 400 && response.status < 500
					? "bg-orange-500"
					: "bg-red-500";

	const formatSize = (bytes: number): string => {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	};

	return (
		<div className="flex items-center gap-4 px-4 py-3 border-b border-border bg-muted/30">
			{/* Status */}
			<Badge className={cn("font-mono", statusColor)}>
				{response.status} {response.statusText}
			</Badge>

			{/* Time */}
			<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
				<Clock className="w-4 h-4" />
				<span>{response.time} ms</span>
			</div>

			{/* Size */}
			<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
				<FileText className="w-4 h-4" />
				<span>{formatSize(response.size)}</span>
			</div>
		</div>
	);
}
