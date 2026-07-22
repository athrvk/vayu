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
import { formatResponseTime, formatSize } from "@/components/shared/response-viewer/utils";
import { StatusCodeBadge } from "@/components/shared/response-viewer/StatusCodeBadge";

export interface ResponseHeaderProps {
	response: {
		status: number;
		statusText: string;
		time: number;
		size: number;
	};
}

export default function ResponseHeader({ response }: ResponseHeaderProps) {
	return (
		/*
		 * `border-border-strong`. This bar sits inside `ResponseViewer`'s
		 * `bg-card`, and design-system.md already states the rule for that case -
		 * `--border` on `--card` measures 1.003 in dark, the same colour. The
		 * `bg-muted/30` tint is not carrying it either: over a card that composites
		 * to 1.04. So the bar that reports status, time and size had no boundary at
		 * all in dark mode, top or bottom. `--border-strong` gives 1.278.
		 */
		<div className="flex items-center gap-4 px-4 py-3 border-b border-rule bg-muted/30">
			{/* Status */}
			<StatusCodeBadge status={response.status} statusText={response.statusText} />

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
