/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A Send or a script's `pm.sendRequest` in the session Console (#3634): the shared
 * `SampledExchange` row, titled by the method and the masked URL, with status, time and size in the
 * row's own tracks and the held exchange as its expansion.
 */

import { memo } from "react";
import { MethodBadge } from "@/components/shared/MethodBadge";
import { TimeValue } from "@/components/shared/TimeValue";
import { TruncatedText } from "@/components/shared/TruncatedText";
import { SampledExchange, phasesFromTrace } from "@/components/shared/response-viewer";
import { formatBytes } from "@/lib/format-number";
import type { ConsoleScriptRequestRow, ConsoleSendRow, ConsoleRow } from "@/stores/console-store";
import ScopeTag from "@/modules/request-builder/components/ResponseViewer/ScopeTag";
import { SCRIPT_SECTIONS } from "@/modules/request-builder/components/ResponseViewer/console/script-sections";
import { ExchangeView } from "./ExchangeView";
import { CopyCurlButton, OpenRunButton } from "./RowActions";

type RequestRowData = ConsoleRow & (ConsoleSendRow | ConsoleScriptRequestRow);

/** `errorCode` and `errorMessage` as one line; absent when the exchange did not fail. */
function failureText(row: RequestRowData): string | undefined {
	const text = [row.errorCode, row.errorMessage].filter(Boolean).join(": ");
	return text || undefined;
}

/** The method and URL, and for a script request the script that made it. */
function RequestTitle({ row }: { row: RequestRowData }) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<MethodBadge method={row.method || "GET"} />
			<TruncatedText className="min-w-0 font-mono text-xs text-foreground">
				{row.url}
			</TruncatedText>
			{row.kind === "scriptRequest" && (
				<>
					<span className="shrink-0 text-micro text-muted-foreground">
						{SCRIPT_SECTIONS[row.source].label}
					</span>
					<ScopeTag scope={row.scope} />
				</>
			)}
		</span>
	);
}

interface RequestRowProps {
	row: RequestRowData;
	isExpanded: boolean;
	onToggle: (id: number) => void;
}

export const RequestRow = memo(function RequestRow({ row, isExpanded, onToggle }: RequestRowProps) {
	const runId = row.kind === "send" ? row.runId : undefined;
	return (
		<SampledExchange
			label={row.id}
			title={<RequestTitle row={row} />}
			statusCode={row.status}
			statusText={row.statusText}
			latencyMs={row.timeMs}
			timestamp={
				<span className="tabular-nums">
					{formatBytes(row.sizeBytes)} · <TimeValue value={row.at} style="time-ms" />
				</span>
			}
			error={failureText(row)}
			phases={phasesFromTrace(row.exchange.timing)}
			scriptMs={row.exchange.timing?.scriptMs}
			isExpanded={isExpanded}
			onToggle={() => onToggle(row.id)}
			actions={
				<>
					<CopyCurlButton row={row} />
					{runId && <OpenRunButton runId={runId} />}
				</>
			}
		>
			<ExchangeView exchange={row.exchange} />
		</SampledExchange>
	);
});
