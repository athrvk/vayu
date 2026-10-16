/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run's error card: the total and its rate, the HTTP-error / no-response
 * split (issue #2124), then the engine's two breakdowns - by transport error
 * type and by status code.
 *
 * The history Overview and the dashboard's Request / Response tab are two
 * reports of one run, so both draw it from here. A copy of each had drifted
 * apart: the dashboard's printed the bare total and the raw type keys and
 * omitted By status code, which left a run whose errors were all HTTP 500
 * showing an empty list under a non-zero total.
 *
 * Absent for a run with no errors. `onSelectStatus` turns each By status code
 * row into a button that reports its code; without it the rows are plain text.
 */

import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format-number";
import { formatErrorPercent } from "@/modules/dashboard/utils/format";
import type { RunReport } from "@/types";

/**
 * Display labels for `report.errors.types` keys (`error_type_name` in the
 * engine's `load_strategy.cpp`, one entry per `vayu::ErrorCode`).
 *
 * Not `errorType.replace(/_/g, " ")` through `capitalize`: that renders
 * protocol acronyms as "Ssl Error" / "Dns Failed" / "Invalid Url", losing
 * the casing SSL/DNS/URL carry everywhere else in the UI. A key this map
 * does not carry (a future `ErrorCode`) falls back to the same
 * underscore-to-space, sentence-cased rendering rather than the raw token.
 */
const ERROR_TYPE_LABELS: Record<string, string> = {
	timeout: "Timeout",
	connection_failed: "Connection failed",
	dns_failed: "DNS failed",
	ssl_error: "SSL error",
	invalid_url: "Invalid URL",
	invalid_method: "Invalid method",
	script_error: "Script error",
	data_binding_failed: "Data binding failed",
	proxy_error: "Proxy error",
	internal_error: "Internal error",
	unknown: "Unknown",
};

function errorTypeLabel(errorType: string): string {
	if (ERROR_TYPE_LABELS[errorType]) return ERROR_TYPE_LABELS[errorType];
	const spaced = errorType.replace(/_/g, " ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const ROW_CLASS = "flex justify-between items-center p-2 bg-muted rounded-md text-sm";

function CountRow({ label, count, mono }: { label: string; count: number; mono?: boolean }) {
	return (
		<div className={ROW_CLASS}>
			<span className={cn(mono && "font-mono")}>{label}</span>
			<span className="font-medium">{formatNumber(count)}</span>
		</div>
	);
}

function StatusCodeRow({
	code,
	count,
	onSelect,
}: {
	code: string;
	count: number;
	onSelect?: (code: string) => void;
}) {
	const label = code === "0" ? "No response (status 0)" : `HTTP ${code}`;
	if (!onSelect) return <CountRow label={label} count={count} mono />;
	return (
		<Button
			type="button"
			variant="listRow"
			className={cn(ROW_CLASS, "justify-between font-normal hover:bg-accent")}
			onClick={() => onSelect(code)}
		>
			<span className="font-mono">{label}</span>
			<span className="font-medium">{formatNumber(count)}</span>
		</Button>
	);
}

function Breakdown({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="space-y-2">
			<p className="text-xs font-medium text-muted-foreground">{title}</p>
			{children}
		</div>
	);
}

export interface ErrorSummaryProps {
	errors: RunReport["errors"] | undefined;
	/** The run's error rate as a percent (`summary.errorRate`), not a fraction. */
	errorRate: number;
	httpErrors: number;
	noResponse: number;
	onSelectStatus?: (code: string) => void;
}

export function ErrorSummary({
	errors,
	errorRate,
	httpErrors,
	noResponse,
	onSelectStatus,
}: ErrorSummaryProps) {
	if (!errors || errors.total <= 0) return null;

	const types = Object.entries(errors.types ?? {});
	const statusCodes = Object.entries(errors.byStatusCode ?? {});

	return (
		<Card className="enter-fade border-destructive/30">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-destructive-text">
					<AlertCircle className="w-5 h-5" />
					Error summary
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="flex justify-between items-center p-3 bg-destructive/10 border border-destructive/20">
					<span className="text-sm font-medium text-destructive-text">Total errors</span>
					<span className="text-lg font-bold text-destructive-text">
						{formatNumber(errors.total)} ({formatErrorPercent(errorRate, 2)}%)
					</span>
				</div>

				<div className="grid grid-cols-2 gap-2">
					<CountRow label="HTTP errors" count={httpErrors} />
					<CountRow label="No response" count={noResponse} />
				</div>

				{types.length > 0 && (
					<Breakdown title="By error type">
						{types.map(([errorType, count]) => (
							<CountRow
								key={errorType}
								label={errorTypeLabel(errorType)}
								count={count}
							/>
						))}
					</Breakdown>
				)}

				{statusCodes.length > 0 && (
					<Breakdown title="By status code">
						{statusCodes.map(([code, count]) => (
							<StatusCodeRow
								key={code}
								code={code}
								count={count}
								onSelect={onSelectStatus}
							/>
						))}
					</Breakdown>
				)}
			</CardContent>
		</Card>
	);
}
