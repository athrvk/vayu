/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RunMetadata Component
 *
 * Displays API endpoint, test mode, timing information
 */

import { Activity, Clock, Globe, Calendar, Table2, Timer } from "lucide-react";
import type { RunMetadataProps } from "../types";
import { formatDuration } from "../utils/format";
import { loadTestTypeToLabel } from "@/utils";
import { LoadTestConfig } from "@/types";
import { MethodBadge } from "@/components/shared";

export default function RunMetadata({
	requestUrl,
	requestMethod,
	startTime,
	endTime,
	mode,
	elapsedDuration,
	setupOverhead,
	configuration,
}: RunMetadataProps) {
	if (!requestUrl && !requestMethod && !startTime) {
		return null;
	}

	return (
		<div className="mb-4 p-3 bg-muted/50 border rounded-lg">
			<div className="flex flex-wrap items-center gap-4 text-sm">
				{/* API Endpoint */}
				{requestUrl && (
					<div className="flex items-center gap-2">
						<Globe className="w-4 h-4 text-muted-foreground" />
						<span className="font-medium text-muted-foreground">Endpoint:</span>
						{requestMethod && <MethodBadge method={requestMethod} size="md" />}
						<span
							className="text-foreground font-mono text-xs truncate max-w-md"
							title={requestUrl}
						>
							{requestUrl}
						</span>
					</div>
				)}

				{/* Test Mode & Config */}
				{configuration?.mode && (
					<div className="flex items-center gap-2">
						<Activity className="w-4 h-4 text-muted-foreground" />
						<span className="font-medium text-muted-foreground">Mode:</span>
						<span className="text-foreground capitalize">
							{loadTestTypeToLabel(configuration.mode as LoadTestConfig["mode"])}
						</span>
						{configuration.targetRps && (
							<span className="text-muted-foreground">
								@ {configuration.targetRps} RPS
							</span>
						)}
						{configuration.concurrency && (
							<span className="text-muted-foreground">
								({configuration.concurrency} concurrent)
							</span>
						)}
						{configuration.duration && (
							<span className="text-muted-foreground">
								(for {configuration.duration} seconds)
							</span>
						)}
					</div>
				)}

				{/* What a data-driven run bound (issue #993). The rows themselves
				    are never stored - the snapshot keeps their count in their
				    place - so this is the whole record that the run was driven by
				    a file, and the only place a reader learns how large the set
				    was. Absent for every run without one, rather than "0 rows". */}
				{typeof configuration?.dataRowCount === "number" &&
					configuration.dataRowCount > 0 && (
						<div className="flex items-center gap-2">
							<Table2 className="w-4 h-4 text-muted-foreground" />
							<span className="font-medium text-muted-foreground">Data:</span>
							<span className="text-foreground">
								{configuration.dataRowCount}{" "}
								{configuration.dataRowCount === 1 ? "row" : "rows"}
							</span>
							<span className="text-muted-foreground text-xs">
								(one per request, repeating)
							</span>
						</div>
					)}
			</div>

			{/* Timing Info */}
			<div className="flex flex-wrap items-center gap-4 text-sm mt-2">
				{/* Start Time */}
				{startTime && (
					<div className="flex items-center gap-2">
						<Calendar className="w-4 h-4 text-muted-foreground" />
						<span className="font-medium text-muted-foreground">Started:</span>
						<span className="text-foreground">
							{new Date(startTime).toLocaleString()}
						</span>
					</div>
				)}

				{/* End Time (only show when completed) */}
				{mode === "completed" && endTime && (
					<div className="flex items-center gap-2">
						<Clock className="w-4 h-4 text-muted-foreground" />
						<span className="font-medium text-muted-foreground">Completed:</span>
						<span className="text-foreground">
							{new Date(endTime).toLocaleString()}
						</span>
					</div>
				)}

				{/* Duration */}
				{(elapsedDuration > 0 || startTime) && (
					<div className="flex items-center gap-2">
						<Timer className="w-4 h-4 text-muted-foreground" />
						<span className="font-medium text-muted-foreground">Run Duration:</span>
						<span className="text-foreground">
							{mode === "completed"
								? formatDuration(
										elapsedDuration ||
											(endTime && startTime ? endTime - startTime : 0)
									)
								: // Live: use the tick-derived elapsed (renders are tick-driven)
									// rather than Date.now(), which is impure during render.
									formatDuration(elapsedDuration)}
						</span>
						{/* Show setup overhead if available */}
						{mode === "completed" &&
							setupOverhead !== undefined &&
							setupOverhead > 0 && (
								<span
									className="text-muted-foreground text-xs"
									title="Time spent in setup before test started"
								>
									(+{(setupOverhead * 1000).toFixed(0)}ms setup)
								</span>
							)}
					</div>
				)}

				{/* Comment */}
				{configuration?.comment && (
					<div className="flex items-center gap-2 w-full mt-1">
						<span className="font-medium text-muted-foreground">Note:</span>
						<span className="text-foreground/80 italic">{configuration.comment}</span>
					</div>
				)}
			</div>
		</div>
	);
}
