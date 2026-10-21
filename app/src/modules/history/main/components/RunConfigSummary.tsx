/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RunConfigSummary Component
 *
 * The "Test config" box of a stored load run: one line with the settings that
 * define the experiment (mode, virtual users, duration, protocol) and a
 * "Details" disclosure for the rest (target rate, data set, timeout). The
 * second tier is closed by default because it is reference, not the answer; the
 * protocol's "not negotiated" correction is the one detail that stays on the
 * line, since hiding it would restore the mislabelling it exists to stop.
 */

import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, Settings2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";
import { formatLatency, formatNumber, formatRate } from "@/lib/format-number";
import { dataFileDisplayName } from "@/lib/run-data-file";
import { CONCURRENCY_LABEL, loadTestTypeToLabel } from "@/constants/load-test-modes";
import { HTTP_VERSIONS, isHttpVersion } from "@/constants/request";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { LoadTestConfig, RunReport } from "@/types";

type RunConfiguration = NonNullable<NonNullable<RunReport["metadata"]>["configuration"]>;

interface RunConfigSummaryProps {
	config: RunConfiguration | undefined;
	/** `report.summary.httpVersionDowngraded`; 0 and absent both draw nothing. */
	downgradedRequests: number;
}

interface ConfigEntry {
	label: string;
	value: string;
	/** Free text (the mode's name) is not set in the code font; numbers are. */
	mono: boolean;
}

function ConfigField({
	label,
	mono = true,
	trailing,
	children,
}: {
	label: string;
	mono?: boolean;
	/** Drawn after the value, in the row. */
	trailing?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-muted-foreground">{label}:</span>
			<span className={mono ? "text-foreground font-mono" : "text-foreground capitalize"}>
				{children}
			</span>
			{trailing}
		</div>
	);
}

function ConfigFields({ entries }: { entries: ConfigEntry[] }) {
	return entries.map(({ label, value, mono }) => (
		<ConfigField key={label} label={label} mono={mono}>
			{value}
		</ConfigField>
	));
}

/** The mode and the two numbers that size it; protocol is drawn beside them. */
function headlineEntries(config: RunConfiguration): ConfigEntry[] {
	const entries: ConfigEntry[] = [];
	if (config.mode) {
		entries.push({
			label: "Mode",
			value: loadTestTypeToLabel(config.mode as LoadTestConfig["mode"]),
			mono: false,
		});
	}
	if (config.concurrency != null && config.concurrency > 0) {
		entries.push({
			label: CONCURRENCY_LABEL,
			value: formatNumber(config.concurrency),
			mono: true,
		});
	}
	if (config.duration != null && config.duration !== "") {
		entries.push({ label: "Duration", value: String(config.duration), mono: true });
	}
	return entries;
}

function detailEntries(config: RunConfiguration): ConfigEntry[] {
	const entries: ConfigEntry[] = [];
	if (config.targetRps != null && config.targetRps > 0) {
		entries.push({ label: "Target RPS", value: formatRate(config.targetRps), mono: true });
	}
	if (config.dataRowCount != null && config.dataRowCount > 0) {
		const rows = `${formatNumber(config.dataRowCount)} ${pluralize(config.dataRowCount, "row")}`;
		entries.push({
			label: "Data",
			value: config.dataFileName
				? `${rows} · ${dataFileDisplayName(config.dataFileName, config.dataFileCastNumbers)}`
				: rows,
			mono: true,
		});
	}
	if (config.timeout != null && config.timeout > 0) {
		entries.push({ label: "Timeout", value: formatLatency(config.timeout), mono: true });
	}
	return entries;
}

/**
 * Requested protocol, not the negotiated one (`RunResultTrace.response.httpVersion`
 * is per-exchange and has no single value across a load run's many requests).
 * Labelled from the shared HTTP_VERSIONS list so this never keeps its own copy.
 */
function requestedProtocolLabel(config: RunConfiguration): string | undefined {
	const requested = config.httpVersion;
	if (!isHttpVersion(requested)) return undefined;
	return HTTP_VERSIONS.find((v) => v.value === requested)?.label;
}

/**
 * The label above is what the run *asked for*, and on its own it is the
 * mislabelling issue #215 describes: a run whose every request fell back to
 * HTTP/1.1 still reads "HTTP/2", over latency and throughput measured on
 * HTTP/1.1. This is the correction, drawn only when the engine counted a
 * downgrade - see summary.httpVersionDowngraded.
 */
function NotNegotiated({ count }: { count: number }) {
	return (
		<span
			className="flex items-center gap-1.5 text-status-warning-text"
			title={
				`${formatNumber(count)} of this run's requests asked for ` +
				`HTTP/2 and negotiated an older protocol.\n` +
				`The results below were measured over those connections.`
			}
		>
			<AlertTriangle className="size-icon shrink-0" />
			not negotiated
		</span>
	);
}

export default function RunConfigSummary({ config, downgradedRequests }: RunConfigSummaryProps) {
	const [detailsOpen, setDetailsOpen] = useState(false);
	if (!config) return null;

	// Gated on the protocol too, not just the mode: POST /runs accepts an
	// iterations-only body with no `mode` key (execution.cpp only requires
	// mode+duration OR iterations), so a run can legitimately have neither and
	// still carry a protocol worth showing. The run's comment is not here: it is
	// drawn under the run's title by the header above this pane.
	const protocolLabel = requestedProtocolLabel(config);
	if (!config.mode && !protocolLabel) return null;

	const headline = headlineEntries(config);
	const details = detailEntries(config);

	return (
		<Collapsible
			open={detailsOpen}
			onOpenChange={setDetailsOpen}
			className="border rounded-md bg-background/50 text-sm"
		>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
				<div className="flex items-center gap-2 text-muted-foreground">
					<Settings2 className="size-icon shrink-0" />
					<span className="font-medium">Test config</span>
				</div>
				<ConfigFields entries={headline} />
				{protocolLabel && (
					<ConfigField
						label="Protocol"
						trailing={
							downgradedRequests > 0 && <NotNegotiated count={downgradedRequests} />
						}
					>
						{protocolLabel}
					</ConfigField>
				)}
				{details.length > 0 && (
					<CollapsibleTrigger className="ml-auto flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
						<ChevronDown
							className={`size-icon-sm transition-transform ${detailsOpen ? "" : "-rotate-90"}`}
							aria-hidden="true"
						/>
						Details
					</CollapsibleTrigger>
				)}
			</div>
			<CollapsibleContent>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2">
					<ConfigFields entries={details} />
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
