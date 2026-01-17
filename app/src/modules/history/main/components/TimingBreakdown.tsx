
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
				<div className={`bg-blue-50 dark:bg-blue-950/30 ${padding} rounded text-center`}>
					<p className={`${labelSize} text-muted-foreground uppercase`}>DNS</p>
					<p className={`${textSize} font-bold text-blue-700 dark:text-blue-300`}>
						{dnsMs.toFixed(1)}
						<span className="text-xs font-normal">ms</span>
					</p>
				</div>
			)}
			{connectMs !== undefined && (
				<div
					className={`bg-purple-50 dark:bg-purple-950/30 ${padding} rounded text-center`}
				>
					<p className={`${labelSize} text-muted-foreground uppercase`}>Connect</p>
					<p className={`${textSize} font-bold text-purple-700 dark:text-purple-300`}>
						{connectMs.toFixed(1)}
						<span className="text-xs font-normal">ms</span>
					</p>
				</div>
			)}
			{tlsMs !== undefined && (
				<div
					className={`bg-indigo-50 dark:bg-indigo-950/30 ${padding} rounded text-center`}
				>
					<p className={`${labelSize} text-muted-foreground uppercase`}>TLS</p>
					<p className={`${textSize} font-bold text-indigo-700 dark:text-indigo-300`}>
						{tlsMs.toFixed(1)}
						<span className="text-xs font-normal">ms</span>
					</p>
				</div>
			)}
			{firstByteMs !== undefined && (
				<div className={`bg-green-50 dark:bg-green-950/30 ${padding} rounded text-center`}>
					<p className={`${labelSize} text-muted-foreground uppercase`}>TTFB</p>
					<p className={`${textSize} font-bold text-green-700 dark:text-green-300`}>
						{firstByteMs.toFixed(1)}
						<span className="text-xs font-normal">ms</span>
					</p>
				</div>
			)}
			{downloadMs !== undefined && (
				<div
					className={`bg-yellow-50 dark:bg-yellow-950/30 ${padding} rounded text-center`}
				>
					<p className={`${labelSize} text-muted-foreground uppercase`}>Download</p>
					<p className={`${textSize} font-bold text-yellow-700 dark:text-yellow-300`}>
						{downloadMs.toFixed(1)}
						<span className="text-xs font-normal">ms</span>
					</p>
				</div>
			)}
		</div>
	);
}
