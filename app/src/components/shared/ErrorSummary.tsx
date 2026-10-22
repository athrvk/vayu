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
 * Drawn by the history Overview, which the dashboard also shows for a finished
 * run (#2220). It was shared out because the dashboard's own report once kept
 * a copy that had drifted: it printed the bare total and the raw type keys and
 * omitted By status code, which left a run whose errors were all HTTP 500
 * showing an empty list under a non-zero total.
 *
 * Absent for a run with no errors. `onSelectStatus` / `onSelectErrorType` turn
 * the By status code / By error type rows into buttons that report their key;
 * without them the rows are plain text. `hasSamples` disables a row the run kept
 * no example of (#2213).
 *
 * By error type can cover fewer errors than the total (#2400): a run stored
 * before the engine kept exact per-type counts breaks down only the errors its
 * store kept. `sampling.errorsDropped` says how many were not kept, and the
 * note under the rows says so. It is silent for a run whose types account for
 * every no-response request, whatever `errorsDropped` reads, because the
 * breakdown is exact there.
 */

import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, DisabledHint } from "@/components/ui";
import { Callout } from "./Callout";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format-number";
import { formatErrorPercent, pickByCount } from "@/modules/dashboard/utils/format";
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
	too_many_redirects: "Too many redirects",
	bad_content_encoding: "Bad content encoding",
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

/**
 * Said under By error type when the rows cover only the errors the run stored.
 * `stored` is the count the breakdown does cover, `dropped` the errors past it.
 */
function UntypedErrorsNote({ dropped, stored }: { dropped: number; stored: number }) {
	const first = formatNumber(stored);
	const count = formatNumber(dropped);
	const text = pickByCount(dropped, {
		one: `${count} error beyond the first ${first} is not broken down by type.`,
		other: `${count} errors beyond the first ${first} are not broken down by type.`,
	});
	return (
		<Callout severity="info">
			{text} The counts here cover only the stored errors; the totals above are exact.
		</Callout>
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
	/**
	 * The run's retention counts. `errorsDropped` is what By error type did not
	 * see; absent (an older run) says nothing rather than "nothing was dropped".
	 */
	sampling?: RunReport["sampling"];
}

export function ErrorSummary({
	errors,
	errorRate,
	httpErrors,
	noResponse,
	onSelectStatus,
	onSelectErrorType,
	hasSamples,
	sampling,
}: ErrorSummaryProps) {
	if (!errors || errors.total <= 0) return null;

	const types = Object.entries(errors.types ?? {});
	const statusCodes = Object.entries(errors.byStatusCode ?? {});
	const unavailable = (target: ErrorRowTarget) => hasSamples?.(target) === false;
	// A run that counted every error by type has types adding up to its
	// no-response requests, so dropped stored records cost the breakdown nothing.
	const typed = types.reduce((sum, [, count]) => sum + count, 0);
	const droppedFromTypes = typed < noResponse ? (sampling?.errorsDropped ?? 0) : 0;

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
						{droppedFromTypes > 0 && (
							<UntypedErrorsNote
								dropped={droppedFromTypes}
								stored={errors.withDetails}
							/>
						)}
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
