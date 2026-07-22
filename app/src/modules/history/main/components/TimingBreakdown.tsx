/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TimingBreakdown Component
 *
 * Displays request timing breakdown (DNS, Connect, TLS, TTFB, Download).
 */

import { formatPhaseDuration } from "@/components/shared/response-viewer/utils";

interface TimingBreakdownProps {
	dnsMs?: number;
	connectMs?: number;
	tlsMs?: number;
	firstByteMs?: number;
	downloadMs?: number;
	compact?: boolean;
}

export default function TimingBreakdown({
	dnsMs,
	connectMs,
	tlsMs,
	firstByteMs,
	downloadMs,
	compact = false,
}: TimingBreakdownProps) {
	const hasData = dnsMs !== undefined || connectMs !== undefined || tlsMs !== undefined;

	if (!hasData) return null;

	const padding = compact ? "p-2" : "p-3";
	const textSize = compact ? "text-sm" : "text-lg";
	const labelSize = compact ? "text-[10px]" : "text-[10px]";

	return (
		<div className="grid grid-cols-5 gap-2">
			{dnsMs !== undefined && (
				<div className={`bg-blue-50 dark:bg-blue-950/30 ${padding} rounded-md text-center`}>
					<p className={`${labelSize} text-muted-foreground uppercase`}>DNS</p>
					<p className={`${textSize} font-bold text-blue-700 dark:text-blue-300`}>
						{formatPhaseDuration(dnsMs).value}
						<span className="text-xs font-normal">
							{formatPhaseDuration(dnsMs).unit}
						</span>
					</p>
				</div>
			)}
			{connectMs !== undefined && (
				<div
					className={`bg-purple-50 dark:bg-purple-950/30 ${padding} rounded-md text-center`}
				>
					<p className={`${labelSize} text-muted-foreground uppercase`}>Connect</p>
					<p className={`${textSize} font-bold text-purple-700 dark:text-purple-300`}>
						{formatPhaseDuration(connectMs).value}
						<span className="text-xs font-normal">
							{formatPhaseDuration(connectMs).unit}
						</span>
					</p>
				</div>
			)}
			{tlsMs !== undefined && (
				<div
					className={`bg-indigo-50 dark:bg-indigo-950/30 ${padding} rounded-md text-center`}
				>
					<p className={`${labelSize} text-muted-foreground uppercase`}>TLS</p>
					<p className={`${textSize} font-bold text-indigo-700 dark:text-indigo-300`}>
						{formatPhaseDuration(tlsMs).value}
						<span className="text-xs font-normal">
							{formatPhaseDuration(tlsMs).unit}
						</span>
					</p>
				</div>
			)}
			{firstByteMs !== undefined && (
				<div
					className={`bg-green-50 dark:bg-green-950/30 ${padding} rounded-md text-center`}
				>
					<p className={`${labelSize} text-muted-foreground uppercase`}>TTFB</p>
					<p className={`${textSize} font-bold text-green-700 dark:text-green-300`}>
						{formatPhaseDuration(firstByteMs).value}
						<span className="text-xs font-normal">
							{formatPhaseDuration(firstByteMs).unit}
						</span>
					</p>
				</div>
			)}
			{downloadMs !== undefined && (
				<div
					className={`bg-yellow-50 dark:bg-yellow-950/30 ${padding} rounded-md text-center`}
				>
					<p className={`${labelSize} text-muted-foreground uppercase`}>Download</p>
					<p className={`${textSize} font-bold text-yellow-700 dark:text-yellow-300`}>
						{formatPhaseDuration(downloadMs).value}
						<span className="text-xs font-normal">
							{formatPhaseDuration(downloadMs).unit}
						</span>
					</p>
				</div>
			)}
		</div>
	);
}
