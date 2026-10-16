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
 * Absent for a run with no errors. `onSelectStatus` / `onSelectErrorType` turn
 * the By status code / By error type rows into buttons that report their key;
 * without them the rows are plain text. `hasSamples` disables a row the run kept
 * no example of (#2213).
 */

import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, DisabledHint } from "@/components/ui";
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

const NO_SAMPLE_REASON = "No sample of this was kept";

interface CountRowProps {
	label: string;
	count: number;
	mono?: boolean;
	/** Makes the row a button. Absent, the row is plain text. */
	onSelect?: () => void;
	/** With `onSelect`: the run kept nothing to open, so the button is disabled and says why. */
	unavailable?: boolean;
}

function CountRow({ label, count, mono, onSelect, unavailable }: CountRowProps) {
	const text = (
		<>
			<span className={cn(mono && "font-mono")}>{label}</span>
			<span className="font-medium">{formatNumber(count)}</span>
		</>
	);
	if (!onSelect) return <div className={ROW_CLASS}>{text}</div>;

	// DisabledHint's wrapper is inline-flex; the row has to stay full width.
	return (
		<div className="[&>[data-slot=disabled-hint]]:flex [&>[data-slot=disabled-hint]]:w-full">
			<DisabledHint reason={unavailable && NO_SAMPLE_REASON}>
				<Button
					type="button"
					variant="listRow"
					className={cn(ROW_CLASS, "justify-between font-normal hover:bg-accent")}
					disabled={unavailable}
					onClick={onSelect}
				>
					{text}
					{unavailable && <span className="sr-only">{NO_SAMPLE_REASON}</span>}
				</Button>
			</DisabledHint>
		</div>
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

/** A row of the card, named the way a caller needs to look it up. */
export type ErrorRowTarget = { kind: "status"; code: string } | { kind: "errorType"; key: string };

export interface ErrorSummaryProps {
	errors: RunReport["errors"] | undefined;
	/** The run's error rate as a percent (`summary.errorRate`), not a fraction. */
	errorRate: number;
	httpErrors: number;
	noResponse: number;
	onSelectStatus?: (code: string) => void;
	onSelectErrorType?: (errorType: string) => void;
	/**
	 * Whether a row has anything to open. A row with a handler that it refuses is
	 * drawn disabled; a row without a handler is plain text whatever it says.
	 * Absent, every such row is open-able.
	 */
	hasSamples?: (target: ErrorRowTarget) => boolean;
}

export function ErrorSummary({
	errors,
	errorRate,
	httpErrors,
	noResponse,
	onSelectStatus,
	onSelectErrorType,
	hasSamples,
}: ErrorSummaryProps) {
	if (!errors || errors.total <= 0) return null;

	const types = Object.entries(errors.types ?? {});
	const statusCodes = Object.entries(errors.byStatusCode ?? {});
	const unavailable = (target: ErrorRowTarget) => hasSamples?.(target) === false;

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
								onSelect={onSelectErrorType && (() => onSelectErrorType(errorType))}
								unavailable={unavailable({ kind: "errorType", key: errorType })}
							/>
						))}
					</Breakdown>
				)}

				{statusCodes.length > 0 && (
					<Breakdown title="By status code">
						{statusCodes.map(([code, count]) => (
							<CountRow
								key={code}
								label={code === "0" ? "No response (status 0)" : `HTTP ${code}`}
								count={count}
								mono
								onSelect={onSelectStatus && (() => onSelectStatus(code))}
								unavailable={unavailable({ kind: "status", code })}
							/>
						))}
					</Breakdown>
				)}
			</CardContent>
		</Card>
	);
}
